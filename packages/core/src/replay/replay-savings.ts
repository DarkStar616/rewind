// Replay-savings sink — ported from qm-athena's harness/recorded/replay-savings.ts,
// with the qm session-store coupling dropped (no sessionId/turnSeq/replayedAt, no
// durable `list`/postgres backing). This is the clean, portable accounting piece:
// it records how much re-execution a replay cache-hit or a rewind avoided, and totals
// it. `callId` dedupes overlapping rewinds so the same avoided call is never counted
// twice. Costs are carried as integer micro-units (costMicros) to avoid float drift.

export interface ReplaySaving {
  scope: string;
  tokensAvoided: number;
  costMicros: number;
  model: string;
  /** Identity of the avoided call; repeated records with the same callId collapse to one. */
  callId: string;
}

export interface ReplaySavingsTotal {
  tokens: number;
  costMicros: number;
}

export interface ReplaySavingsSink {
  record(saving: ReplaySaving): void;
  /** Sum of distinct-by-callId savings; scoped when a scope is given, else across all scopes. */
  total(scope?: string): ReplaySavingsTotal;
}

export function createMemoryReplaySavings(): ReplaySavingsSink {
  // Keyed by callId so an overlapping rewind that re-reports the same avoided call
  // does not double-count. First write wins.
  const byCallId = new Map<string, ReplaySaving>();
  return {
    record(saving) {
      if (byCallId.has(saving.callId)) return;
      byCallId.set(saving.callId, { ...saving });
    },
    total(scope) {
      let tokens = 0;
      let costMicros = 0;
      for (const s of byCallId.values()) {
        if (scope !== undefined && s.scope !== scope) continue;
        tokens += s.tokensAvoided;
        costMicros += s.costMicros;
      }
      return { tokens, costMicros };
    },
  };
}
