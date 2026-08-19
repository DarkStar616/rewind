# Agent Rewind — research-grounded roadmap: more savings, more accuracy (2026)

Source: deep-research pass, 28 sources → 135 claims → 24 confirmed / 1 refuted (3-vote adversarial
verification). All figures are 2025-2026 primary sources; **caveats at the bottom are load-bearing** —
several key numbers are single self-reported preprints on non-Claude models.

## The strategic insight: savings and accuracy are the SAME lever

The two things we want reinforce each other, and Agent Rewind is uniquely positioned to exploit it:

- Backtracking/rewind is the biggest **accuracy** win (AgentRewind: **+25.6pp** task success).
- Backtracking's cost is the **extra tokens** it spends re-exploring after a rewind.
- Agent Rewind's **Mechanism A (exact replay)** serves the unchanged prefix of that re-exploration at
  **zero upstream cost**, and **Mechanism B (cache preservation)** serves the rest at **~0.1× input**.

→ **We can afford more accuracy-boosting backtracking than anyone else, because our replay makes the
re-exploration nearly free.** That is a real wedge: "the reversible agent runtime that makes
tree-search cheap." Don't sell savings and accuracy as two features — sell the loop.

---

## Part 1 — MORE TOKEN SAVINGS (ranked by impact ÷ cost, with replay-safety flagged)

### 1. Harden Mechanism B: cache-breakpoint DISCIPLINE — **DO FIRST** ✅ replay-safe
- **Impact:** ~**78–80%** cost reduction on Claude Sonnet 4.5 (78.5%, system-prompt-only) and GPT-5.2
  (79.6%, exclude-tool-results); cache reads are **0.1× input** (Sonnet $3.00→$0.30/M). Gemini 2.5 Pro 41.4%.
- **Why safe:** a cache hit *requires* a byte-identical prefix (cumulative-hash, strict prefix match) —
  the exact property our replay key already enforces. Caching is inherently exact-replay-safe.
