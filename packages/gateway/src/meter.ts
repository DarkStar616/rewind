/**
 * meter — turns a provider-reported usage block into an avoided-cost figure, the billing basis.
 *
 * The discipline that makes this honest and auditable:
 *
 *   - **Only the provider's own numbers.** Every token count comes from the upstream `usage` object.
 *     Nothing here estimates tokens from text length; a metering that guessed token counts locally
 *     would be unverifiable and un-billable. If the provider reported nothing, we bill nothing.
 *   - **Per-component rates.** Input, output, cache-write and cache-read are priced separately because
 *     they differ by ~50× (cache-read is a tenth of input; output is 5× input). A single blended rate
 *     would systematically mis-price and is only fit for the free-tier receipt's rough estimate.
 *   - **Mechanism A prices the WHOLE avoided call.** A replay serves the response locally with zero
 *     upstream traffic, so every token the recorded call would have processed — including whatever it
 *     would have paid at the cache-read rate — is genuinely avoided. `avoidedCostMicros` is exactly the
 *     cost the upstream call would have incurred.
 *   - **Dated + versioned.** The table carries a `version` (the date its public rates were captured),
 *     and `meterAvoidance` stamps that version on every record. Public list prices drift and differ
 *     from a customer's contract rates; the billing system overrides this table with the real rates,
 *     and the stamped version is the provenance of whatever number was booked.
 *
 * Integer arithmetic throughout: rates are micro-USD per MILLION tokens (integers), so the only
 * rounding is the single final divide — no float drift accumulates across a month of records.
 */
import type { ProviderUsage } from "./record-store.ts";

/**
 * Per-component rates in **micro-USD per 1,000,000 tokens** (integers). Because 1 USD = 1e6 micro-USD,
 * a public "$X per MTok" figure is exactly `X * 1_000_000` here (e.g. $0.80/MTok → 800_000).
 */
export interface ComponentRates {
  /** Uncached input tokens (`usage.input_tokens`). */
  input: number;
  /** Output tokens (`usage.output_tokens`). */
  output: number;
  /** Cache-write tokens (`usage.cache_creation_input_tokens`). */
  cacheWrite: number;
  /** Cache-read tokens (`usage.cache_read_input_tokens`), the cheapest component. */
  cacheRead: number;
}

export interface PriceTable {
  /** The date the public rates in this table were captured — provenance, stamped on every record. */
  version: string;
  currency: "USD";
  /** Rates by model id. `default` prices any model not listed; a table with no `default` bills 0 for
   *  an unknown model rather than guessing. */
  rates: Readonly<Record<string, ComponentRates>>;
}

/**
 * A conservative, dated public-list-price table, marked ESTIMATE. The billing system OVERRIDES this
 * with each customer's real contract rates; this exists so the deterministic bench and the free-tier
 * receipt have a defensible default. Figures are public list prices captured on the `version` date.
 * The `default` row is deliberately the CHEAPEST plausible model, so an unknown model under-bills
 * rather than over-bills — a savings meter must never flatter itself.
 */
export const DEFAULT_PRICE_TABLE: PriceTable = {
  version: "2026-08-18",
  currency: "USD",
  rates: {
    // Anthropic public list prices (per MTok), captured 2026-08-18. cache-write is the 5m-TTL 1.25×
    // write rate; cache-read is the 0.1× read rate.
    "claude-opus-4-8": { input: 15_000_000, output: 75_000_000, cacheWrite: 18_750_000, cacheRead: 1_500_000 },
    "claude-sonnet-4-5": { input: 3_000_000, output: 15_000_000, cacheWrite: 3_750_000, cacheRead: 300_000 },
    "claude-haiku-4-5": { input: 1_000_000, output: 5_000_000, cacheWrite: 1_250_000, cacheRead: 100_000 },
    // Conservative default = the cheapest tier, so unknown models under-bill, never over-bill.
    default: { input: 1_000_000, output: 5_000_000, cacheWrite: 1_250_000, cacheRead: 100_000 },
  },
};

/** Resolve the rates for a model, falling back to the table's `default`. `undefined` if neither exists. */
function ratesFor(model: string, table: PriceTable): ComponentRates | undefined {
  return table.rates[model] ?? table.rates.default;
}

/**
 * The micro-USD an avoided (replayed) call would have cost upstream = each provider-reported token
 * field priced at its component rate. Zero/absent usage → exactly 0 (the golden-negative). Never
 * estimates tokens; prices only what the provider reported. Integer micro-USD (rounded once).
 */
export function avoidedCostMicros(
  usage: ProviderUsage,
  model: string,
  table: PriceTable = DEFAULT_PRICE_TABLE,
): number {
  const r = ratesFor(model, table);
  if (!r) return 0;
  // Each term: tokens × (micro-USD per 1e6 tokens). Sum stays an exact integer (safe < 2^53 for any
  // realistic monthly volume), divided by 1e6 exactly once at the end.
  const microTimesMillion =
    (usage.input_tokens ?? 0) * r.input +
    (usage.output_tokens ?? 0) * r.output +
    (usage.cache_creation_input_tokens ?? 0) * r.cacheWrite +
    (usage.cache_read_input_tokens ?? 0) * r.cacheRead;
  return Math.round(microTimesMillion / 1_000_000);
}

/** Total tokens across every provider-reported field — the ownable "tokens avoided" number. */
export function totalUsageTokens(usage: ProviderUsage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/** A fully-metered avoidance record: the ownable token count, the priced cost, and the table version
 *  that produced it (provenance for the bill). */
export interface MeteredAvoidance {
  tokensAvoided: number;
  costMicros: number;
  priceTableVersion: string;
}

/**
 * Meter one avoided call end to end: count tokens, price them, and stamp the price-table version.
 * This is what a booked ReplaySaving's cost should come from.
 */
export function meterAvoidance(
  usage: ProviderUsage,
  model: string,
  table: PriceTable = DEFAULT_PRICE_TABLE,
): MeteredAvoidance {
  return {
    tokensAvoided: totalUsageTokens(usage),
    costMicros: avoidedCostMicros(usage, model, table),
    priceTableVersion: table.version,
  };
}
