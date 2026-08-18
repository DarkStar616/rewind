# deep-prospect log

## 2026-08-18 — harvest targets for Rewind's next levers (pruning · verified cache · tree-search · proxy interop)

Grounding: Rewind is TypeScript/Node 24; **exact-replay determinism is the sacred invariant**. Next
levers (from `docs/RESEARCH-ROADMAP.md`): deterministic pruning (savings), verified off-path semantic
cache (savings), tree-search/backtracking (accuracy). Three lanes (HF / GitHub / papers), all
candidates verified against live APIs.

### Ranked — worth harvesting or interoperating

| Candidate | Lane | What it is | Verified stats | Relevance / replay verdict |
|---|---|---|---|---|
| **SWE-Pruner** (Ayanami1314/swe-pruner; paper 2601.16746; model `ayanami-kitasan/code-pruner`) | B+A+C | 0.6B skimmer picks keep/drop LINES of tool output; **23–38% token cut, +1.2–1.4pp** resolve on SWE-bench Verified; syntax-preserving (87.3% AST-correct vs 0.29% LLMLingua) | 310★ · MIT · pushed 2026-06 · Python + PyPI + HF weights | Lever 1 model-based. **PRESERVES replay only if** the skim call+output is recorded (temp-0/Viterbi argmax, pinned precision). Heavier: a model in the path. **Port the selection algorithm; record the skim.** LATER slice. |
| **opencode-dynamic-context-pruning (DCP)** | B | Rule-based: collapse superseded tool-call/result pairs, keep-latest, drop obsolete | **4,012★** · AGPL-3.0 · pushed 2026-08-16 · **TypeScript** | Lever 1 rule-based — **replay-safe BY CONSTRUCTION (no LLM)**. AGPL → reimplement clean. **Closest prior art to our first slice.** |
| **tuanhung303/opencode-agent-context-pruning** | B | Rule-based latest-only tool-output prune, npm-published | 10★ · **MIT · TypeScript** · pushed 2026-02 | The one we could actually vendor/fork — clean license + TS. Rule-based → replay-safe. |
| **Krites** (paper 2602.13165, ACM) | B+C | **Verified** semantic cache: async off-path judge promotes grey-zone matches; **triggering request NEVER served a near-hit**; +136–290% curated-served share, zero critical-path latency | Peer-reviewed · **no OSS impl** | Lever 2 — the design to build from the paper. PRESERVES replay if each cache decision is a recorded trace node. LATER slice (needs async judge). |
| **Slipstream** (2605.08580; github chenzhuofu/slipstream) | C | Off-path judge validates a candidate context-compaction against the agent's next-k steps; **+8.8pp SWE-bench, −39.7% latency**; small (2–3B) judge suffices | Open source · Princeton | Best off-path-validation template for Lever 2. Record the adopt/reject decision. |
| **Speculate-with-Memory** (2607.12236) | C | **Provably lossless** speculative pre-launch of side-effect-free calls during idle | Salesforce · no repo | Latency lever (not tokens). **Safest under exact-replay** — committed trace unchanged. Optional later. |
| **LATS** (2310.04406; lapisrocks/LanguageAgentTreeSearch) | B+C | MCTS over agent trajectories; HumanEval +12.6pp (GPT-4), +26.9pp (GPT-3.5) — but **10–40× tokens** | 852★ · MIT · Python · stale (2024-07) | Lever 3. **A tree node = a Rewind checkpoint; backtrack = `rewind`.** LATS explicitly NEEDS env reversion — which we uniquely provide. Sell the substrate; port the search loop later. |
| **Reflexion** (2303.11366; noahshinn/reflexion) | B+C | Verbal self-reflection carried across attempts; ~2–3× tokens | 3,233★ · MIT · Python | Our rewind-memory IS Reflexion-across-a-rewind. Validated pattern. |
| **Portkey-AI/gateway** | B | Production AI gateway, plugin/hooks + cache modes | **12,757★ · MIT · TypeScript** · active | Lever 4 — highest-value interop (TS+MIT). Rewind owns the record/replay boundary; treat its cache hit as a recorded substitution. |
| **Helicone**, **LiteLLM** | B | Proxy + observability / dominant OpenAI-format proxy | 6k★ Apache TS · 56k★ Python | Interop/learn-from. Be wire-compatible so Rewind drops into existing stacks. |
| **nebius/SWE-agent-trajectories**, **SWE-bench Verified**, **terminal-bench** | A | 80k real agent trajectories; the 500-instance gold eval; terminal-agent bench | CC-BY / MIT · high downloads | The benchmark + test corpus to MEASURE pruning token-cut and rewind accuracy. Inert data → zero replay risk. |
| **swe-pruner-pro-training-corpus** | A | 22,609 line-level keep/prune annotations | 210 dl · Apache-2.0 | Training data to build OUR OWN deterministic skimmer (we control precision) if we go model-based. |

