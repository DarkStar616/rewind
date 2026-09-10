# Agent Rewind — Full Product Breakdown

*Reversible execution + verifiable token savings for AI coding agents.*

> **Purpose of this document.** A complete, technically accurate breakdown of what Agent Rewind is, what
> it ships, how each piece works, why it works, and exactly what has been measured versus what is a
> design guarantee. It is written to be used in marketing and sales conversations with a technical
> audience — so every claim carries its evidence, and nothing is rounded up. A buyer who reads the
> code will find it matches this page.

---

## Evidence legend

Every substantive claim below is tagged:

| Tag | Meaning |
|---|---|
| **[PROVEN]** | Backed by an automated test that fails if the property breaks. Named test titles are quoted so you can audit them. |
| **[BY DESIGN]** | True by construction of the architecture; follows from the code, not from a benchmark. |
| **[SYNTHETIC]** | A real, reproducible number from a deterministic in-repo scenario with mock upstream and injected clock — **not** a measurement against a live provider. |
| **[RESEARCH]** | A figure from published external research that motivates the design. **Not** Agent Rewind's own result. |
| **[NOT YET MEASURED]** | Honestly unproven; on the roadmap. |

---

## 1. In one sentence

Agent Rewind is a **local, zero-config MCP server + LLM proxy** that gives any coding agent (Claude Code,
Cursor, Codex CLI, Cline, Windsurf) three things it doesn't have on its own: **whole-workspace
checkpoint/rewind**, a **refuse-and-record effect barrier** so a rewind can never silently re-fire a
real-world side effect, and **token savings from byte-exact record/replay + prompt-cache
preservation** — all recorded on a **tamper-evident SHA-256 hash chain**, and billable as a share of
the savings it can *prove*.

## 2. The problem it solves

A multi-step agent that fails at step 18 of 20 is expensive in the worst way. Conventional retry
throws away the 17 good steps and redoes them. And the two obvious "fixes" are traps:

- **Version control isn't reversal.** `git checkout` will happily "revert" a workspace to before an
  email was sent or a card was charged — a *dangerous illusion*, not a real undo. Agent state isn't
  just files.
- **Built-in agent rewinds are half-blind.** Claude Code's `/rewind` tracks only its own file-edit
  tools. Anything a `bash` command changed, and every external side effect, is invisible to it —
  untracked and un-undoable.

Agent Rewind covers exactly that gap — *everything the built-in can't see (bash + external effects)* — and
does it for **every** agent, not one.

Why now: recent research shows agents fail in ways that make blind retry actively dangerous — GPT-5
submits a patch on **100%** of runs but resolves only **44%** **[RESEARCH: arXiv:2603.25764]**, and
**60–69%** of failures "edit the correct functions yet still produce incorrect patches"
**[RESEARCH: arXiv:2603.24631]**. An agent that confidently does the wrong thing needs a *safe* undo,
not a hopeful one.

---

## 3. Feature list at a glance

| Pillar | What you get | Evidence |
|---|---|---|
| **Whole-workspace checkpoint/rewind** | Snapshot the entire working tree (including bash-made changes) and restore any checkpoint; history survives restore (append-only). | **[PROVEN]** |
| **Refuse-and-record effect barrier** | A spent external effect (payment, email, provisioning call) cannot be re-fired across a rewind; the refusal is recorded and returned with a reason. | **[PROVEN]** |
| **Tamper-evident hash chain** | Every checkpoint, effect, and refusal is linked on an append-only SHA-256 chain; any edit is detectable; verification never crashes. | **[PROVEN]** |
| **Byte-exact record/replay** | A byte-equivalent request after a rewind is served from record with **zero** upstream cost; a semantically different request is *never* served a stale answer. | **[PROVEN]** |
| **Prompt-cache preservation** | Injects one cache breakpoint on the static prefix when the agent set none, so the prefix is re-read at the provider's cache-read rate. | **[PROVEN]** |
| **Deterministic tool-output pruning** | Losslessly collapses duplicate `tool_result` blocks; replay-safe by construction. | **[PROVEN]** |
| **Gainshare billing** | Bill a share of **verified** savings, anchored to a hard-to-game "billable saved tokens" definition and reconciled against the provider's own bill. | **[BY DESIGN]** |
| **Free Savings Analysis** | A hash-attested, redacted report of how replayable a customer's traffic is — *before* any contract. | **[PROVEN]** |
| **Distribution** — **LIVE on npm** | Install is `npx -y @agent-rewind/mcp` (scoped, since the unscoped `rewind` name is taken), one-line config for Claude Code, Cursor, Codex CLI. Published as `@agent-rewind/core`, `/gateway`, `/mcp` and **verified installable + runnable from the registry**. | **[PROVEN]** live + verified install |

