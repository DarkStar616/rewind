// The hard-to-game "billable saved tokens" definition (RIP-LIST #8).
//
// Billable = tokens the agent DID re-issue as a byte-equivalent request and we served from record,
// chain-logged as a realized replay. A counterfactual / hypothetical "would-have" call is NEVER
// credited: it is structurally absent from the savings list — there is no record to pass in. This is
// the published contractual basis of a "saved call" for the gainshare model, and it is deliberately
// conservative: it dedupes by callId (an overlapping rewind that re-reports the same avoided call
// counts ONCE, matching createMemoryReplaySavings) and FLOORS every figure (never rounds up), so the
// customer is billed no more than was demonstrably earned.
//
// Pure function over realized-replay records; no clock, no filesystem, no provider network. The
// aggregate reconciliation against the provider's own bill lives in reconcile.ts (#6); this module
// only defines what WE attest as billable from the chain-logged replays.

import type { ReplaySaving } from "@rewind/core";

export interface BillableSavings {
  /** Total avoided input+output tokens over distinct realized replays, floored. */
  billableTokens: number;
  /** Total avoided cost in integer micro-units over distinct realized replays, floored. */
  billableCostMicros: number;
  /** Count of distinct realized replays (deduped by callId) that make up the billable figure. */
  realizedReplays: number;
}

/**
 * Sum the realized replay savings into the billable figure. Records are deduped by `callId`
 * (first-seen wins), so the same avoided call reported by two overlapping rewinds is one billable
 * event. Figures are floored — a fractional input can only ever reduce the bill, never inflate it.
 */
export function billableSavedTokens(savings: readonly ReplaySaving[]): BillableSavings {
  const seen = new Set<string>();
  let tokens = 0;
  let costMicros = 0;
  for (const s of savings) {
    if (seen.has(s.callId)) continue; // distinct-by-callId — never double-bill an overlapping rewind
    seen.add(s.callId);
    tokens += s.tokensAvoided;
    costMicros += s.costMicros;
  }
  return {
    billableTokens: Math.floor(tokens),
    billableCostMicros: Math.floor(costMicros),
    realizedReplays: seen.size,
  };
}