### The two cross-cutting findings
1. **Rule-based tool-output pruning is deterministic and replay-safe by construction** (DCP/ACP): drop
   byte-identical/superseded tool outputs, no model. This is the highest impact-÷-cost, lowest-risk next
   slice for a TS replay-invariant system. Model-based SWE-Pruner is a heavier later slice.
2. **No existing proxy does byte-exact record/replay** (LiteLLM/Portkey/Helicone all cache on content
   similarity). **That is Rewind's defensible moat.** Best interop: be OpenAI/Anthropic-wire-compatible.

### Checked, didn't hold up
- **TweakLLM** (2507.23674): the OPPOSITE of Krites — synchronous, on-path, rewrites+serves the near-hit
  to the triggering request → corrupts code, threatens replay. Single unreplicated student preprint with
  soft metrics. **AVOID.**
- **GPTCache** (8k★ MIT): serves near-hits VERBATIM (the anti-pattern). Harvest the architecture, not the
  behavior. **RouteLLM**: cost-router, not caching/replay, stale. **llm-d**: K8s inference infra, wrong
  layer. Various `*/semantic-cache-llm` demos: 0–4★, unlicensed, verbatim near-hit serving — vaporware.
- **orca-zhang/code-pruner-onnx**, unlicensed HF cache datasets: stubs / no license.

### Decision
Build the **deterministic rule-based tool-output pruner** first (pure TS, no model, replay-safe by
construction). Defer model-based SWE-Pruner, Krites verified-cache, and a LATS controller as later,
heavier slices — each validated here as real, with a clear harvest path.

---

## 2026-08-18 — competitive landscape (products/startups): who else saves tokens or rewinds agents

Grounding: Rewind = a LOCAL, byte-exact **record/replay** LLM proxy + MCP server for coding agents, with
whole-workspace git checkpoint/rewind, a refuse-and-record **effect barrier** + tamper-evident hash
chain, deterministic pruning + cache-hygiene (savings), AgentRewind-style selective-rewind + failure
memory (accuracy), and planned **gainshare** billing (% of *verified* token savings). GAP axes tested
against every product: **BXR** = byte-exact LLM record/replay · **WGR** = whole-workspace git rewind ·
**EB** = refuse-and-record effect barrier + hash chain · **GS** = gainshare billing · **LOCAL** =
local-first/privacy. Three lanes: GitHub OSS (gh-api-verified 2026-08-18), commercial (web + funding),
pricing/white-space. **Headline: no product holds more than ~1 of the five axes** (a few coding agents
hold partial WGR); the assembled combination is unoccupied.

### A. LLM proxies / AI gateways (the closest category — all compete on cost, none on the moat)

