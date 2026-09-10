import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemoryReplaySavings } from "@agent-rewind/core";

import { canonicalizeRequest } from "../src/canonical-request.ts";
import { createMemoryRecordStore, type RecordedCall } from "../src/record-store.ts";
import { createReplayer, StrictReplayMissError } from "../src/replay.ts";

/**
 * The replayer sits between the caller and the paid upstream. On a byte-equivalent request whose
 * record exists in the caller's scope it serves the recorded response with ZERO upstream call and
 * books a ReplaySaving for the whole recorded token count. On a miss it reports 'live' so the proxy
 * forwards upstream — unless strict mode is on, in which case a miss HARD-FAILS rather than silently
 * paying for a call the caller declared it did not want.
 */

function requestBody(text = "What is the weather in Paris?"): Record<string, unknown> {
  return {
    model: "claude-opus-4-8",
    max_tokens: 1024,
    messages: [{ role: "user", content: text }],
  };
}

function recordedCall(): RecordedCall {
  return {
    response: { id: "msg_1", role: "assistant", content: [{ type: "text", text: "It is sunny." }] },
    usage: {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 300,
    },
    model: "claude-opus-4-8",
  };
}

test("prepared replay has no accounting side effect until its idempotent commit", () => {
  const store = createMemoryRecordStore();
  const savings = createMemoryReplaySavings();
  const body = requestBody();
  store.put({ scope: "s", replayKey: canonicalizeRequest(body) }, recordedCall());
  let writes = 0;
  const replayer = createReplayer(store, { total: savings.total, record(s) { writes++; savings.record(s); } });
  const prepared = replayer.prepare!("s", body);
  assert.equal(prepared.served, "replay");
  assert.equal(savings.total().tokens, 0);
  prepared.commit?.();
  prepared.commit?.();
  assert.equal(writes, 1);
  assert.equal(savings.total().tokens, 6500);
});

// A fixed price table (µUSD per 1e6 tokens) so the booked cost is hand-checkable and independent of
// whatever the shipped DEFAULT table's list prices are on any given day.
const TEST_PRICES = {
  version: "test",
  currency: "USD" as const,
  rates: {
    "claude-opus-4-8": { input: 1_000_000, output: 5_000_000, cacheWrite: 1_250_000, cacheRead: 100_000 },
  },
};
// recordedCall @ TEST_PRICES: (1000·1M + 200·5M + 300·1.25M + 5000·0.1M)/1e6 = 2875 µUSD.
const RECORDED_CALL_COST = 2875;

test("a miss reports served:'live' and books NO savings", () => {
  const store = createMemoryRecordStore();
  const savings = createMemoryReplaySavings();
  const replayer = createReplayer(store, savings);

  const body = requestBody();
  const outcome = replayer.handle("scope-a", body);

  assert.equal(outcome.served, "live");
  assert.equal(outcome.keyed, canonicalizeRequest(body));
  assert.equal("response" in outcome, false);
  assert.deepEqual(savings.total(), { tokens: 0, costMicros: 0 });
});

test("a hit serves the recorded response and books tokensAvoided = recorded total", () => {
  const store = createMemoryRecordStore();
  const savings = createMemoryReplaySavings();
  const replayer = createReplayer(store, savings, { priceTable: TEST_PRICES });

  const body = requestBody();
  const call = recordedCall();
  store.put({ scope: "scope-a", replayKey: canonicalizeRequest(body) }, call);

  const outcome = replayer.handle("scope-a", body);

  assert.equal(outcome.served, "replay");
  assert.equal(outcome.keyed, canonicalizeRequest(body));
  assert.deepEqual(outcome.served === "replay" ? outcome.response : undefined, call.response);
  // 1000 + 200 + 5000 + 300 = 6500 tokens avoided; cost is the whole avoided call priced per-component.
  assert.deepEqual(savings.total("scope-a"), { tokens: 6500, costMicros: RECORDED_CALL_COST });
});

test("re-serving the SAME request in a scope does not double-count (content-addressed callId)", () => {
  const store = createMemoryRecordStore();
  const savings = createMemoryReplaySavings();
  const replayer = createReplayer(store, savings, { priceTable: TEST_PRICES });

  const body = requestBody();
  store.put({ scope: "scope-a", replayKey: canonicalizeRequest(body) }, recordedCall());

  replayer.handle("scope-a", body);
  replayer.handle("scope-a", body);

  assert.deepEqual(savings.total("scope-a"), { tokens: 6500, costMicros: RECORDED_CALL_COST });
});

test("cross-scope NEVER serves: a record in scope-a is a miss for scope-b", () => {
  const store = createMemoryRecordStore();
  const savings = createMemoryReplaySavings();
  const replayer = createReplayer(store, savings);

  const body = requestBody();
  store.put({ scope: "scope-a", replayKey: canonicalizeRequest(body) }, recordedCall());

  const outcome = replayer.handle("scope-b", body);

  assert.equal(outcome.served, "live");
  assert.deepEqual(savings.total(), { tokens: 0, costMicros: 0 });
});

test("strict mode HARD-FAILS on a miss instead of silently paying", () => {
  const store = createMemoryRecordStore();
  const savings = createMemoryReplaySavings();
  const replayer = createReplayer(store, savings, { strict: true });

  assert.throws(() => replayer.handle("scope-a", requestBody()), StrictReplayMissError);
  // A hard-fail must not have booked a phantom saving.
  assert.deepEqual(savings.total(), { tokens: 0, costMicros: 0 });
});

test("strict mode still serves a hit normally", () => {
  const store = createMemoryRecordStore();
  const savings = createMemoryReplaySavings();
  const replayer = createReplayer(store, savings, { strict: true, priceTable: TEST_PRICES });

  const body = requestBody();
  store.put({ scope: "scope-a", replayKey: canonicalizeRequest(body) }, recordedCall());

  const outcome = replayer.handle("scope-a", body);
  assert.equal(outcome.served, "replay");
  assert.deepEqual(savings.total("scope-a"), { tokens: 6500, costMicros: RECORDED_CALL_COST });
});
