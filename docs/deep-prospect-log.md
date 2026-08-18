# deep-prospect log

## 2026-08-18 — Rewind: prior art, reusable OSS, evidence, distribution

Grounding: Rewind = standalone TS SDK + stdio MCP server giving any coding agent (Claude Code/Cursor/
Cline/Windsurf/Codex CLI) — later Claude.ai/ChatGPT web — git/CoW checkpoint+rewind + refuse-and-record
effect barrier + tamper-evident hash chain; MVP TS-only; distribution/virality is the goal. Strategic
synthesis lives in `POSITIONING.md`; this is the raw verified candidate log.

### Competitors / prior art (GitHub — Lane B)

| Repo | What it does | Stars | Last push | License | Closeness |
|---|---|---|---|---|---|
| New1Direction/korg | Hash-chained signed ledger + replay/rewind of ledger AND workspace (`git read-tree`), MCP-callable | 4 | 2026-06 | MIT | Closest to CHAIN+REWIND half. **No effect barrier.** Rust. Watch it. |
| SeanFDZ/agent-gate | Pre-exec authority gate at proposed→executed seam; vault-backup before destructive ops | 5 | 2026-03 | none | Closest to BARRIER half. **Not rewind-aware.** Python, no license. |
| ThousandBirdsInc/chidori | Durable runtime; every side-effect a recorded host call → byte-identical replay, 0 LLM calls | 1362 | 2026-08 | Apache-2.0 | Effect-record/replay axis, not the barrier. Most mature. Rust core. |
| khalilbalaree/Rewind-MCP | Checkpointing MCP server for Claude Code | 13 | 2025-08 | MIT | Checkpoint+rewind only. **NAME COLLISION.** |
| nicobailon/pi-rewind-hook | Pi-agent file-state rewind via a git ref | 161 | 2026-07 | none | Checkpoint half. **NAME COLLISION** (most-starred). |
| combinatrix-ai/PromptTrail.ts | TS: tools declare re-run-safety / idempotency key; gate refuses silent tools | 2 | 2026-07 | MIT | TS idempotency-declaration idiom ≈ our injected vocabulary. Good pattern ref. |

Framework-level "unsolved" validation (not repos): **microsoft/agent-framework #3938** (checkpoint
retry re-sends `send_email`), **pydantic-ai #7247** (asks for first-class checkpoint/rewind). Best
"incumbents know the problem, haven't solved it" citations.

Academic (Lane C): **ACRFence** (arxiv:2603.20625) — the effect-barrier thesis formalized, closest
prior art. **AgentRewind** (arxiv:2608.14380) — recoverable execution, 30% vs 8% recovery.
**DeltaBox/Crab/Shepherd/ChronoMem/DART/GA-Rollback** — reversibility space is crowded.
Shipped-OSS competitor: **rune0-dev/agent-ledger** (PyPI) — idempotency+replay+intent-bound approvals.

### Reusable building blocks (GitHub — Lane B)

| Package | Take | Stars / last / license | Verdict |
|---|---|---|---|
| @reflink/reflink (npm) | Node CoW reflink (APFS/btrfs/XFS/ReFS), pnpm-maintained | 27★ / 2024-12 / MIT | **IMPORT.** Only clean fit. Pin version, add ext4 fallback + capability detect. |
| New1Direction/korg | HLC causal ordering, `git read-tree` restore-on-rewind pattern | 4★ / MIT | LEARN-FROM (Rust). |
| SeanFDZ/agent-gate | proposed→executed gate seam, literal-only enforcement, identity binding | 5★ / none | LEARN-FROM (don't vendor — no license). |
| ThousandBirdsInc/chidori | "every side effect a recorded host call" → deterministic replay | 1362★ / Apache-2.0 | LEARN-FROM (Rust core). |
| combinatrix-ai/PromptTrail.ts | TS idempotency-key declaration idiom | 2★ / MIT | LEARN-FROM (cherry-pick). |

### Datasets / evidence (HuggingFace — Lane A)

| Dataset | What | Verified stats | Relevance |
|---|---|---|---|
| Anonymousblind/agent-failure-dynamics (AgentHazard) | Coding-agent trajectories, edit-level error labels, stopping rules | 85,050 traj; cc-by-4.0; upd 2026-07 | Strongest match: "agents make bad edits, need rollback." Anonymous → cite cautiously. |
| SWE-bench/SWE-bench_Verified | De-facto coding-agent benchmark, human-validated | 500 tasks; 92,633 dl | Demo venue + credibility; measure token/accuracy delta here. |
| SWE-bench/SWE-smith-trajectories | Coding-agent execution trajectories | ~76k rows; **MIT** | Clean replay fuel (redistributable). |
| obaydata/mcp-agent-trajectory-benchmark | MCP agent trajectories, full tool traces | 49 traj; apache-2.0 | Only MCP-native trace set; small but on-format. |
| GXCafe/ai-agent-failure-logs | Real production silent-failure records | 3,518 records; cc-by-4.0 | "Agents fail silently" narrative color (JP back-office, not code). |

### Checked, didn't hold up
- HF: solsticestudioai/agent-failure-atlas-benchmark ("Synthetic Smoke Set"), Maitreyajayaraj/… (10 dl),
  orlando23/failed_agent_trajectory (mobile-UI), xwang2775/long-horizon-agent-failures (NO license),
  diyuxiaoyemao & ClarusC64 rollback sets (stubs). No HF dataset measures "reversibility saves tokens."
- GitHub: LangGraph "time-travel" debugger cluster (in-memory state, not FS workspace, all near-0★);
  adi-suresh01/rewind (agent memory, name collision); nicokoch/reflink (Rust), KarpelesLab/reflink (Go)
  — wrong language; kiro-mcp-checkpoint / agentcheckpoint / AgentKernel (0★ thin experiments).

### Distribution mechanics (Lane D) — see POSITIONING.md §5 for the full plan
One core + two transports (stdio = full local moat across 5 agents; remote Streamable-HTTP = both webs,
barrier/audit half only). MVP distribution: npm stdio bin + two config snippets + a Claude Code plugin
(only surface that auto-wires the `PreToolUse` barrier) + "Add to Cursor" deeplink. Defer web
connectors + directories. Virality driver: killer demo + `npx`/one-click friction, not registry rank.
