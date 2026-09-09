/**
 * replay — Mechanism A ("ours"): a byte-equivalent request after a rewind is served from the record
 * with ZERO upstream call, and the whole recorded token count is booked as avoided.
 *
 * Harvested from qm-athena's `recorded-response-harness.ts`, distilled to the portable core:
 * fingerprint the request → look it up in the caller's scope → on a hit serve the recorded response
 * and book a `ReplaySaving` → on a miss report 'live' so the proxy forwards upstream. The one
 * behaviour that must never regress is athena's hard-fail-on-miss: in strict mode a miss throws
 * rather than silently falling through to a paid call the caller declared it did not want.
 *
 * Pure logic over the request body and the record store: no filesystem, no clock, no network.
 */
import type { ReplaySavingsSink } from "@agent-rewind/core";

import { canonicalizeRequest } from "./canonical-request.ts";
import { totalRecordedTokens, type RecordStore, type RecordedCall } from "./record-store.ts";
import { avoidedCostMicros, DEFAULT_PRICE_TABLE, type PriceTable } from "./meter.ts";

export interface ReplayerOptions {
  /**
   * When true, a miss HARD-FAILS (throws `StrictReplayMissError`) instead of reporting 'live'. Use
   * it when replay is required and a fall-through to a paid upstream call would be a correctness bug
   * (deterministic bench, offline re-run). Off by default.
   */
  strict?: boolean;
  /**
   * The dated price table used to value avoided calls (the billing basis). Defaults to the shipped
   * public-list-price estimate; the billing system passes the customer's real contract rates here.
   */
  priceTable?: PriceTable;
}

export interface ReplayOutcomeReplay {
  served: "replay";
  /** The recorded response payload, served verbatim with no upstream call. */
  response: unknown;
  /** The replayKey the request resolved to. */
  keyed: string;
}

export interface ReplayOutcomeLive {
  served: "live";
  /** The replayKey the request resolved to, so the caller can record the live response under it. */
  keyed: string;
}

export type ReplayOutcome = ReplayOutcomeReplay | ReplayOutcomeLive;

/** Thrown by a strict replayer on a miss: replay was required and no record matched. */
export class StrictReplayMissError extends Error {
  readonly scope: string;
  readonly replayKey: string;
  constructor(scope: string, replayKey: string) {
    super(
      `strict replay: no recorded response for key ${replayKey} in scope "${scope}"; ` +
        "this request diverged from the recording and strict mode refuses to fall back to a paid upstream call",
    );
    this.name = "StrictReplayMissError";
    this.scope = scope;
    this.replayKey = replayKey;
  }
}

export interface Replayer {
  /** Side-effect-free lookup. The transport validates the record, then commits only after choosing
   * replay irrevocably. Optional for compatibility with existing consumer-supplied replayers. */
  prepare?(
    scope: string,
    body: unknown,
    headers?: Record<string, string | string[] | undefined>,
    url?: string,
    validate?: (record: RecordedCall) => boolean,
  ): ReplayOutcome & { commit?: () => void };
  /**
   * Resolve a request body against the record store in the given scope. On a hit: serve the record
   * and book the avoided tokens. On a miss: 'live' (or throw, in strict mode). `headers` supplies the
   * request headers other than established auth/local/transport noise that co-determine the key; `url` supplies
   * the request target whose pathname (query stripped) co-determines the key — essential when the model
   * or the JSON-vs-SSE choice lives in the URL (e.g. Gemini) rather than the body.
   */
  handle(
    scope: string,
    body: unknown,
    headers?: Record<string, string | string[] | undefined>,
    url?: string,
  ): ReplayOutcome;
}

export function createReplayer(
  store: RecordStore,
  savings: ReplaySavingsSink,
  options: ReplayerOptions = {},
): Replayer {
  const strict = options.strict ?? false;
  const priceTable = options.priceTable ?? DEFAULT_PRICE_TABLE;
  const prepare: NonNullable<Replayer["prepare"]> = (scope, body, headers, url, validate) => {
      const keyed = canonicalizeRequest(body, headers, url);
      const recorded = store.get({ scope, replayKey: keyed });
      if (!recorded || (validate && !validate(recorded))) {
        if (strict) throw new StrictReplayMissError(scope, keyed);
        return { served: "live", keyed };
      }
      const saving = {
        scope,
        tokensAvoided: totalRecordedTokens(recorded.usage),
        // The whole upstream call is avoided, so its full cost is the saving — priced per-component
        // from the dated table (the meter). costMicros is 0 only when the provider reported no usage.
        costMicros: avoidedCostMicros(recorded.usage, recorded.model, priceTable),
        model: recorded.model,
        // Content-addressed identity: re-serving the same request in the same scope collapses to
        // one saving, so overlapping rewinds never double-count. (First write wins in the sink.)
        callId: `${scope}\0${keyed}`,
      };
      let committed = false;
      return { served: "replay", response: recorded.response, keyed, commit() {
        if (committed) return;
        // Mark before invoking a consumer sink: a sink may write successfully and then throw.
        committed = true;
        savings.record(saving);
      } };
  };
  return {
    prepare,
    handle(scope, body, headers, url) {
      const outcome = prepare(scope, body, headers, url);
      outcome.commit?.();
      // Preserve the original public result shape and conservative content-addressed accounting.
      return outcome.served === "replay"
        ? { served: "replay", response: outcome.response, keyed: outcome.keyed }
        : { served: "live", keyed: outcome.keyed };
    },
  };
}
