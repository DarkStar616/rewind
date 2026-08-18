# Rewind MVP — design spec

**Status:** approved to plan (2026-08-18). Consolidates `docs/ARCHITECTURE.md`, `docs/PLAN.md`,
`docs/POSITIONING.md`, `docs/SAVINGS-RECEIPT.md`. Those remain the depth; this is the build contract.

## Goal

Ship `@rewind/core` + `@rewind/mcp` + a `rewind` CLI: whole-workspace git checkpoint/rewind plus a
deterministic refuse-and-record effect barrier and tamper-evident hash chain, harvested from
qm-athena and genericized so the same core later runs elsewhere unchanged.

## Approved decisions

1. **Reach:** full moat in every terminal and local agent now; the remote-HTTP web adapter
   (barrier/audit/verify only — web physically cannot do local rewind) is a **fast-follow, not in the
   MVP slices**. Hosted sandbox and OS jail are later tiers.
2. **Execution:** autonomous sprint after approval — Slice 0 → 1 → 1.5, TDD, a test-gate per slice,
   commit per task, pause only on a real decision or a red gate.

## Surface matrix (how "works everywhere" is delivered)

One `@rewind/core`; thin adapters. Terminal CLI (universal floor, full moat) · stdio MCP (`npx rewind
mcp`, full moat, all local agents) · Claude Code plugin (auto-wires the barrier via a PreToolUse hook)
· remote Streamable-HTTP MCP (fast-follow, portable half only).

## Scope

**In (MVP slices):**
- **Slice 0** — `@rewind/core`: `WorldBackend` interface + Tier-0 git backend; canonical JSON;
  tamper-evident evidence chain; deterministic effect barrier (refuse-and-record) **with the
  concurrency fix**; replay-savings sink; the two injected coupling points (action vocabulary,
  authority resolver) with permissive/no-op defaults; a thin internal engine driving a `rewind` CLI.
- **Slice 1** — `@rewind/mcp`: stdio MCP server exposing `checkpoint`/`list`/`rewind`/`replay`/
  `guard_effect`, handle-in/handle-out, state in the durable store; `npx rewind` distribution; config
  snippets; the Claude Code plugin (`.mcp.json` + PreToolUse barrier hook); "Add to Cursor" deeplink.
- **Slice 1.5** — the savings receipt: `rewind savings` CLI + `savings` MCP tool over the replay-savings
  sink, with honest-counterfactual metering (per `SAVINGS-RECEIPT.md`).

**Out (explicitly deferred):** remote-HTTP web adapter (fast-follow after MVP), hosted sandbox / OS
jail tiers, Slice 2 (flip qm-athena onto the published package), the public name change, the waste
calculator (already built as a standalone page, no code dependency).

## Global constraints (verbatim into the plan)

- **Runtime:** Node ≥ 24.15 (`.node-version` 24.18.0). ESM only (`"type":"module"`). Native TypeScript
  — no bundler; import with `.ts` extensions; `tsconfig` `module`/`moduleResolution` `nodenext`,
  `verbatimModuleSyntax`, `allowImportingTsExtensions`. Test runner: `node --test` (node:test).
- **MCP:** official `@modelcontextprotocol/sdk` ^1.29.
- **Packaging & licence (FINAL, research-grounded):** npm workspaces; `@rewind/core` and `@rewind/mcp`
  are separate packages licensed **FSL-1.1-Apache-2.0** (Functional Source License; `package.json`
  `"license": "FSL-1.1-ALv2"`; bundle the FSL `LICENSE` text). Source-available and legally proprietary:
  a competitor may NOT build a competing/substituting product on it; converts to Apache-2.0 after 2 yrs.
  The **dev repo may stay private** (hygiene) but note the shipped package is readable on the user's disk
  regardless — protection is by licence, not secrecy. **Real secrecy + access-gate + billing integrity
  live HOSTED (closed), never shipped:** entitlement validation, savings verification/billing, team
  dashboard, and the Athena authority resolver. Athena consumes `@rewind/core` privately (common
  ownership; a private registry is optional). See `docs/LICENCE-DECISION.md` + `docs/BUSINESS-MODEL.md`.
- **The barrier and the hash chain NEVER read the filesystem** — only the effect log and the trace.
  Exactly ONE real barrier implementation (the TypeScript one). Any Python probe is a conformance model.
- **Harvest, don't rebuild.** Port from the qm-athena `deploy-latest` worktree
  `/home/reuben/projects/qm-athena/.claude/worktrees/mvp-golden-path/` (read-only; never modify athena).
  Exact source files and the two coupling points are in `docs/ARCHITECTURE.md`.
- **Concurrency fix (mandatory):** the harvested barrier reads `spentAt` outside the append lock with
  no uniqueness constraint (TOCTOU). The port MUST move the spent-check inside the serializing lock and
  add a unique `(scope, effectKey)` constraint, proven by a concurrent-double-emit test that fails on
  the lifted-as-is code.
- **Honesty:** Tier-0 is reversibility, not isolation, and it is commodity — the moat is the
  deterministic, filesystem-independent barrier + chain. No token-saving/accuracy claim ships
  unsubstantiated; the savings number is metered conservatively.

## Success (the acceptance demo)

In any git repo: an agent checkpoints, edits files including via a `bash` command, rewinds to the
checkpoint, and is refused when it re-fires a spent effect across the rewind, with the refusal recorded
on the hash chain and verifiable — end to end through the MCP tools, verified against at least one real
client, zero accounts, zero privileges. `rewind savings` prints an honest recovered-tokens line.