---

## 3a. Use cases (who reaches for this, and when)

- **Long multi-step agent tasks** — big refactors, framework migrations, dependency upgrades. Recover
  from a bad step at minute 40 without throwing away the first 39.
- **Agents that touch the real world** — deploys, database migrations, payments, emails, provisioning.
  A safe undo that **cannot double-fire** the effect on a retry (the barrier's whole point).
- **Cutting cost on repetitive / iterative runs** — the optional proxy replays byte-identical calls at
  zero upstream cost and keeps prompt caching healthy.
- **Safe experimentation / what-if** — checkpoint, try a risky approach, rewind cleanly if it doesn't
  pan out.
- **Debugging agent runs** — a typed divergence report shows exactly where a re-run stopped matching a
  recorded one.

## 3b. How the token savings & accuracy actually happen (plain English)

**Two separate systems — don't conflate them.** Checkpoint/rewind is **literally git** (a private side
repo doing real commits over the whole workspace); it does **not** use prompt caching. Prompt caching is
a feature of the **optional proxy**, a different layer entirely. You can run either without the other.

**Token savings — three levers in the proxy**, all priced from the provider's *own* usage numbers and
floored so they never over-count:
1. **Exact record/replay (the big one).** A *byte-identical* request — common right after a rewind or a
   retry — is served from the local record with **zero** upstream call; the saving is that whole call.
   Correctness-safe by construction: only byte-for-byte-equivalent requests replay, so it can never
   serve a subtly-wrong answer (the key difference from "semantic" caches that guess).
2. **Prompt-cache preservation.** For Anthropic message requests, injects or keeps one `cache_control`
   breakpoint on the static prefix when the client supplied none. Provider policy and usage determine
   whether that produces a cache hit or a billed saving.
3. **Deterministic pruning.** Collapses repeated Anthropic-format tool-result blocks while preserving
   the first full result. It changes model-visible context, so it remains opt-in and needs outcome testing.

*(The math and price table are in §6; the executable nine-call simulated benchmark is in §8.)*

**Accuracy — the mechanism.** Agent Rewind makes *recovery* cheap and safe: instead of compounding a mistake,
the agent rewinds to the last good checkpoint and tries again; a **failure-memory** model (the
`backtrack` tools) stops it re-walking the same dead-end; and the barrier guarantees a retry can't
double-fire an effect. **[RESEARCH, not ours]** the headline accuracy figures (e.g. task-success
~44%→~88% with environment rewind) come from published research that motivates the design — Agent
Agent Rewind ships the *mechanism*; measuring its own accuracy uplift is future work.

---

## 4. Architecture — the one discipline that makes it portable

Agent Rewind is a small monorepo of three TypeScript packages (npm workspaces, ESM; runs on Node ≥ 20, build-from-source needs Node ≥ 24.15; zero
Python in the core path):

- **`@agent-rewind/core`** — the moat as pure logic: the `WorldBackend` interface (with one Tier-0 git
  implementation), the effect barrier, the evidence hash chain, canonical JSON, the engine, and the
  recovery/failure-memory model.
- **`@agent-rewind/gateway`** — the token-saving LLM proxy: canonical request keying, record store, replay,
  metering, cache preservation, cache hygiene, pruning, and the savings/analysis surface.
- **`@agent-rewind/mcp`** — the stdio MCP server and the `agent-rewind` CLI, plus durable file-backed stores.

