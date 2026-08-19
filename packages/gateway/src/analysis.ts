// Free Savings Analysis mode + hash-attested report (RIP-LIST #7, the ProsperOps "prove-then-charge"
// funnel done the Rewind way).
//
// Point the analysis at a batch of recent/live request traffic (in shadow, no upstream calls) and it
// answers, verifiably: how many of your calls were BYTE-REPLAYABLE (a later request in a scope whose
// canonical replay key already appeared — i.e. the second time the agent issued the same call), what
// that would have cost at the provider's own token rates, and how much deterministic tool-output
// pruning would additionally save. The result is folded into a ONE-ENTRY tamper-evident hash chain
// (the exact same chain primitive the effect ledger uses — NOT a second implementation) so the report
// is `verifyChain`-checkable by the customer before any contract exists.
//
// Honesty rails:
//   - Only genuine REPEATS are avoidable. The first occurrence of a key must still be issued once, so
//     it is never counted as a saving — counting first occurrences would inflate the figure.
//   - Scope-isolated, exactly like the record store: an identical body in a different scope is not a hit.
//   - Provider's own numbers only (avoidedCostMicros floors; see meter.ts). Never estimates tokens.
//   - The surfaced sample is REDACTED (redact.ts) so a shared report never leaks a customer prompt/key.
// Pure and deterministic: no clock, no random, no network. attestAnalysis injects at:0 and a fixed
// correlationId so the same analysis always attests to the same root hash.

import { canonicalizeRequest } from "./canonical-request.ts";
import { pruneToolOutputs } from "./prune.ts";
import { avoidedCostMicros, totalUsageTokens, DEFAULT_PRICE_TABLE, type PriceTable } from "./meter.ts";
import { redactValue, DEFAULT_REDACTORS, type RedactFn } from "./redact.ts";
import type { ProviderUsage } from "./record-store.ts";
import { computeEntryHash, GENESIS_HASH, type AuditEntry, type UnhashedEntry } from "@agent-rewind/core";

/** One observed request in the traffic sample: which scope it belongs to, its body, and its usage. */
export interface AnalyzedCall {
  scope: string;
  body: unknown;
  usage: ProviderUsage;
  model: string;
  /**
   * The request's headers. The output-affecting subset (`anthropic-version`, `anthropic-beta` — see
   * canonical-request.ts KEY_HEADERS) is folded into the replay key exactly as the live gateway does, so
   * two calls with the same body but a different API version/beta are NOT counted as a replay.
   *
   * Semantics of absence matter: OMITTING this field means the headers are UNKNOWN, and an
   * unknown-headers call is never counted as a replay (it might have differed in a header we cannot see —
   * never over-credit). To have a call count as replayable you must DECLARE its headers, using `{}` to
   * mean "I checked, there are no output-affecting headers."
   */
  headers?: Record<string, string | string[] | undefined>;
}

export interface ScopeAnalysis {
  scope: string;
  /** Total calls observed in this scope. */
  calls: number;
  /** Calls that repeat an earlier canonical key in this scope (the byte-replayable ones). */
  replayableCalls: number;
  /** Provider-reported tokens the replayable calls would have re-processed (the avoidable tokens). */
  avoidedTokens: number;
  /** Floored micro-USD those avoided tokens would have cost at the price table's rates. */
  avoidedCostMicros: number;
  /** Chars deterministic tool-output pruning would remove across this scope's bodies (independent lever). */
  pruneCharsSaved: number;
}

export interface AnalysisTotals {
  calls: number;
  replayableCalls: number;
  avoidedTokens: number;
  avoidedCostMicros: number;
  pruneCharsSaved: number;
}

export interface SavingsAnalysis {
  /** Provenance: which price-table version produced the cost figures. */
  priceTableVersion: string;
  /** Per-scope breakdown, in first-seen scope order (deterministic). */
  perScope: ScopeAnalysis[];
  total: AnalysisTotals;
  /** A redacted copy of the first observed call's body — a safe-to-share illustration, or undefined. */
  sample?: unknown;
}

export interface AnalyzeOptions {
  /** Redactor for the surfaced sample. Default: DEFAULT_REDACTORS. */
  redact?: RedactFn;
  /** Price table for the cost figures. Default: DEFAULT_PRICE_TABLE. */
  priceTable?: PriceTable;
}

const emptyScope = (scope: string): ScopeAnalysis => ({
  scope,
  calls: 0,
  replayableCalls: 0,
  avoidedTokens: 0,
  avoidedCostMicros: 0,
  pruneCharsSaved: 0,
});

/**
 * Analyse a batch of request traffic for replay + prune savings, scope-isolated and provider-priced.
 * Deterministic and side-effect-free — no upstream calls are made; this only reads the supplied bodies.
 */
