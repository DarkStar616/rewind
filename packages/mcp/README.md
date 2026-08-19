# @agent-rewind/mcp

**Reversible execution for AI coding agents** — the `rewind` CLI and stdio MCP server.

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

## Token-saving proxy

Point your agent's `ANTHROPIC_BASE_URL` at the local gateway (`agent-rewind gateway`): a byte-equivalent
request after a rewind is served from record with **zero** upstream cost, and `agent-rewind savings` prints
the running total.

## Links

- Full install guide, architecture, and the product breakdown: <https://github.com/DarkStar616/rewind>
- Licence: **FSL-1.1-ALv2** (Functional Source License 1.1, Apache-2.0 future grant at 2 years).