**The load-bearing rule:** the barrier, the hash chain, the meter, the pruner, and every analysis
function read **only** the effect log / recorded calls / provider usage — **never the filesystem or a
clock** **[BY DESIGN]**. That single discipline is why the exact same moat can later run on a hosted
sandbox without a rewrite, and why the correctness-critical logic is fully unit-testable with injected
inputs. Timestamps are injected; there is no `Date.now()` in the pure path.

Two "coupling points" were deliberately genericized during extraction so the larger product can depend
on `@agent-rewind/core` as a published package: the hash chain's **action vocabulary** and its **authority
resolver** are both *injected*, not hard-coded (with a no-op default) **[BY DESIGN]**.

---

## 5. Component-by-component breakdown

### 5.1 The moat (`@agent-rewind/core`)

**`world/git-backend.ts` — Tier-0 whole-workspace snapshots.**
*What:* snapshots the entire working tree into a **side** git dir (`.rewind/snapshots.git`), never the
project's own `.git`. *How:* `snapshot()` stages into a per-call throwaway `GIT_INDEX_FILE` (so it
never touches a shared index), commits, and **compare-and-swaps** `refs/heads/main` so a concurrent
writer can never orphan a commit; `restore()` captures the current tree first, then `read-tree -u
--reset` + `clean -fd`, and on any mid-flight failure **rolls the tree back** to exactly where it
started (`RestoreFailedError`) rather than leaving it half-applied. Restore moves **no ref**, so
`log()` still shows every snapshot afterwards — history survives a rewind. All tree/ref mutations for a
given repo serialize through one process-global queue keyed by the canonical git-dir path. *Why:* a
reversibility tool whose "undo" can leave a half-applied tree is worse than none; the append-only chain
is what lets you rewind *forward* again and what the effect barrier reads across a rewind.
**[PROVEN]** — `"a restore that fails mid-flight rolls the work tree BACK, not half-applied"`,
`"concurrent snapshots all land on the append-only chain"`, `"two backend instances on the same git
dir serialize"`. Secrets (`.env`, private keys) and heavy dirs (`node_modules`, …) are excluded by
default so a rewind can never revert a live credential **[PROVEN]** — `git-backend-secrets.test.ts`.

**`audit/effect-ledger.ts` — the refuse-and-record effect barrier.**
*What:* the differentiated piece. Identity is `(scopeLabel, effectKey)`. The first emit of a key is
admitted and recorded; any later emit of the same key is **refused** and recorded, citing the original,
and returns a structured `reason`. *How:* the whole check-and-append runs inside a per-scope keyed
queue, closing a real time-of-check/time-of-use race where two concurrent emits could both see
"unspent." Because the git backend excludes `.rewind/` from snapshots, a rewind rolls back the
*workspace* but **not** the evidence chain — so the spent record survives, and the re-fired effect is
still seen as spent. *Why:* this neutralizes a published class of "semantic rollback" attack where an
agent re-synthesizes a slightly different request after a restore to double-charge or reuse a consumed
credential. **[PROVEN]** — `"first emit is admitted; a second emit of the same key is refused and
recorded citing the first"`, `"30 parallel emits of one key: exactly one admission, one spent entry,
29 recorded refusals"`.

**`audit/evidence-ledger.ts` — the tamper-evident SHA-256 hash chain.**
*What:* an append-only, per-scope, hash-linked log. *How:* each entry's hash is SHA-256 over a
canonical serialization of its contents plus the previous entry's hash; `verifyChain` re-derives every
hash and checks scope, contiguous sequence, and linkage. It is **fail-closed**: a structurally invalid
entry that can't be re-hashed returns a broken verdict rather than throwing. *Why:* the neutral source
of truth for both the effect barrier and gainshare billing — you can hand a customer the chain and they
can verify it themselves. **[PROVEN]** — `"verify passes on an untouched chain and fails when an
interior field is edited"`, `"tampering ANY hashed field (not only detail) breaks verification"`,
`"verify RETURNS a broken verdict (never throws) when a tampered entry has non-finite detail"`.

**`audit/canonical-json.ts`** — deterministic key-sorted serialization the hash is taken over; rejects
anything with no canonical form (non-finite numbers, cycles, non-plain objects) and is `__proto__`-safe
**[PROVEN]**, 18 tests including a byte-stability golden.

