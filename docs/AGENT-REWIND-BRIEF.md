# Agent Rewind — briefing (paste this into an AI to write a doc or an email)

*Self-contained. Everything below is accurate as of launch; claims are marked where they're proven vs.
where they're honest limits. Product name: **Agent Rewind**. It is **live and installable today**.*

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
2. **Rewind to any checkpoint** — resume from where it went wrong instead of starting over. History is
   kept, so you can go forward again too.
3. **A refuse-and-record effect barrier** — the first time the agent fires an irreversible external
   effect (a payment, an email, a provisioning call), it's recorded on a tamper-evident log. If the
   agent retries that same effect *after a rewind*, it's **refused** — so a rewind can't cause a
   double-charge or a duplicate email.

Everything runs **locally**. No account, no API key, no data leaves the machine.

---

## Status: LIVE ✅

Published on the public npm registry and **verified end-to-end from the registry** (installed fresh and
run, not just "publish reported success"):

- `@agent-rewind/core@0.1.0` — the reversible-execution engine + effect barrier + hash chain
- `@agent-rewind/gateway@0.1.0` — the token-saving record/replay LLM proxy
- `@agent-rewind/mcp@0.1.0` — the CLI + MCP server people install

**Source:** https://github.com/DarkStar616/rewind · **Licence:** FSL-1.1-ALv2 (source-available, becomes
Apache-2.0 after 2 years).

**Proven working end-to-end** (run against the published package): checkpoint a workspace → change a
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
- **Rewind** restores the entire working tree to a checkpoint but keeps the history, so you can replay
  forward again — the undo is all-or-nothing (it rolls back cleanly even if interrupted).
- **The effect barrier** records each external effect under a stable key on an **append-only,
  tamper-evident SHA-256 hash chain**. Re-firing a spent effect after a rewind is refused, with a
  reason the agent can act on. Anyone holding the log can independently verify it hasn't been altered.
- **Token savings (the gateway)** — an optional local proxy that serves a byte-identical repeated
  request from its record at *zero* upstream cost, preserves prompt-cache breakpoints, and prunes
  duplicate tool output. It only ever counts savings it can *prove*, anchored to the provider's own
  bill — the basis for a "pay a share of verified savings" business model.

---

## What's proven vs. honest limits (do not overclaim)

**Proven** (automated tests + live verification): the checkpoint/rewind/effect-barrier/hash-chain
guarantees are covered by **286 passing tests**, ran green **40+ times with zero flakiness**, went
through **five rounds of independent (different-AI-vendor) code review that converged clean**, and the
published package was **installed from npm and run end-to-end**.

**Honest limits — state these, don't hide them:**
- The default tier is **reversibility, not isolation or security**. It can undo the workspace and block
  replayed effects, but it is **not a sandbox** — it doesn't stop an effect from happening the *first*
  time, and doesn't stop the agent touching files outside the tree. A real jail is a separate future
  tier.
- Copy-on-write snapshot *speed* depends on the filesystem (fast on APFS/btrfs/XFS/ReFS; still correct
  but slower on ext4).
- The token-savings percentage quoted anywhere internally (~28%) is from a **synthetic benchmark**, not
  a live-traffic measurement. There is **no real-dollar savings figure yet** — don't publish one as if
  there were.

---

## Why it's differentiated (the wedge)

- **No existing LLM proxy does byte-exact record/replay**, and **no agent-checkpoint tool ships the
  refuse-and-record effect barrier.** Agent Rewind is the intersection, delivered locally.
- It's **correctness-first**: it will never serve a stale/wrong cached answer (unlike "semantic" caches
  that trade correctness for hit-rate).
- It works with **every** coding agent (Claude Code, Cursor, Codex CLI, Cline, Windsurf), not one.

---

## Quick facts (for reference)

| | |
|---|---|
| Name | Agent Rewind |
| Install | `npx -y @agent-rewind/mcp mcp` (or `claude mcp add agent-rewind …`) |
| Price | Free, local, open (FSL-1.1-ALv2). Planned paid layer: a share of *verified* token savings. |
| Works with | Claude Code, Cursor, Codex CLI, Cline, Windsurf (any MCP client) |
| Requires | Node ≥ 20. No account, no API key. |
| npm | @agent-rewind/core, @agent-rewind/gateway, @agent-rewind/mcp (all 0.1.0) |
| Repo | https://github.com/DarkStar616/rewind |
| One-line pitch | "An undo button for AI coding agents — that can't accidentally re-charge a card." |

---

## Suggested angles (for whoever writes the doc/email)

- **The hook:** *AI agents are great until they aren't — and "just retry" can re-send the email.* Agent
  Rewind is the safe undo.
- **For developers:** one line to install, works with the agent you already use, nothing leaves your
  machine.
- **For the skeptical/technical reader:** every safety claim is test-backed and the log is
  independently verifiable — lead with the honesty, it's the credibility.
- **Call to action:** `npx -y @agent-rewind/mcp mcp` — try it in any repo in 30 seconds.
