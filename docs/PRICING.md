# Rewind pricing decision — gainshare on verified savings

Decision record. Derived from the competitive scan (`deep-prospect-log.md`, `RIP-LIST.md` #3) and the
ProsperOps-vs-nOps contrast. This is a positioning + go-to-market decision; the metered basis and the
trust anchor it references are already built.

## The decision

**Lead with a pure percentage of verified token savings.** Rewind charges a share of the savings it
can *prove* it delivered — nothing else, by default. This is the maximum-alignment model: Rewind only
makes money when the customer demonstrably spends less, and the amount is derived from a tamper-evident
record, not an invoice line the customer has to take on faith.

- **Metered basis:** `billableSavedTokens` (`packages/gateway/src/billable.ts`). Billable = tokens the
  agent *did* re-issue as a byte-equivalent request and Rewind served from record, chain-logged as a
  realized replay. Deduped by `callId`, floored, and **counterfactuals are structurally
  unrepresentable** — there is no "would-have" record to pass in, so a hypothetical saving can never be
  billed. See the module for the exact definition.
- **Trust anchor:** `reconcileAgainstProviderBill` (`packages/gateway/src/reconcile.ts`). The billable
  figure is reconciled against the aggregate the customer's own provider (Anthropic/OpenAI) bills for
  the period. The chain attests the individual events; the provider's bill bounds the aggregate. A
  claim that exceeds the provider's own reported total is flagged, never silently credited.
- **Prove-then-charge:** the Free Savings Analysis (`analyzeTraffic` + `attestAnalysis`, the
  `rewind analyze` subcommand) produces a **hash-attested, redacted report** of replayable savings
  *before any contract*. The customer verifies the report against their own bill; the trust barrier for
  a novel pricing model collapses because the number is checkable, not asserted.

## What we will NOT do

- **No percent-of-total-LLM-spend floor.** This is the nOps "feels like a tax" churn trigger: charging
  a fraction of a bill the customer would pay anyway, whether or not Rewind saved anything, breaks the
  alignment that is the entire wedge. A percent-of-spend component is a hard skip (`RIP-LIST.md`).
- **No crediting counterfactual saved calls.** Only realized, chain-logged replays count. Crediting
  calls the agent never actually re-issued forfeits the defensibility the tamper-evident chain buys us.
- **Never round up.** Every figure floors (`avoidedCostMicros`, `billableSavedTokens`). A savings meter
  that flatters itself is unbillable the first time a customer audits it.

## If revenue stability is needed

Some customers/investors want a predictable floor. If so, add a **small fixed platform or per-seat fee,
kept strictly separate from the savings share** — a line item for the software, not a fraction of spend.
This preserves alignment (the variable part is still pure gainshare) while smoothing revenue. The fixed
fee must be visibly independent of the customer's LLM bill; the moment it scales with spend it becomes
the tax we are avoiding.

## Audit rights

Publish the `billableSavedTokens` formula and pre-negotiate audit rights in the contract: the customer
(or their auditor) can re-run `verifyChain` over the evidence chain and reconcile against their provider
bill at any time. The billing basis is a published definition backed by a verifiable artifact, not a
black box — that is the whole point of anchoring gainshare to a hash chain.

## Honest framing

Tell customers and investors exactly what the guarantee is: **"you pay a share of the token savings we
can prove on your own provider's bill, verifiable by a tamper-evident log you can check yourself."** Do
not overclaim precision we do not have — provider APIs report aggregates, not per-call provenance (see
`reconcile.ts`), so the honest claim is "chain attests events, bill attests the aggregate," never "the
provider certifies each saved call."
