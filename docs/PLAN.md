# Rewind standalone: build plan

Appetite for the MVP: a couple of focused build sessions, not a quarter. If the design does not fit
that, cut the design, not the appetite. The MVP is three slices. Everything after them is explicitly
later, and is listed so you can see the shape, not so you build it now.

The demo that defines success: in any git repo, an agent checkpoints, edits files including through a
shell command, rewinds to the checkpoint, and is refused when it tries to re-fire a spent effect
across the rewind, with the refusal recorded and verifiable. That is the whole thesis, end to end,
with zero accounts and zero privileges.

---

## MVP

### Slice 0: the core engine (`@rewind/core`)

Build the portable moat with one world backend and no substrate dependency.

- Scaffold the repo: a small npm workspace, TypeScript, one test runner, MIT or Apache licence, a
  clean split between the open core packages and any future commercial packages.
- `WorldBackend` interface + the Tier 0 git and reflink copy-on-write worktree backend
  (`snapshot`, `fork`, `restore`, `diff`, `log`). Detect copy-on-write support and fall back to a
  plain checkout with a clear message where reflink is unavailable.
- The effect barrier (`emitEffect`) and the append-only tamper-evident hash chain (`append`,
  `verify`) with canonical JSON hashing. Both read only the effect log and trace, never the
  filesystem. Both take the injected action vocabulary and authority resolver, with permissive
  defaults.
- A thin internal CLI engine (`rewind checkpoint | list | rewind | replay | guard`) over the core.

Harvest from the files listed in `docs/ARCHITECTURE.md`; do not rebuild. Genericize the two coupling
points as you port the hash chain.

**Acceptance:**
- `snapshot` then edit then `restore` returns the tree to the snapshot, including a change made by a
  shell command, on a copy-on-write filesystem and on a fallback filesystem.
- `emitEffect` on a fresh key records a spent entry; a second `emitEffect` on the same key after a
  `restore` is refused and the refusal is recorded citing the first.
- `verify` passes on an untouched chain and fails, pointing at the entry, when any interior field is
  edited. This test must fail on a do-nothing implementation.
- **Concurrent double-emit of the same effect key produces exactly one spent entry.** The harvested
  barrier has a verified TOCTOU gap (spent-check outside the append lock, no uniqueness constraint on
  the key) — the port must close it (check inside the serializing lock + unique `(scope, effectKey)`
  constraint). This test must fail on the lifted-as-is code. See `ARCHITECTURE.md` harvest map.

### Slice 1: the MCP server (`@rewind/mcp`) — the first adoptable surface

- A stdio MCP server over the core, exposing `checkpoint`, `list`, `rewind`, `replay`,
  `guard_effect` as tools, each minting and accepting a checkpoint-id handle, with all state in the
  durable store keyed by the handle, none in transport or connection memory.
- Distribution as `npx rewind` with zero install.
- **Minimum viable distribution (see `POSITIONING.md` §5):** (1) the `npx -y @rewind/mcp` stdio bin;
  (2) two copy-paste snippets on the docs page — one JSON `mcpServers` block with `"type":"stdio"` that
  drops into Claude Code + Cursor + Cline + Windsurf unchanged, and one TOML `[mcp_servers.rewind]` for
  Codex CLI (the outlier) — plus the `claude mcp add` / `codex mcp add` one-liners as the primary path;
  (3) a Claude Code **plugin** in a marketplace repo bundling `.mcp.json` **+ a `PreToolUse`
  `guard_effect` hook on `Bash|Write|Edit`** — the ONLY surface that auto-wires the barrier with zero
  user config; (4) an "Add to Cursor" deeplink button. Web connectors (one shared remote
  Streamable-HTTP transport, barrier/audit half only — no local rewind on web) are deferred.

**Acceptance:**
- The same server binary is added to Claude Code and to one of Cursor or Codex CLI from its config,
  and an agent completes the success demo above end to end through the MCP tools.
- Verified live against at least one real client before the slice is called done.

### Slice 2: keep it inside the larger product

- Confirm the two coupling points (action vocabulary, authority resolver) are injected in
  `@rewind/core`.
- Publish `@rewind/core` (a private or pre-release channel is fine) and switch the larger product
  from its local copies to the package, injecting its own store, vocabulary and resolver.

**Acceptance:**
- The larger product builds and its effect-barrier and evidence-chain tests pass against the package,
  with no behaviour change. One implementation, consumed in two places, no fork.

---

## Later phases (do not pull forward)

**Phase 1, automation and reach on coding agents.** A Claude Code plugin bundling the MCP server with
a `PostToolUse` shell-matcher that auto-checkpoints after every shell call and a `PreToolUse` matcher
that calls the effect guard before risky commands, installable in one command. A public
`rewind run -- <agent command>` CLI for agents with no MCP or hook story. Both call the same engine.

**Phase 2, deeper reversibility and enforcement.** Surface replay with tokens and cost avoided as a
first-class result. Add the Tier 1 OS-level jail as a drop-in backend for users who need enforced,
not merely recorded, containment; this is where the Python substrate and its command-line contract
enter, and where a privileged host is required.

**Phase 3, web.** Host the MCP server with OAuth, publish it as a Claude.ai custom connector and a
ChatGPT app over the identical tool contract, and add the Tier 2 hosted sandbox backend, targeting the
Apache-2.0 self-hostable provider first. Lead the web pitch with the effect barrier, and never claim
local rollback on web.

**Beyond, the correlated evidence record.** The tamper-evident chain is the seam to the actor
attestation and action-verification systems in the larger product. That correlation is a separate,
later moat surface and is not part of the standalone SDK's near-term path.

---

## Cross-cutting, do these early and cheaply

- **Name — escalated to a publish blocker (2026-08-18).** "Rewind" is crowded in exactly this niche:
  `khalilbalaree/Rewind-MCP` (a checkpoint MCP server), `nicobailon/pi-rewind-hook` (161★),
  `adi-suresh01/rewind`. Pick a distinctive name + npm scope **before the first npm publish / plugin
  listing.** See `POSITIONING.md` §4.
- **Open-core boundary from the first commit.** Core packages MIT or Apache; keep any hosted or
  enterprise code in separate packages so the boundary never has to be untangled later.
- **Honesty guardrails, in the docs and the tool descriptions.** Tier 0 is reversibility, not
  isolation — and per fresh research it is now **commodity** (Claude Code/Cline/OpenCode/Gemini CLI all
  ship rewind); do not market it as the moat. Git snapshots do not capture process memory or external
  effects; the effect barrier covers the external-effect gap. On web there is no local rollback. State
  each plainly.
- **Positioning — pressure-tested (DONE, see `POSITIONING.md`).** Finding: the effect-barrier *concept*
  is NOT novel (ACRFence arxiv:2603.20625; `rune0-dev/agent-ledger` on PyPI; LangGraph #8464 building
  it), but the *combination* Rewind ships is unshipped and the *implementation* is defensible. New
  headline: "the only deterministic, filesystem-independent, TypeScript-native effect barrier +
  tamper-evident chain — in a space the research has proven every framework gets wrong." Reversibility's
  value is strongly evidenced (AgentRewind 30% vs 8% recovery); the token-saving $ number is a
  land-grab we should publish first.

---

## First commands for the build session

```
# in /home/reuben/projects/rewind
git init
# scaffold the npm workspace and @rewind/core per docs/ARCHITECTURE.md, then start Slice 0.
```

Read `CLAUDE.md`, then `docs/ARCHITECTURE.md`, then build Slice 0. Harvest from
`/home/reuben/projects/qm-athena` and `/home/reuben/projects/shepherd`; do not rebuild what already
works there.
