# Rewind’s competitive position and token-efficiency opportunity

## Assessment

Rewind is a promising, technically substantial development build. It is not yet a demonstrated world-class token-saving product or an enterprise-ready release. Its strongest implemented characteristics are explicit ordered replay, an encrypted transactional storage foundation, transport-aware response validation, compact MCP interfaces, and a willingness to distinguish measurements from estimates. Its most important weaknesses are incomplete integration, an unresolved replay-identity defect, and the absence of representative, provider-billed, quality-controlled savings evidence.

The defensible product opportunity is **dependable agent recovery with independently inspectable efficiency evidence**. The market already has exact caches, durable execution, sealed replay, context reducers, and native provider cache diagnostics. A superiority claim must come from better behavior on defined workloads and clearer operating guarantees. It cannot come from counting features or claiming that the ingredients are unique.

This assessment covers the private Rewind development branch at `f36fc72`, as observed on 9 September 2026. The current npm/package version remains 1.0.0; draft PR #4 is development work toward 1.1. Public-source findings describe documentation and inspected implementations, not a head-to-head execution benchmark. Neither competitors’ marketing percentages nor academic results are measured Rewind savings.

## What the build actually establishes

| Area | Evidence in the development branch | Assessment |
| --- | --- | --- |
| Exact response replay | Provider adapters, response validation, binary occurrence records, strict ordered cursors and retry identities | Substantial implementation; replay eligibility and identity need further hardening |
| Durable storage | SQLite worker, encrypted values and staging, atomic optimistic transactions, queue bounds, managed WAL admission | A strong substrate; lifecycle and all production adapters are unfinished |
| Restart behavior | Gateway/CLI recording and ordered replay survive reopening storage | Demonstrated narrow workflow, not complete recovery orchestration |
| Protocol coverage | Anthropic, Chat Completions, Responses and Gemini adapter paths | Useful coverage; protocol presence is not complete support for every provider feature |
| Token-conscious interface | Lean/recovery/analytics/all MCP profiles; compact analysis output and incremental NDJSON | A measurable improvement in Rewind’s own context footprint |
| Savings proof | Versioned benchmark artifact, source hashes, explicit simulated results | Good evidence structure; real-workload financial benefit remains unmeasured |
| Production accounting | Pure mechanism ledger exists; durable replay is not connected to savings receipts | Incomplete and unsuitable as a gainshare billing authority |
| Enterprise operation | Trusted tenant option and encrypted storage | Necessary components, not certification, deployment maturity or full governance |

The read-only audit reran `npm run check` at this head: TypeScript and 417 tests passed. The prior package build also passed; the build was not rerun for this research-only inspection. A local fixture demonstrated Responses replay, encrypted storage close/reopen replay, and a real MCP checkpoint. These checks establish particular behaviors. They do not establish production incident rates, general savings, or absence of defects. The known `__proto__` collision is a concrete counterexample to treating a green suite as sufficient assurance.

The lean MCP surface measures 2,762 characters, compared with 9,359 for the earlier full surface: approximately **70.5% fewer characters**. Dividing by four gives about 691 versus 2,340 estimated tokens. That is a comparison of different tool surfaces, not an exact tokenizer measurement or a 70.5% reduction in whole-agent expenditure. The executable nine-call benchmark’s 28.08% result is simulated and workload-specific.

### Additional release blockers verified in the code audit

The gateway currently lacks a policy separating ordinary inference from hosted
web search or other provider-side tools. Its request identity retains only a
small allowlist of headers. Tape epochs/cursors are supplied manually and are
not bound to the engine's restored checkpoint. These gaps can create stale or
incorrect reuse despite an intact encrypted recording.

The runtime price fallback is not guaranteed conservative, and pricing a recorded
call does not establish the marginal cost of a later avoided call. Durable replay
still lacks receipt wiring. Storage retention, key rotation and full lifecycle
operation remain unfinished. These are release conditions, not cosmetic polish.

The installed MCP default remains `all`; the 70.5% character reduction requires
selecting `lean`. Existing history tools are not yet paginated. The research
therefore recommends making the compact path usable in the installed product and
measuring the actual client-visible result.

### Corrections to earlier positioning

Several earlier statements need narrower wording:

