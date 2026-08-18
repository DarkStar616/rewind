# Rewind: positioning & distribution (grounded 2026-08-18)

This is the pressure-tested positioning the plan asked for. It is sourced from a five-lane research
pass (HuggingFace, GitHub, web/papers, distribution mechanics) plus a read of shepherd's own docs.
Where a claim is unsourced, it says so. **Read this before writing marketing copy or the README pitch.**

---

## 1. The honest one-line finding

**The effect barrier is not a novel concept — but the *combination* Rewind ships is genuinely
unshipped, and the correct *implementation* of it is defensible.** Lead with the combination and the
implementation discipline, never with "we invented refuse-and-record."

---

## 2. What the evidence actually supports

| Claim | External support | Honest positioning |
|---|---|---|
| **Reversibility raises recovery / accuracy** | **STRONG.** AgentRewind (arxiv:2608.14380): **30% recovery vs 8%** for plain "continue"; **87.8% vs 43.9%** task success with vs without environment rewind. "Confident and Wrong" (arxiv:2603.25764): GPT-5 submits a patch **100%** of runs, resolves only **44%**. Coherence Collapse (arxiv:2603.24631): 60–69% of failures "edit the correct functions yet still produce incorrect patches" — right state, then wrecked it. | **Cite freely.** This is our strongest evidence-backed claim. It is the *value*, even though the *mechanism* (rewind) is now commodity. |
| **Saves tokens / cost** | **PARTIAL.** Prompt-caching gives 59–90% but that's provider-side prefix caching, **not ours** — don't borrow it. "Fail-Fast, Restart-Smart" (arxiv:2608.03222): early-stopping saves **28–64% of tokens on failed trajectories** for a 1.6–4.2pt success cost. Replay-on-rewind is mechanistically sound but **no public $ number exists.** | Plausible-but-unsourced *for Rewind specifically*. **Opportunity: publish the first real replay-savings number** and own it. Do not claim caching's 90% as ours. |
| **Lightweight / zero-config git+reflink** | Mechanism real but **commodity.** Every major agent already ships rewind: Claude Code `/rewind`, Cline Checkpoints, OpenCode `/undo`, Gemini CLI `/rewind`, Replit App History. DeltaBox/Crab are faster. | True but **not differentiating.** Don't market Tier 0 as the moat (CLAUDE.md already warns this). |
| **Effect barrier = novel headline moat** | **NOT novel.** ACRFence (arxiv:2603.20625, UCSC, Mar 2026) is the thesis formalized — "semantic rollback attacks," effect log, "replay-or-fork semantics," our two invariants verbatim. `rune0-dev/agent-ledger` ships it on PyPI ("AI agents retry. Side effects shouldn't."). LangGraph #8464 is building it natively. Stripe/OpenAI-Agents/Strands ecosystem converging. | **Reposition (see §3).** The concept is claimed. Sell the combination + implementation. |
| **Tamper-evident hash chain** | Well-supported as a *category*: Proof of Execution (arxiv:2607.05397), Right to History (arxiv:2602.20214, EU-AI-Act-motivated), Mandato (arxiv:2608.14074). | Legitimate, on-trend (EU AI Act tailwind). But Notarized Agents (arxiv:2606.04193) critiques self-produced logs as self-attested — **applies to us**; receiver-attestation is a roadmap answer. |

---

## 3. The defensible position (what to actually say)

The barrier *concept* is claimed, but **no one ships the union** Rewind does. Verified via GitHub
(Lane B): `korg` has chain+rewind but no barrier (Rust); `agent-gate` has the gate but is not
rewind-aware (Python, no license); `chidori` records effects for replay but no barrier (Rust);
`agent-ledger` has idempotency+replay but no workspace-rewind and no tamper-evident chain (Python).
And the incumbents have it filed **open and unsolved**: **microsoft/agent-framework #3938** (checkpoint
retry re-sends `send_email`) and **pydantic-ai #7247** (asking for a first-class checkpoint/rewind
primitive). These two are the best "the incumbents know the problem and haven't solved it" citations.

**Our three defensible edges:**
1. **Deterministic** pure-logic barrier — ACRFence's analyzer is an *LLM* (misclassification-prone);
   ours is exact logic over the effect log.
2. **Provably filesystem-independent** — the barrier + chain never read the FS, so the same moat rides
   on *any* checkpoint tier (local git, hosted sandbox, OS jail). No competitor has this portability
   discipline, and it is exactly what lets one core serve both a local and a web surface.
3. **TypeScript + MCP-native** in a field that is otherwise all Python.

