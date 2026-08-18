# Rewind

**Reversible execution for AI agents. Checkpoint the whole workspace, rewind a failed run to
any step, and never let an agent re-fire a spent external effect across a retry or a revert.**

Rewind is a small, portable substrate that drops into any AI coding agent (Claude Code, Cursor,
Cline, Windsurf, Codex CLI) as a single MCP server, and gives it three things the agent does not
have on its own:

1. **Whole-workspace checkpoints** — a copy-on-write snapshot of the working tree at each step,
   including changes made by shell commands, not just the agent's file-edit tools.
2. **Rewind to any checkpoint** — resume a multi-step run from where it went wrong instead of
   starting over.
3. **An effect barrier** — a refuse-and-record guard so that when a run is rewound, an external
   effect that already happened (a payment, an email, a provisioning call) cannot be silently
   replayed. The refusal is recorded on a tamper-evident hash chain.

## Why this exists

A multi-step agent that fails at step 18 of 20 is expensive in the worst way: conventional retry
throws away the 17 good steps and re-does them. Version control is not the answer, because agent
state is not just files, and because `git checkout` will happily "revert" a workspace to before
an email was sent, which is a dangerous illusion, not a reversal.

The coding agents that do ship a rewind (Claude Code's `/rewind`) only track their own file-edit
tools. Anything a `bash` command changed, and every external side effect, is invisible to it, and
untracked, and un-undoable. Rewind covers exactly that gap, and it does it for every agent, not
one.

**The wedge:** *rewind for everything the built-in can't see (bash and external effects), on every
agent.*

## The moat

The snapshot mechanics are a commodity, and Rewind's core is built on an open-source (MIT)
reversible-execution substrate. The differentiated piece is the **effect barrier**: at the moment
an irreversible external effect is emitted it is recorded as spent, on the same hash chain as
everything else, so a later rewind cannot un-spend it. An agent that tries to re-emit a spent
effect after a rewind is refused, and the refusal is itself recorded, citing the original. This
neutralises a published class of "semantic rollback" attack in which an agent re-synthesises a
slightly different request after a restore to cause a duplicate charge or reuse a consumed
credential. As far as the launch research found, no competing agent-checkpoint tool ships this.

## What it is not

Rewind's default tier is **reversibility, not isolation**. A git-snapshot workspace can be
reverted, but it cannot stop an agent from touching files outside the tree or making a network
call. Enforcement (an OS-level jail) is an opt-in tier, and this project does not market the
default as a security boundary. Honesty about that line is part of the product.

## Status

This repository is a fresh start. The design is grounded in a working implementation that already
exists inside a larger product, and the plan here is to extract the portable core, ship it as a
standalone open-core SDK plus MCP server, and keep the larger product consuming the same package.

- Start with `CLAUDE.md` for how to build here.
- `docs/RESEARCH.md` is the grounded research the plan rests on.
- `docs/ARCHITECTURE.md` is the proposed shape.
- `docs/PLAN.md` is the phased build plan, and names the first slice to build.

## Licence

Open-core. The core SDK and MCP server are intended to be MIT or Apache-2.0 (the underlying
substrate is MIT). Hosted and enterprise features are the commercial layer.
