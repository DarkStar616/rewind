# Install Agent Rewind

Agent Rewind gives any coding agent **whole-workspace checkpoint and rewind** plus a **refuse-and-record
effect barrier**: the first time an external effect fires it is admitted and recorded on a
tamper-evident hash chain; re-firing that spent effect across a rewind is **refused** and the refusal
is recorded too.

> **Honesty:** Tier 0 (git snapshots) is **reversibility, not isolation or security.** It lets an
> agent undo the workspace and refuses replaying a spent effect. It is *not* a sandbox or a jail —
> that is a separate opt-in tier. Do not rely on it as a security boundary.

The server ships as one stdio MCP server. Zero install, run it straight from npm:

```bash
npx -y @agent-rewind/mcp mcp
```

It exposes five tools — `checkpoint`, `list`, `rewind`, `replay`, `guard_effect` — and is stateless:
every stateful tool mints or takes back an explicit checkpoint-id handle, and all durable state lives
under `.rewind/` in the workspace.

---

## Claude Code

**One-liner** (adds the server to the current project; use `--scope user` to add it globally):

```bash
claude mcp add agent-rewind -- npx -y @agent-rewind/mcp mcp
```

**Or by hand** — create `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "rewind": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@agent-rewind/mcp", "mcp"]
    }
  }
}
```

### As a plugin (server + guard hook)

Agent Rewind also ships as a Claude Code **plugin** (`packages/mcp/dist-plugin/`). Installing the plugin
registers the MCP server **and** a `PreToolUse` hook that runs the effect barrier before every
`Bash`, `Write` and `Edit` tool call — a refused effect exits `2`, which **blocks** the tool call and
tells the agent why.

The plugin bundles:

- `.claude-plugin/plugin.json` — the manifest.
- `.mcp.json` — the stdio server (same block as above).
- `hooks/hooks.json` — a `PreToolUse` matcher `Bash|Write|Edit` → `scripts/guard.sh`.
- `scripts/guard.sh` — derives an effect key from the tool call and calls `agent-rewind guard`.

> **Note (scoped tool names):** installed as a plugin, Agent Rewind's own tools are exposed under scoped
> names (`mcp__agent-rewind__checkpoint` … `mcp__agent-rewind__guard_effect`). The `Bash|Write|Edit` matcher
> targets the agent's built-in effect tools, so the guard hook never fires on Agent Rewind's own tools.
>
> **Note (advisory guard):** the `guard.sh` hook is a client-side speed bump, not a security
> boundary. It **fails open** on any error so a misconfiguration cannot wedge the editor, and blocks
> only on an explicit barrier refusal. The real enforcement boundary is server-side.

---

## Cursor

**One-click** — [**Add Agent Rewind to Cursor**](cursor://anysphere.cursor-deeplink/mcp/install?name=agent-rewind&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBhZ2VudC1yZXdpbmQvbWNwIiwibWNwIl19)

The deeplink is:

```
cursor://anysphere.cursor-deeplink/mcp/install?name=agent-rewind&config=eyJ0eXBlIjoic3RkaW8iLCJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBhZ2VudC1yZXdpbmQvbWNwIiwibWNwIl19
```

`config` is base64 of the server block `{"type":"stdio","command":"npx","args":["-y","@agent-rewind/mcp","mcp"]}`.

**Or by hand** — add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "rewind": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@agent-rewind/mcp", "mcp"]
    }
  }
}
```

---

## Cline / Windsurf / other MCP clients

Any client that reads the standard `mcpServers` shape uses the exact block above — add it to that
client's MCP settings file (Cline: the MCP servers settings JSON; Windsurf: `~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "rewind": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@agent-rewind/mcp", "mcp"]
    }
  }
}
```

---

## Codex CLI

**One-liner:**

```bash
codex mcp add agent-rewind -- npx -y @agent-rewind/mcp mcp
```

**Or by hand** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-rewind]
command = "npx"
args = ["-y", "@agent-rewind/mcp", "mcp"]
```

---

## Verify

Once configured, the acceptance demo runs entirely through the tools: **checkpoint** the workspace,
make edits (including via `bash`), **rewind** to the checkpoint, then try to re-fire a spent effect —
`guard_effect` **refuses** it and records the refusal on the chain, which `verify` then confirms.
