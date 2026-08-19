# Real-client smoke test — Agent Rewind MCP server

> **Status: PARKED — human-gated.** The autonomous run cannot drive a GUI editor. The stdio
> JSON-RPC end-to-end path is already proven automatically by
> `packages/mcp/test/e2e-stdio.test.ts` (it spawns the built `dist/cli.js mcp` bin and runs the full
> checkpoint → edit → rewind → refused → chain-verified demo over the real MCP wire). **This
> checklist is the ONE thing that automation cannot close:** a human running the five tools inside a
> real GUI client (Claude Code and Cursor) and pasting the transcript below. Until that is done,
> "verified against a real client" is unproven — do not claim it.

This is `docs/PLAN.md` Slice-1 success demo, executed by hand through a real editor rather than the
test harness. It must be run in **both** Claude Code and Cursor.

## Prerequisites

- Node ≥ 20 on PATH (`node --version`).
- Any throwaway **git** repo to experiment in (`mkdir /tmp/rewind-smoke && cd $_ && git init`), with
  one committed file to edit (e.g. `echo original > a.txt`).
- Network access for `npx` to fetch `@agent-rewind/mcp` on first run (or a local `npm link`).

## Step 1 — add the server

### Claude Code

```bash
claude mcp add agent-rewind -- npx -y @agent-rewind/mcp mcp
```

(Add `--scope user` to register it globally instead of for the current project.) Confirm it is
listed and connected:

```bash
claude mcp list
```

### Cursor

Use the one-click deeplink from `docs/install/README.md`
(`cursor://anysphere.cursor-deeplink/mcp/install?name=agent-rewind&config=…`), or add by hand to
`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "agent-rewind": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@agent-rewind/mcp", "mcp"]
    }
  }
}
```

Reload the MCP servers and confirm `agent-rewind` shows the tools as connected.

## Step 2 — run the five tools, in order

Drive the agent (or call the tools directly from the client's MCP panel) through the exact Slice-1
demo. Each tool call and its result should be visible in the client.

1. **`checkpoint`** `{ "label": "before" }` → returns `{ id, ts }`. **Copy the `id`** — it is the
   durable handle you pass back.
2. Make a real edit in the workspace: have the agent run a shell command (e.g. `echo mutated >
   a.txt`) or edit `a.txt` with its own edit tool. Confirm the file changed on disk.
3. **`guard_effect`** `{ "descriptor": { "effectKey": "charge:42", "scopeLabel": "s", "kind":
   "http" } }` → returns `{ "decision": "admitted", "chainHash": "<64-hex>", … }`. This is the
   **first** emit of the key: admitted and recorded on the tamper-evident chain.
4. **`rewind`** `{ "id": "<the id from step 1>" }` → returns `{ revertedTo, refusedEffects: [ …
   charge:42 … ] }`. Confirm on disk that `a.txt` is back to `original` — the whole tree was
   restored, including the shell edit.
5. **`guard_effect` again**, the SAME descriptor → returns `{ "decision": "refused",
   "firstEmittedSeq": 0, "reason": "…", "chainHash": "<64-hex>" }`.
6. **`list`** `{}` → confirm the checkpoint from step 1 is listed by its handle.

Optionally also call **`replay`** `{ "id": "<id>" }` and **`savings`** `{}` to see the honest
receipt (both report `0` in a no-replay run — that is correct, not a bug).

## Step 3 — what "refused" must look like

The re-fired `guard_effect` in step 5 is the load-bearing assertion. A PASS shows **all** of:

- `decision: "refused"` (NOT `admitted`).
- a non-empty `reason` naming the effect and citing the first emit (e.g. *"…effect charge:42 already
  fired (first at seq 0); do not re-fire it across the rewind"*).
- `firstEmittedSeq: 0` — the refusal points back at the original emit.
- a 64-hex `chainHash` — the refusal itself is appended to the tamper-evident chain.

If the second `guard_effect` returns `admitted`, the demo **FAILS** — the barrier did not refuse a
spent effect across the rewind. Do not paste a passing verdict in that case.

## Step 4 — paste the captured transcript

Paste the full client transcript (both editors) — the five tool calls and their JSON results, plus a
line confirming `a.txt` reverted on disk — into the block below. This is what closes "verified
against a real client."

### Claude Code transcript

```
PASTE TRANSCRIPT HERE
```

### Cursor transcript

```
PASTE TRANSCRIPT HERE
```

---

**Sign-off:** _(operator name + date, once both transcripts above are pasted and show a refusal in
step 5)_
