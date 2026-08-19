# Deliberately deferred rips (#12–#14)

Decision record. These three were considered in the competitive scan (`RIP-LIST.md`) and **deliberately
not built now** — each for a specific reason, each with a concrete trigger that would un-defer it. This
file exists so the decision is remembered, not silently rediscovered. Deferring is a choice with a
rationale; it is not a backlog.

## #12 — Per-session namespaced snapshot refs + GC (source: Cline)

**What it is.** Give each concurrent agent session its own namespaced snapshot refs and garbage-collect
old ones, so several sessions can checkpoint/rewind the same workspace without stepping on one shared
`refs/heads/main` chain.

**Why deferred.** The MVP git backend serialises all snapshot/restore through one in-process queue and
keeps a single append-only chain; that is correct and simple for the single-session case the MVP
targets. Concurrent-session support is real work with real hazards, and there is no demand for it yet.

**Un-defer trigger.** Real concurrent-session demand — more than one agent operating the same workspace
at once. **Constraints that must hold when built:** preserve the append-only *"history survives restore"*
differentiator (a restore must never move or drop a ref), and **never GC a ref the evidence chain
references** — collecting a snapshot the chain points at would break verification. Namespacing must not
reintroduce the cross-instance temp-index/ref races the current design already guards (see
`git-backend.ts`).

## #13 — Externally-ratified "Effective Token Savings Rate" metric (source: FinOps ESR)

**What it is.** A standards-body-ratified metric name for the savings rate, for durable category
ownership (the way FinOps ratified "Effective Savings Rate" for cloud commitments).

**Why deferred.** Standards-body ratification is slow and outside our control; gating anything on it
would stall delivery. We already ship the substance: the self-published, hard-to-game
`billableSavedTokens` definition (RIP-LIST #8, `packages/gateway/src/billable.ts`) and the pricing
decision in `PRICING.md`.

**Un-defer trigger.** Ship the self-published formula first (done). Pursue a standards-body blessing
later as a positioning move if the category matures — **never gate billing or a customer contract on
ratification.** The formula stands on its own, backed by the verifiable chain.

## #14 — Human-approval gate tier whose decision is chain-recorded (source: HumanLayer)

**What it is.** A tier where a human approves/denies an effect and the decision is recorded on the
tamper-evident chain — a genuine differentiator and a natural upsell.

**Why deferred.** It is a **new product surface**, and the MVP prime directive is not to pull later
phases forward. More importantly, a *blocking* human gate placed inside the replay path would break
exact-replay determinism (a human decision is session state, not replayable request input). It must live
**above** the pure core, never inside the barrier/replay path.

**Un-defer trigger.** Post-MVP, when the effect-barrier tiers are the focus. **Constraint:** the gate
sits above `@agent-rewind/core`; the pure barrier/replay path stays deterministic and human-free. The chain
records the human's decision as an event (like any other effect), but the decision must never be a
blocking step inside a replay. This composes with the deny-reason work (#11, already shipped) but adds
approval state, which is exactly what must stay out of the core (RIP-LIST hard-skip on auto-approve
state in the core).

---

**Common thread.** Each deferral protects a core invariant — append-only history (#12), don't-gate-on-
outside-parties (#13), exact-replay determinism (#14). Un-defer only when the trigger is real, and only
in a way that keeps the invariant intact.