**`engine.ts`** — thin driver wiring backend + barrier + savings; crucially, after a rewind it reports
which effects are now refusable **from the chain, never the filesystem** **[PROVEN]** —
`"engine: checkpoint → bash edit → guard admitted → rewind → guard refused-and-recorded → chain
verifies"`.

**`recovery/recovery.ts`** — an AgentRewind-style selective-rewind + carried-forward failure-memory
model (pure logic, injected timestamps): which checkpoint to resume from, and remembering what already
failed so the agent doesn't repeat it. Motivated by **[RESEARCH: arXiv:2608.14380]** which reports
environment rewind lifting agent task success from **43.9% → 87.8%** and recovery from **8% → 30%** —
*their* numbers, the reason this model exists, not Agent Rewind's measurement.

### 5.2 The token-saving proxy (`@agent-rewind/gateway`)

**`canonical-request.ts` — the replay key.**
*What:* turns a request body + output-affecting headers into a SHA-256 `replayKey`. *How:* a
**deny-list**, not an allow-list — only known-noise fields (caching hints, auth material, request ids)
are stripped; **everything else, known or unknown, is kept**. *Why (the core safety argument):* a false
**miss** costs one redundant paid call (money); a false **hit** serves a wrong, stale answer the agent
then acts on (a correctness disaster). These are not symmetric, so the key is built to **never
false-hit**, at the cost of occasionally false-missing. An unrecognized field — including a future
output-affecting parameter — therefore forces a *new* key and a miss, never a collision. `stream` is
deliberately kept (SSE vs JSON wire formats differ). **[PROVEN]** — `"FAIL-SAFE: an UNRECOGNIZED field
changes the key (unknown → miss, never a false hit)"`, and a property test over 200 randomized requests:
`"property: any output-affecting change ALWAYS changes the key"`.

**`replay.ts` + `record-store.ts` — Mechanism A (exact replay).**
On a hit, the recorded response bytes are served locally with **zero** upstream traffic and the whole
avoided call is booked as a saving; on a miss, the proxy forwards (fail-open) — or, in strict mode,
hard-fails rather than pay. Records are content-addressed and scope-isolated (nested maps, no
delimiter-injection), so one caller's recording is never served to another. **[PROVEN]** —
`"strict mode HARD-FAILS on a miss instead of silently paying"`, cross-scope isolation.

**`meter.ts` — the honest cost math.** See §6.

**`cache-preserve.ts` — Mechanism B (cache preservation).**
If the request already carries any `cache_control`, Agent Rewind changes nothing (agent-controlled).
Otherwise it injects **one** ephemeral breakpoint on the static prefix, and credits a saving *only*
when it injected **and** the provider actually reported a cache read — valued at
`(input_rate − cacheRead_rate)`. It never touches the replay key. **[PROVEN]** — `cache-preserve.test.ts`.

**`prune.ts` — deterministic, lossless pruning.**
Collapses byte-identical duplicate `tool_result` blocks (keep-first, elide-later) — the duplicate key
is `canonicalize({content, isError})`, so key-order is ignored but a success is never collapsed against
an error with the same text. Only `tool_result` blocks are touched (never the agent's own `tool_use`
inputs), and only above 200 chars. Because it's a pure function of the bytes, the pruned request keys
and records **identically** on replay. **[PROVEN]** — `"DETERMINISTIC: same input → byte-identical
pruned output"`, `"tool_use blocks are NEVER pruned"`.

**`proxy.ts`** — a byte-transparent HTTP proxy you point `ANTHROPIC_BASE_URL` at; replays on hit,
fails **open** on miss (a proxy failure never fabricates a model answer), and records only complete 2xx
successes. **[PROVEN]** — `"strict replayer: a miss returns 409 and does NOT reach upstream"`, and the
fail-open path never fabricates.

**`cache-hygiene.ts`** — advisory static analysis that flags prefix-poisoning dynamic content
(timestamps, UUIDs, epochs) that silently busts prompt caching. Motivated by
**[RESEARCH: arXiv:2601.06007v2]**: teams forfeit **~78–80%** of achievable cache savings this way.
Advisory only — it can't prove a given value actually changes, so it accepts false positives.

