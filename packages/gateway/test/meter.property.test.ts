import { test } from "node:test";
import assert from "node:assert/strict";

import { avoidedCostMicros, DEFAULT_PRICE_TABLE, type PriceTable } from "../src/meter.ts";
import type { ProviderUsage } from "../src/record-store.ts";

/**
 * Property/fuzz tests for the meter — the billing-critical invariant. The cardinal rule is NEVER
 * over-credit. Across randomized usage we assert: cost is a non-negative integer, it never exceeds the
 * exact real-valued cost (floor, never round-up), it is monotonic in every token field, and zero usage
 * prices to exactly 0.
 */

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randUsage(rng: () => number): ProviderUsage {
  const r = () => Math.floor(rng() * 200_000); // realistic per-call token magnitudes
  return {
    input_tokens: r(),
    output_tokens: r(),
    cache_read_input_tokens: r(),
    cache_creation_input_tokens: r(),
  };
}

const TABLE: PriceTable = {
  version: "prop",
  currency: "USD",
  rates: { m: { input: 3_000_000, output: 15_000_000, cacheWrite: 3_750_000, cacheRead: 300_000 } },
};

/** The exact real-valued cost (no rounding) for comparison. */
function exactCost(u: ProviderUsage, r = TABLE.rates.m): number {
  return (
    ((u.input_tokens ?? 0) * r.input +
      (u.output_tokens ?? 0) * r.output +
      (u.cache_creation_input_tokens ?? 0) * r.cacheWrite +
      (u.cache_read_input_tokens ?? 0) * r.cacheRead) /
    1_000_000
  );
}

test("property: cost is a non-negative integer and NEVER exceeds the exact cost (500 usages)", () => {
  const rng = makeRng(0xbadf00d);
  for (let i = 0; i < 500; i++) {
    const u = randUsage(rng);
    const cost = avoidedCostMicros(u, "m", TABLE);
    assert.equal(Number.isInteger(cost), true, `iter ${i}: not an integer`);
    assert.ok(cost >= 0, `iter ${i}: negative cost`);
    const exact = exactCost(u);
    // Floor, never round-up: the billed micros must be <= the exact real cost, within <1 of it.
    assert.ok(cost <= exact, `iter ${i}: OVER-credited ${cost} > exact ${exact}`);
    assert.ok(exact - cost < 1, `iter ${i}: under-credited by >=1 micro (${exact - cost})`);
  }
});

test("property: cost is monotonic — adding tokens to any field never decreases it (300 usages)", () => {
  const rng = makeRng(0x5eed);
  const fields: (keyof ProviderUsage)[] = [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ];
  for (let i = 0; i < 300; i++) {
    const u = randUsage(rng);
    const base = avoidedCostMicros(u, "m", TABLE);
    for (const f of fields) {
      const more = { ...u, [f]: (u[f] ?? 0) + 1 + Math.floor(rng() * 1000) };
      assert.ok(avoidedCostMicros(more, "m", TABLE) >= base, `iter ${i}: adding ${f} decreased cost`);
    }
  }
});

test("property: zero usage always prices to exactly 0, on any model incl. the shipped default", () => {
  const rng = makeRng(0x0);
  for (let i = 0; i < 100; i++) {
    const model = ["m", "claude-opus-4-8", `unlisted-${i}`][i % 3];
    const table = i % 2 === 0 ? TABLE : DEFAULT_PRICE_TABLE;
    assert.equal(avoidedCostMicros({}, model, table), 0);
    assert.equal(
      avoidedCostMicros(
        { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        model,
        table,
      ),
      0,
    );
    void rng;
  }
});

test("property: the shipped DEFAULT never prices an unlisted model above the most expensive listed one", () => {
  const rng = makeRng(0xabc);
  for (let i = 0; i < 200; i++) {
    const u = randUsage(rng);
    const unlisted = avoidedCostMicros(u, `who-is-${i}`, DEFAULT_PRICE_TABLE);
    const opus = avoidedCostMicros(u, "claude-opus-4-8", DEFAULT_PRICE_TABLE);
    // The conservative default must never over-bill relative to the priciest known model.
    assert.ok(unlisted <= opus, `iter ${i}: default ${unlisted} over-billed vs opus ${opus}`);
  }
});