- **“Unoccupied moat” is not established.** Public implementations overlap with every major ingredient, including ordered sealed replay.
- **“Lossless pruning” does not establish unchanged model behavior.** Keeping one copy of repeated information preserves content availability, but changing its position, repetition or presentation can change an agent’s decisions.
- **“Zero correctness risk” is too strong for cache optimization.** Metadata translation, model-specific schemas, invalidation, rejected requests and compatibility failures all require testing.
- **“Hash-attested savings” is not equivalent to a provider bill.** A hash chain can make later alteration detectable. It cannot establish that a counterfactual cost was correct when recorded.
- **“Exact response” does not imply “fresh response.”** The same request may depend on external tools, current data, provider-managed state or model changes. Replay needs an explicit historical-recovery contract.

## Research findings that change the roadmap

### Cost composition is not savings headroom

Weinberger and Hozez’s provider-billed study reports 2,908 primary-campaign runs, with 2,848 analyzed, and cache traffic accounting for approximately 80% of the actual bill. Crucially, it estimates only about 6% of cost as addressable by the evaluated user-side surfaces; much cached content was framework-owned. Its aggressive reduction arm removed 38.4% of tool tokens while increasing billed cost by 6.8%. These are findings about particular interventions and workloads, not a universal ceiling for Rewind. The relevant lesson is to measure incremental benefit against an already optimized native client.[^billed]

Rewind can avoid an entire eligible model call through replay, which is a different intervention from shortening shell output. That opportunity depends on how frequently a customer legitimately repeats a recoverable call. A workload with few eligible repetitions may obtain little benefit from replay, even if every hit is perfectly implemented. Measuring the eligible-repeat rate should precede forecasting revenue or savings.

### Context reduction has both positive and negative evidence

| Research | Result relevant to Rewind | Boundary on interpretation |
| --- | --- | --- |
| **The Complexity Trap** | On SWE-bench Verified, observation masking often matched summarization at lower cost. For Qwen3-Coder, cost fell from $1.29 to $0.61 and solve rate was 53.4% versus 54.8%. For thinking Gemini, masking reduced cost but solve rate fell from 40.4% to 36.4%. | The quality change is model-dependent. Window settings also depended on the agent scaffold. Lower cost is not automatically an acceptable trade.[^masking] |
| **TokenPilot** | An isolated-mode ablation reduced modeled expenditure from $8.31 to $4.35 with prefix stabilization, then $2.87 with reduction passes. Removing recovery reduced the reported task score. | Uses GPT-5.4-mini on PinchBench/Claw-Eval with API usage and a specified price model. Harness-owned placeholder changes and semantic lifecycle decisions cannot be copied blindly into an arbitrary proxy.[^pilot] |
| **ContextPipe** | Proposes context-source catalogs, staged assembly and an EXPLAIN-style trace. Preliminary results report 31% fewer tokens and 23% fewer calls despite a lower cache-hit ratio. | Only three Qutebrowser instances were evaluated; important ablations remain open. The architecture is more persuasive than a broad performance claim.[^pipe] |
| **SWE-Pruner** | Reports 23–38% token reduction and 1.2–1.4 percentage-point success improvements on SWE-bench through query-conditioned line selection. | Uses a trained neural skimmer, focuses on Python repositories and adds inference overhead. This is counter-evidence to “all code selection fails,” not permission to rewrite exact edit anchors.[^pruner] |
| **Context as a Tool** | Treats context management as an explicit operation in the agent’s decision process. | A useful architectural neighbor; its abstract is insufficient to establish Rewind-compatible savings or production readiness.[^cat] |

These results are compatible once their baselines and interventions are distinguished. Removing information can reduce repeated input, but can also cause extra retrieval, longer reasoning, broken edits, or cache rebuilds. A powerful coding assistant may already perform much of the useful reduction. Rewind should retain its conservative replay path and evaluate optional context transformations separately, with preserved originals and task-level quality gates.

A useful refinement to “never change the prefix” is **stable prefixes within explicit cache epochs**. Appending ordinary observations should preserve already-sent history. A deliberate, infrequent compaction can start a new epoch, with its cost and effect measured. An absolute ban on every historical change would eventually conflict with finite context windows; uncontrolled changes each turn would destroy predictable caching.

### Native providers are moving the baseline

OpenAI’s current documentation distinguishes model generations. GPT-5.6 and later support explicit breakpoints, cache-write charging and `prompt_cache_options.ttl`; older models use different policies. `prompt_cache_key` influences routing but does not guarantee a hit. Rewind therefore needs a versioned provider/model capability registry, not a universal “OpenAI caching is free to create” assumption.[^openai-cache]