export function analyzeTraffic(calls: readonly AnalyzedCall[], opts: AnalyzeOptions = {}): SavingsAnalysis {
  const table = opts.priceTable ?? DEFAULT_PRICE_TABLE;
  const redact = opts.redact ?? DEFAULT_REDACTORS;

  const scopes = new Map<string, ScopeAnalysis>();
  const order: string[] = [];
  const seenByScope = new Map<string, Set<string>>();

  let callIndex = -1;
  for (const c of calls) {
    callIndex += 1;
    let scope = scopes.get(c.scope);
    if (!scope) {
      scope = emptyScope(c.scope);
      scopes.set(c.scope, scope);
      order.push(c.scope);
      seenByScope.set(c.scope, new Set());
    }
    scope.calls += 1;

    // A call whose headers are UNKNOWN (the field is absent) cannot be PROVEN byte-replayable: two such
    // calls may have differed in an output-affecting header (anthropic-version / anthropic-beta) that the
    // live gateway keys on but we cannot see here. Give it a key that can never match another call, so it
    // is never counted as a replay — over-crediting is the one thing a savings report must never do. A
    // call that DECLARES its headers (even `{}` = "I checked, no output-affecting headers") is keyed
    // normally and can match. The `unknown-headers:` key can never collide with a 64-hex canonical key.
    const key = c.headers === undefined ? `unknown-headers:${callIndex}` : canonicalizeRequest(c.body, c.headers);
    const seen = seenByScope.get(c.scope)!;
    if (seen.has(key)) {
      // A byte-replayable repeat: the whole upstream call is avoidable on replay. A malformed call
      // missing `usage` (untyped CLI/JSON input) is treated as zero usage — the honest under-count
      // direction (avoids nothing) rather than a crash.
      const usage = c.usage ?? {};
      scope.replayableCalls += 1;
      scope.avoidedTokens += totalUsageTokens(usage);
      scope.avoidedCostMicros += avoidedCostMicros(usage, c.model ?? "", table);
    } else {
      seen.add(key); // first occurrence — must still be issued once, never counted as a saving
    }

    // Prune savings are an independent, per-call lever (dedupe within one body), summed across the scope.
    scope.pruneCharsSaved += pruneToolOutputs(c.body).charsSaved;
  }

  const perScope = order.map((s) => scopes.get(s)!);
  const total = perScope.reduce<AnalysisTotals>(
    (acc, s) => ({
      calls: acc.calls + s.calls,
      replayableCalls: acc.replayableCalls + s.replayableCalls,
      avoidedTokens: acc.avoidedTokens + s.avoidedTokens,
      avoidedCostMicros: acc.avoidedCostMicros + s.avoidedCostMicros,
      pruneCharsSaved: acc.pruneCharsSaved + s.pruneCharsSaved,
    }),
    { calls: 0, replayableCalls: 0, avoidedTokens: 0, avoidedCostMicros: 0, pruneCharsSaved: 0 },
  );

  const sample =
    calls.length > 0
      ? redactValue(safeClone(calls[0].body), redact, { path: "$", kind: "request" })
      : undefined;

  return { priceTableVersion: table.version, perScope, total, sample };
}

/** Deep-clone a JSON-ish value so redaction never touches the caller's input; non-JSON falls through. */
function safeClone(value: unknown): unknown {
  try {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
}

export interface AttestedAnalysis {
  analysis: SavingsAnalysis;
  /** A one-entry evidence chain over the analysis, verifiable with `verifyChain`. */
  chain: AuditEntry[];
  /** The root digest — the single entry's SHA-256 hash. Stable for a given analysis. */
  rootHash: string;
}

/**
 * Fold an analysis into a one-entry tamper-evident chain using the SAME hash primitive as the effect
 * ledger (computeEntryHash) — no second chain implementation. Deterministic: at:0 and a fixed
 * correlationId, so an unchanged analysis always yields the same root hash, and any later edit to the
 * analysis breaks `verifyChain`.
 */
export function attestAnalysis(analysis: SavingsAnalysis): AttestedAnalysis {
  const unhashed: UnhashedEntry = {
    scopeLabel: "analysis",
    seq: 0,
    prevHash: GENESIS_HASH,
    action: "savings_analysis",
    actorId: null,
    objectId: null,
    detail: analysis,
    onBehalfOf: null,
    authorityChain: [],
    at: 0, // injected — the pure path has no clock
    correlationId: "savings-analysis", // fixed — deterministic attestation
  };
  const hash = computeEntryHash(unhashed);
  const entry: AuditEntry = { ...unhashed, hash };
  return { analysis, chain: [entry], rootHash: hash };
}