**Recommended headline (survives a reviewer's one-search puncture test):**
> The only **deterministic, filesystem-independent, TypeScript-native effect barrier + tamper-evident
> chain** — riding on top of whatever checkpoint tier you use — in a space the research (ACRFence,
> Stop-Means-Stop) has proven **every framework currently gets wrong**.

**The killer demo (the Context7-grade hook):** checkpoint → edit via `bash` → rewind → get **refused**
re-firing a spent effect, with the refusal **verifiable on the hash chain**. That refuse-and-record
moment is the "obviously useful" hook that drives installs.

---

## 4. The naming problem (escalated — decide before first publish)

"Rewind" is **crowded in exactly our niche.** Three live repos: `khalilbalaree/Rewind-MCP` (13★,
literally a checkpoint MCP server — direct functional + name collision), `nicobailon/pi-rewind-hook`
(161★), `adi-suresh01/rewind` (agent memory). None own a `@rewind` npm scope you'd want, but the name
does not read as distinctive here. **Recommendation: treat the name as unresolved and pick a
distinctive one before the first npm publish / marketplace listing.** This is now a blocker for
*publishing*, not just a day-one nicety.

---

## 5. Distribution & virality — the "how do we ship to every agent + both webs"

**The load-bearing fact:** local-rewind (checkpoint/rewind of a real workspace) is **impossible on
web** — Claude.ai and ChatGPT run the MCP server from the vendor's cloud with no local disk/shell
(both confirmed). What survives to web is exactly the portable half our architecture isolates: the
**effect barrier + hash chain read only the effect log and trace, never the FS.** So: **one core, two
transports.**

- **`@rewind/core`** — the moat.
- **stdio transport** (`npx @rewind/mcp`) — where the *full* local moat works. One JSON `mcpServers`
  block (with `"type": "stdio"`, `npx -y @rewind/mcp`) drops into **Claude Code + Cursor + Cline +
  Windsurf unchanged**; one TOML `[mcp_servers.rewind]` block covers **Codex CLI** (the sole outlier).
  Prefer the CLI one-liners `claude mcp add` / `codex mcp add` as the primary documented path.
- **remote Streamable-HTTP transport** — the single transport accepted by *both* Claude.ai custom
  connectors *and* ChatGPT Developer-Mode connectors. Exposes only `guard_effect`/`list`/`verify`
  (the portable half); `checkpoint`/`rewind`/`replay` are no-ops or hosted-backed. **Defer.** (SSE is
  deprecated — target Streamable HTTP only. ChatGPT write-actions are Business/Enterprise-gated.)

### Minimum viable distribution (build these four)
1. **`@rewind/mcp` stdio bin on npm** — the single payload behind every install.
2. **Two copy-paste snippets** on the docs page (JSON `mcpServers` + TOML for Codex) plus the CLI
   one-liners.
3. **A Claude Code plugin in a marketplace repo** bundling the `.mcp.json` **+ a `PreToolUse`
   `guard_effect` hook on `Bash|Write|Edit`.** This is the **only** surface where the effect barrier
   auto-wires with zero user config — the loose snippet gives tools but *not* enforced pre-tool
   interception. `PreToolUse` exit 2 blocks the call = our refuse-and-record path. (To hook the
   plugin's own MCP tools, matchers need the scoped name `mcp__plugin_<plugin>_<server>__<tool>`.)
4. **An "Add to Cursor" deeplink button** on the docs page (`cursor://…/mcp/install?...`) — the proven
   low-friction virality primitive; Windsurf has a `windsurf://` equivalent.

### Defer
- Claude.ai + ChatGPT **web connectors** (need the hosted HTTP transport; local-rewind impossible
  there; only the barrier/audit half ships).
- The two **directories** (Claude Connectors, ChatGPT Apps) — human-reviewed, OAuth-required,
  org-admin/identity-gated, frozen-snapshot. High friction, lagging amplifier. List on **PulseMCP + the
  official MCP registry** instead for early discovery.
- `.mcpb` desktop bundle — Team/Enterprise-Desktop-only; secondary.

### What made dev-tools go viral in 2025-26 (Lane D)
One sharp universal pain + near-zero install friction (`npx` one-liner / one-click) dropping into every
major client from day one. Context7 (~50k★, ~240k weekly npm) is the textbook case: daily pain +
`npx -y` + "Add to Cursor" button + hosted HTTP fallback. Registry #1 placement is a *lagging*
amplifier, not the initial driver. **So: lead with the killer demo (§3), ship `npx` + snippets + the
Cursor deeplink day one, list on registries as amplification.**

### Corrections to the original framing
- "Ship to web as the same core artifact" is only half-true: web needs a *separate remote HTTP
  transport* and can never do local-rewind. Plan for **one core + two transports**, not one artifact.
- The `.mcp.json` snippet alone does **not** install the barrier — only the *plugin* auto-registers the
  `PreToolUse` hook.

---

## 6. Reusable OSS (verified — see `deep-prospect-log.md` for full tables)

- **IMPORT:** `@reflink/reflink` (npm, MIT, pnpm-maintained) — the canonical Node CoW reflink for
  Tier-0. Pin the version (last release 2024-12) and add our own ext4 full-checkout fallback +
  capability detection (CLAUDE.md already mandates this).
- **LEARN-FROM:** `korg` (chain+rewind via `git read-tree`, HLC causal ordering), `agent-gate`
  (proposed→executed gate seam), `chidori` (every side-effect as a recorded host call → deterministic
  replay), `PromptTrail.ts` (TS idiom: tools declare re-run-safety / idempotency key).
- **Evidence / demo surface:** SWE-bench Verified (demo venue + the 44%-resolve number),
  SWE-smith-trajectories (~76k rows, MIT — replay fuel), AgentHazard (85k trajectories, edit-level
  failure labels — cite for "agents make bad edits you must roll back").
