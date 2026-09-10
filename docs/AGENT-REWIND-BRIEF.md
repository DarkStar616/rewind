# Agent Rewind — briefing (paste this into an AI to write a doc or an email)

*Self-contained. Claims are marked where they are proven and where limits remain. Product name:
**Agent Rewind**. v1.1.0 is live on npm and in the public source repository.*

---

## What it is (one sentence)

**Agent Rewind is a free, local tool that gives any AI coding agent an "undo button" for its whole
workspace — plus a safety catch so that undoing a step can never silently re-fire a real-world action
like a payment or an email.**

## What it is (a bit more)

When an AI coding agent runs a long task and screws up at step 18 of 20, the normal options are bad:
start over (throwing away 17 good steps), or "revert" with git — which is a dangerous illusion, because
`git checkout` will happily roll your files back to *before* an email was sent or a card was charged,
without un-sending or un-charging anything. Built-in agent rewinds (like Claude Code's `/rewind`) only
track the agent's own file edits — anything a shell/`bash` command changed, and every external side
effect, is invisible to them.

Agent Rewind fixes exactly that gap, for **every** agent:

1. **Whole-workspace checkpoints** — snapshot the entire working tree at any step, *including* changes
   made by shell commands, not just the agent's edit tools.
2. **Agent Rewind to any checkpoint** — resume from where it went wrong instead of starting over. History is
   kept, so you can go forward again too.
3. **A refuse-and-record effect barrier** — the first time the agent fires an irreversible external
   effect (a payment, an email, a provisioning call), it's recorded on a tamper-evident log. If the
   agent retries that same effect *after a rewind*, it's **refused** — so a rewind can't cause a
   double-charge or a duplicate email.

Rewind's checkpoints, evidence and replay store run **locally** with no Rewind account or API key.
When the optional gateway makes a live model call, that request still goes to the configured provider;
Rewind does not turn a hosted model into an offline one.

---

## Status: v1.1.0 is live

All three v1.1.0 packages are published and report `1.1.0` as their latest npm release:

- `@agent-rewind/core@1.1.0` — the reversible-execution engine + effect barrier + hash chain
- `@agent-rewind/gateway@1.1.0` — the token-saving record/replay LLM proxy
- `@agent-rewind/mcp@1.1.0` — the CLI + MCP server people install

**Source:** https://github.com/DarkStar616/rewind · **Licence:** FSL-1.1-ALv2 (source-available, becomes
Apache-2.0 after 2 years).

**Proven working end-to-end**: checkpoint a workspace → change a
file via `bash` → rewind → the file is restored → the agent re-fires a spent effect → it's **refused
and recorded** → the tamper-evident chain **verifies**. All confirmed. ✅

---

## How you install it (one line, zero config)

```bash
# Claude Code
claude mcp add agent-rewind -- npx -y @agent-rewind/mcp mcp

# Codex CLI
codex mcp add agent-rewind -- npx -y @agent-rewind/mcp mcp

# Cursor / Cline / Windsurf — add to the client's MCP config:
{ "mcpServers": { "agent-rewind": { "command": "npx", "args": ["-y", "@agent-rewind/mcp", "mcp"] } } }

# Or just run the server directly
npx -y @agent-rewind/mcp mcp
```

Requires Node ≥ 20. Nothing to sign up for.

---

## How it works (plain-English, the four pieces)

- **Checkpoints** are whole-workspace snapshots stored in a private, side git repository (`.rewind/`),
  separate from your project's own git — so it captures *everything*, including bash-made changes, and
  never touches your real git history. Fast (copy-on-write) on modern filesystems.
- **Agent Rewind** restores the entire working tree to a checkpoint but keeps the history, so you can replay
  forward again — the undo is all-or-nothing (it rolls back cleanly even if interrupted).
- **The effect barrier** records each external effect under a stable key on an **append-only,
  tamper-evident SHA-256 hash chain**. Re-firing a spent effect after a rewind is refused, with a
  reason the agent can act on. Anyone holding the log can independently verify it hasn't been altered.
- **Token savings (the gateway)** — an optional local proxy that serves a byte-identical repeated
  request from its record at *zero* upstream cost, preserves prompt-cache breakpoints, and prunes
  duplicate tool output. It only ever counts savings it can *prove*, anchored to the provider's own
  bill — the basis for a "pay a share of verified savings" business model.

---

## Two separate systems — don't conflate them (important for accuracy)

People assume the checkpoint tracking *is* the prompt caching. It isn't. There are **two independent
systems**, and you can use either without the other:

- **Checkpoint / rewind = literally git.** Under the hood it's a real git repository (a private,
  side repo in `.rewind/`, separate from your project's git) doing commits and trees over your whole
  workspace. So "true git-like tracking" is exactly right — it genuinely *is* git, append-only.
- **Prompt caching = a separate feature of the optional proxy.** The git tracking does **not** use
  prompt caching. Prompt-cache preservation is one of the proxy's token-saving levers, on a different
  layer entirely. They're complementary but independent.

## How the token savings actually happens (the mechanism)

Three levers in the optional local proxy, all priced from the **provider's own usage numbers** and
floored, so they never over-count:

1. **Exact record/replay (the big lever).** The proxy records each eligible model request+response. When a
   request with the same canonical replay identity comes through again — common after a rewind or retry —
   it serves the recorded response locally and makes **zero** upstream API call. The saving is the entire
   cost of that avoided call. The replay key covers the output-affecting request fields Rewind knows about;
   requests with hosted or remote state bypass automatic replay, and unknown future provider fields require
   maintenance. This is stricter than a semantic cache, which guesses whether two requests are similar.
