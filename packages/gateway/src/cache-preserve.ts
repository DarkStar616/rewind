/**
 * cache-preserve — Mechanism B, kept strictly separate from Mechanism A (replay) so nothing is ever
 * double-counted.
 *
 * The observation: many agent harnesses never set `cache_control` on their requests, so the provider
 * re-reads the entire static prefix (system + tools) at FULL input price on every turn. Anthropic's
 * cache is explicit — no breakpoint, no caching. The gateway can place one ephemeral breakpoint on the
 * stable prefix so that prefix is cached once and re-read at the 0.1× rate thereafter.
 *
 * Two honesty rules:
 *   1. **Never override the agent.** If the request already carries ANY `cache_control`, we change
 *      nothing and claim nothing — the agent is managing its own caching and the saving is theirs.
 *   2. **Credit only what the gateway CAUSED.** `meterCachePreservation` books a Mechanism-B saving
 *      only when we injected a breakpoint AND the provider then reported a cache read; the credit is
 *      the discount those cached tokens got versus full input price. Otherwise it is exactly 0.
 *
 * The breakpoint we inject does NOT affect the replay key (canonicalizeRequest strips cache_control),
 * so Mechanism A is unchanged whether preservation is on or off.
 */
import type { ProviderUsage } from "./record-store.ts";
import type { PriceTable, ComponentRates } from "./meter.ts";
import { DEFAULT_PRICE_TABLE } from "./meter.ts";

const EPHEMERAL: { type: "ephemeral" } = { type: "ephemeral" };

/** Deep-scan a value for any `cache_control` marker (the agent's own caching, which we must respect). */
export function hasCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCacheControl);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("cache_control" in o) return true;
    return Object.values(o).some(hasCacheControl);
  }
  return false;
}

export interface CachePlan {
  /** The request body to forward — a breakpoint-annotated copy, or the original if we left it alone. */
  body: Record<string, unknown>;
  /** True iff the gateway added a breakpoint the request did not have. */
  injected: boolean;
  /** Why we did or didn't inject — for logging and honesty. */
  reason: "agent-controlled" | "injected-on-tools" | "injected-on-system" | "no-cacheable-prefix";
}

/** Attach an ephemeral cache_control to the last tool (tools are identical every turn — an ideal prefix). */
function annotateLastTool(tools: unknown[]): unknown[] {
  const copy = tools.map((t) => (t && typeof t === "object" ? { ...(t as object) } : t));
  const last = copy[copy.length - 1];
  if (last && typeof last === "object") (last as Record<string, unknown>).cache_control = EPHEMERAL;
  return copy;
}

/** Normalise `system` (string OR block array) to a block array with the final block cache-marked. */
function annotateSystem(system: unknown): unknown {
  const blocks = typeof system === "string" ? [{ type: "text", text: system }] : Array.isArray(system) ? [...system] : null;
  if (!blocks || blocks.length === 0) return system;
  const copy = blocks.map((b) => (b && typeof b === "object" ? { ...(b as object) } : b));
  const last = copy[copy.length - 1];
  if (last && typeof last === "object") (last as Record<string, unknown>).cache_control = EPHEMERAL;
  return copy;
}

/**
 * Decide where (if anywhere) to place a cache breakpoint on an outgoing request. Respects an agent's
 * existing caching; otherwise marks the static prefix (tools preferred, else system). Returns a COPY;
 * the input is never mutated.
 */
export function planCacheBreakpoints(body: Record<string, unknown>): CachePlan {
  if (hasCacheControl(body)) return { body, injected: false, reason: "agent-controlled" };

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return { body: { ...body, tools: annotateLastTool(body.tools) }, injected: true, reason: "injected-on-tools" };
  }
  if (body.system !== undefined) {
    const annotated = annotateSystem(body.system);
    if (annotated !== body.system) {
      return { body: { ...body, system: annotated }, injected: true, reason: "injected-on-system" };
    }
  }
  return { body, injected: false, reason: "no-cacheable-prefix" };
}

function ratesFor(model: string, table: PriceTable): ComponentRates | undefined {
  return table.rates[model] ?? table.rates.default;
}

export interface CachePreservationCredit {
  /** The Mechanism-B saving in micro-USD: the discount the injected breakpoint earned this call. */
  costMicros: number;
  /** The cache-read tokens that discount was computed over (0 when nothing was credited). */
  creditedTokens: number;
  priceTableVersion: string;
}

/**
 * The honest Mechanism-B credit for one call: the discount the gateway's injected breakpoint earned,
 * versus the same tokens at full input price. ZERO unless we injected AND the provider reported a
 * cache read. `(input_rate - cacheRead_rate)` is the per-token saving; anything ≤ 0 (misconfigured
 * table) clamps to 0 so a saving can never go negative.
 */
export function meterCachePreservation(
  usage: ProviderUsage,
  injected: boolean,
  model: string,
  table: PriceTable = DEFAULT_PRICE_TABLE,
): CachePreservationCredit {
  const version = table.version;
  if (!injected) return { costMicros: 0, creditedTokens: 0, priceTableVersion: version };
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  if (cacheRead <= 0) return { costMicros: 0, creditedTokens: 0, priceTableVersion: version };
  const r = ratesFor(model, table);
  if (!r) return { costMicros: 0, creditedTokens: 0, priceTableVersion: version };
  const perTokenDiscount = Math.max(0, r.input - r.cacheRead); // µUSD per 1e6 tokens
  return {
    // FLOOR, not round — a billed saving must never round a fractional micro UP (see meter.ts).
    costMicros: Math.floor((cacheRead * perTokenDiscount) / 1_000_000),
    creditedTokens: cacheRead,
    priceTableVersion: version,
  };
}
