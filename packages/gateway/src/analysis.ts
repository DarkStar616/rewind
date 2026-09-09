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
   * The request's headers, excluding established auth/local/transport noise, are folded into the
   * replay key. Unknown provider headers and content type remain significant; callers must capture
   * the same header view used by their live gateway, excluding any configured local scope header.
   *
   * Semantics of absence matter: OMITTING this field means the headers are UNKNOWN, and an
   * unknown-headers call is never counted as a replay (it might have differed in a header we cannot see —
   * never over-credit). To have a call count as replayable you must DECLARE its headers, using `{}` to
   * mean "I checked, there are no output-affecting headers."
   */
  headers?: Record<string, string | string[] | undefined>;
  /**
   * The request's ABSOLUTE upstream URL (scheme + host + path [+ query]), exactly as the live gateway
   * sees it — e.g. `"https://api.anthropic.com/v1/messages"`. The origin, pathname and non-auth query are
   * folded into the replay key EXACTLY as the gateway does (proxy.ts `keyUrl`), so two calls are counted
   * as a replay ONLY when their upstream ORIGIN, endpoint/model target (e.g. Gemini's
   * `…/gemini-2.5-pro:generateContent` vs `…:flash`) and wire choice (`?alt=sse`) all match.
   *
   * Absence — or a RELATIVE/origin-less url like `"/v1/messages"` — is treated as UNKNOWN, exactly like
   * an omitted `headers`: the upstream origin cannot be established, and the live gateway namespaces its
   * key by origin (two OpenAI-compatible vendors both speak `/v1/chat/completions`), so a repeat can only
   * be PROVEN when the origin matched too. An unknown-target call is never counted as a replay —
   * over-crediting is the one thing a savings report must never do. Pass the absolute url (the form a
   * proxy access log already records) for the call to be eligible as a replay.
   */
  url?: string;
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
 * The normalized ABSOLUTE href (origin + path + query) if `url` is absolute, else undefined.
 *
 * The live gateway namespaces its replay key by the absolute upstream href (proxy.ts `keyUrl` resolves
 * the request against the upstream base and takes `.href`, which lowercases the host and drops the
 * default port). To key EXACTLY as it does — and never over-credit — the analysis only treats a call as
 * replay-eligible when it carries an absolute url, and normalizes it the same way. A relative/origin-less
 * url leaves the upstream ORIGIN unknown, so a repeat can never be PROVEN to have hit the same vendor;
 * such a call returns undefined here and is keyed as an unknown target (never a replay).
 */
function absoluteHref(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).href; // absolute only — a relative url has no base and throws, matching keyUrl's own parse
  } catch {
    return undefined;
  }
}

/**
 * Analyse a batch of request traffic for replay + prune savings, scope-isolated and provider-priced.
 * Deterministic and side-effect-free — no upstream calls are made; this only reads the supplied bodies.
 */
export function analyzeTraffic(calls: readonly AnalyzedCall[], opts: AnalyzeOptions = {}): SavingsAnalysis {
  const analyzer = createTrafficAnalyzer({ ...opts, sample: "full", maxKeys: Math.max(1, calls.length), maxScopes: Math.max(1, calls.length) });
  for (const call of calls) analyzer.add(call);
  return analyzer.result();
}

export interface TrafficAnalyzerOptions extends AnalyzeOptions {
  /** No sample means no prompt clone/redaction work or retained prompt content. */
  sample?: "none" | "full";
  maxKeys?: number;
  maxScopes?: number;
}
export interface TrafficAnalyzer { add(call: AnalyzedCall): void; result(): SavingsAnalysis }

