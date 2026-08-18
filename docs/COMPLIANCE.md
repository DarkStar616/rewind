# Rewind and tamper-evident logging (EU AI Act Article 12 framing)

Positioning note, not a legal opinion. Derived from `RIP-LIST.md` #4. Frames a primitive Rewind
**already ships** — the append-only SHA-256 evidence chain — in the language of the EU AI Act's
automatic-logging requirement. It does not add code and does not claim certified compliance.

## The primitive we already have

`packages/core/src/audit/evidence-ledger.ts` implements an append-only, hash-linked event log:

- Each entry carries `seq`, `prevHash`, and a `hash` = SHA-256 over the entry's canonicalized contents
  (`computeEntryHash`), linked to its predecessor; genesis is a fixed zero hash.
- `verifyChain` walks the chain and returns `{ ok, brokenAtSeq?, reason? }` — any edit to a recorded
  entry, any reordering, any broken link, or any structurally-invalid entry is detected, and
  verification **fails closed** (a re-hash that would throw is reported as a broken chain, never crashes
  the verdict).
- The chain is what records the effect barrier's refuse-and-record decisions, so a spent effect
  re-fired across a rewind leaves a verifiable, tamper-evident trace.

## The Article 12 framing

Article 12 of the EU AI Act requires certain high-risk AI systems to **automatically record events
("logs") over their lifetime**, with the logs being appropriate to the system's purpose and supporting
traceability. The engineering primitive that requirement calls for is exactly a tamper-evident,
append-only log with an integrity check — which is what the evidence chain is.

Rewind's surface for this:

- **Seal → root digest.** Any set of events (including the Free Savings Analysis report, via
  `attestAnalysis`) folds into the chain and produces a root hash that fixes the content.
- **Verify → pass | fail.** `verifyChain` re-derives every hash and reports pass/fail with the first
  broken sequence — a third party can independently confirm the log has not been altered since sealing.
- **Concrete export.** `rewind analyze <json>` emits a hash-attested, redacted report whose
  `verified: true/false` field is exactly this check; the same mechanism attests effect-barrier events.

## What we do NOT claim

- **Not certified compliance.** We provide a *tamper-evident logging primitive suitable for Art. 12-style
  automatic logging*, verified by our own tests — not a certification, not legal advice, and not a claim
  that deploying Rewind makes a system Art. 12-compliant. Compliance is a property of the whole system
  and its operator, assessed by a competent body; a log integrity primitive is one input to that.
- **Not "two AI vendors" as independence.** The real assurance is deterministic tests + the SHA-256
  construction + a human auditor re-running `verifyChain`, exactly as with billing (see `PRICING.md`).

## Honest summary

"Rewind ships an append-only SHA-256 evidence chain with a fail-closed `verifyChain`, a tamper-evident
logging primitive suitable for EU AI Act Article 12-style automatic logging and independently checkable
by anyone holding the log — we verify it with our own tests and do not claim certified compliance."