| Product | What it does | Verified stats | GAP vs Rewind | Verdict |
|---|---|---|---|---|
| **LiteLLM** (BerriAI) | Default OSS LLM proxy; 100+ providers, cost tracking, prompt-cache pass-through | 56,665★ · non-std lic · push 2026-08-18 · **Python** | Caching is provider-native pass-through, not deterministic replay. No BXR/WGR/EB/GS | **Direct** category king, but **interoperable** — be wire-compatible, sit in front/behind |
| **Portkey** | Fast TS AI gateway: routing, guardrails, **simple + semantic caching** | 12,757★ · **MIT · TS** · push 2026-05-25 · seed ~$3M | Semantic cache serves near-hits (unsafe-for-code, no verify); no BXR/WGR/EB/GS | **Direct** on caching · best TS harvest/interop target |
| **Helicone** | Proxy-based observability + LLM response caching, cost analytics | 6,082★ · Apache-2.0 · **TS** · push 2026-08-16 · YC, ~$3–5M | Exact-key TTL cache, not replay-for-savings; no BXR/WGR/EB/GS | **Direct** on caching |
| **Cloudflare AI Gateway** | Edge gateway: caching, rate-limit, analytics | closed/hosted · public co (NET) | Response cache only; runs on CF edge — **opposite of local-first**; no BXR/WGR/EB/GS | **Direct** on caching / adjacent overall |
| **OpenRouter** | Unified API to 300+ models, credit routing, cache pass-through | closed · ~$40M (a16z) | Aggregator; **~5% fee on credit top-ups = fee on SPEND, not verified savings**; no BXR/WGR/EB/GS | Adjacent (nearest %-fee precedent) |
| **Martian** | Routes each call to cheapest model meeting a quality bar | closed (no OSS repo) · seed ~$9M (NEA) | Cuts cost by **model-swap → different answer each time**, the opposite of byte-exact; no BXR/WGR/EB/GS | Adjacent (savings-competitor on *message*) |
| **Kong AI Gateway** | API-gw extended for LLM: semantic caching, routing, guardrails | OSS + Konnect · Kong ~$170M, ~$2B val | Ships fuzzy semantic caching (correctness risk); no BXR/WGR/EB/GS; infra not local | **Direct** on semantic caching |
| **TrueFoundry** | ML/LLM deploy platform + AI gateway (caching, routing) | closed · Series A ~$19M | Gateway caching inside a deploy platform; no BXR/WGR/EB/GS; cloud/k8s | Adjacent |
| **Langfuse** | OSS LLM tracing/evals, prompt mgmt, dataset reruns | 33,340★ · non-std lic · **TS** · push 2026-08-18 · YC W23 | "Rerun" hits the LIVE model, not BXR; trace sink only; no WGR/EB/GS | Adjacent (interoperable trace sink) |
| **Traceloop / OpenLLMetry** | OpenTelemetry instrumentation for LLM apps | 7,381★ · Apache-2.0 · push 2026-08-10 · seed ~$6M | Telemetry only; none of the 5 axes | Adjacent |
| **Braintrust** | LLM eval + prompt playground + proxy w/ dev caching | closed · Series A ~$36M (a16z) | Dev-speed cache, not billed savings; no BXR/WGR/EB/GS | Adjacent |
| **Requesty / Unify** | LLM routing + cost controls / model router-benchmark | Unify 113★ MIT Python · Requesty closed | Routing + caching for cost; no BXR/WGR/EB/GS | Adjacent (minor) |

### B. Semantic caches (the group Rewind must out-message on *correctness*)

| Product | What | Verified stats | GAP vs Rewind |
|---|---|---|---|
| **GPTCache** (zilliztech) | Canonical semantic cache; embeds prompt, serves nearest cached answer | 8,161★ · MIT · Python · **push 2025-07-11 (~13mo STALE)** | Serves near-hits **verbatim, no verify → can return a subtly WRONG answer**; the exact hole BXR closes. Effectively dormant |
| **Canonical AI** (canonical.chat) | Semantic prompt cache for agents/voice | closed · funding unknown (early) | Embedding-similarity match → wrong-answer-on-near-miss risk; no BXR(true)/WGR/EB/GS | **Direct** on caching, inferior correctness |
| **Redis LangCache** | Managed semantic caching service for LLM responses | closed · Redis (well-funded) | Same fuzzy-hit correctness risk; TTL/threshold tuning; no BXR/WGR/EB/GS |

### C. Agent checkpoint / time-travel / durable execution (all snapshot *state*, none the filesystem)

| Product | What | Verified stats | GAP vs Rewind |
|---|---|---|---|
| **LangGraph** | Agent graph runtime with checkpointer + time-travel (fork prior graph state) | 39,945★ · MIT · Python · push 2026-08-18 | Snapshots **graph/conversation state**, not the **workspace filesystem**; no BXR/EB/GS. Closest conceptual "rewind" but state-only |
| **Temporal** | Durable execution: deterministic replay of workflow *code* from event history | 22,389★ · MIT · Go | Replays workflow code, not LLM bytes or the FS; **idempotency prevents re-fire on RETRY, not across a human/agent rewind** | 
| **Inngest / Restate** | Durable functions / journaled resumable execution | 5,740★ / 4,306★ · Go/Rust | Step-level durability, not workspace/LLM; none of the 5 axes |
| **Humanlayer** | Human-in-the-loop approvals for agent tool calls | 11,295★ · non-std lic · **TS** · push 2026-06-19 | Approval gating **overlaps EB conceptually**, but it's a human-approval webhook, not a tamper-evident hash-chained refuse-and-record barrier; no BXR/WGR/GS. **Watch this one** |
| **LangSmith time-travel** | Trace + "time-travel" rerun from a step | closed · LangChain ~$25M+ | Re-runs from a trace point against the **LIVE** model — NOT byte-exact deterministic replay; no WGR/EB/GS |
| **AgentOps** | Agent session replay/visualization + token tracking | closed · small seed | "Replay" = trace visualization/re-run, not byte-exact response replay; no WGR/EB/GS |

### D. Coding agents with context/checkpoint tricks (potential Rewind *consumers*, not competitors)