OpenAI also exposes request-comparison diagnostics through `comparison_response_id`, reporting reasons for missed reuse. These are useful evidence inputs, not proof that Rewind caused a saving. A Rewind diagnostic view can combine provider explanations with local transport and transformation provenance.[^diagnostics]

Anthropic supports automatic top-level cache control as well as explicit markers, with model-specific thresholds, TTL pricing and breakpoint constraints. A caller that already manages caching may need no injection. Optimizing only static tools misses opportunities in growing conversation history, but modifying caller policy without proving compatibility can make things worse.[^anthropic-cache]

Gemini’s current documentation separates implicit caching in the Interactions API from explicit cache resources in the Generate Content API. Explicit resources carry storage-duration costs. Endpoint compatibility and lifecycle economics must be part of the design, not an assumed universal Gemini cache adapter.[^gemini][^gemini-explicit]

Native compaction also matters. OpenAI returns opaque compaction items with prescribed continuation behavior; Anthropic documents that context editing can invalidate cached prefixes and can interact with preserved thinking. A proxy should preserve these contracts and avoid interpreting opaque state as ordinary text.[^compact][^context-edit]

### A proxy can accidentally remove native savings

Claude Code documents that a custom `ANTHROPIC_BASE_URL` disables tool search by default because many proxies do not support `tool_reference` blocks. Explicit configuration can override the fallback, subject to supported models and managed policy. This makes client conformance an economic requirement: a small Rewind tool surface cannot compensate reliably for eagerly loading a large external tool catalog.[^claude-mcp]

Claude Code’s own caching guide also distinguishes deferred tools from tools loaded into the prefix. Changes to upfront definitions can invalidate reuse. The relevant benchmark must therefore compare native client behavior, transparent proxy behavior and enabled Rewind optimization—not simply compare Rewind with an artificial uncached baseline.[^claude-cache]

## Competitive comparison

| System | Established overlap | Implication for Rewind |
| --- | --- | --- |
| **Bifrost** | Normalized direct-response caching exists without semantic lookup; optional semantic caching is separate. Its inspected text projection lowercases and trims inputs. | Compare identity policy, commit semantics and operator visibility. Do not import this normalization into Rewind’s exact replay identity.[^bifrost] |
| **LiteLLM** | Exact caching, namespaces, TTL and backend controls. Its documentation warns against semantic caching for multi-turn agent traffic. | Interoperate with gateway conventions and make strict-replay failure semantics explicit.[^litellm] |
| **Helicone** | Multiple response samples can be stored for an identical request; inspected implementation chooses randomly from a bucket. | Multiple-sample storage is established. An explicit ordered cursor and retry contract are a more specific distinction.[^helicone] |
| **Portkey** | Hosted exact/semantic caching, namespaces and lifecycle controls; public middleware is not the same feature set as the hosted product. | Avoid comparing Rewind code with an undifferentiated mixture of OSS and commercial promises.[^portkey] |
| **LangGraph** | Checkpoints, persistence, time travel and branching. Nodes after a selected checkpoint execute again. | Recovery is established territory. Exact recorded HTTP substitution plus workspace recovery is a particular integration choice.[^langgraph] |
| **RTK** | Command-specific reductions with recoverable raw output in current inspected source. | Recovery-backed reduction is not unique; compare total task behavior, recovery latency and omitted-information failures.[^rtk] |
| **Headroom** | Cache-preserving proxy mode and retrieval of stored originals through CCR. | Direct overlap with the proposed context/CAS direction. Rewind must prove better fidelity, integration or operation.[^headroom] |
| **agenticstash** | Per-channel/key occurrence cursors, input divergence checks, forks and SHA-256 seals. | A counterexample to uniqueness of ordered sealed replay. Its seal covers selected event fields and referenced payloads, not every recording field; raw HTTP and world/effect fidelity remain separate.[^stash] |

No competitor was installed or benchmarked as part of this comparison. Source inspection establishes implementation overlap, not production reliability or a winner. Development-head features may differ from released versions. No numerical “world-class score,” market ranking or universal performance advantage is supported.

The strategic opportunity is still meaningful. Combining recoverable execution, exact artifacts, accounting and usable local deployment can reduce integration work for an enterprise buyer. That advantage becomes defensible through a strong operational contract, reproducible workload results and adoption—not through the mere presence of SQLite, hashes or caching.

