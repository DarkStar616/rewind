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
       | gateway [--port <n>] [--upstream <url>] [--profile compat|lean] [--tenant <id>]
       [--preserve-cache|--no-preserve-cache] [--prune-context|--no-prune-context]
       [--config <path>] | mcp
```

A refused `guard` exits **2**, so a `PreToolUse` hook can block the offending tool call.

## Token-saving proxy (optional)

The default `agent-rewind gateway` preserves the existing request-body behavior (`compat`).
Enable the existing Anthropic cache planner and duplicate tool-result pruning explicitly:

```bash
agent-rewind gateway --profile lean --prune-context
# Immediate opt-out on the next startup:
agent-rewind gateway --no-preserve-cache --no-prune-context
```

`lean` enables cache preservation; pruning remains opt-in because it changes model-visible content.
`--preserve-cache` enables the cache planner independently of the profile. The gateway prints its
active configuration and capability limits to stderr before its listening address. `max` fails with
an actionable message until observation retrieval and its shaping guarantees are implemented.

| Mechanism | Current behavior |
| --- | --- |
| Exact record/replay | Reuses recorded equivalent requests without an upstream call. Records are currently in memory and are cleared on restart; replay savings persist. |
| Cache preservation | Adds an Anthropic prefix breakpoint when the client supplies none; other providers are skipped. Provider policy and usage determine the actual benefit. |
| Pruning | Collapses repeated Anthropic-format tool results, preserving the first full result. Other formats are skipped. |

The savings receipt currently reports replay savings only. Enabling cache/pruning does not yet add
separate dollar attribution to that receipt. Pruning can reduce request size without reducing the
provider bill; assess paired task outcomes and billed cost before enabling it broadly.

For an Athena-managed tenant, run `agent-rewind gateway --tenant datami --profile lean` in that
tenant's own working directory/process. The fixed tenant comes from configuration, never an HTTP
header; `x-rewind-scope` selects only a validated subordinate scope. Invalid identity returns 403.
Use one process/store per tenant and never share its store with a legacy gateway. This loopback
configuration is not a remotely authenticated service. All `x-rewind-*` headers are stripped upstream.

Configuration precedence is profile defaults, file overrides, environment, then explicit CLI flags.
Duplicate/conflicting CLI flags, unknown options, missing values and invalid configuration fail at
startup. Use `--config gateway.json` (or `REWIND_CONFIG`) with this JSON shape:

```json
{"profile":"lean","port":8788,"upstream":"https://api.anthropic.com","pruneContext":false}
```

File fields are `profile`, `port`, `upstream`, `preserveCache`, `pruneContext`, and `tenant`. Their environment
equivalents are `REWIND_PROFILE`, `REWIND_PORT`, `REWIND_UPSTREAM`, `REWIND_PRESERVE_CACHE`, and
`REWIND_PRUNE_CONTEXT`; `tenant` uses `REWIND_TENANT`. Boolean environment values must be exactly `true` or `false`. Supply provider
authentication in request headers; upstream URLs must use a root path and cannot contain credentials, query strings or fragments.

The executable nine-call mock benchmark reports **28.08% simulated cost savings**, with three
replayed calls out of nine. Unique calls report zero. Run `npm run --silent bench:json` from a source
checkout for a reproducible artifact with source hashes and denominators. These results are not real
provider billing or a general product savings estimate. The historical 120-trial Benchmark B curve is
unverified: its runner and corpus were not located, so those percentages are withdrawn.


## Links

- Full install guide, architecture, and the product breakdown: <https://github.com/DarkStar616/rewind>
- Licence: **FSL-1.1-ALv2** (Functional Source License 1.1, Apache-2.0 future grant at 2 years).

## MCP tool profiles (v1.1.0)

Use `agent-rewind mcp --profile lean` or set `REWIND_MCP_PROFILE=lean`. The CLI flag takes precedence.
Unknown profiles and options fail startup. The default remains `all`.

| Profile | Tools | Approximate initialization tokens |
| --- | --- | ---: |
| `lean` | checkpoint, rewind, guard_effect | 691 |
| `recovery` | lean tools plus list, replay, backtrack_candidates, backtrack_commit | 1,609 |
| `analytics` | savings | 271 |
| `all` | All eight existing tools | 1,841 |

Measured through the MCP SDK on 2026-09-09: serialized tool definitions plus server instructions,
characters divided by four and rounded up. The previous full surface measured 9,359 characters
(2,340 approximate tokens); the updated lean surface measured 2,762 characters. These are context-size
estimates, not measured tokenization or dollar savings. Tests enforce the lean budget of 1,000.
Clients may add their own protocol wrappers. Hidden tools cannot be called through that profile.

Checkpoint at meaningful risky boundaries and retain the returned id. The lean profile restores by
id; switch to recovery for checkpoint discovery and failure memory. Tier 0 provides reversibility,
not isolation or security. Text and structured result forms remain available for compatibility.

### Explicit durable ordered tape (v1.1.0)

Set `REWIND_STORAGE_KEY` securely in the process environment to exactly 64 hex
characters (32 random bytes). Keep that key for reopening this tenant's store.
It is never accepted as a CLI argument or JSON configuration field.

```sh
agent-rewind gateway --storage sqlite --tenant athena --epoch trial-1
# Stop recording, then replay the ordered responses (strict misses return 409):
agent-rewind gateway --storage sqlite --tenant athena --epoch trial-1 --replay-cursor review-1
```

Storage defaults to `.rewind/storage`; override with `--storage-directory`.
Equivalent non-secret environment fields are `REWIND_STORAGE`, `REWIND_TENANT`,
`REWIND_EPOCH`, `REWIND_REPLAY_CURSOR`, and `REWIND_STORAGE_DIRECTORY`; JSON uses
`storage`, `tenant`, `epoch`, `replayCursor`, and `storageDirectory`. Existing
configuration precedence applies. A tenant needs its own directory and key.
The optional SQLite native driver must be installed successfully; missing driver,
missing key, wrong key and corrupt storage fail visibly without memory fallback.

Without a cursor, every eligible live call is appended as a distinct occurrence,
including identical requests. With a cursor, responses are consumed in order and
the cursor resumes across process restarts. Set a unique `x-rewind-request-id`
for each logical replay call and reuse it only when retrying that same call to
recover the original response without consuming another position. Control headers
are stripped upstream. Unsupported mutations are refused; GET/HEAD metadata calls
may still reach the upstream. Conflicts and storage failures return 503 without a
paid model fallback. Ordered replay is not yet included in `agent-rewind savings`.

This remains opt-in: the default memory mode is unchanged. The gateway serializes
tape requests within one process (queue limit 64). Request/response eligibility is
512 KiB; oversized recording traffic passes through with an explicit skip log.
Eligible responses are held in full until recording commits, delaying first-token
delivery. On crossing the eligibility limit, held bytes are flushed and the rest
streams without recording. A client disconnect cancels its upstream request; an
absolute 120-second upstream deadline releases stalled work. SDK callers can set
`tape.upstreamTimeoutMs`. Full request streaming/backpressure and incremental
terminal staging remain U26 work. Multi-process recording of
the same epoch can conflict; run one writer. Physical WAL limits and broader
storage lifecycle certification remain separate acceptance work.

## Bounded traffic analysis (v1.1.0)

Run `agent-rewind analyze --file capture.ndjson --ndjson`, or pipe a capture to
`agent-rewind analyze --stdin`. JSON arrays and a positional JSON argument remain supported.
NDJSON is processed incrementally, with limits of 2 MiB per record, 128 MiB total,
100,000 distinct request keys and 1,000 scopes. JSON arrays use a 16 MiB buffer limit.

The default attested report contains aggregate counters and a source byte count/hash,
without prompt samples or scope labels. These are hypothetical exact-request repeat
opportunities, not realized savings. Unknown request headers or upstream origins never
count as replay opportunities. Invalid token counts and counter overflow are rejected.
`--legacy-json` explicitly includes the previous redacted sample and scope breakdown;
review captured content before sharing that expanded report. Errors contain bounded
reasons and source byte counts/hashes, without request excerpts or filesystem paths.

### Compare two requests' cache prefixes (v1.1.0)

Save consecutive messages-style request bodies as JSON, then run:

```sh
agent-rewind cache-compare previous.json current.json
```

The compact report identifies unchanged history, appended messages, appended
content blocks, or divergence and gives a recommendation. `firstChangedPath`
points to the relevant message/block or request settings. Prompts and responses
are not printed. No model call or workspace initialization occurs.

This is a conservative content comparison adapted from Headroom, not proof of a
provider cache hit. All request settings remain significant; object property
order is ignored. Inputs must be regular UTF-8 JSON files, no more than 2 MiB each,
with message arrays. Responses `input`-style bodies are not yet supported by this
command. Invalid or oversized inputs exit 1 with an actionable error.

In a source checkout before release, use `node packages/mcp/dist/cli.js` in place
of `agent-rewind` after `npm run build`. Apache-2.0 attribution is shipped under
`third_party/headroom/` in the MCP package.

Use `--record-only` to explicitly clear a replay cursor inherited from configuration or
`REWIND_REPLAY_CURSOR`. This makes live upstream calls and requires SQLite mode. It
cannot be combined with `--replay-cursor`. Explicit `null` configuration values are
rejected; omit a field to use its default.