| Product | Context/checkpoint tricks | Verified stats | GAP vs Rewind |
|---|---|---|---|
| **Cline** | Prompt-cache use, context-window mgmt, **per-message checkpoints (git-shadow) + restore** | 66,420★ · Apache-2.0 · **TS** · push 2026-08-18 · ~$32M | **Overlaps WGR** (workspace file checkpoints) but IDE/agent-locked, shadow-git not portable; **no BXR/EB/GS**. Closest workspace-rewind analog — study its shadow-git. **Interoperable** (could adopt Rewind MCP) |
| **Cursor** (Anysphere) | Agent + chat checkpoints, context mgmt | closed · Series C ~$10B val | IDE-locked chat/checkpoint restore, not agent-agnostic git WGR; no BXR/EB/GS; cloud | 
| **Windsurf** (Cognition) | Cascade agent w/ checkpoint/revert | closed · Codeium→Cognition 2025 | Cascade checkpoints overlap WGR but IDE-locked; no BXR/EB/GS |
| **Kilo Code** | Roo/Cline superset: compaction, context condensing, checkpoints | 26,917★ · MIT · **TS** · push 2026-08-18 | Same as Cline; consumer target, not competitor on BXR/EB/GS |
| **OpenCode** (anomalyco) | Terminal coding agent; compaction/summarization | (SST lineage, MIT, TS, active) | Agent; MCP consumer; none of BXR/WGR/EB/GS |
| **aider** | Repo-map context, git auto-commit per change (undo via git) | 48,312★ · Apache-2.0 · Python | Git-commit-per-edit ≈ lightweight rewind; no BXR/EB/GS |
| **goose** (block) | Local coding agent, extensible via MCP | 52,962★ · Apache-2.0 · Rust | Agent, not a rewind engine; potential MCP consumer |
| **Augment / Sourcegraph Amp** | Retrieval/context-engine for large codebases | closed · ~$252M / ~$2.6B val | Context = retrieval; markets efficiency but no token-savings *billing*; no BXR/WGR/EB/GS |

### E. Byte-exact record/replay — the direct-overlap tech (BXR exists ONLY as test tooling, never as a savings product)

| Repo | What | Stats | Note |
|---|---|---|---|
| **agenticstash** (davccavalcante) | TS byte-exact replay "by substitution" + **SHA-256 tamper-evident sealing** (cites EU AI Act Art. 12), forking/diff/redaction | Apache-2.0 · OSS | **Closest technical neighbor** — proves the *tech* is not novel. Positioned for compliance/debugging; **no billing, no gainshare, no workspace rewind, no effect barrier** |
| **proxay** (airtasker) | VCR-style HTTP record/replay proxy, language-agnostic | 87★ · TS | Closest architectural cousin; CI test-fixture |
| **FlightBox / promptecho / langchain-replay / mcp-rec / agent-vcr / agentcassette** | "Flight recorder"/cassette record-replay-diff for LLM/agent/MCP calls | 0–283★ | **Every one is a CI test fixture (record-once, replay-offline-for-$0-in-tests)** — none is a production savings proxy, none does WGR/EB/GS |

### F. Gainshare / %-of-savings pricing precedents (the model to RIP — from adjacent infra, none in LLM-savings)

| Precedent | Mechanism | Why it matters to Rewind |
|---|---|---|
| **ProsperOps** | Bills a % of the **realized** savings *as determined by the cloud provider's own bill* — never their own counter. Anchors to **Effective Savings Rate (ESR)**, a standard they got the FinOps Foundation to ratify | **The blueprint.** Defeats "your numbers are made up" by anchoring to a neutral source of truth. Rewind's hash chain = our version of "the provider's bill" |
| **ProsperOps funnel** | Leads with a no-commitment **Free Savings Analysis** — prove savings before charging | Rip the top-of-funnel: replay recent traffic, show hash-attested savings before any charge |
| **nOps** | ~15% of savings **or** 1–2% of spend, *whichever is greater* | The floor **erodes pure alignment** ("feels like a tax") — take only as an *optional* floor, flag the tension |
| **Cast AI** | Not %-share but a **guarantee** ("≥50% savings") | Alternative trust model (guarantee vs share) |
| **Sierra / Nevermined / Zendesk** | Outcome-based pricing (per-resolution / "verified business results") | Outcome pricing is a top-2026 trend, but **every instance bills business outcomes, none bills % of token/cost savings** — the LLM-savings gainshare slot is open |

