# Agent Rewind — Ultimate Token-Saving Prospect & Cross-Provider Playbook

**Date:** 2026-09-09 · **Method:** `/deep-prospect`, 4 parallel verified lanes (Hugging Face · GitHub token-saving OSS · gateways + client-integration · academic papers). Every stat below was pulled live from a primary source (HF API / `gh api` / paper PDF / official docs) on 2026-09-09 — not from a search snippet. This is a **handoff for codex**: what to build, what to rip, what to avoid, and how to make Rewind usable from every coding client.

> Companion to `docs/RESEARCH-ROADMAP.md` (which already rejected token-level compression for code — corroborated below) and `docs/deep-prospect-log.md` (dated index).

---

## 0. TL;DR — the build order for codex

1. **Ship the prompt-cache breakpoint OPTIMIZER** (auto-place `cache_control` at the longest stable prefix; per-provider min-token thresholds + TTL choice). Highest ROI, **zero correctness risk, exact-replay-preserving.** This is the flagship next feature.
2. **Make prefix-stability a hard invariant** — never let any token-saving feature mutate the request prefix (it can *raise* cost by voiding the vendor cache).
3. **Preserve cache breakpoints across Anthropic↔OpenAI translation** — rip OpenRouter's `cache_control`↔`prompt_cache_breakpoint` mapping; this is what makes "usable across both endpoint styles" real.
4. **Build an honest savings BENCHMARK harness** on real coding-agent traces (permissively-licensed HF datasets below) — plugs the "our 41.2% is one synthetic condition" credibility gap.
5. **(Bounded, opt-in, later)** deterministic append-only **NL-only** context compaction — off the replay-exact path, never code/anchors.
6. **Do NOT** auto-serve semantic-cache hits, build proxy-layer KV reuse, or ship token-level compression on the served path. All three are corroborated as unsafe / infeasible / correctness-breaking below.

