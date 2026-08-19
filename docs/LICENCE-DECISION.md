# Agent Rewind — licence & code-protection decision (research-grounded 2026-08-18)

Four-lane research (protectability · empirical licence models · licence menu · theft/moat) + a running
deep-research pass. Findings are unanimous and well-sourced. **This corrects the earlier "publish an
obfuscated closed binary" tactic — that specific move is refuted by the evidence below.** It does NOT
change the goal (proprietary, defensible, sell access, bill on savings); it changes how we get there.

## The uncomfortable finding: you cannot hide the code, and trying hurts you

- **Every local-hiding method is a speed bump, not a wall.** Obfuscation is reversed in minutes by free
  tools (webcrack + the LLM renamer "humanify"); Node SEA / `pkg` / **Bun-compile** embed extractable
  JS (public one-command extractors exist); V8 bytecode buys hours-to-days and leaves all strings in
  cleartext; WASM protects only the slice you rewrite and costs a full rewrite. Sources: obfuscator.io,
  BeDefended, PT SWARM, electron-vite, arXiv 2411.02278.
- **The exact-category precedent is brutal:** **Claude Code ships as a Bun-compiled binary and its
  source was extracted wholesale** by the public `unbuned` tool ("10.9 MB… Anthropic SDK code, tool
  definitions, CLI internals"). A shipped agent CLI gets extracted regardless of the wrapper.
- **Obfuscation also taxes an MCP server in an agent's inner loop** — strong presets inflate runtime
  40–295% and size 1,600–7,500%.
- **Our core ideas are already public anyway:** the effect barrier is formalized in **ACRFence
  (arXiv:2603.20625)** including our "authority resurrection" case; **agent-ledger** ships
  idempotency+replay on PyPI; **LangGraph 1.2** ships durable idempotency; whole-workspace rewind is
  commodity (Claude Code/Gemini CLI/Cline/OpenCode). Hiding source protects a secret that isn't secret.

## The empirical reality of this niche

- **There is NO successful closed-source, locally-run, viral MCP server or agent component. Zero.**
  Every breakout is permissively licensed (Context7 MIT 61k★/4.6M dl-mo; Playwright MCP Apache 36k★;
  Cline Apache 66k★; OpenHands MIT 84k★; Codex CLI Apache; …).
- **The two closed exceptions (Cursor, Claude Code) monetize a captive paid MODEL**, not hidden code.
  Agent Rewind ships no model, so it can't borrow that moat.
- **Warp is the cautionary tale:** a closed, login-required *terminal* (same "touches everything" trust
  profile as Agent Rewind) — "a dealbreaker for a tool this sensitive"; it reversed and open-sourced (2026).
- **Closing a shell+write tool is audit- and procurement-hostile** (SBOM/supply-chain review flags
  opaque packages with filesystem reach) — you'd earn the friction without earning the secrecy.

## What this means — "proprietary" should mean protect the money, not the source

Everything you actually want survives, and gets *stronger*, when the protection moves off the device:
- **Sell access** → license key + server-side entitlement (online activation / periodic check-in).
  Gate usage and features by key. **This survives and is the right mechanism** (it was the correct half
  of the earlier answer).
- **Defensibility** → a **licence** a competitor can't legally build a rival product on (below), plus
  the architectural moat that never ships to a device: the **hosted team tier** (server-side), the
  **Athena authority resolver** (kept private via the injection seam, never in `@agent-rewind/core`), the
  **savings-data flywheel**, and **distribution/first-mover**.
- **Bill on savings** → the tamper-evident hash chain is your **billing meter**; the honest-counterfactual
  metering is **invoice integrity**; server-side receipt validation stops under-reporting. (Unchanged and
  reinforced — see `SAVINGS-RECEIPT.md`.)

## The licence options (competitor-forbidden / source-public / converts-to-open)

| Option | A competitor legally CANNOT… | Source public? | Fit |
|---|---|---|---|
| **FSL-1.1-Apache-2.0 (Fair Source)** — *recommended* | ship a competing/substituting commercial or hosted product, or resell it | **Yes (auditable)** | blocks rivals, keeps viral install + trust; converts to Apache-2.0 after 2 yrs |
| Apache-2.0 open-core | (nothing at the core; they may fork) | Yes | max growth, zero code-level legal moat; all defence server-side |
| Fully proprietary EULA + closed binary | use/copy/redistribute source | No | max legal restriction, but source is extractable anyway + audit/procurement friction + no viral precedent |
| Elastic-2.0 | offer it as a **hosted/managed service** only | Yes | guards the wrong flank (we're local-first); never converts |
| BSL-1.1 | any production use unless granted | Yes | FSL fixes its 4-yr clock + bespoke-grant friction |
| SSPL | offer as a service w/o releasing all service source | Yes | toxic/enterprise-banned; wrong threat |

**Legal facts confirmed:** shepherd being MIT imposes only attribution — Agent Rewind may license itself any
way. Under common ownership, the **hosted tier and Athena stay fully closed under EVERY option** (the
licensor isn't bound by its own outbound licence). A private npm registry is optional, not required.

## Recommendation

**FSL-1.1-Apache-2.0, flown under the "Fair Source" banner, for `@agent-rewind/core` + `@agent-rewind/mcp`; hosted
tier + Athena as separate fully-closed proprietary packages; sell access via license keys.** It is the
one option that is *legally proprietary/defensible* (no one can build a competing rewind on it) **and**
keeps the frictionless install + the auditability a shell-touching tool needs to be trusted and to pass
procurement — while the money and the real moat live server-side. Apache-2.0 future variant chosen for
the patent grant over the effect-barrier/hash-chain mechanics. Confirm exact SPDX string + run a
dependency licence-scan before first publish. *Not legal advice — have an IP lawyer confirm the FSL
"substantially similar functionality" language.*

---

## FINAL DECISION (locked 2026-08-18)

**Licence: `FSL-1.1-Apache-2.0` (SPDX `FSL-1.1-ALv2`) on `@agent-rewind/core` + `@agent-rewind/mcp`.** Dev repo may
stay private (hygiene only — the shipped package is readable on the user's disk regardless; protection is
by licence + hosting, never by secrecy). The deep-research (`wuoiazto1`) confirmed the tactic: Bun/SEA
binaries are extracted wholesale (Claude Code's own was), and client-side licence checks are bypassable
(CWE-602) — so **access is enforced SERVER-SIDE**, not by hiding code.

**"Proprietary" is delivered by three things, none of which is code secrecy:**
1. **Licence (FSL)** — a competitor legally cannot build a competing/substituting product; converts to
   Apache-2.0 after 2 years.
2. **Hosting** — entitlement validation, savings verification/billing, the team dashboard, and the Athena
   resolver run on a closed server and never ship.
3. **Access sold server-side** — free tier = local + FSL; paid tier = server-gated.

Business model + pricing (gainshare, hybrid base + 10–15% of verified savings, the counterfactual risk,
Agent Rewind's measured-avoided-re-spend edge): `docs/BUSINESS-MODEL.md`. Superseded: the earlier
"UNLICENSED + obfuscated closed binary" and any "hide the source" framing — refuted by the evidence above.