## The stronger product architecture

Rewind should expose three distinct, cooperating functions.

**Recovery** records eligible model interactions and links them to workspace checkpoints, explicit execution epochs and effect state. Historical replay reproduces what happened. A divergence report explains why a requested continuation cannot reuse the tape. Creating a live fork is an explicit operation, with visible cost and a fresh identity.

**Context delivery** limits what enters the model at the tool boundary. Exact artifacts stay in durable storage; the agent receives bounded results, stable handles and enough information to decide whether to retrieve more. Small outputs remain inline. Edit anchors, failing assertions, user constraints and relevant security findings are pinned according to an explicit contract. This function is easiest to integrate inside Athena, where the runtime owns tool execution and context assembly.

**Efficiency evidence** records provider usage, cache decisions, replay deliveries, transformations, additional retrieval and task outcomes. It explains observed behavior without conflating estimates with paid invoices. The same data supports a human report and regression gates.

Anthropic’s engineering guidance supports just-in-time context acquisition and processing tool data in code before returning only relevant results to the model. Its published examples show large context reductions, but they are examples rather than a general savings guarantee.[^context-engineering][^code-mcp] Its tool-use guidance also notes that discovery is less beneficial for small, compact tool libraries; Rewind’s three-tool lean interface does not need an elaborate search mechanism merely to imitate a larger platform.[^advanced-tools]

### New priority: an explainable context plan

Add a compact, deterministic report for each request:

- Selected provider/model/endpoint and capability-policy version.
- Existing caller cache policy and whether Rewind changed anything.
- Stable-prefix fingerprint, first changed segment, and native diagnostic reason when available.
- Exact replay eligibility, epoch, cursor and reason for refusal or bypass.
- Content included, omitted or referenced, with original-artifact handles.
- Observed usage, estimated marginal cost and the next measurement needed to resolve uncertainty.

This is a practical application of ContextPipe’s architectural idea. It need not begin as a general optimizer or a new language. A typed manifest over existing paths is sufficient for the first version. Keep it out of the model’s normal context; return a short summary and an inspection handle.

### New priority: cost-aware intervention gates

An intervention should estimate its economic effect before changing a request. Let:

`expected benefit = avoided future input cost − cache rebuild premium − transformation cost − expected retrieval/recovery cost`

Apply an optional transformation only when the benefit is positive with a conservative margin and its quality contract is satisfied. The expected number of remaining turns and reuse probability are uncertain, so report them as assumptions. Prefer an abstention to a fabricated saving. Near the context limit, continuation feasibility can justify compaction even when its immediate financial benefit is uncertain; label that reason separately.

This prevents two common mistakes: paying to cache a prefix that will never be reused, and saving cheap cached tokens while causing a more expensive model turn. It also explains why the best policy depends on the client, model, task and session phase.

## Accounting that can withstand scrutiny

The principal outcome metric should be:

`cost per accepted task = all evaluated run costs / number of accepted tasks`

Include failed runs, extra retrieval, summaries, retries, tool charges, storage and any extra model calls. Report solve rate and cost distribution alongside the ratio. If nothing succeeds, the ratio is undefined, not zero. Human rework time should be reported separately unless a documented valuation is agreed.

Provider token counts establish usage for the call that occurred. They do not reveal the exact cost of a call that was avoided later. For example, a recorded first call might contain cache writes; a later equivalent call might have read a warm cache. Reusing the first call’s cost as a certain saving can overstate the counterfactual. Likewise, an unknown-model fallback rate cannot be guaranteed conservative when cheaper or contracted models exist.

Maintain separate fields for **actual provider spend**, **historical record cost**, **estimated avoided cost**, and **measured incremental savings from an experiment**. A record may support multiple independently avoided requests, while a retry of the same logical request must not become a second saving. Cache discounts already supplied by a client/provider should not be automatically attributed to Rewind.

This is a stronger commercial foundation than a percentage counter. It makes disagreements about pricing, baseline behavior and retries inspectable. The hash chain can protect the integrity of the recorded evidence while the experiment establishes the causal benefit.

## Proof required for a leadership claim

A credible evaluation needs both transport-level correctness and full agent tasks. SWE-bench provides executable task evaluation infrastructure; it should be supplemented with representative private workflows and recovery-heavy tasks rather than treated as a complete enterprise acceptance suite.[^swebench] Agent evaluation guidance likewise distinguishes the trajectory from the final outcome and encourages multiple trials and appropriate graders.[^evals]