**The one finding that reframes the whole product:** on **2,848 provider-billed Claude Code runs, prompt-cache traffic (creation + reads) was ~87% of reconstructed cost / ~80% of the bill** — generated output was a minority ("Token Reduction Is Not Cost Reduction", https://arxiv.org/abs/2607.12161). **The money is in cache reuse, not context shrinkage.** Rewind's record/replay + cache-preservation already targets exactly this; the roadmap below doubles down on it instead of chasing lossy compression.

---

## 1. Grounding — what Rewind is, and the invariant everything is judged against

Rewind v1.0.0 (npm `@agent-rewind/{core,gateway,mcp}`, FSL-1.1) is a **local proxy over hosted vendor APIs** with three **lossless** savings levers:
- **(A) byte-exact record/replay** — a byte-identical request after a rewind/retry is served from a local record at **zero** upstream cost;
- **(B) prompt-cache preservation** — injects one `cache_control` breakpoint on the static prefix so it re-reads at the provider's ~0.1× cache-read rate;
- **(C) deterministic lossless pruning** — collapses byte-identical duplicate `tool_result` blocks.

Adapters: Anthropic (`/v1/messages`), OpenAI (`/v1/chat/completions`), Gemini.

**SACRED INVARIANT — exact-replay determinism: Rewind must NEVER serve a stale/approximate answer.** This is the moat versus every semantic cache in the field, and it is the yardstick for every candidate below. A technique is only "core" if it preserves byte-exact output; anything that rewrites context is at best an opt-in, off-the-replay-path tier, and at worst rejected.

**A proxy over black-box hosted APIs can reshape the bytes it sends** (→ trigger vendor caching, serve its own exact-replay cache — both safe) but **cannot touch model KV tensors** (→ RadixAttention/CacheBlend are out of scope) and must not *rewrite* served context (→ compression/semantic caching threaten the invariant). This single fact sorts the entire landscape.

---

## 2. The prioritized RIP LIST (ranked by savings ÷ correctness-risk ÷ effort)

| # | Do this | Verdict | Exact-replay | Rip from / grounded in | Effort |
|---|---|---|---|---|---|
| 1 | **Prompt-cache breakpoint optimizer** — auto-place `cache_control` at the longest stable observed prefix; honor per-provider min-token + TTL | **IMPLEMENT (core)** | **Preserves** (changes billing metadata only) | OpenRouter mapping; `cacheguardian`, `anthonycho-ux/prompt-cache-gate`, `ingram-technologies/anthropic-cache`; Anthropic/OpenAI/Gemini docs | M |
| 2 | **Prefix-stability guard** — forbid any feature that mutates the prefix; compaction must be append-only/suffix-only | **IMPLEMENT-bounded** (design constraint + lint) | **Preserves** | TokenPilot (2606.17016), Irminsul (2605.05696) | S |
| 3 | **Cache-preserving cross-provider translation** — keep/convert cache breakpoints when translating Anthropic↔OpenAI; provider-sticky routing | **IMPLEMENT** (serves the multi-endpoint goal) | **Preserves** | OpenRouter; Envoy AI Gateway / `theagentrouter/agent-router` (bidirectional translation incl. streaming, tool_use, thinking blocks) | M |
| 4 | **Honest savings benchmark harness** on real coding-agent traces | **IMPLEMENT (credibility)** | N/A (measurement) | HF: `obaydata/mcp-agent-trajectory-benchmark`, `MaxDevv/real-pi-coding-agent-traces-sessions`, `zai-org/LongBench-v2` | M |
| 5 | **Deterministic, append-only, NL-only compaction** — opt-in, off replay path, never code/diffs/anchors | **IMPLEMENT-bounded (later)** | **Threatens** on served path → keep opt-in & deterministic | ACON (2510.00615), "Less Context, Better Agents" (2606.10209); **caution:** Governance Decay (2606.22528) | L |
| 6 | **Advisory "suggest-don't-serve" semantic layer** — surface a similar prior response as a *candidate* to re-verify, never auto-return | **OPTIONAL (far later)** | **Threatens** if served → must be advisory only | vCache per-prompt confidence bound (2502.03771) — **reimplement, CC BY-NC** | L |

### Why #1 is the flagship (measured)
- **Anthropic:** up to **4 breakpoints**/request; **cache read = 0.1× input (90% off)**, write = 1.25× (5-min TTL) or 2× (1-hr TTL); 20-block lookback; min cacheable **1,024 tok** (Opus 4.8 / Sonnet 4.x), 512 (Opus 5), 4,096 (Haiku 4.5). Rule: put `cache_control` on the last block whose prefix is identical across requests. (platform.claude.com prompt-caching docs.)
- **OpenAI:** automatic, **50% discount** on cached input, kicks in ≥1,024 tok in 128-tok increments. (openai.com/index/api-prompt-caching.)
- **Gemini:** implicit ~90% discount no storage fee; explicit 90% (2.5+) / 75% (2.0) + $1/M-tok/hr storage; break-even ≈ 1 read/hour. (geminipricing.com/context-caching.)
- Independent corroboration of the 50–90% headline: "Tail-Optimized Caching for LLM Inference" (https://arxiv.org/abs/2510.15152).
- **Automatic optimal placement is an open research gap** — no dedicated paper found; the deterministic engineering rule (cache system prompt + tool schemas + stable history prefix at the breakpoint boundary, varying content after) is what to ship.

---

## 3. Do NOT build / do NOT do (the correctness wall)

| Anti-pattern | Why (measured) | Source |
|---|---|---|
| **Auto-serve semantic-cache hits** | Error is probabilistic, never zero; correct vs incorrect hits overlap in similarity space (**means 0.84 vs 0.85**); poisonable by collision attacks. Pushing δ→0 collapses hit rate to ~0 (= verify-always). Best-in-class vCache still only *bounds expected* error. | vCache 2502.03771; LaCache 2608.01718; "When Is It Safe to Reuse an Answer?" 2605.27494 |
| **Build proxy-layer KV-cache reuse** | RadixAttention/CacheBlend/LMCache need **inference-server control**; a proxy over hosted APIs cannot touch KV. The only KV reuse available to Rewind is the vendors' own prefix caching (= #1). | SGLang 2312.07104; CacheBlend 2405.16444; `LMCache/LMCache` |
| **Token-level compression on the served path / any code** | **Rejection corroborated AND strengthened for coding agents:** an arm cutting **38.4% of tool-output tokens had +6.8% billed cost** (broke prompt caching); compression cut **patch application 27/40 → 15/40** by corrupting edit anchors; CompressionAttack **avg ASR 0.71** (0.98 on tool-selection). | "Token Reduction Is Not Cost Reduction" 2607.12161; CompressionAttack/COMA 2510.22963; "Prompt Compression in the Wild" 2604.02985 |

**Counter-evidence hunted and rejected:** claims that "code compresses fine" ("The Perplexity Paradox" 2602.15843, resting on a single-author self-cited "Compress or Route?"; "Stingy Context 18:1" 2601.19929) could **not** be substantiated against a credible primary source and contradict the rigorous multi-provider, provider-billed studies above. Given the invariant, weight the adversarial billed-cost evidence. **Recommendation: keep the compression decision closed.**

---

## 4. Cross-provider CLIENT INTEGRATION matrix — "point any client at Rewind"

Verified verbatim from each client's official docs/repo on 2026-09-09. This is the copy-paste table Rewind's install docs should ship.

| Client | Injection mechanism (verbatim) | Gotcha Rewind must document |
|---|---|---|
| **Claude Code** | `ANTHROPIC_BASE_URL=http://localhost:PORT` (Rewind's Anthropic adapter). Auth: `ANTHROPIC_AUTH_TOKEN` → `Authorization: Bearer`, or `ANTHROPIC_API_KEY` → `X-Api-Key`. Extra headers: `ANTHROPIC_CUSTOM_HEADERS` (v2.1.227+). | On a non-`api.anthropic.com` host, Claude Code **disables MCP tool search by default** (`ENABLE_TOOL_SEARCH=true` to re-enable) and **disables Remote Control** (v2.1.196+). |
| **aider** | OpenAI path: `OPENAI_API_BASE` / `--openai-api-base` + `OPENAI_API_KEY`, model `openai/<id>`. Anthropic path (litellm): `ANTHROPIC_API_BASE` + `ANTHROPIC_API_KEY`, model `anthropic/<id>`. | Model name **must carry the provider prefix** so litellm routes correctly. (`ANTHROPIC_API_BASE` is litellm-standard; not shown on aider's own OpenAI-compat page — high confidence, mark verified-by-litellm.) |
| **Codex CLI** | `~/.codex/config.toml`: `model_provider = "rewind"`, `[model_providers.rewind]` `base_url = "http://localhost:PORT/v1"`, `env_key`, `wire_api = "chat"`. | ⚠️ **Load-bearing decision:** official docs disagree on whether `wire_api` now defaults to / requires `"responses"`. **If Codex requires the Responses API, Rewind needs a `/v1/responses` adapter to serve Codex** (currently deferred post-1.0). Confirm against a running Codex before shipping the snippet. Reserved ids `openai`/`ollama`/`lmstudio` can't be reused. |
| **OpenCode** | `opencode.json` → `provider.rewind.options.baseURL = "http://localhost:PORT/v1"` via `@ai-sdk/openai-compatible`; creds via `/connect`. | `@ai-sdk/openai-compatible` = `/v1/chat/completions`. Provider id must match `/connect`. |
| **Cline** | GUI → Settings → API Provider → **OpenAI Compatible** → Base URL `http://localhost:PORT/v1` + API Key + Model ID. | Base URL = root or `/v1` — **not** `/chat/completions`. GUI-only, no env var. |
| **Cursor** | Settings → Models → **Override OpenAI Base URL** → base URL + key + model. OpenAI-compat (`/chat/completions`) only. | 🚫 **Cursor is cloud-routed via `api2.cursor.sh` — it CANNOT reach `http://localhost`.** A local Rewind needs a **public tunnel (Cloudflare Tunnel / ngrok)**. Cursor also silently unchecks the override periodically and disables native models when on. **Document this limitation prominently.** |

**Two product decisions this surfaces for the founder:**
1. **Codex Responses-API adapter** — is `/v1/responses` needed to serve Codex CLI natively? (Currently deferred; the OpenAI adapter is chat-completions only.) This gates "usable from Codex."
2. **Cursor** is the one client that can't hit a local proxy — either document the tunnel workaround or accept it's out of scope for a local-first tool.

---

## 5. Gateway landscape — interoperate & learn, don't rebuild

None of these do byte-exact record/replay for deterministic re-execution — they do response caching (exact or semantic) + observability. Rewind's space is white; borrow the hard-won mechanics.

| Gateway | Stars / License / Last push | What to rip / note |
|---|---|---|
| **OpenRouter** (openrouter.ai) | Closed SaaS | **Closest ref to Rewind's cross-provider cache-preservation:** converts Anthropic `cache_control` ↔ OpenAI `prompt_cache_breakpoint`, provider-sticky routing to keep cache hits. Rip the mapping. |
| **BerriAI/litellm** | 58,361★ · MIT (w/ `enterprise/` carve-out → SPDX NOASSERTION) · active | The de-facto translation layer. **Gap Rewind fills:** its cache does **not** run on the Anthropic `/v1/messages` passthrough — exactly the path Rewind's replay covers. Interoperate, don't out-breadth. |
| **maximhq/bifrost** | 7,917★ · Apache-2.0 · active | **Closest distribution competitor:** ships `npx -y @maximhq/bifrost` zero-config (mirrors Rewind's `npx -y @agent-rewind/mcp`). L1 exact-hash + L2 vector cache — study the split. |
| **Envoy AI Gateway** → `theagentrouter/agent-router` | 2,010★ · Apache-2.0 · active | **Best bidirectional Anthropic↔OpenAI translation** (streaming, tool_use, reasoning/thinking, images). The reference for Rewind's multi-provider adapters. (Repo rebranded to Tetrate — ownership in flux.) |
| **Cloudflare AI Gateway** | Closed SaaS | Exact-match only (hash of provider+endpoint+model+auth+body); header UX `cf-aig-cache-ttl` / `-skip-cache` / `-cache-key` — a clean model for exposing Rewind's replay keys to callers. |
| **Portkey-AI/gateway** | 12,943★ · MIT · 2026-05-25 | Cleanest OSS unified-provider + config-object cache surface (simple=exact, semantic=enterprise). |
| **higress** | 9,334★ · Apache-2.0 · active | Pluggable semantic-cache backends — but k8s-heavy, opposite of Rewind's local posture. Idea only. |
| **Helicone** | 6,139★ · Apache-2.0 · **maintenance mode** (acq. Mintlify 2026-03) | `Cache-Control` header + bucket model; logs full req/resp (≠ deterministic replay). Cite as contrast, don't depend. |

---

## 6. Verified candidate inventory (import decisions with licenses)

### Benchmark datasets (Hugging Face) — the highest-value harvest
| Dataset | dl / likes / license / updated | Verdict |
|---|---|---|
| `obaydata/mcp-agent-trajectory-benchmark` | 992 · 3 · **apache-2.0** · 2026-03-26 | **IMPORT** — 49 real MCP tool-use trajectories; Rewind *is* an MCP server. Smoke/regression set (n<1K). |
| `MaxDevv/real-pi-coding-agent-traces-sessions` | 6,584 · 3 · **"other"** (pi-share) · 2026-07-19 | **ADAPT** — best "does savings hold on real coding runs with backtracking" corpus. ⚠️ license "other" → don't republish numbers until terms checked. |
| `allenai/WildChat-1M` | 20,432 · 459 · **odc-by** · 2024-10-17 | **ADAPT (NL-only bench)** — real NL context to validate any non-code compaction. |
| `zai-org/LongBench-v2` | 73,011 · 56 · **apache-2.0** · 2024-12-20 | **IMPORT** — neutral ground to prove any compression quality/loss claim. |
| `thoughtworks/agentic-coding-trajectories` | 539 · 1 · "other" · 2026-05-04 | ADAPT (bench), license-check. Small. |
| `davongluck/swe-bench-trajectory-quality-subsets` | 83 · 2 · apache-2.0 · 2026-03-28 | ADAPT (curated permissive bench slice). |

### Prompt-cache-breakpoint tooling (GitHub) — technique to rip (all byte-exact safe)
| Repo | Stars / License / Last push | Verdict |
|---|---|---|
| `Portkey-AI/gateway` | 12,943★ · MIT · 2026-05-25 | Architecture ref (adapt idea, don't vendor). |
| `BerriAI/litellm` | 58,361★ · MIT* · active | Exact request-keyed cache = closest mainstream analog to mode-A. Check enterprise-dir boundary before copying code. |
| `kclaka/cacheguardian` | 1★ · MIT · 2026-02-22 | Detects prompt-cache breaks <1ms, auto-optimizes `cache_control` for **Anthropic/OpenAI/Gemini** — Rewind's exact 3-adapter surface. Learn-from (too small to depend). |
| `anthonycho-ux/prompt-cache-gate` | 0★ · **no license** · 2026-09-08 | *Is* Rewind's mode-B: reuse-gated breakpoint injection. Learn-from only (no license → don't copy). |
| `ingram-technologies/anthropic-cache` | 0★ · MIT · 2026-08-23 | Automatic Anthropic caching (Vercel AI SDK/Bedrock). Learn-from. |

### Semantic-cache references (advisory-only, if ever)
| Repo | Stars / License / Last push | Verdict |
|---|---|---|
| `vcache-project/vCache` | 79★ · **CC BY-NC (non-commercial)** · active | Per-prompt confidence bound = the only defensible advisory idea. **Reimplement from paper — cannot vendor (NC).** Still probabilistic → suggest-don't-serve. |
| `zilliztech/GPTCache` | 8,185★ · MIT · **2025-07-11 (~14mo stale)** | The archetype Rewind positions *against* (fixed threshold, can serve wrong answer). Cite as "what we are not." |

### Record/replay (moat confirmation — all CI-scoped, none rewind-aware)
`Gonzih/mock-llm-service` (record/replay LLM proxy, test mock), `jibranusman95/llm_cassette` (streaming-aware VCR for OpenAI+Anthropic, no license), `stlahxm/llm-cassette` (MIT, drift-diff on prompt change — study the hit/miss detection). **Verdict: learn-from; confirms no one ties byte-exact record/replay to rewind as production savings.**

### KV-cache & agent compaction (learn-from-only — wrong layer or lossy)
`LMCache/LMCache` (11,719★ Apache — inference-engine layer, N/A to proxy); `cline/cline` (67,714★), `RooCodeInc/Roo-Code` (24,306★), `Aider-AI/aider` (48,849★ — repomap is the best public "what context to keep" ref, but **lossy** selection). Cite as differentiation; importing either violates the invariant.

---

## 7. Checked, didn't hold up (negative results — save the next search)

- **License landmines (do NOT vendor):** `naver/provence-reranker-*` (cc-by-nc-nd), `vcache-project/vCache` (CC BY-NC), `YaoJiayi/CacheBlend` (no license). Use MIT reimpls (`hotchpotch/open-provence-*`) or re-derive.
- **Wrong domain (name collisions):** `UnicomAI/MeanCache` / `comfyui-meancache` = **image-gen** acceleration, not LLM cache; `*/RequestChain` = Android/ASP.NET request-ID middleware.
- **Stale / maintenance:** `zilliztech/GPTCache` (~14mo), `Helicone` (maintenance mode), `vitobotta/openai-prompt-cache-proxy` (~19mo).
- **Stubs / research-only, not importable:** `500xCompressor` (paper only, not on HF), `sggetao/icae` (~0 dl), `RECOMP` (only GGUF forks), C3 Context-Cascade-Compression (GPU, lossy reconstruction). Learn-from at most.
- **UNVERIFIED (flagged, not guessed):** Codex `wire_api` current default (chat vs responses) — **load-bearing, confirm before publishing the Codex snippet**; aider `ANTHROPIC_API_BASE` on aider's own page; `Martian`/`Unify`/`Requesty` gateway status; OpenCode star count anomaly (`gh api` returned 206k on the redirect target).
- **No corpus exists** of raw LLM request/response logs or prompt-cache benchmarks on HF — Rewind must generate its own bench from the trajectory datasets above.

---

## 8. Open decisions for the founder (hand to codex with an answer)

1. **`/v1/responses` adapter for Codex CLI?** — gates native Codex usability. Needs confirmation of Codex's current `wire_api` requirement.
2. **Ship the advisory semantic layer at all?** — recommendation: **defer**; it fights the sacred invariant and adds an attack surface for marginal, unsafe gain. The confidence-bound idea is worth keeping on the shelf, not building now.
3. **Reopen the compression decision?** — recommendation: **no.** Corroborated and strengthened; for coding agents it *raised* cost and broke patches.
4. **Prefix-stability lint/guard** — cheap, high-leverage: add a check that no savings feature mutates the request prefix. Prevents the "cut tokens, raise cost" foot-gun the billed-cost study documented.
