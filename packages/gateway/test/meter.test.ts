import { test } from "node:test";
import assert from "node:assert/strict";

import {
  avoidedCostMicros,
  meterAvoidance,
  totalUsageTokens,
  DEFAULT_PRICE_TABLE,
  type PriceTable,
} from "../src/meter.ts";
import type { ProviderUsage } from "../src/record-store.ts";

/**
 * The meter prices the provider's OWN reported usage at a dated, per-component, versioned table. It
 * never estimates tokens locally, prices every component separately, reports exactly 0 when nothing
 * was avoided, and stamps the table version on every record so a booked cost carries its provenance.
 */

// A tiny, exact table so the arithmetic can be checked by hand. Rates are micro-USD per 1e6 tokens.
const TEST_TABLE: PriceTable = {
  version: "test-2026-01-01",
  currency: "USD",
  rates: {
    "model-x": { input: 800_000, output: 4_000_000, cacheWrite: 1_000_000, cacheRead: 80_000 },
    default: { input: 100_000, output: 500_000, cacheWrite: 125_000, cacheRead: 10_000 },
  },
};

test("a versioned/snapshot model id resolves to its base family rate, not the cheap default", () => {
  const u: ProviderUsage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  // OpenAI snapshot: gpt-4o-2024-08-06 must price as gpt-4o ($2.50/MTok input), not the $0.25 default.
  assert.equal(avoidedCostMicros(u, "gpt-4o-2024-08-06", DEFAULT_PRICE_TABLE), 2_500_000);
  // gpt-4.1-2025-04-14 → gpt-4.1 ($2.00/MTok).
  assert.equal(avoidedCostMicros(u, "gpt-4.1-2025-04-14", DEFAULT_PRICE_TABLE), 2_000_000);
  // Gemini snapshot number: gemini-2.5-flash-002 → gemini-2.5-flash ($0.30/MTok input).
  assert.equal(avoidedCostMicros(u, "gemini-2.5-flash-002", DEFAULT_PRICE_TABLE), 300_000);
});

test("normalization never crosses a non-numeric family suffix (mini stays mini, flash stays flash)", () => {
  const u: ProviderUsage = { input_tokens: 1_000_000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  // gpt-4o-mini-2024-07-18 must resolve to gpt-4o-mini ($0.15), NOT gpt-4o ($2.50) — the date strips,
  // but `mini` (non-numeric) halts the strip, so the cheaper mini family is preserved.
  assert.equal(avoidedCostMicros(u, "gpt-4o-mini-2024-07-18", DEFAULT_PRICE_TABLE), 150_000);
  // An entirely unknown family still floors to the conservative default, never a wrong (dearer) family.
  assert.equal(avoidedCostMicros(u, "some-unknown-model-99", DEFAULT_PRICE_TABLE), 250_000);
});

test("golden-negative: zero/empty usage prices to EXACTLY 0", () => {
  assert.equal(avoidedCostMicros({}, "model-x", TEST_TABLE), 0);
  assert.equal(
    avoidedCostMicros(
      { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      "model-x",
      TEST_TABLE,
    ),
    0,
  );
});

test("component math is hand-checkable and prices each field at its own rate", () => {
  // input 1_000_000 @ 0.80 = 800_000µ ; output 100_000 @ 4.00 = 400_000µ ;
  // cacheWrite 200_000 @ 1.00 = 200_000µ ; cacheRead 5_000_000 @ 0.08 = 400_000µ. Total = 1_800_000µ.
  const usage: ProviderUsage = {
    input_tokens: 1_000_000,
    output_tokens: 100_000,
    cache_creation_input_tokens: 200_000,
    cache_read_input_tokens: 5_000_000,
  };
  assert.equal(avoidedCostMicros(usage, "model-x", TEST_TABLE), 1_800_000);
});

test("cache-read is priced far below input — the components are NOT blended", () => {
  const asRead = avoidedCostMicros({ cache_read_input_tokens: 1_000_000 }, "model-x", TEST_TABLE);
  const asInput = avoidedCostMicros({ input_tokens: 1_000_000 }, "model-x", TEST_TABLE);
  assert.equal(asRead, 80_000); // 1e6 @ 0.08
  assert.equal(asInput, 800_000); // 1e6 @ 0.80
  assert.equal(asInput, asRead * 10); // exactly the 10× read discount, proving separate rates
});

test("an unknown model falls back to the table's `default` rates", () => {
  const usage: ProviderUsage = { input_tokens: 1_000_000 };
  assert.equal(avoidedCostMicros(usage, "never-heard-of-it", TEST_TABLE), 100_000); // default input rate
});

test("a table with NO default bills 0 for an unknown model rather than guessing", () => {
  const noDefault: PriceTable = {
    version: "v0",
    currency: "USD",
    rates: { "model-x": { input: 800_000, output: 4_000_000, cacheWrite: 1_000_000, cacheRead: 80_000 } },
  };
  assert.equal(avoidedCostMicros({ input_tokens: 1_000_000 }, "unknown", noDefault), 0);
});

test("NEVER estimates tokens locally: a huge text body with no usage numbers prices to 0", () => {
  // The meter takes a usage object, not a request body — but prove the property directly: absent
  // provider counts mean absent cost, no matter how large the underlying content would be.
  const usage: ProviderUsage = {}; // provider reported nothing
  assert.equal(avoidedCostMicros(usage, "model-x", TEST_TABLE), 0);
});

test("totalUsageTokens sums every reported field and treats missing as zero", () => {
  assert.equal(
    totalUsageTokens({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 }),
    1255,
  );
  assert.equal(totalUsageTokens({ output_tokens: 7 }), 7);
  assert.equal(totalUsageTokens({}), 0);
});

test("meterAvoidance stamps the price-table version on every record", () => {
  const m = meterAvoidance({ input_tokens: 1_000_000 }, "model-x", TEST_TABLE);
  assert.equal(m.priceTableVersion, "test-2026-01-01");
  assert.equal(m.tokensAvoided, 1_000_000);
  assert.equal(m.costMicros, 800_000);
});

test("the shipped DEFAULT table is dated and its default under-bills relative to a premium model", () => {
  assert.match(DEFAULT_PRICE_TABLE.version, /^\d{4}-\d{2}-\d{2}$/);
  const usage: ProviderUsage = { input_tokens: 1_000_000, output_tokens: 1_000_000 };
  const opus = avoidedCostMicros(usage, "claude-opus-4-8", DEFAULT_PRICE_TABLE);
  const unknown = avoidedCostMicros(usage, "some-unlisted-model", DEFAULT_PRICE_TABLE);
  // Conservative default must never price an unknown model ABOVE a known premium one.
  assert.ok(unknown < opus, `default ${unknown} should under-bill vs opus ${opus}`);
});

test("integer arithmetic stays exact at a realistic monthly volume (no float drift)", () => {
  // 2 billion cache-read tokens over a month @ 0.08/MTok = $160 = 160_000_000µ, exactly.
  const cost = avoidedCostMicros({ cache_read_input_tokens: 2_000_000_000 }, "model-x", TEST_TABLE);
  assert.equal(cost, 160_000_000);
  assert.equal(Number.isInteger(cost), true);
});