- **What to build (extends the code we already have):**
  - Place the breakpoint at the end of the **stable prefix** (system + tools), not full-context.
  - **Push all dynamic content to the suffix** — timestamps, session/user IDs, volatile tool results
    placed early silently forfeit the *entire* cached prefix. Detect + warn when a request poisons its
    own prefix (this is the #1 real-world cache-savings bug).
  - Respect the **4-breakpoint cap** (a 5th needed for auto-caching returns HTTP 400).
  - Meter Mechanism B honestly (already gated on a caused warm read).
- Sources: `arxiv.org/html/2601.06007v2` ("Don't Break the Cache", PwC), `platform.claude.com/docs/en/build-with-claude/prompt-caching`.

### 2. Deterministic context pruning + tool-output summarization — **strong second** ⚠️ replay-safe *only if deterministic + hash-chained*
- **Impact:** **23–64%** token cut, and it often *improves* accuracy on long runs — recency pruning
  (last 5 tool pairs) cut tokens 63.9% and raised completion **+8pp**; adding summarization **+20.6pp**.
  **SWE-Pruner** (a 0.6B line-level skimmer) cut 23–38% on SWE-Bench Verified with **<1pp** success drop
  and beat LLMLingua-2 on *both* axes.
- **Replay risk:** it **rewrites the request bytes**, so it threatens exact replay unless the transform
  is deterministic and recorded on the hash chain. **Prefer line-level pruning (SWE-Pruner style) over
  LLM summarization** — deterministic, and it dodges the code-corruption problem below.
- Sources: `arxiv.org/html/2606.10209v1` ("Less Context, Better Agents"), `arxiv.org/html/2601.16746v1` (SWE-Pruner).

### 3. Verified semantic caching — **opt-in tier only, OFF the deterministic path** ⚠️ correctness bounded, not eliminated
- **Impact:** moderate. Near-hit serving has an **irreducible precision/recall wall**: 0.70 similarity →
  ~10% of hits are *wrong*; tightening to ~0.97 precision collapses recall to ~0.2. Approximate KV reuse
  loses **9–11%** accuracy. For a code agent, "even 3% error is unacceptable."
- **The only safe pattern (Krites/Apple):** an **async LLM judge** evaluates *only* grey-zone near-misses
  off the critical path (99/100 human agreement), and **promotes** approved matches for *future*
  requests — the triggering request is **never** served the near-hit. Lifts hit-rate up to **3.9×** with
  unchanged critical-path latency. TweakLLM alternatively *rewrites* the cached response for relevance.
- **Rule:** never serve a near-hit verbatim; keep this entirely off Mechanism A's deterministic path.
- Sources: `arxiv.org/html/2602.13165` (Krites), `arxiv.org/html/2507.23674v2` (TweakLLM).

### 4. Token-level prompt compression (LLMLingua-2 in the loop) — **AVOID for code** ❌ breaks replay + corrupts code
- Compression **subtly corrupts code**: aggregate scores stay stable while **edit-similarity drops
  significantly** — "adds latency without quality benefits for code generation." The claim that "code
  tolerates aggressive compression" was **refuted 0-3** in this very research.
- Adds an **adversarial attack surface** (CompressionAttack: up to 80% attack success, 98% preference
  flip, real VSCode-Cline/Ollama case studies) and breaks exact-replay determinism.
- Sources: `arxiv.org/html/2604.02985v1` ("Prompt Compression in the Wild"), `arxiv.org/html/2510.22963v2` (CompressionAttack).

---

## Part 2 — MORE ACCURACY (ranked)

### 1. AgentRewind-style selective rewind + failure-memory — **the big one** (this is the deferred BP2)
- **Impact (quote HONESTLY — corrected by the 2026-08-18 prospect pass):** the headline **+25.6pp**
  (62.2%→87.8% on MettleBench) is vs the *weakest* baseline (Continue). Vs the *strongest* baseline
  (Restart-with-Experiences) it is **+10.2pp**, and on Terminal-Bench 2.0 it is **+4.4pp** (83.1% vs
  78.7%). MettleBench is the authors' own 82-task benchmark on GPT-5.4. **Do not quote +25.6pp bare.**
- **The real moat is COST, not just accuracy:** AgentRewind gets long-horizon recovery gains at **~1×
  tokens** because rewind + replay replaces re-exploration — whereas tree-search (LATS) buys comparable
  coding gains at **10–40× tokens**. That cost asymmetry is Agent Rewind's defensible edge.
- **Key design lesson:** naive environment-**reset restart can be WORSE than just continuing**;
  **selective** rewind-to-checkpoint (carrying the failure experience forward) beats both.
- **Why cheap for us specifically:** it maps directly onto our whole-workspace checkpoint/rewind
  substrate, and Mechanism A replays the re-exploration cheaply. **This is the highest-leverage next
  slice — it's the accuracy feature AND it showcases the savings loop.**
- Source: `arxiv.org/abs/2608.14380` (AgentRewind, Aug 2026).

### 2. When-to-rewind policy + verification-guided backtracking
- A validation gate at checkpoints that *triggers* the selective rewind (the "checkpoint-selection"
  half). Pairs with the effect barrier we already have (a spent-effect/validation signal).

### 3. Bank the savings↔accuracy synergy explicitly
- Instrument and report: tokens spent on re-exploration vs tokens avoided by replay during backtracking.
  This is the number that proves the wedge.

> Note: Tree-of-Thoughts / LATS / Reflexion were searched but **no surviving claim quantified their
> deltas vs AgentRewind** on coding tasks — so the accuracy roadmap is anchored on AgentRewind, the one
> rewind method with verified numbers. LATS/ToT/Reflexion refs: `arxiv.org/abs/2310.04406`,
> `arxiv.org/abs/2305.10601`, `arxiv.org/abs/2303.11366`.

---

## Caveats (do not overclaim to investors)
- Several load-bearing numbers are **single, non-peer-reviewed, self-reported preprints** measured by the
  method's authors on their **own** benchmarks: AgentRewind +25.6pp (MettleBench is theirs), SWE-Pruner
  (authors' subset, sub-1pp deltas within noise), pruning+summarization +20.6pp (n=5, narrow domain).
- **Benchmark mismatch:** the pruning and AgentRewind results run on **GPT-5.x, not Claude**, on narrow
  domains — generalization to arbitrary Claude/Cursor/Codex agents is unproven.
- Semantic-cache safety numbers come from **NL/RAG datasets, not code** — a code agent's bar is higher,
  so those bounds likely **understate** real risk.
- The exact-replay-safety classification per lever is an **engineering judgment**, not a measured
  property: any transform that alters outgoing bytes is replay-safe **only if deterministic + hash-chained**.
- Pricing figures are **time-sensitive 2026 snapshots** and will drift.

## Recommended next slice
**BP2 — selective rewind + failure-memory**, because it (a) is the largest measured accuracy win, (b)
maps onto substrate we already have, and (c) is the demo that proves savings and accuracy are one loop.
Ship the Mechanism-B breakpoint-discipline hardening alongside it (cheap, replay-safe, ~78–80% cache win).

## Status (2026-08-18) — SHIPPED
The recommended slice is **built and tested** (plan: `docs/superpowers/plans/2026-08-18-recovery-and-cache-hygiene.md`):
- **Accuracy:** `@agent-rewind/core` recovery policy (rewind-memory, selective `recommendedCheckpoint`,
  sparsity gate) + durable attempt log + `backtrack_candidates`/`backtrack_commit` MCP tools (note
  required; memory survives across sessions).
- **Savings:** `analyzeCacheHygiene` + proxy advisory + `rewind cache-report` CLI (flags prefix
  poisoners + the 4-breakpoint cap; advisory-only, exact-replay-safe).

**Still deferred** (next candidates from the ranking above): deterministic line-level context pruning
(SWE-Pruner style, savings lever #2 — must be deterministic + hash-chained), and verified semantic
caching as an opt-in off-path tier (savings lever #3).