Use at least these experimental arms:

| Arm | Question answered |
| --- | --- |
| Native client, normal caching | What does the customer already get? |
| Transparent Rewind transport, optimizations off | Does adding the proxy itself change cost, latency or behavior? |
| Cache-policy improvements only | What incremental benefit comes from cache decisions? |
| Eligible historical replay only | What is the benefit at the customer’s actual recovery frequency? |
| Bounded, recoverable tool results | Do input reductions survive added retrieval and quality costs? |
| Combined configuration | Do the mechanisms compose, or interfere? |

Pin client/model versions, policies, repository snapshots and task graders. Randomize arm order and account for warm-cache carryover. Separate cold-start, warm-continuation and post-idle sessions. Include small tasks, long tasks, unique requests, repeated requests, intentional divergence, unavailable retrieval and process restart.

Predeclare acceptable quality loss—preferably none for the conservative path—and a statistical non-inferiority policy for optional transformations. A small pilot is a feasibility signal, not proof of a tiny regression bound. Report paired uncertainty intervals, token categories, time to first token, end-to-end duration, memory/disk pressure, and restoration correctness. Keep every failed or excluded run with its reason.

No honest total savings forecast is available before this experiment. A useful release target is a reproducible reduction in cost per accepted task on a declared workload, with no critical fidelity failure and no regression against native-client capabilities. A target is a decision rule, not a result.

## Recommended direction

First close identity, eligibility and accounting gaps. Then preserve native client efficiencies and add provider-aware diagnostics. Optimize known stable prefixes and reduce oversized outputs at ingestion with exact recovery available. Finally evaluate selective compaction and more ambitious retrieval policies on separate experimental paths.

The existing broad v1.1 plan remains useful as a capability inventory. The accompanying roadmap addendum reorganizes its delivery around measurable customer outcomes. It keeps deferred functionality visible while making the first enterprise pilot smaller, more explainable and easier to validate.

The strongest future claim would be specific: **on these workloads, with these clients and versions, Rewind reduced accepted-task cost by this measured amount, preserved these recovery guarantees, and exposed every decision needed to reproduce the result.** That is a claim an enterprise buyer can evaluate.

## Sources

Public pages were accessed on 9 September 2026. Research percentages below describe their original experiments. Dynamic product documentation should be rechecked before implementation.

