# @agent-rewind/mcp

**Reversible execution for AI coding agents** — the `agent-rewind` CLI and stdio MCP server.

Agent Rewind gives any coding agent (Claude Code, Cursor, Codex CLI, Cline, Windsurf) three things it
doesn't have on its own:

1. **Whole-workspace checkpoint & rewind** — snapshot the entire working tree (including changes made
   by `bash`, not just file-edit tools) and restore any checkpoint. History survives a rewind.
2. **A refuse-and-record effect barrier** — the first time an external effect fires (a payment, an
   email, a provisioning call) it is admitted and recorded; re-firing that spent effect across a
   rewind is **refused**, and the refusal is recorded too, with a reason the agent can act on.
3. **A tamper-evident SHA-256 hash chain** — every checkpoint, effect, and refusal is linked on an
   append-only chain that anyone holding it can independently verify.

> **Honesty:** the default tier is **reversibility, not isolation or security.** It lets an agent undo
> the workspace and refuses replaying a spent effect. It is *not* a sandbox or a jail — that's a
> separate opt-in tier. Don't rely on it as a security boundary.

## Install & run

Zero install — run straight from npm (requires Node ≥ 20):

```bash
npx -y @agent-rewind/mcp mcp     # start the stdio MCP server
```

### Claude Code

```bash
claude mcp add agent-rewind -- npx -y @agent-rewind/mcp mcp
```

### Cursor / Cline / Windsurf — add to the client's `mcpServers` config

```json
{
  "mcpServers": {
    "agent-rewind": { "type": "stdio", "command": "npx", "args": ["-y", "@agent-rewind/mcp", "mcp"] }
  }
}
```

### Codex CLI

```bash
codex mcp add agent-rewind -- npx -y @agent-rewind/mcp mcp
```

Once added, the server tells your agent the workflow on connect — nothing else to configure.

## How to use it (the workflow)

Three moves, in plain terms:

1. **Checkpoint before risky work.** Ask the agent (or let it decide) to `checkpoint` before a
   multi-step change. It snapshots the *whole* workspace — including anything `bash` touches — and
   returns an `id`.
2. **Agent Rewind to undo.** If it goes wrong, `rewind <id>` restores the entire workspace to that point.
   History is kept, so you can `replay` forward again.
3. **Guard real-world effects.** Before an irreversible action (a payment, an email, a deploy), the
   agent calls `guard_effect` with a stable key. The first call is recorded; a retry of the *same*
   effect after a rewind is **refused** — so undoing a step can't re-charge a card or re-send an email.

In Claude Code (installed as a plugin) the guard runs **automatically** via a `PreToolUse` hook — you
don't have to remember it.

## Use cases

- **Long multi-step tasks** (big refactors, migrations, upgrades): recover from a bad step at minute 40
  without redoing the first 39.
- **Agents that touch the real world** (deploys, DB migrations, payments, emails): a safe undo that
  can't double-fire the effect on a retry.
- **Cheaper repetitive runs**: the optional proxy replays identical calls at zero cost and keeps prompt
  caching healthy (see below).
- **Safe experimentation**: checkpoint, try a risky approach, rewind if it doesn't pan out.

## MCP tools

`checkpoint`, `list`, `rewind`, `replay`, `guard_effect` (the five MVP tools), plus a `savings`
receipt and two `backtrack` tools. The server is stateless — every stateful tool mints or takes back
an explicit checkpoint-id handle, and all durable state lives under `.rewind/` in the workspace.

## CLI

```
agent-rewind checkpoint [label] | list | rewind <id> | replay <id> | guard <json>
       | savings [--json] | cache-report <json> | prune <json> | analyze <json>
       | gateway [--port <n>] [--upstream <url>] | mcp
```

A refused `guard` exits **2**, so a `PreToolUse` hook can block the offending tool call.

## Token-saving proxy (optional)

Point your agent's base URL at the local gateway (`agent-rewind gateway`) and it saves tokens three
ways — all priced from the provider's *own* usage numbers, floored so they never over-count. It works
with **Anthropic**, **OpenAI**, **Google Gemini**, and any **OpenAI-compatible** provider (Kimi /
Moonshot, DeepSeek, Together, Fireworks, Groq, OpenRouter, Nebius, xAI, vLLM, Ollama, …) — the provider
is auto-detected from the request, or pinned explicitly.

- **Exact record/replay** — a **byte-identical** request (common after a rewind or a retry) is served
  from the local record with **zero** upstream call; the saving is that whole call. Correctness-safe by
  design: only byte-for-byte-equivalent requests replay, so it never serves a subtly-wrong answer.
- **Prompt-cache preservation** — injects/keeps one `cache_control` breakpoint on the static prefix
  (system prompt + tools) so it's re-read at ~1/10th the input price instead of full price each turn.
- **Deterministic pruning** — collapses duplicate tool-output blocks losslessly, sending fewer tokens.

How many **tokens** a rewind recovers depends on **how late the run failed** (Benchmark B,
deterministic): **9.1%** for an early failure → **41.2%** for a late one (step 8 of 10). It's a curve,
not a constant — the late-failure condition rides with the number. Those figures are *tokens recovered*;
the **billable** saving (the marginal cost avoided over your provider's own prompt caching, which is
what a gainshare bill would charge) is lower — roughly 25–35% on the same runs — because the recovered
tokens are largely the already-cheap cached prefix. `agent-rewind savings` prints your running total. *(Note: this is separate from the checkpoint/rewind
system — that's real git; this proxy is a different layer you can run independently.)*

## Links

- Full install guide, architecture, and the product breakdown: <https://github.com/DarkStar616/rewind>
- Licence: **FSL-1.1-ALv2** (Functional Source License 1.1, Apache-2.0 future grant at 2 years).
