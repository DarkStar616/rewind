# Agent Rewind

**Token-saving recovery for AI agents. Checkpoint the whole workspace, resume failed runs without
repaying for eligible model calls, and prevent spent external effects from firing twice.**

Agent Rewind is a small, portable substrate that drops into any AI coding agent (Claude Code, Cursor,
Cline, Windsurf, Codex CLI) as a single MCP server, and gives it four things the agent does not
have on its own:

1. **Whole-workspace checkpoints** — a copy-on-write snapshot of the working tree at each step,
   including changes made by shell commands, not just the agent's file-edit tools.
2. **Agent Rewind to any checkpoint** — resume a multi-step run from where it went wrong instead of
   starting over.
3. **Token-saving replay and cache controls** — an optional local gateway that reuses eligible recorded
   model responses at zero upstream cost, preserves Anthropic prompt-cache breakpoints, and can prune
   repeated tool results.
4. **An effect barrier** — a refuse-and-record guard so that when a run is rewound, an external
   effect that already happened (a payment, an email, a provisioning call) cannot be silently
   replayed. The refusal is recorded on a tamper-evident hash chain.

## Quick start

Public source and npm packages — no Rewind account or Rewind API key, Node ≥ 20:

```bash
# Claude Code
claude mcp add agent-rewind -- npx -y @agent-rewind/mcp mcp
# Cursor / Cline / Windsurf: add { "command": "npx", "args": ["-y","@agent-rewind/mcp","mcp"] } to mcpServers
# Codex CLI
codex mcp add agent-rewind -- npx -y @agent-rewind/mcp mcp
```

Then, in plain terms: the agent **checkpoints** before risky work, **rewinds** to undo (bash changes
included), and **guards** irreversible effects so a retry after a rewind can't re-charge a card or
re-send an email. For token savings, the optional gateway records eligible calls and serves exact
replays locally after a rewind or retry. The server tells the agent this workflow on connect. Full guide:
[`docs/install/README.md`](docs/install/README.md).

**Use cases:** long multi-step tasks (recover from a bad step without redoing everything) · agents that
deploy/migrate/pay/email (safe undo that can't double-fire) · cheaper repetitive runs (the optional
record/replay + prompt-cache proxy) · safe experimentation (checkpoint, try, rewind).

## Savings evidence

| Mechanism | Measured or guaranteed effect |
|---|---|
| Rewind + exact replay | Benchmark B: **9.1%** recovered tokens after an early failure, **25.6%** mid-run, and **41.2%** after a late failure at step 8/10 across 120 deterministic trials. |
| Compact MCP profile | About **2,340 → 691 initialization tokens**, a **70.5% reduction**, using the documented characters/4 estimate. |
| Eligible replay hit | **Zero upstream tokens for that repeated call**; total workload savings depend on how often requests repeat. |
| Reproducible mock cost scenario | **28.08% avoided simulated cost** over nine calls with three replays; the unique-call control reports zero. |

The condition matters: 41.2% is the late-failure result, not a universal savings promise. The repository
also ships a Nebius runner that prices the same rewind/replay scenario from real provider-reported token
usage. These controlled results are not production-traffic or universal dollar-savings estimates. See
the [benchmark evidence and claim rules](docs/BENCHMARKS.md).

## What shipped in v1.1.0

- **Smaller MCP context:** `lean`, `recovery`, `analytics`, and `all` tool profiles let clients load
  only the tools needed for a session.
- **OpenAI Responses support:** the gateway understands `/v1/responses`, validates completed JSON and
  SSE responses, and replays the exact recorded response bytes for eligible requests.
- **Durable ordered replay:** an opt-in encrypted SQLite tape records distinct stochastic responses,
  survives restarts, and replays them in order. It requires an explicit tenant, epoch, and 32-byte key.
- **Safer gateway controls:** explicit compatibility and lean profiles, strict configuration parsing,
  fixed-tenant scope isolation, replay eligibility checks for hosted state, bounded queues, and
  upstream cancellation/deadlines.
- **Bounded analysis tools:** streaming NDJSON traffic analysis and cache-prefix comparison emit compact
  reports without printing prompts or responses by default.

The default remains the compatibility profile with in-memory replay. Durable storage and context
pruning are opt-in. See the [v1.1.0 changelog](CHANGELOG.md#110--2026-09-10) and the
[MCP/gateway reference](packages/mcp/README.md) for configuration and limits.

**OSS boundary:** v1.1.0 selectively adapts Headroom's prefix comparison. The pinned Bifrost and
agenticstash snapshots are attributed review material; their full lifecycle, exchange, fork, and diff
features are not runtime capabilities in this release.

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

**v1.1.1 is live.** The source repository is public and all three packages report `1.1.1` as their
latest npm release:

- [`@agent-rewind/mcp`](https://www.npmjs.com/package/@agent-rewind/mcp) — the CLI + MCP server people install
- [`@agent-rewind/core`](https://www.npmjs.com/package/@agent-rewind/core) — the reversible-execution engine, effect barrier, and hash chain
- [`@agent-rewind/gateway`](https://www.npmjs.com/package/@agent-rewind/gateway) — the token-saving record/replay proxy

Backed by 443 tests (green in the release verification run) and repeated rounds of independent
cross-vendor (codex) code review. See [`docs/AGENT-REWIND-BRIEF.md`](docs/AGENT-REWIND-BRIEF.md) for the full
plain-English breakdown (how token savings and accuracy work, use cases, and honest limits),
[`docs/PRODUCT-BREAKDOWN.md`](docs/PRODUCT-BREAKDOWN.md) for the evidence-tagged technical breakdown,
and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the shape.

## Licence

**FSL-1.1-ALv2** — the [Functional Source License 1.1](https://fsl.software/), which converts to
Apache-2.0 two years after each release. The source is available to use, copy, modify, and distribute
under the FSL terms, including its competing-use restriction. Hosted and enterprise features are the
commercial layer.
