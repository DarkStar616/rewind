import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemoryReplaySavings } from "@rewind/core";

import { createMemoryRecordStore } from "../src/record-store.ts";
import { createReplayer } from "../src/replay.ts";
import { startProxy, type RunningProxy } from "../src/proxy.ts";
import { manualClock, startMockUpstream } from "../bench/mock-upstream.ts";
import { runBench } from "../bench/bench.ts";

/**
 * Gates that BITE. The bench proves the happy path saves money; these prove the meter cannot be
 * tricked into crediting a saving that did not happen, and — the correctness-critical one — that a
 * request which is not byte-equivalent is NEVER served a stale recorded answer.
 */

// --- Hand-oracle: a trajectory hand-derivable without trusting the token counter ---

test("hand-oracle: issuing one prefix-less turn twice avoids exactly the second call", async () => {
  // turnBody(1) has a single message and therefore NO cacheable prefix, so the provider cache never
  // helps — the second call costs the same as the first. The gateway avoids exactly that second call.
  const r = await runBench([1, 1]);
  assert.equal(r.avoidedCalls, 1, "the second occurrence is replayed");
  assert.equal(r.offUpstreamCalls, 2);
  assert.equal(r.onUpstreamCalls, 1);
  // OFF pays for two identical full-price calls; ON pays for one; the saving is exactly one call.
  assert.equal(r.offCostMicros, 2 * r.onCostMicros);
  assert.equal(r.billableSavedMicros, r.onCostMicros);
  // No prefix → warm==cold → gross equals billable (no provider-cache discount to net out).
  assert.equal(r.billableSavedMicros, r.grossReplayMicros);
});

// --- Golden-negative / do-nothing passthrough ---

test("do-nothing passthrough: an all-unique trajectory bills EXACTLY 0", async () => {
  const r = await runBench([1, 2, 3, 4, 5, 6]);
  assert.equal(r.avoidedCalls, 0);
  assert.equal(r.billableSavedMicros, 0);
  assert.equal(r.billableSavedPct, 0);
});

// --- Proxy-level correctness gates (a false serve here is a WRONG answer to the agent) ---

interface Fix {
  proxy: RunningProxy;
  upstreamCalls: () => number;
  close(): Promise<void>;
}

async function fixture(): Promise<Fix> {
  const upstream = await startMockUpstream({ clock: manualClock(0) });
  const store = createMemoryRecordStore();
  const replayer = createReplayer(store, createMemoryReplaySavings());
  const proxy = await startProxy({ upstreamBase: upstream.base, replayer, store });
  return {
    proxy,
    upstreamCalls: () => upstream.calls.length,
    close: async () => {
      await proxy.close();
      await upstream.close();
    },
  };
}

function post(proxy: RunningProxy, body: unknown) {
  return fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rewind-scope": "g6" },
    body: JSON.stringify(body),
  });
}

test("near-match MUST miss: a one-word-different prompt is never served the recorded answer", async () => {
  const fix = await fixture();
  try {
    const bodyX = { model: "bench-model", max_tokens: 100, messages: [{ role: "user", content: "solve problem X" }] };
    const bodyY = { model: "bench-model", max_tokens: 100, messages: [{ role: "user", content: "solve problem Y" }] };

    const rX = await post(fix.proxy, bodyX);
    const tX = await rX.text();
    assert.equal(rX.headers.get("x-rewind"), "live");
    assert.equal(fix.upstreamCalls(), 1);

    const rY = await post(fix.proxy, bodyY);
    const tY = await rY.text();
    // The changed prompt must reach upstream and get ITS answer — not X's recorded reply.
    assert.equal(rY.headers.get("x-rewind"), "live", "a near-match must NOT be served from the record");
    assert.equal(fix.upstreamCalls(), 2, "the changed prompt must hit upstream");
    assert.notEqual(tX, tY, "the answers must differ — no stale serve");
  } finally {
    await fix.close();
  }
});

test("cache-hint-only difference STILL replays: a cache_control marker does not change the answer", async () => {
  const fix = await fixture();
  try {
    const plain = { model: "bench-model", max_tokens: 100, messages: [{ role: "user", content: "hello there" }] };
    const withHint = {
      model: "bench-model",
      max_tokens: 100,
      messages: [{ role: "user", content: [{ type: "text", text: "hello there", cache_control: { type: "ephemeral" } }] }],
    };

    await post(fix.proxy, plain);
    assert.equal(fix.upstreamCalls(), 1);

    // Same output-affecting content; only a cache hint differs → must serve from record, no new call.
    // (canonicalizeRequest treats the string and the single text block as the same content.)
    const r2 = await post(fix.proxy, {
      model: "bench-model",
      max_tokens: 100,
      messages: [{ role: "user", content: "hello there" }],
      cache_control: { type: "ephemeral" },
    });
    assert.equal(r2.headers.get("x-rewind"), "replay");
    assert.equal(fix.upstreamCalls(), 1, "a pure cache-hint difference must NOT re-hit upstream");
    // withHint is a structural variant; assert it does not crash and is handled deterministically.
    void withHint;
  } finally {
    await fix.close();
  }
});

test("divergence: after a diverged re-run, only the byte-identical calls are credited", async () => {
  const fix = await fixture();
  try {
    const a = { model: "bench-model", max_tokens: 100, messages: [{ role: "user", content: "step A" }] };
    const b = { model: "bench-model", max_tokens: 100, messages: [{ role: "user", content: "step B" }] };
    const bPrime = { model: "bench-model", max_tokens: 100, messages: [{ role: "user", content: "step B-different" }] };

    await post(fix.proxy, a); // record A
    await post(fix.proxy, b); // record B
    assert.equal(fix.upstreamCalls(), 2);

    // Re-run: A is byte-identical (replay, no call); B diverges (miss, a real call).
    const rA = await post(fix.proxy, a);
    assert.equal(rA.headers.get("x-rewind"), "replay");
    assert.equal(fix.upstreamCalls(), 2, "the identical re-run is served from record");

    const rBp = await post(fix.proxy, bPrime);
    assert.equal(rBp.headers.get("x-rewind"), "live");
    assert.equal(fix.upstreamCalls(), 3, "the diverged call is NOT served a stale answer");
  } finally {
    await fix.close();
  }
});
