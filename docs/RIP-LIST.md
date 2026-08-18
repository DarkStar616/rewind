# Rewind — rip-list (what to harvest from the competitive scan)

Derived 2026-08-18 from the competitive `/deep-prospect` (see `deep-prospect-log.md`) via a 4-agent
verify-and-synthesize workflow. Every item is graded against **what Rewind already ships**, so nothing
here re-builds the moat. Sacred invariant throughout: **exact-replay determinism**.

## Direct answer: "can we add agenticstash in as well?"

**Study its design; import ZERO code; do NOT add it as a dependency.** agenticstash
(`@takk/agenticstash`, Apache-2.0) is a ~1★, single-commit, solo-maintainer v1.0.0 SDK whose core —
replay-by-substitution, SHA-256 seal, fork/diff — **all duplicate our moat** (Mechanism A replay,
`packages/core` `verifyChain`, `recovery/backtrack`) and is an *in-process* library that would not
compose with our HTTP-proxy architecture. A second implementation of our correctness-critical replay +
hash chain would violate one-real-implementation discipline. What we take is **three pure design/frame
ideas, re-derived in our own code**: the record-time redaction API shape, the typed divergence-report
taxonomy, and the EU AI Act Art. 12 framing for our existing chain. (Apache-2.0, so even studying it is
obligation-free once we write our own implementation.)

## Build now — correctness + the gainshare funnel

