# Agent Rewind

**Reversible execution for AI agents. Checkpoint the whole workspace, rewind a failed run to
any step, and never let an agent re-fire a spent external effect across a retry or a revert.**

Agent Rewind is a small, portable substrate that drops into any AI coding agent (Claude Code, Cursor,
Cline, Windsurf, Codex CLI) as a single MCP server, and gives it three things the agent does not
have on its own:

1. **Whole-workspace checkpoints** — a copy-on-write snapshot of the working tree at each step,
   including changes made by shell commands, not just the agent's file-edit tools.
2. **Agent Rewind to any checkpoint** — resume a multi-step run from where it went wrong instead of
   starting over.
3. **An effect barrier** — a refuse-and-record guard so that when a run is rewound, an external
   effect that already happened (a payment, an email, a provisioning call) cannot be silently
   replayed. The refusal is recorded on a tamper-evident hash chain.

## Quick start

Live on npm — no account, no API key, Node ≥ 20:

```bash
# Claude Code
claude mcp add agent-rewind -- npx -y @agent-rewind/mcp mcp
# Cursor / Cline / Windsurf: add { "command": "npx", "args": ["-y","@agent-rewind/mcp","mcp"] } to mcpServers
# Codex CLI
codex mcp add agent-rewind -- npx -y @agent-rewind/mcp mcp
```

Then, in plain terms: the agent **checkpoints** before risky work, **rewinds** to undo (bash changes
included), and **guards** irreversible effects so a retry after a rewind can't re-charge a card or
re-send an email. The server tells the agent this workflow on connect. Full guide:
[`docs/install/README.md`](docs/install/README.md).

**Use cases:** long multi-step tasks (recover from a bad step without redoing everything) · agents that
deploy/migrate/pay/email (safe undo that can't double-fire) · cheaper repetitive runs (the optional
record/replay + prompt-cache proxy) · safe experimentation (checkpoint, try, rewind).

## Why this exists

A multi-step agent that fails at step 18 of 20 is expensive in the worst way: conventional retry
throws away the 17 good steps and re-does them. Version control is not the answer, because agent
state is not just files, and because `git checkout` will happily "revert" a workspace to before
an email was sent, which is a dangerous illusion, not a reversal.

The coding agents that do ship a rewind (Claude Code's `/rewind`) only track their own file-edit
tools. Anything a `bash` command changed, and every external side effect, is invisible to it, and
untracked, and un-undoable. Agent Rewind covers exactly that gap, and it does it for every agent, not
one.

**The wedge:** *rewind for everything the built-in can't see (bash and external effects), on every
agent.*

## The moat

The snapshot mechanics are a commodity — Agent Rewind's core drives plain `git` in a private side
repo, no exotic substrate. The differentiated piece is the **effect barrier**: at the moment
an irreversible external effect is emitted it is recorded as spent, on the same hash chain as
everything else, so a later rewind cannot un-spend it. An agent that tries to re-emit a spent
effect after a rewind is refused, and the refusal is itself recorded, citing the original. This
neutralises a published class of "semantic rollback" attack in which an agent re-synthesises a
slightly different request after a restore to cause a duplicate charge or reuse a consumed
credential. As far as the launch research found, no competing agent-checkpoint tool ships this.

## What it is not

Agent Rewind's default tier is **reversibility, not isolation**. A git-snapshot workspace can be
reverted, but it cannot stop an agent from touching files outside the tree or making a network
call. Enforcement (an OS-level jail) is an opt-in tier, and this project does not market the
default as a security boundary. Honesty about that line is part of the product.

## Status

**Live on npm.** Three packages, verified installable and working end-to-end from the registry:

- [`@agent-rewind/mcp`](https://www.npmjs.com/package/@agent-rewind/mcp) — the CLI + MCP server people install
- [`@agent-rewind/core`](https://www.npmjs.com/package/@agent-rewind/core) — the reversible-execution engine, effect barrier, and hash chain
- [`@agent-rewind/gateway`](https://www.npmjs.com/package/@agent-rewind/gateway) — the token-saving record/replay proxy

Backed by 334 tests (green, run repeatedly with zero flakiness) and repeated rounds of independent
cross-vendor (codex) code review. See [`docs/AGENT-REWIND-BRIEF.md`](docs/AGENT-REWIND-BRIEF.md) for the full
plain-English breakdown (how token savings and accuracy work, use cases, and honest limits),
[`docs/PRODUCT-BREAKDOWN.md`](docs/PRODUCT-BREAKDOWN.md) for the evidence-tagged technical breakdown,
and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the shape.

## Licence

**FSL-1.1-ALv2** — the [Functional Source License 1.1](https://fsl.software/), which converts to
Apache-2.0 two years after each release. Source-available and free for you to use and modify; the
future Apache grant keeps it open long-term. Hosted and enterprise features are the commercial layer.