[^billed]: Sarel Weinberger and Amir Hozez, “Token Reduction Is Not Cost Reduction: An Empirical Study of End-to-End Efficiency in API-Based Coding Agents,” arXiv v5, 12 August 2026. [Full paper](https://arxiv.org/html/2607.12161v5), especially cost attribution and limitations.
[^masking]: Tobias Lindenbauer et al., “The Complexity Trap,” arXiv v3, 27 October 2025. [Full paper](https://arxiv.org/html/2508.21433v3), Tables 1 and 4; [released data](https://huggingface.co/datasets/JetBrains-Research/the-complexity-trap). Data license must be checked before importing artifacts.
[^pilot]: “TokenPilot: Cache-Efficient Context Management for LLM Agents,” arXiv v1, June 2026. [Full paper](https://arxiv.org/html/2606.17016v1), Tables 3–5 and cost-model appendix.
[^pipe]: Peng Xu et al., “ContextPipe: Database-Inspired Context Assembly for Long-Horizon Agents,” arXiv v1, 1 September 2026. [Full paper](https://arxiv.org/html/2609.00749v1), evaluation and limitations.
[^pruner]: “SWE-Pruner: Self-Adaptive Context Pruning for Coding Agents,” arXiv, 2026. [Paper and version history](https://arxiv.org/abs/2601.16746); conclusion, training appendix and limitations.
[^cat]: “Context as a Tool: Context Management for Long-Horizon SWE-Agents,” arXiv, December 2025. [Abstract and version history](https://arxiv.org/abs/2512.22087). Architectural background only.
[^openai-cache]: OpenAI, [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), model-difference and routing sections.
[^diagnostics]: OpenAI, [Prompt cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics), availability, comparison semantics and limitations.
[^anthropic-cache]: Anthropic, [Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), automatic caching, pricing and invalidation.
[^gemini]: Google, [Context caching](https://ai.google.dev/gemini-api/docs/caching), updated 2 September 2026, Interactions API scope.
[^gemini-explicit]: Google, [Generate Content context caching](https://ai.google.dev/gemini-api/docs/generate-content/caching), updated 2 September 2026, explicit resources and duration charges.
[^compact]: OpenAI, [Compaction](https://developers.openai.com/api/docs/guides/compaction), opaque items and continuation contract.
[^context-edit]: Anthropic, [Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing), cache invalidation and thinking compatibility.
[^claude-mcp]: Anthropic, [Claude Code MCP documentation](https://code.claude.com/docs/en/mcp), “Configure tool search.”
[^claude-cache]: Anthropic, [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching), tool-definition and compaction behavior.
[^bifrost]: Maxim, [Bifrost caching](https://docs.getbifrost.ai/features/semantic-caching); [cache implementation](https://github.com/maximhq/bifrost/blob/1d89501c733e94feeadce1b1ec9f0b76ec0a670f/plugins/semanticcache/main.go). Development source inspected; not execution-tested.
[^litellm]: BerriAI, [LiteLLM caching](https://docs.litellm.ai/docs/proxy/caching); [implementation](https://github.com/BerriAI/litellm/blob/main/litellm/caching/caching.py).
[^helicone]: Helicone, [LLM caching](https://docs.helicone.ai/features/advanced-usage/caching); [sample-selection implementation](https://github.com/Helicone/helicone/blob/ca34549ea56f7ed587843f82d9cc19baa1f36ba4/worker/src/lib/util/cache/cacheFunctions.ts).
[^portkey]: Portkey, [Cache documentation](https://portkey.ai/docs/product/ai-gateway/cache-simple-and-semantic); [public middleware](https://github.com/Portkey-AI/gateway/blob/669825cbe89ee51569918b8f78a9db486fd69dd4/src/middlewares/cache/index.ts).
[^langgraph]: LangChain, [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence) and [Time travel](https://docs.langchain.com/oss/python/langgraph/use-time-travel).
[^rtk]: RTK, [repository](https://github.com/rtk-ai/rtk), [Git filters](https://github.com/rtk-ai/rtk/blob/8e9aa04cb2afb189747fac4e36bec2254ddd0564/src/cmds/git/git.rs) and [recovery dispatch](https://github.com/rtk-ai/rtk/blob/8e9aa04cb2afb189747fac4e36bec2254ddd0564/src/core/tee.rs).
[^headroom]: Headroom, [current profile source](https://github.com/headroomlabs-ai/headroom/blob/7bd4dbaf8f40d00f579f1cfca4bc56716f508d85/headroom/agent_savings.py) and [CCR documentation](https://docs.headroomlabs.ai/docs/ccr). Older documentation and current defaults may differ.
[^stash]: agenticstash, [project](https://github.com/davccavalcante/agenticstash), [replay](https://github.com/davccavalcante/agenticstash/blob/b73efb4378df37de893901b9016abf6498f2474f/src/replay/index.ts) and [sealing](https://github.com/davccavalcante/agenticstash/blob/b73efb4378df37de893901b9016abf6498f2474f/src/seal/index.ts).
[^context-engineering]: Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), 29 September 2025.
[^code-mcp]: Anthropic, [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp), 4 November 2025.
[^advanced-tools]: Anthropic, [Introducing advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use), 24 November 2025.
[^swebench]: SWE-bench, [evaluation documentation](https://www.swebench.com/SWE-bench/) and [evaluation harness](https://github.com/SWE-bench/SWE-bench).
[^evals]: Anthropic, [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), 9 January 2026.

### Local implementation references

- `packages/gateway/src/proxy.ts`, `record-store-v2.ts`, `storage/`: gateway and storage behavior.
- `packages/gateway/src/canonical-request.ts`: identity projection; unresolved collision.
- `packages/gateway/src/cache-preserve.ts`, `prune.ts`, `meter.ts`: existing policy and accounting limits.
- `packages/mcp/src/mcp-profile.ts`, `analyze-input.ts`, `gateway-config.ts`: profiles, bounded analysis and configuration.
- `docs/V1.1-EXECUTION.md`: implemented slices and dated verification evidence.
- `docs/residual-review-findings/2026-09-09-core-oracle-review.md`: reproduction, proposed repair and oracle-review requirements.
- `docs/plans/2026-09-09-001-perf-maximize-token-savings-plan.md`: accepted implementation inventory, preserved unchanged.
