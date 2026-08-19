/**
 * The savings receipt (Slice 1.5) — the ONE honest metering surface, shared by both adapters:
 * the `rewind savings` CLI command and the `savings` MCP tool. Per docs/ARCHITECTURE.md there is one
 * engine and thin adapters, so the receipt math lives here ONCE and both adapters call it; neither
 * re-derives it.
 *
 * Honesty is the entire value (docs/SAVINGS-RECEIPT.md). "Saved" = tokens that would PROVABLY have
 * been re-spent and were not — only replay cache-hits and rewind-avoided re-executions recorded as
 * ReplaySaving entries, deduped by the recorded call identity (the sink dedupes by `callId`). It is
 * NEVER the whole cost of a rewound failed run, never wall-clock or "productivity", and never the
 * provider's own prompt-cache discount (that is the user's, from their provider). If in doubt, report
 * less: a conservative real number is a category we own; an inflated one is discredited the first time
 * an engineering manager divides it by their actual invoice.
 *
 * MVP scope (stated, not hidden): the only metering path wired in the MVP is the replay cache-hit
 * sink, so every metered token is a replay hit and the rewind-avoided subtotal is honestly 0 — it
 * lights up when the execution-recording provider lands (a later slice), which is also why the local
 * sink is process-lifetime and the durable, time-windowed receipt is deferred. The `window` label is
 * carried through for the shareable line; it does not (yet) filter by time, so it is a label only.
 */
import type { ReplaySavingsTotal } from "@agent-rewind/core";

export type Currency = "USD";

/** Where the saved tokens came from. Both are provably-avoided re-spend; never a whole-run projection. */
export interface SavingsBreakdown {
  /** Tokens avoided by a replay cache-hit (a recorded turn returned with modelCalls:0). */
  replayHits: number;
  /** Tokens avoided by re-execution served from a real recorded prior after a rewind. 0 in the MVP. */
  rewindAvoided: number;
}

export interface SavingsReceipt {
  tokensSaved: number;
  /** Avoided cost in `currency` units, from the RECORDED per-call cost (an estimate — see `estimate`). */
  costSaved: number;
  currency: Currency;
  /** A human label for the reporting window (e.g. "week", "all-time"). A label only in the MVP. */
  window: string;
  breakdown: SavingsBreakdown;
  /** Cost is priced from a static per-model rate table and is therefore an estimate, never a bill. */
  estimate: true;
}

export interface BuildSavingsReceiptOptions {
  /** The window label to stamp on the receipt. Default: "all-time". */
  window?: string;
}

/** Micro-USD (1e-6 USD) per token, per model. ESTIMATE ONLY, and overridable at every call site. */
export interface ModelRate {
  microsPerToken: number;
}

/**
 * A small static rate table, marked ESTIMATE and overridable. Blended micro-USD per token — a rough
 * public-pricing figure, deliberately conservative, NOT a bill. Callers pass their own table to price
 * accurately; unknown models fall back to `default`.
 */
export const DEFAULT_MODEL_RATES: Readonly<Record<string, ModelRate>> = {
  "claude-3-5-sonnet": { microsPerToken: 6 },
  "claude-3-5-haiku": { microsPerToken: 1 },
  "claude-3-opus": { microsPerToken: 30 },
  "gpt-4o": { microsPerToken: 5 },
  "gpt-4o-mini": { microsPerToken: 1 },
  default: { microsPerToken: 5 },
};

/** Estimate the micro-USD a given token count is worth for `model`. Estimate; overridable via `rates`. */
export function estimateCostMicros(
  model: string,
  tokens: number,
  rates: Readonly<Record<string, ModelRate>> = DEFAULT_MODEL_RATES,
): number {
  const rate = rates[model] ?? rates.default ?? { microsPerToken: 0 };
  return Math.round(tokens * rate.microsPerToken);
}

/**
 * Build the honest receipt from a ReplaySavings total (already deduped-by-callId inside the sink).
 * `tokensSaved` is the summed avoided tokens; `costSaved` is the summed RECORDED avoided cost
 * (micro-USD → USD, no rounding here so it reconciles exactly with the underlying records). In the
 * MVP every metered token is a replay cache-hit, so `breakdown.replayHits === tokensSaved` and
 * `breakdown.rewindAvoided === 0`; the two always sum to `tokensSaved`.
 */
export function buildSavingsReceipt(
  total: ReplaySavingsTotal,
  opts: BuildSavingsReceiptOptions = {},
): SavingsReceipt {
  const tokensSaved = total.tokens;
  return {
    tokensSaved,
    costSaved: total.costMicros / 1_000_000,
    currency: "USD",
    window: opts.window ?? "all-time",
    breakdown: { replayHits: tokensSaved, rewindAvoided: 0 },
    estimate: true,
  };
}

/** Compact, shareable token count: 4_200_000 -> "4.2M", 1_200 -> "1.2k", 500 -> "500", 0 -> "0". */
export function formatTokens(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return trimZero(n / 1_000_000) + "M";
  if (abs >= 1_000) return trimZero(n / 1_000) + "k";
  return String(Math.round(n));
}

function trimZero(v: number): string {
  // One decimal place, with a trailing ".0" trimmed (4.0M -> "4M", 4.2M -> "4.2M").
  const s = v.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** Dollars for the human line: whole/near-whole amounts print plainly ("63"); tiny amounts keep 2 sig figs. */
export function formatDollars(d: number): string {
  if (d === 0) return "0";
  if (d >= 1) return String(Math.round(d * 100) / 100); // to the cent; a whole dollar prints as "63"
  return d.toPrecision(2); // sub-dollar: keep 2 significant figures so a real-but-tiny figure survives
}

/** The shareable line: `Rewind recovered <N> tokens this <window> (~$<X> saved).` */
export function formatReceiptLine(receipt: SavingsReceipt): string {
  const phrase = receipt.window === "all-time" ? "so far" : `this ${receipt.window}`;
  return `Rewind recovered ${formatTokens(receipt.tokensSaved)} tokens ${phrase} (~$${formatDollars(
    receipt.costSaved,
  )} saved).`;
}

/** The paid team-view savings dashboard (the only account-gated surface). */
export const TEAM_VIEW_LINK = "https://rewind.dev/team";

/** Cumulative-lifetime token threshold that unlocks the single upsell line. Overridable per call. */
export const DEFAULT_UPSELL_THRESHOLD_TOKENS = 1_000_000;

/**
 * The ONE upsell ask in the free, local product: shown only once cumulative lifetime savings cross the
 * threshold, and never otherwise. Returns the line, or null when below threshold (so callers append
 * nothing). Nothing else in the local product asks for an account.
 */
export function upsellLine(
  lifetimeTokens: number,
  threshold: number = DEFAULT_UPSELL_THRESHOLD_TOKENS,
  link: string = TEAM_VIEW_LINK,
): string | null {
  if (lifetimeTokens < threshold) return null;
  return `You've recovered ${formatTokens(lifetimeTokens)} tokens total. See your whole team's savings → ${link}`;
}