**Verified failure modes of %-of-savings pricing:** baseline/counterfactual disputes (the "what would you
have spent anyway" number is the whole ballgame); "feels like a tax" once incremental vendor effort is
low; negative/edge-case savings math; verifiability **requires a neutral source of truth + shared
dashboard**. Every trusted player anchors to the provider's billing, not their own meter.

### Checked, didn't hold up
- **RooCodeInc/Roo-Code — ARCHIVED** (2026-05-15, 24,331★); lineage consolidated into Kilo Code (active). **opencode-ai/opencode — ARCHIVED** (13,673★), superseded by SST-lineage `anomalyco/opencode` — two "opencode"s exist, don't conflate.
- **GPTCache — STALE ~13mo** (push 2025-07-11); still top-cited semantic cache but effectively unmaintained.
- **withmartian/martian — no such repo (404)**; Martian is closed/hosted, only 0-star API-directory stubs on GitHub.
- **Cloudflare AI Gateway, OpenRouter, Requesty, Redis LangCache, AWS Bedrock AgentCore** — all closed-source hosted; competitive on messaging, not harvestable, no OSS repo to profile.
- **Windsurf** — still live, changed owner (Codeium→Windsurf; OpenAI deal collapsed; acquired by Cognition 2025).

### White-space synthesis + what to RIP
1. **The moat is the COMBINATION, not any single piece.** Each ingredient exists alone; the assembled
   product (BXR + WGR-incl-bash-side-effects + EB + hash chain + gainshare-on-verified-savings) does not.
   No verified OSS or commercial product occupies it; nearest neighbors overlap ≤2 pillars (Cline = WGR,
   LangGraph = state time-travel).
2. **The effect barrier is the most defensible, least-copied element.** Every coding-agent checkpoint
   (Cursor/Claude Code/Kiro/Cline) rewinds *files* but explicitly does **not** prevent re-firing a spent
   side-effect (bash/API/email) after a rewind. Durable-execution frameworks (Temporal/Inngest/Diagrid)
   only prevent re-fire on RETRY, not across a human/agent rewind. "Refuse-and-record a spent effect
   across a rewind, on a tamper-evident chain" is unclaimed. **Lead with this.**
3. **RIP #1 — ProsperOps' attestation model, wholesale.** Anchor "tokens saved" to the *provider's own
   billed usage* (Anthropic/OpenAI usage API), never Rewind's internal counter; the hash chain attests
   the delta between billed-baseline and replayed-actual. Publish a crisp, hard-to-game definition of a
   "saved call" (replay cache-hit returning byte-identical output). This is the direct antidote to the
   baseline-gaming/distrust failure mode.
4. **RIP #2 — ProsperOps' "Free Savings Analysis" funnel + a shared savings dashboard.** Zero-commitment
   readout that replays recent traffic and shows provable, hash-attested savings before any charge; make
   the dashboard the trust surface. Take nOps' "whichever is greater" only as an optional floor (flag the
   alignment tension).
5. **Honesty flags a reviewer WILL catch (state them first):**
   - "**Undo for agents" is dead as a headline** — Cursor/Claude Code/Kiro/aider/Cline/git-worktrees
     already own workspace rewind. Treat WGR as the substrate, not the pitch.
   - **The record/replay *tech* is already OSS** — agenticstash independently shipped byte-exact replay
     *plus* SHA-256 sealing. Our defensibility is **productization + billing rails + effect semantics**,
     NOT "no one can record LLM calls." Position the moat as the *application*, not the primitive.
   - **Token savings are commoditized by caching** — AI gateways give 30–90% savings free. Gainshare only
     holds if we bill on savings that byte-exact replay produces **which lossy semantic caching cannot
     safely claim** (correctness-guaranteed, replay-identical). The pitch is "**verified/attested
     savings**," not "cheaper" — else customers ask why they don't just turn on a free cache.
6. **The narrow, defensible wedge, stated plainly:** *effect barrier + hash-chain-attested token savings
   billed as gainshare, sitting on a byte-exact-replay substrate that everyone else treats only as a test
   tool* — with local-first/privacy as the deployment posture the hosted gateways structurally can't match.

### Interop / harvest shortlist (from this scan)
- **Be wire-compatible with LiteLLM/Portkey/Helicone** (OpenAI + Anthropic formats) so Rewind drops into
  existing stacks rather than replacing them. TS incumbents (Portkey, Helicone, Langfuse) are the
  language-aligned interop lane; LiteLLM (Python, 56k★) is the gravitational center to sit beside.
- **Study Cline's shadow-git checkpoint** implementation as prior art for the workspace-rewind substrate.
- **Watch Humanlayer** — the only player whose approval-gating overlaps the effect barrier conceptually.
