# Rewind standalone: build plan

Appetite for the MVP: a couple of focused build sessions, not a quarter. If the design does not fit
that, cut the design, not the appetite. The MVP is three slices. Everything after them is explicitly
later, and is listed so you can see the shape, not so you build it now.

The demo that defines success: in any git repo, an agent checkpoints, edits files including through a
shell command, rewinds to the checkpoint, and is refused when it tries to re-fire a spent effect
across the rewind, with the refusal recorded and verifiable. That is the whole thesis, end to end,
with zero accounts and zero privileges.

**This is a sprint** (strategy folded in 2026-08-18): the product ships free, local-only, zero
marginal cost (their API key, their disk, their provider's cache discount — we are never in the data
path). The growth engine is not a later phase — it is **the savings receipt** (Slice 1.5), built on
the same replay-savings data we are already harvesting. Distribution is a config line into the harness
they already run. The full go-to-market shape and the honest business model are in `POSITIONING.md`;
the sprint-critical pieces are pulled into the slices below.

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

### Slice 1.5: the savings receipt (the growth engine — do NOT defer)

The single highest-leverage feature in the whole product. It is the retention hook, the shareable
artifact, and the upsell trigger, and its data source **already exists in the harvest**
(`src/harness/recorded/replay-savings.ts` writes a `ReplaySaving` with tokens/cost avoided on every
replay). Full spec: `docs/SAVINGS-RECEIPT.md`.

- A `rewind savings` CLI command (and an MCP `savings` tool) that reads the accumulated
  `ReplaySaving` records for a scope and prints one honest line:
  `Rewind recovered 4.2M tokens this week (~$63 saved).`
- **Honest counterfactual metering is the acceptance bar, not a nicety.** "Saved" counts ONLY tokens
  that would provably have been re-spent and were not: replay cache-hits (a recorded turn returned with
  `modelCalls:0`) and re-executions avoided by rewinding to a checkpoint with a real prior. It must
  NEVER credit a whole failed run, or bill-agnostic wall-clock. A padded number dies the moment a
  sharp engineering manager checks it; a conservative real number is a category we can own (no public
  replay-savings figure exists — Lane C).
- Local and account-free. When cumulative savings cross a threshold it prints ONE upsell line pointing
  at the (paid, hosted) team view — the only place an email is ever requested.

**Acceptance:**
- Given a sequence with a real replay cache-hit, `rewind savings` reports exactly the avoided token
  count from the `ReplaySaving` records — and reports **zero** for a run with no avoided re-spend.
  A test feeds a no-replay session and asserts the receipt says 0 (guards against an inflated number).
- The token/cost figures reconcile to the sum of the underlying `ReplaySaving` records (no double
  count across overlapping rewinds).

### Slice 2: keep it inside the larger product

- Confirm the two coupling points (action vocabulary, authority resolver) are injected in
  `@rewind/core`.
- Publish `@rewind/core` (a private or pre-release channel is fine) and switch the larger product
  from its local copies to the package, injecting its own store, vocabulary and resolver.

**Acceptance:**
- The larger product builds and its effect-barrier and evidence-chain tests pass against the package,
  with no behaviour change. One implementation, consumed in two places, no fork.

---

## Go-to-market sprint (folded from strategy 2026-08-18, founder-confirmed)

The build and the distribution are one sprint, in this order. Rationale and the honest business model
live in `POSITIONING.md` §5; the risks (support-time-scales-with-success, the two-motions focus
question) are founder calls and are noted there, not resolved here.

1. **Name:** deferred by founder — ship under `rewind` / `@rewind/*` for now, rename in prod before a
   loud launch. (The collision risk still stands for the *public* launch; it is not a blocker for the
   sprint.)
2. **Savings receipt (Slice 1.5)** — built on the harvested replay-savings sink. The growth engine.
3. **Waste calculator** — a standalone public page ("How much are you burning on failed agent runs?").
   One week of work, **no product dependency**, the most linkable thing we will own. Defaults grounded
   in evidence, not vibes: a failed run ≈ 50–60 LLM calls; 28–64% of tokens on failed trajectories are
   recoverable (arxiv:2608.03222); agents submit ~100% but resolve ~44% (arxiv:2603.25764). Spec +
   first build: `docs/calculator/`.
4. **Distribution** — the four minimum-viable artifacts in Slice 1 (npm stdio bin, two config snippets,
   the Claude Code plugin that auto-wires the barrier, the "Add to Cursor" deeplink).
5. **Twenty real users, quietly. Fix onboarding. Then one loud launch** (Product Hunt / Show HN are
   one-shot cards — do not spike onto a broken onboarding).

**The free/paid line = the local/hosted line.** Everything free is local and account-free (a library +
a CLI that prints to the terminal). The paid convert is the **team view** — a manager seeing spend
across N developers inherently needs aggregation, which inherently needs a server. Keep cloud
checkpoint sync and any hosted dashboard strictly paid and metered; they are the only things that turn
a zero marginal cost into a real bill.

**The one path back to Athena** is a single button in the (paid) team view: *"See who authorised these
runs."* That button is not a bolt-on — it is the **authority resolver** coupling point
(`ARCHITECTURE.md` #2). Free Rewind ships the **no-op default resolver** (no authority, no button);
Athena injects its **real resolver** and the button lights up. Same `@rewind/core`, no fork. Do not
mention Athena anywhere else in the product.

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
