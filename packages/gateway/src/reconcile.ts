// Provider-bill reconciliation adapter (RIP-LIST #6, the ProsperOps "as determined by your provider's
// billing system" trust anchor).
//
// The gainshare model must be defensible against the customer's OWN provider bill. This reconciles our
// chain-attested billable savings (billableSavedTokens, #8) against the aggregate the provider
// independently reports for the same period, and flags any case where our claim exceeds that baseline.
//
// HONEST LIMIT — read before extending: provider usage/cost APIs (Anthropic, OpenAI) report AGGREGATE
// billed tokens per key over a period, NOT per-call provenance. So this adapter can prove "the chain
// attests these individual replay events, and their total is consistent with the aggregate the provider
// billed" — it CANNOT make the provider certify each saved call one by one. Position it exactly that
// way: the chain attests the events, the bill attests the aggregate. Never claim the provider certifies
// each avoided call. The pure `reconcileAgainstProviderBill` takes the provider number directly so it is
// testable without network; the `ProviderUsageFetcher` type is the seam a real (async, networked)
// adapter implements.

import type { ReplaySaving } from "@agent-rewind/core";
import { billableSavedTokens } from "./billable.ts";

export interface ReconciliationReport {
  /** Our chain-attested billable tokens (deduped, floored) — see billableSavedTokens. */
  billableTokens: number;
  /** Our chain-attested billable cost in micro-USD. */
  billableCostMicros: number;
  /** Count of distinct realized replays behind the billable figure. */
  realizedReplays: number;
  /** The aggregate tokens the provider independently reports for the period (the baseline). */
  providerBaselineTokens: number;
  /**
   * True when our billable claim is within the provider-attested baseline. A coarse AGGREGATE sanity
   * bound, not a per-call certification: a claim larger than the provider's own reported total for the
   * period cannot be vouched for and is flagged rather than silently credited.
   */
  withinBill: boolean;
}

/** The seam a real, networked provider-usage adapter implements (Anthropic/OpenAI usage & cost API). */
export type ProviderUsageFetcher = (period: { since: string; until: string }) => Promise<number>;

/** A provider baseline is only usable if it is a finite, non-negative token count; otherwise treat it
 *  as zero, which fails closed (any positive claim is then flagged rather than vouched for). */
function usableBaseline(providerBilledTokens: number): number {
  return Number.isFinite(providerBilledTokens) && providerBilledTokens > 0 ? providerBilledTokens : 0;
}

/**
 * Reconcile chain-attested billable savings against the provider's independently-reported aggregate.
 * Pure and synchronous — the provider number is passed in (fetch it with a ProviderUsageFetcher).
 */
export function reconcileAgainstProviderBill(
  savings: readonly ReplaySaving[],
  providerBilledTokens: number,
): ReconciliationReport {
  const billable = billableSavedTokens(savings);
  const baseline = usableBaseline(providerBilledTokens);
  return {
    billableTokens: billable.billableTokens,
    billableCostMicros: billable.billableCostMicros,
    realizedReplays: billable.realizedReplays,
    providerBaselineTokens: baseline,
    withinBill: billable.billableTokens <= baseline,
  };
}