### 5.3 The gainshare surface (`@agent-rewind/gateway` + `@agent-rewind/mcp`)

**`billable.ts`** — the published, hard-to-game "billable saved tokens" definition: the sum of
**realized** replays, deduped by call id, **floored**; a counterfactual "would-have" call is
structurally impossible to pass in, so it can never be credited **[PROVEN]**.
**`analysis.ts`** — the **Free Savings Analysis**: shadow-analyze a batch of traffic, count
byte-replayable repeats, price them, and fold the report into a **one-entry attested hash chain** so a
prospect can verify it themselves **[PROVEN]** — `"tampering with the attested analysis breaks
verification"`. The surfaced sample is **redacted** (`redact.ts`, export-only — never the replay tape
or key). **`reconcile.ts`** — reconciles the chain-attested figure against the provider's own aggregate
bill and flags any over-claim; honest limit encoded: *the chain attests the events, the bill attests
the aggregate*. **`diverge.ts`** — turns a failed replay match into a typed, debuggable report
(input-mismatch / extra-call / missing-call).

**`@agent-rewind/mcp`** — the `agent-rewind` CLI (subcommands `checkpoint / list / rewind / replay / guard /
savings / cache-report / prune / analyze / gateway / mcp`; a refused `guard` exits **2** so a
PreToolUse hook can block the offending tool call) and the stdio MCP server exposing the five MVP tools
(`checkpoint`, `list`, `rewind`, `replay`, `guard_effect`) plus `savings` and two `backtrack` tools.
Durable state (evidence chain, savings, rewind-memory) is file-backed with atomic temp+rename writes
that **fail closed** on a corrupt file **[PROVEN]**.

---

## 6. Token economics — the math, and why it's honest

**Avoided cost** (`meter.ts`) is computed from the **provider's own reported usage**, never estimated
from text: each token field × its own component rate, summed, then `floor(sum / 1_000_000)`. Rates are
integers in micro-USD per million tokens, so arithmetic is exact (one divide, no float drift), and the
result is **floored, never rounded** — a billed saving must always round toward *under*-billing.
Components are priced separately because they differ by ~50× (cache-read ≈ 0.1× input; output ≈ 5×
input); a blended rate would systematically mis-price.

**Why a replay's saving equals the whole upstream call cost:** a replay serves the recorded response
with zero upstream traffic, so every token that call would have processed is genuinely avoided
**[BY DESIGN]**. Verified conservation: **[PROVEN]** — `meter.property.test.ts`, `"property: cost …
NEVER exceeds the exact cost (500 usages)"`.