/** Incremental exact-key analysis. Only bounded key digests/counters survive each add. */
export function createTrafficAnalyzer(opts: TrafficAnalyzerOptions = {}): TrafficAnalyzer {
  const table = opts.priceTable ?? DEFAULT_PRICE_TABLE;
  const sampleMode = opts.sample ?? "none";
  const maxKeys = opts.maxKeys ?? 100_000, maxScopes = opts.maxScopes ?? 1_000;
  for (const limit of [maxKeys, maxScopes]) if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("invalid analysis cardinality limit");
  if (opts.sample !== undefined && opts.sample !== "none" && opts.sample !== "full") throw new Error("invalid analysis sample policy");
  const scopes = new Map<string, ScopeAnalysis>();
  const seen = new Map<string, Set<string>>();
  let keyCount = 0, sampled = false, sample: unknown;
  let totals: AnalysisTotals = { calls: 0, replayableCalls: 0, avoidedTokens: 0, avoidedCostMicros: 0, pruneCharsSaved: 0 };
  return {
    add(c) {
      if (!c || typeof c !== "object" || typeof c.scope !== "string") throw new Error("invalid analysis call/scope");
      if (c.usage !== undefined && (!c.usage || typeof c.usage !== "object" || Array.isArray(c.usage))) throw new Error("invalid analysis usage");
      for (const field of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const) {
        const count = c.usage?.[field];
        if (count !== undefined && (!Number.isSafeInteger(count) || count < 0)) throw new Error("invalid analysis usage");
      }
      if (!Number.isSafeInteger(totalUsageTokens(c.usage ?? {}))) throw new Error("invalid analysis usage");
      if (c.headers !== undefined) {
        if (!c.headers || typeof c.headers !== "object" || Array.isArray(c.headers) ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(c.headers)) ||
            Object.values(c.headers).some((value) => value !== undefined && typeof value !== "string" &&
              !(Array.isArray(value) && value.every((part) => typeof part === "string")))) {
          throw new Error("invalid analysis headers");
        }
      }
      const existing = scopes.get(c.scope);
      if (!existing && scopes.size >= maxScopes) throw new Error("analysis scope cardinality limit exceeded");
      const href = absoluteHref(c.url);
      // Unknown headers/origin cannot prove equality and never occupy the digest index.
      const key = c.headers === undefined || href === undefined ? undefined : canonicalizeRequest(c.body, c.headers, href);
      const repeated = key !== undefined && seen.get(c.scope)?.has(key) === true;
      if (key !== undefined && !repeated && keyCount >= maxKeys) throw new Error("analysis key cardinality limit exceeded");
      const delta = {
        calls: 1, replayableCalls: repeated ? 1 : 0,
        avoidedTokens: repeated ? totalUsageTokens(c.usage ?? {}) : 0,
        avoidedCostMicros: repeated ? avoidedCostMicros(c.usage ?? {}, c.model ?? "", table) : 0,
        pruneCharsSaved: pruneToolOutputs(c.body).charsSaved,
      };
      const firstSample = !sampled && sampleMode !== "none"
        ? redactValue(safeClone(c.body), opts.redact ?? DEFAULT_REDACTORS, { path: "$", kind: "request" }) : undefined;
      const next = { ...(existing ?? emptyScope(c.scope)) };
      const nextTotals = { ...totals };
      for (const field of Object.keys(delta) as Array<keyof typeof delta>) {
        if (!Number.isSafeInteger(delta[field]) || delta[field] < 0 || !Number.isSafeInteger(totals[field] + delta[field])) throw new Error("analysis counter limit exceeded");
        next[field] += delta[field];
        nextTotals[field] += delta[field];
      }
      scopes.set(c.scope, next);
      totals = nextTotals;
      if (key !== undefined && !repeated) {
        if (!seen.has(c.scope)) seen.set(c.scope, new Set());
        seen.get(c.scope)!.add(key); keyCount++;
      }
      if (!sampled) { sample = firstSample; sampled = true; }
    },
    result() {
      const perScope = [...scopes.values()].map((scope) => ({ ...scope }));
      const total = { ...totals };
      return { priceTableVersion: table.version, perScope, total, sample: safeClone(sample) };
    },
  };
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
