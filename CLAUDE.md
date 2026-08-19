# Agent Rewind: build instructions for this session

You are building **Agent Rewind**, a standalone, source-available reversible-execution SDK and MCP server for
AI agents. This file is the standing brief. Read `docs/PLAN.md` for the slice to build, and
`docs/ARCHITECTURE.md` for the shape. `docs/RESEARCH.md` is the evidence; do not re-derive it.

## The one-sentence product

A local MCP server (and thin CLI) that gives any coding agent whole-workspace checkpoint and
rewind, plus a refuse-and-record effect barrier, with a zero-config git/copy-on-write default and
opt-in stronger tiers.

## The prime directive: ship the smallest thing that grows fastest

The founder is a self-identified over-engineer. Your job is to resist that. The MVP is deliberately
tiny, and most of the interesting design is explicitly deferred. Do not pull later phases forward.
When you are tempted to build the hosted service, the OS jail, the web connector, or the second
language, stop and re-read the phase boundaries in `docs/PLAN.md`.

## What the MVP is, exactly

Three npm packages, TypeScript, zero Python, zero dependency on the alpha substrate:

- `@agent-rewind/core` — a `WorldBackend` interface with ONE implementation (git + reflink copy-on-write
  worktrees), plus the effect barrier and the tamper-evident hash chain. The barrier and chain are
  pure logic (`node:crypto`), and they sit ABOVE the `WorldBackend`, reading only the effect log
  and the trace, never the filesystem. That single discipline is what lets the same moat later run
  on a hosted sandbox without a rewrite. Do not violate it.
- `@agent-rewind/gateway` — the token-saving record/replay LLM proxy (exact replay, prompt-cache
  preservation, deterministic pruning) plus the verifiable savings/analysis surface.
- `@agent-rewind/mcp` — a stdio MCP server exposing five tools: `checkpoint`, `list`, `rewind`, `replay`,
  `guard_effect`. Follow the current MCP stateless-core rule: every stateful tool mints an explicit
  checkpoint-id handle and takes it back as an argument. Do not store per-connection state in
  transport or session memory; persist it in the substrate's durable store keyed by the handle.

Distribution: runnable as `npx -y @agent-rewind/mcp` with zero install. Ship a one-line config snippet for Claude
Code, Cursor and Codex CLI.

Done means: in any git repo, an agent can checkpoint, make edits including via `bash`, rewind to a
checkpoint, and be refused when it tries to re-fire a spent effect across the rewind, with the
refusal recorded on the hash chain and verifiable.

## Harvest, do not rebuild

A working implementation exists. Read it and port it; do not reinvent it. The sources:

- qm-athena, TypeScript moat: the git-snapshot sandbox decorator, the effect barrier, the evidence
  hash chain, the correlation identity, the canonical JSON, and the replay/cost-accounting.
  **These live on branch `deploy-latest`, not `main`** — harvest from the worktree that has it
  checked out (`/home/reuben/projects/qm-athena/.claude/worktrees/mvp-golden-path/`), because the
  plain `/home/reuben/projects/qm-athena` checkout (on `main`) will look like the files are missing.
  `docs/ARCHITECTURE.md` lists the exact files and the two coupling points to genericize.
- `/home/reuben/projects/shepherd` (the MIT substrate, `shepherd-workspace` v0.3.0) implements git
  and copy-on-write world snapshots. Tier 0 is a harvest from here, not a rebuild.

Two coupling points MUST be genericized during extraction, or you drag a whole product's model into
a general-purpose SDK:

1. The hash chain hard-codes one product's action vocabulary. Inject the action vocabulary instead.
2. The hash chain imports one product's approval-authority resolver. Inject an authority resolver
   instead (with a no-op default).

## Hard constraints

- **TypeScript is the single source of truth** for the moat semantics and the public surface. The
  substrate is Python and stays behind a CLI/JSON boundary; the two in-process substrate adapters
  (snapshot carrier, replay provider) are Python and stay Python. Do not rewrite either across the
  boundary. There must be exactly one real implementation of the effect barrier: the TypeScript one.
  Any Python copy is a conformance model only, never a second implementation.
- **The effect barrier and hash chain never read the filesystem.** They read the effect log and the
  trace. This is what keeps them portable across every backend tier.
- **Do not market Tier 0 (git snapshots) as isolation or security.** It is reversibility. Isolation
  is the opt-in jail tier. Overclaiming here is a product defect, not a nicety.
- **Reflink copy-on-write is filesystem-dependent** (fast on APFS, btrfs, XFS, ReFS; falls back to a
  full checkout on ext4 and similar). Detect and message this, never promise CoW speed everywhere.
- **Keep it consumable by the larger product.** The larger product will depend on `@agent-rewind/core` as
  a published package once the two coupling points above are genericized. Design the public API so
  that consumer can inject its own store, action vocabulary and authority resolver. Do not fork.

## Method

- Small commits, feature branch, PR. One slice at a time.
- Every slice ships with tests. The effect barrier and the hash chain are correctness-critical:
  test the refuse-and-record path and the tamper-evidence (an interior edit must break verification)
  directly, and make the test fail on a do-nothing implementation.
- Verify the MCP server against at least one real client (Claude Code or Cursor) before calling a
  slice done.
- Report honestly. If a tier is reversibility-only, say so. If a claim is unproven, mark it.

## Naming and licence to confirm early

- Name RESOLVED: the product is **Agent Rewind** (the bare "Rewind" was taken by unrelated products),
  published under the `@agent-rewind/*` npm scope.
- Licence is **FSL-1.1-ALv2** (Functional Source License 1.1, converting to Apache-2.0 two years after
  each release) — source-available, not MIT/open-source. Keep the hosted and enterprise layers separate
  from the core packages from the first commit, so the commercial boundary is clean.