Default price table (`version 2026-08-18`, public list prices, marked ESTIMATE — the billing system
overrides it with the customer's contract rates and stamps the version as provenance):

| Model | input | output | cache-write | cache-read |
|---|---|---|---|---|
| claude-opus-4-8 | $15 / MTok | $75 / MTok | $18.75 / MTok | $1.50 / MTok |
| claude-sonnet-4-5 | $3 | $15 | $3.75 | $0.30 |
| claude-haiku-4-5 | $1 | $5 | $1.25 | $0.10 |
| *default (unknown model)* | $0.25 | $1.25 | $0.3125 | $0.025 |

The `default` row is deliberately the **cheapest rate Anthropic has ever charged**, so an unlisted
model *under*-bills; a table with no default bills **0** for an unknown model rather than guessing. A
savings meter must never flatter itself.

**Gainshare model** (see `docs/PRICING.md`): lead with a **pure percentage of verified savings** —
maximal alignment, and the strongest wedge. Never a percent-of-total-spend floor (the churn trigger);
never credit counterfactuals. Precedent: outcome-priced infra vendors take **10–15% of realized
savings** **[RESEARCH: ProsperOps, per `docs/BUSINESS-MODEL.md`]**. Honest boundary: cryptography can
attest *actual* usage but **cannot** anchor the counterfactual baseline — so we say "the chain attests
the events," never "the metric is cryptographically unforgeable."

---

## 7. Testing & verification results (Agent Rewind's own numbers)

- **443 automated tests passing; typecheck clean** **[PROVEN]** in the v1.1.0 release verification run.
  Run `npm run check` to reproduce the current result.
- **Property-based tests** on the two most safety-critical functions: the replay key (200 randomized
  requests — determinism *and* "any output-affecting change always changes the key") and the meter (500
  usages — cost never exceeds the exact cost).
- **End-to-end guarantee, three ways:** the full "checkpoint → guard admitted → bash edit → rewind →
  guard REFUSED across the rewind → chain verifies" flow is proven at the **engine**, **CLI**, and
  **MCP server** layers **[PROVEN]**.
- **Cross-vendor review:** independent automated review has found concrete over-credit, redaction,
  concurrency, and tamper-evidence defects that were fixed and regression-tested. It remains a
  bug-finding aid rather than certification, and later findings supersede any earlier “clean” verdict.

**What is NOT yet measured [NOT YET MEASURED]:** there is no production-traffic, end-to-end gateway A/B
for latency, throughput, task success, or universal real-dollar savings. The repository does include a
Nebius provider-calibrated scenario that reads real provider usage, described below.

---

## 8. Benchmarks (read this carefully)

Agent Rewind ships **deterministic accounting gates**, not performance benchmarks. They run against a mock
upstream with an injected clock and synthetic token counts, and their job is to prove the savings math
can **never over-credit**, not to report a speed:

- **[MEASURED, DETERMINISTIC] Benchmark B:** across 120 trials of a 10-step task, recovered tokens vary
  with the failure point: **9.1%** at step 2, **25.6%** at step 5, and **41.2%** at step 8. The headline
  must remain condition-bound: *“recover up to 41.2% of the tokens a late-failing run burned.”* It is a
  controlled scenario with a 50% single-interruption ceiling, not a universal or production result.
- **[PROVIDER-CALIBRATED SCENARIO]** `packages/gateway/bench/live-nebius.ts` makes ten real Nebius calls,
  reads the provider's token counts, applies Rewind's production replay key, and calculates the same
  early/mid/late rewind curve. It is not an end-to-end gateway OFF/ON production-traffic experiment.
- **[SIMULATED] Executable nine-call trajectory:** the mock OFF/ON benchmark reports **28.08%**
  avoided simulated cost for `[1,2,3,4,5,3,4,5,6]`. OFF makes nine calls; ON makes six. This is one
  synthetic condition, not observed provider billing, a recovered-token percentage, or task-success
  evidence. The unique-call negative reports zero savings. Run `npm run --silent bench:json` for the
  versioned artifact, source hashes, denominators, simulated rate table and explicit limitations.
- **[EXTERNAL SOURCE, NOT SAVINGS EVIDENCE]** A pinned Apache-2.0 ATIF transcript excerpt is included
  for provenance development. It is not a complete provider request and cannot prove exact replay or
  paired savings. Coding-agent trace coverage, task evaluation and real billed OFF/ON runs remain open.
- **[PROVEN] anti-over-credit gates:** `"golden-negative: a trajectory with NO re-runs bills EXACTLY
  0"`; `"near-match MUST miss: a one-word-different prompt is never served the recorded answer"`;
  `"billable saving never exceeds the gross replay upper bound"`; `"fully deterministic: two runs
  produce byte-identical reports"`.

A live-dollar run against a real API key is written up (`bench/LIVE-RUNBOOK.md`) and deliberately
deferred. **We will not publish a savings percentage as if it were a live result until it is one.**

---

## 9. What Agent Rewind is *not* (honest limits)

These are stated up front because overclaiming here is a product defect:

- **Tier 0 is reversibility, not isolation or security.** A git-snapshot workspace can be reverted but
  cannot stop an agent touching files outside the tree or making a network call. Enforcement (an
  OS-level jail) is a separate, opt-in tier. This honesty is baked into every MCP tool description.
- **Reflink copy-on-write is filesystem-dependent** — fast on APFS/btrfs/XFS/ReFS, falls back to a full
  git checkout on ext4 and similar (correct, just not CoW-accelerated). Agent Rewind detects and messages
  this; it never promises CoW speed everywhere.
- **Provider usage APIs report aggregates, not per-call provenance** — so reconciliation is "chain
  attests events, bill attests aggregate," never "the provider certifies each saved call."
- **Cross-vendor review is a bug-finding aid, not certification;** the hash chain is framed as an EU AI
  Act Article 12-*suitable* logging primitive verified by our own tests — **not** certified compliance,
  not legal advice.
- **The effect-barrier concept is not novel** (others are converging on it). The defensible claim is the
  *combination* — deterministic, filesystem-independent, and portable across backend tiers — not
  invention.
- **Storage modes have different guarantees:** default compatibility mode keeps replay records in memory.
  v1.1.0 also ships an opt-in encrypted SQLite ordered tape that survives restarts. It requires one writer
  per tenant/epoch; broader migration, rotation, deletion, and multi-process certification remain future work.

---

## 10. Where Agent Rewind is differentiated (the white space)

The competitive scan (`docs/deep-prospect-log.md`, `docs/POSITIONING.md`) found overlapping exact-cache,
ordered-replay, context-reduction, and checkpoint products. Agent Rewind's wedge is the combination of
workspace recovery, effect admission, conservative savings evidence, and local operation:

1. **Byte-exact record/replay** — correctness-first (never a stale hit), where semantic caches trade
   correctness for hit-rate.
2. **Refuse-and-record effect barrier on a tamper-evident chain** — the moat competitors don't ship.
3. **Local-first, zero-config** — `npx -y @agent-rewind/mcp`, no Rewind account; Rewind state stays local.
   Live gateway calls still go to the configured model provider.
4. **Gainshare you can verify** — pay a share of savings *proven* on your own provider's bill.

---

## 11. Distribution & integration

> **Availability: v1.1.0 is live on npm.** `@agent-rewind/core`, `@agent-rewind/gateway`, and
> `@agent-rewind/mcp` all report `1.1.0` as latest. The CLI ships
> **scoped** (the unscoped `rewind` name is taken), so install is `npx -y @agent-rewind/mcp`, not a bare
> `npx rewind`.

- **Zero install:** `npx -y @agent-rewind/mcp` (also runnable as a stdio MCP server and a thin CLI).
- **One-line config** for Claude Code, Cursor, and Codex CLI; the plugin ships a `PreToolUse` hook that
  wires the effect guard onto `Bash|Write|Edit` (a refused guard exits 2 to block the call) — **[PROVEN]**
  the plugin test decodes the exact stdio launch and verifies the hook wiring.
- **Proxy mode:** point `ANTHROPIC_BASE_URL` at the local gateway; replays after a rewind cost 0 upstream
  tokens, and `agent-rewind savings` prints the running total.
- **Licence:** FSL-1.1-ALv2 (Functional Source License 1.1 with an Apache-2.0 future grant at 2 years) —
  source-available, with the hosted/enterprise layer kept cleanly separate from day one. The `LICENSE`
  file and every package's `license` field agree.

---

## 12. Claim provenance — quick index

| Claim | Status |
|---|---|
| Checkpoint/rewind, effect barrier, hash chain, exact replay, cache-preserve, prune all work as described | **[PROVEN]** — 443 tests in the v1.1.0 release verification run |
| Never serves a stale/wrong answer on a near-match | **[PROVEN]** — deny-list + bench gate |
| Never over-credits savings (floors, dedupes, counterfactuals impossible) | **[PROVEN]** — meter/billable/bench |
| A rewind can't un-spend a real effect | **[PROVEN]** — engine/CLI/MCP e2e |
| Tamper-evident, fail-closed verification | **[PROVEN]** — evidence-ledger tests |
| Up to 41.2% recovered tokens after a late failure (Benchmark B: 120 deterministic trials) | **[MEASURED]** — condition-bound controlled scenario, not a universal result |
| AgentRewind 43.9%→87.8%, prompt-cache 59–90%, etc. | **[RESEARCH]** — external papers, not Agent Rewind's results |
| Live latency / throughput / real-dollar savings % | **[NOT YET MEASURED]** |

---

*Every quoted test title exists in `packages/*/test/`; every price and rate is from
`packages/gateway/src/meter.ts`; the synthetic bench is
`packages/gateway/bench/`. If a number isn't tagged, it's an error — flag it.*
