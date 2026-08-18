#!/usr/bin/env bash
#
# Rewind PreToolUse guard — the effect barrier wired to a real client (Claude Code).
#
# Claude Code invokes this before every Bash / Write / Edit tool call, passing the tool payload as
# JSON on stdin. We derive a stable effect key from the call, ask `rewind guard`, and — when the
# barrier REFUSES (a spent effect re-fired across a rewind) — exit 2. A PreToolUse hook that exits 2
# BLOCKS the tool call and feeds our stderr back to the agent, so the refusal is both enforced and
# recorded on the tamper-evident chain.
#
# HONESTY (product brief): this is a client-side SPEED BUMP for the agent, not a security boundary
# and not isolation. Tier 0 is reversibility. A determined process can bypass a client hook; the real
# boundary is server-side. Accordingly this guard FAILS OPEN on any error (missing rewind, bad JSON,
# non-git dir): a broken guard must not wedge the editor. It blocks ONLY on an explicit barrier
# refusal (exit 2).
#
# SCOPED-NAME CAVEAT: installed as a plugin, Rewind's own MCP tools are exposed under scoped names
# (`mcp__rewind__checkpoint`, ... `mcp__rewind__guard_effect`). The matcher above (`Bash|Write|Edit`)
# targets the agent's BUILT-IN effect tools and does not match those scoped names, so this hook never
# guards Rewind's own tool calls (which would recurse). If you widen the matcher, exclude
# `mcp__rewind__*` explicitly.
#
# EFFECT-KEY CAVEAT: the barrier refuses ANY re-emit of a key, which is the whole point — a spent
# effect cannot fire twice. Keying on `<tool>:<target>` therefore also refuses an innocent SECOND
# edit of the same file within one forward run, not only replays across a rewind. That is deliberately
# conservative for a demo; in real use, narrow the key (or the matcher) to genuinely external,
# non-idempotent effects (a deploy, a charge, an email), not every file edit.

set -uo pipefail

payload="$(cat)"

# Derive the effect descriptor with node (guaranteed present — the server itself launches via node).
# Bash -> the command string; Write/Edit -> the file path. Emit nothing for anything else (allow).
effect="$(printf '%s' "$payload" | node -e '
  let s = "";
  process.stdin.on("data", (d) => (s += d));
  process.stdin.on("end", () => {
    let p;
    try { p = JSON.parse(s); } catch { process.exit(0); }
    const tool = p.tool_name || "";
    const input = p.tool_input || {};
    const target = tool === "Bash" ? input.command : input.file_path;
    if (!target) process.exit(0);
    const scope = p.cwd || process.cwd();
    process.stdout.write(JSON.stringify({
      effectKey: tool + ":" + target,
      scopeLabel: scope,
      kind: tool.toLowerCase(),
    }));
  });
')" || exit 0

# Nothing guardable in this call -> allow it.
[ -z "$effect" ] && exit 0

# Prefer a `rewind` already on PATH; otherwise fall back to the published package via npx.
if command -v rewind >/dev/null 2>&1; then
  out="$(rewind guard "$effect" 2>/dev/null)"; code=$?
else
  out="$(npx -y @rewind/mcp guard "$effect" 2>/dev/null)"; code=$?
fi

# Exit 2 = barrier refusal -> BLOCK, surfacing the reason to the agent. Any other non-zero is a guard
# malfunction, not a refusal: fail OPEN (see the honesty note above).
if [ "$code" -eq 2 ]; then
  echo "rewind: BLOCKED — spent effect refused on replay across a rewind. ${out}" >&2
  exit 2
fi

exit 0
