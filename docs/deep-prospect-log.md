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