2. **Prompt-cache preservation.** Providers (e.g. Anthropic) let you mark a stable prefix — the system
   prompt + tool definitions — with a `cache_control` breakpoint so it's cached and re-read at roughly
   **one-tenth** the normal input price. Agents often forget to set this or set it badly. The proxy
   injects/preserves one breakpoint on the static prefix, so that big unchanging prefix is billed at the
   cheap cache-read rate every turn instead of full price. Saving = (input rate − cache-read rate) ×
   cached tokens.
3. **Deterministic pruning (smaller lever).** Collapses repeated Anthropic-format tool-result blocks
   while preserving the first full result. This changes model-visible context, so it is opt-in and must
   be evaluated against task outcomes as well as request size.

**The savings benchmark.** The executable nine-call mock scenario reports **28.08% avoided simulated
cost**, with three replayed calls out of nine; a unique-call negative control reports zero. Run
`npm run --silent bench:json` to reproduce it with source hashes and denominators. It is one synthetic
condition, not live provider billing, recovered-token percentage, or a general savings estimate. The
previously quoted 120-trial early/mid/late curve is withdrawn because its runner and corpus were not
found in the repository.

## How accuracy improves (the mechanism)

Accuracy improves because rewind makes **recovery cheap and safe**:

- When an agent goes down a wrong path, instead of compounding the mistake it can **rewind to the last
  good checkpoint** and try a different approach — the entire workspace restored cleanly.
- A **failure-memory** model records what was tried and failed at each checkpoint, so (via the
  `backtrack` tools) the agent doesn't walk back into the same dead-end.
- The effect barrier improves correctness in a hard sense: a rewind-and-retry **cannot** double-fire a
  real-world action.

*Honest note:* the big accuracy figures you'll see (e.g. agent task-success jumping from ~44% to ~88%
with environment rewind) come from **published research that motivates the design — not from Agent
Agent Rewind's own benchmark.** Agent Rewind ships the *mechanism*; measuring its own accuracy uplift is
future work. Don't attribute those research numbers to Agent Rewind directly.

## Use cases

- **Long multi-step agent tasks** (big refactors, migrations, framework upgrades): recover from a bad
  step at minute 40 without throwing away the first 39.
- **Agents that touch the real world** (deploys, DB migrations, payments, emails, provisioning): a safe
  undo that can't double-charge or double-send on a retry.
- **Cutting cost on repetitive/iterative agent runs**: replay + prompt-cache preservation.
- **Safe experimentation / what-if**: checkpoint, try a risky approach, rewind if it doesn't pan out.
- **Debugging agent runs**: see exactly where a re-run diverged from a recorded one.

---

## What's proven vs. honest limits (do not overclaim)

**Proven** (automated tests + release verification): the checkpoint/rewind/effect-barrier/hash-chain
guarantees are covered by **443 passing tests** (run `npm run check`), typechecking and builds pass, and
the v1.1.0 release demo exercises Responses replay, encrypted SQLite reopen/replay, and a real MCP
checkpoint through the SDK. Cross-vendor review is a bug-finding aid, not certification.

**Honest limits — state these, don't hide them:**
- The default tier is **reversibility, not isolation or security**. It can undo the workspace and block
  replayed effects, but it is **not a sandbox** — it doesn't stop an effect from happening the *first*
  time, and doesn't stop the agent touching files outside the tree. A real jail is a separate future
  tier.
- Copy-on-write snapshot *speed* depends on the filesystem (fast on APFS/btrfs/XFS/ReFS; still correct
  but slower on ext4).
- The executable **28.08%** result is a deterministic mock scenario, not a live-traffic or real-dollar
  measurement and not a general product savings estimate. The historical 41.2% figure is withdrawn.

---

## Why it's differentiated (the wedge)

- Rewind combines whole-workspace recovery, an effect barrier, exact ordered replay and conservative
  savings evidence in one local stack. Neighboring tools overlap individual pieces.
- It is **correctness-first**: replay requires exact identity, known hosted or remote-state inputs bypass
  automatic reuse, and uncertain cases prefer a miss. Future provider fields still require maintenance.
- It works with compatible MCP clients including Claude Code, Cursor, Codex CLI, Cline and Windsurf.

---

## Quick facts (for reference)

| | |
|---|---|
| Name | Agent Rewind |
| Install | `npx -y @agent-rewind/mcp mcp` (or `claude mcp add agent-rewind …`) |
| Price | Free and local; source-available under FSL-1.1-ALv2. Planned paid layer: a share of *verified* token savings. |
| Works with | Claude Code, Cursor, Codex CLI, Cline, Windsurf (any MCP client) |
| Requires | Node ≥ 20. No account, no API key. |
| npm | `@agent-rewind/core`, `@agent-rewind/gateway`, and `@agent-rewind/mcp`: latest is 1.1.0. |
| Repo | https://github.com/DarkStar616/rewind |
| One-line pitch | "An undo button for AI coding agents — that can't accidentally re-charge a card." |

---

## Suggested angles (for whoever writes the doc/email)

- **The hook:** *AI agents are great until they aren't — and "just retry" can re-send the email.* Agent
  Agent Rewind is the safe undo.
- **For developers:** one line to install, works with the agent you already use, and keeps Rewind state
  local. Live gateway requests still go to the configured model provider.
- **For the skeptical/technical reader:** every safety claim is test-backed and the log is
  independently verifiable — lead with the honesty, it's the credibility.
- **Call to action:** `npx -y @agent-rewind/mcp mcp` — try it in any repo in 30 seconds.
