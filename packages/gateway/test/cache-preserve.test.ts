import { test } from "node:test";
import assert from "node:assert/strict";

import { createMemoryReplaySavings } from "@rewind/core";

import { planCacheBreakpoints, meterCachePreservation, hasCacheControl } from "../src/cache-preserve.ts";
import type { PriceTable } from "../src/meter.ts";
import { createMemoryRecordStore } from "../src/record-store.ts";
import { createReplayer } from "../src/replay.ts";
import { startProxy } from "../src/proxy.ts";
import { manualClock, startMockUpstream } from "../bench/mock-upstream.ts";

/**
 * Mechanism B (cache-preservation) helps a harness that sets no cache_control by marking the static
 * prefix — but it NEVER overrides an agent's own caching, and it credits a Mechanism-B saving only
 * when it injected a breakpoint AND the provider then reported a cache read.
 */

const TABLE: PriceTable = {
  version: "cp-test",
  currency: "USD",
  rates: { m: { input: 3_000_000, output: 15_000_000, cacheWrite: 3_750_000, cacheRead: 300_000 } },
};

test("injects a breakpoint on the last tool when the agent set none", () => {
  const body = {
    model: "m",
    tools: [{ name: "a" }, { name: "b" }],
    messages: [{ role: "user", content: "hi" }],
  };
  const plan = planCacheBreakpoints(body);
  assert.equal(plan.injected, true);
  assert.equal(plan.reason, "injected-on-tools");
  const tools = plan.body.tools as Array<Record<string, unknown>>;
  assert.equal(tools[1].cache_control !== undefined, true, "last tool marked");
  assert.equal(tools[0].cache_control, undefined, "only the last tool marked");
  // The input body was not mutated.
  assert.equal((body.tools[1] as Record<string, unknown>).cache_control, undefined);
});

test("injects on system when there are no tools", () => {
  const plan = planCacheBreakpoints({ model: "m", system: "You are helpful.", messages: [] });
  assert.equal(plan.injected, true);
  assert.equal(plan.reason, "injected-on-system");
  const system = plan.body.system as Array<Record<string, unknown>>;
  assert.equal(Array.isArray(system), true, "string system normalised to blocks");
  assert.equal(system[system.length - 1].cache_control !== undefined, true);
});

test("respects an agent's existing cache_control — changes nothing, claims nothing", () => {
  const body = {
    model: "m",
    tools: [{ name: "a", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  };
  const plan = planCacheBreakpoints(body);
  assert.equal(plan.injected, false);
  assert.equal(plan.reason, "agent-controlled");
  assert.equal(plan.body, body, "unchanged body reference");
});

test("no cacheable prefix (no tools, no system) → no injection", () => {
  const plan = planCacheBreakpoints({ model: "m", messages: [{ role: "user", content: "hi" }] });
  assert.equal(plan.injected, false);
  assert.equal(plan.reason, "no-cacheable-prefix");
});

test("hasCacheControl finds a nested marker", () => {
  assert.equal(hasCacheControl({ a: { b: [{ cache_control: {} }] } }), true);
  assert.equal(hasCacheControl({ a: { b: [{ text: "x" }] } }), false);
});

test("meter: 0 unless we injected AND the provider reported a cache read", () => {
  // Not injected → 0 even with a big cache read.
  assert.equal(meterCachePreservation({ cache_read_input_tokens: 100000 }, false, "m", TABLE).costMicros, 0);
  // Injected but no cache read → 0.
  assert.equal(meterCachePreservation({ cache_read_input_tokens: 0 }, true, "m", TABLE).costMicros, 0);
  // Injected + warm read → discount = tokens × (input - cacheRead) / 1e6.
  const credit = meterCachePreservation({ cache_read_input_tokens: 1_000_000 }, true, "m", TABLE);
  // (3_000_000 - 300_000) per 1e6 tokens × 1e6 tokens / 1e6 = 2_700_000 µUSD.
  assert.equal(credit.costMicros, 2_700_000);
  assert.equal(credit.creditedTokens, 1_000_000);
  assert.equal(credit.priceTableVersion, "cp-test");
});

test("end-to-end: preserveCache marks the forwarded request so the provider warms the prefix", async () => {
  const upstream = await startMockUpstream({ clock: manualClock(0), cacheMode: "explicit" });
  const store = createMemoryRecordStore();
  const replayer = createReplayer(store, createMemoryReplaySavings());
  const proxy = await startProxy({ upstreamBase: upstream.base, replayer, store, preserveCache: true });
  try {
    // Two DIFFERENT requests that share a static tools prefix (so no replay; only cache-preservation).
    const mk = (q: string) => ({
      model: "m",
      tools: [{ name: "search", description: "a stable tool used every turn" }],
      messages: [{ role: "user", content: q }],
    });
    const post = (b: unknown) =>
      fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rewind-scope": "cp" },
        body: JSON.stringify(b),
      }).then((r) => r.text());

    await post(mk("first question"));
    await post(mk("second question")); // same tools prefix, different message

    // The forwarded bytes carried a cache_control marker (the gateway injected it).
    assert.equal(upstream.calls.length, 2, "both distinct requests reached upstream (no false replay)");
    // The provider warmed the shared tools+system prefix on the second call.
    assert.equal(upstream.calls[1].warm, true, "the second call hit the warm cache the gateway set up");
    assert.ok(upstream.calls[1].cacheReadTokens > 0, "cache-read tokens were reported on the warm call");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});

test("end-to-end: with preserveCache OFF, no breakpoint is added (strict byte-transparency)", async () => {
  const upstream = await startMockUpstream({ clock: manualClock(0), cacheMode: "explicit" });
  const store = createMemoryRecordStore();
  const replayer = createReplayer(store, createMemoryReplaySavings());
  const proxy = await startProxy({ upstreamBase: upstream.base, replayer, store }); // preserveCache default false
  try {
    const mk = (q: string) => ({
      model: "m",
      tools: [{ name: "search" }],
      messages: [{ role: "user", content: q }],
    });
    const post = (b: unknown) =>
      fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rewind-scope": "cp" },
        body: JSON.stringify(b),
      }).then((r) => r.text());

    await post(mk("q1"));
    await post(mk("q2"));
    // Without an injected breakpoint the mock (which credits only EXPLICIT breakpoints via
    // cache_control) reports no warm hit — the byte-transparent path leaves caching entirely to the agent.
    assert.equal(upstream.calls[1].warm, false, "no gateway-injected caching when preserveCache is off");
  } finally {
    await proxy.close();
    await upstream.close();
  }
});