| # | Rip | Source | Take | Effort | Note |
|---|-----|--------|------|--------|------|
| 1 | **Rollback-safe two-phase restore** | Cline (Apache-2.0, model only) | Capture the current worktree into an implicit Rewind snapshot *before* a destructive restore; on `read-tree`/`clean` failure auto-roll-back instead of leaving a half-applied tree. All-or-nothing rewind. | S–M | **VERIFIED real gap:** `git-backend.ts:252-271` throws `RevertIndeterminateError` with no rollback today. `snapshot()` already exists → capture is nearly free. Zero tension with exact-replay. Capture into Rewind's own chain, not the user repo's git. |
| 2 | **Record-time redaction hook** (`RedactFn` + `DROP` sentinel) | agenticstash (design only) | `redact(value,{kind}) => value \| DROP` applied to recorded bodies before they hit disk. | S (design-gated) | `record-store.ts` persists full request/response bodies with **no redaction** — tapes carry API keys/PII/prompts. **Tension to resolve first:** redacting the primary tape breaks byte-exact replay. Resolve by redacting only the shareable *analysis/report export* copy + encrypting the full replay tape at rest; never redact the replay key or primary tape. **Unblocks the Free Savings Analysis funnel (#7).** |
| 7 | **Free Savings Analysis funnel** | ProsperOps | Read-only "analysis mode": point the fail-open proxy at recent/live traffic in shadow, replay-match + prune-simulate, emit a **hash-attested report** ("X% of your calls were byte-replayable, $ figure, verifiable against your own bill") *before any contract*. | M | Prove-then-charge collapses the trust barrier for a novel pricing model. High reuse — proxy/record-store/canonical-request/prune/meter/verifyChain already supply everything; missing piece is analysis mode + report artifact. **Depends on #2** to be safe on customer prompts. |

## Pricing & positioning — free decisions, mostly no code

| # | Rip | Source | Take | Effort |
|---|-----|--------|------|--------|
| 3 ✅ | **Lead with pure %-of-verified-savings** — DECIDED, see [PRICING.md](PRICING.md) | ProsperOps vs nOps | Pure %-of-verified-savings = maximal alignment and our strongest wedge. If revenue stability is needed, add a small **fixed platform/seat fee kept separate** from the savings share — **never a percent-of-spend floor** (the "feels like a tax" churn trigger). | S |
| 4 ✅ | **EU AI Act Art. 12 framing** for the existing chain — DECIDED, see [COMPLIANCE.md](COMPLIANCE.md) | agenticstash | Frame our append-only SHA-256 chain as the tamper-evident primitive Art. 12 automatic-logging calls for; `seal→root-digest` / `verify→pass\|fail` export surface. Framing only — we already ship a stronger `verifyChain`. Don't overclaim certified compliance. | S |
| 6 | **Provider-bill reconciliation adapter** | ProsperOps ("as determined by your provider's billing system") | Reconcile the meter's floored per-call figure against the Anthropic/OpenAI Usage & Cost API as the *billable authority*: chain attests *which* calls were served-from-record/pruned; the provider bill bounds the aggregate $ delta. | M |
| 8 | **Publish a hard-to-game "billable saved tokens" baseline** + audit rights | ProsperOps "Base Savings" + Vendr | Billable = tokens the agent *did* re-issue as a byte-equivalent request and we served from record, chain-logged. Credit **only realized replays, never counterfactuals.** Publish the formula; pre-negotiate audit rights. | M |

> **meter.ts already anchors per-call token counts to the provider's own usage block and floors** — so
> #6/#8 are an *aggregate reconciliation + published-definition* layer on top, not a new meter. Honest
> limit: provider usage APIs report aggregate billed tokens per key, not per-call provenance → position
> as "chain attests events, bill attests the aggregate," never "the provider certifies each saved call."

## Design ideas — small, soon

| # | Rip | Source | Take | Effort |
|---|-----|--------|------|--------|
| 5 | **Per-op throwaway `GIT_INDEX_FILE` for snapshots** (retire the mutex) | Cline | Build snapshot trees in an env-scoped temp index so a snapshot never locks/mutates the real index; feed large untracked sets via NUL-delimited `--pathspec-from-file`. Removes the `index.lock` race `git-backend.ts:~205` currently serializes with a mutex. **Temp index must still honor our excludes** or it captures secrets. | S |
| 9 | **Tape-vs-tape typed divergence report** | agenticstash (taxonomy only) | Typed report: `input-mismatch` / `extra-call` / `missing-call` + `firstDivergence` + collect-all mode. Turns a failed replay into a debuggable object; supports the gainshare audit story. Their alignment code targets an in-process model — taxonomy ports, code does not. | M |
| 10 | **`tool_use_id` as a secondary effect-correlation axis** | HumanLayer (model only) | Key each gated/spent effect to the Anthropic `tool_use_id` as a cheap exact per-call identity, alongside the canonical hash. **Never** trust `tool_use_id` as sole identity for the chain — the SHA-256 canonical hash stays authoritative. | S |
| 11 | **Structured deny-reason fed back to the agent on refusal** | HumanLayer (model only) | When the barrier refuses a spent effect, return a structured reason ("effect already spent before rewind; do not re-fire") as the tool result so the agent adapts. Plugs into `packages/core/recovery`. Take only the deny-reason half, not HumanLayer's auto-approve/skip-permissions state. | S |

## Deliberately deferred (considered, not now)

- **#12 Per-session namespaced snapshot refs + GC** (Cline) — enables concurrent sessions, but must preserve our append-only "history survives restore" differentiator and never GC a ref the chain references. Defer until concurrent-session demand is real.
- **#13 Externally-ratified "Effective Token Savings Rate" metric** (FinOps ESR) — durable category-ownership positioning, but standards-body ratification is slow and outside our control. Ship the self-published formula first; don't gate billing on ratification.
- **#14 Human-approval gate tier whose decision is chain-recorded** (HumanLayer) — a genuine differentiator and natural upsell, but a **new product surface** that violates the MVP prime directive ("don't pull later phases forward"). Must live *above* the pure core; a blocking human gate inside the replay path would break exact-replay. Post-MVP tier.

## Hard skips (don't do these)

- agenticstash **replay-by-substitution engine**, **SHA-256 seal code**, **fork-with-override code**, **runtime dependency**, **edge-runtime target** — all duplicate our moat or add competitor supply-chain risk for no gain.
- Cline **stash-into-user-repo** backend — our separate side git-dir works in *any* workspace; keep that advantage.
- nOps **percent-of-spend floor** as default; **charging a % of total LLM spend**; **crediting counterfactual saved calls the agent never re-issued** — each forfeits the alignment or the defensibility that is the whole point.
- HumanLayer **auto-approve / skip-permissions policy state inside the core** — session state, not replayable input; leaking it into the replay/barrier path breaks exact-replay.

## Recommended next slice

**Build #1 (rollback-safe two-phase restore) first.** Smallest self-contained change that directly
hardens the product's central promise — an atomic rewind that never leaves a half-applied worktree —
which today genuinely fails. Ports cleanly from Cline (model only), `snapshot()` already exists, zero
tension with exact-replay. Then **#2 (redaction)** immediately after with its byte-exact tension called
out, since it unblocks the entire Free Savings Analysis gainshare funnel (#7).
