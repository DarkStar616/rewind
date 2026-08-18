# Rewind standalone: architecture

The shape follows one rule: **the moat is pure logic above a swappable world backend, and it never
reads the filesystem.** Everything else falls out of that.

```
        coding agent (Claude Code / Cursor / Cline / Windsurf / Codex CLI)
                                  |
                                  |  MCP (stdio)          [ later: hooks, plugin, hosted connector ]
                                  v
                        +--------------------+
                        |    @rewind/mcp     |   stdio server: 5 tools, handle-in / handle-out
                        +--------------------+
                                  |  in-process calls
                                  v
                        +--------------------+
                        |    @rewind/core    |   TypeScript, source of truth
                        |                    |
                        |  effect barrier    |   pure logic (node:crypto), refuse-and-record
                        |  evidence chain    |   append-only, tamper-evident hash chain
                        |  trace + replay    |   deterministic replay, tokens/cost avoided
                        |  authority (inj.)  |   injected resolver, no-op default
                        |  action vocab (inj)|   injected vocabulary
                        +--------------------+
                                  |  reads only EffectLog + Trace, never the FS
                                  v
                        +--------------------+
                        |   WorldBackend     |   interface: snapshot / fork / restore / diff / log
                        +--------------------+
                        /          |           \
              Tier 0 (MVP)     Tier 1 (later)    Tier 2 (later)
           git + reflink CoW    OS jail on a     hosted sandbox
           worktrees            privileged host  (Apache-2.0 provider first)
```

## The two packages (MVP)

### `@rewind/core` (TypeScript, MIT/Apache)

The portable moat. No dependency on the Python substrate, and no dependency on the larger product.

- **`WorldBackend` interface** with one method set: `snapshot(label?) -> WorldRef`,
  `fork(ref) -> WorldRef`, `restore(ref) -> RestoreResult`, `diff(a, b) -> Change[]`,
  and a read-only `log() -> WorldRef[]`. One implementation ships: the Tier 0 git plus reflink
  copy-on-write worktree backend.
- **The effect barrier.** `emitEffect(descriptor) -> {spent|refused, chainHash, firstSeq?}`. On
  emit it derives an idempotency key, checks whether that key is already spent on the chain, and
  either records a new spent entry or refuses and records a refusal that cites the first emission.
  Pure `node:crypto`. Reads only the effect log, never the filesystem.
- **The evidence chain.** An append-only, per-scope hash chain with canonical JSON hashing, so any
  interior edit breaks verification. `append(entry)`, `verify() -> ok|brokenAt`. The spent mark and
  the refusal are ordinary entries on this chain, not a separate store, which is what makes a revert
  unable to un-spend an effect.
- **Trace and replay.** The ordered typed record of boundary crossings, and a deterministic replay
  that re-executes a recorded prefix and accounts the tokens and cost avoided. Replay fails hard on
  any divergence from the record; it never falls through to a live call.
- **Two injected dependencies** (this is the extraction discipline): an **action vocabulary** and an
  **authority resolver**, both injected with safe defaults. The larger product injects its own; a
  standalone user gets a permissive default.

### `@rewind/mcp` (TypeScript, MIT/Apache)

A stdio MCP server over `@rewind/core`. Five tools, each stateless-core compliant (mint a handle,
take it back):

| tool | input | output |
|------|-------|--------|
| `checkpoint` | `label?` | `{ id, ts }` |
| `list` | none | `[{ id, label, ts, effects }]` |
| `rewind` | `id` | `{ revertedTo, refusedEffects[] }` |
| `replay` | `id` | `{ steps, tokensAvoided, costAvoided }` |
| `guard_effect` | `descriptor` | `{ decision: allow|refuse, reason, chainHash }` |

State lives in the durable store keyed by the handle, never in transport or connection memory.

## The internal CLI engine

`@rewind/core` is driven by a thin CLI (`rewind checkpoint | list | rewind | replay | guard`) that is
the single engine. The MCP server calls the engine; later, the hooks and the public `rewind run --`
CLI call the same engine. One core, thin adapters, no logic duplicated across surfaces.

## The Python substrate (later tiers only)

The MIT substrate and its two in-process adapters (the copy-on-write snapshot carrier and the replay
provider) stay Python, because they load inside the substrate's runtime. The TypeScript control layer
drives them through the substrate's existing command-line and JSON contract. This only enters the
picture at Tier 1 (enforced jail) and for byte-identical carriers; the MVP does not touch it.

## Harvest map (where the working code already lives)

Read and port from the qm-athena **`deploy-latest`** branch, which is where this code currently
lives. It is **not on `main` yet**, so the plain checkout at `/home/reuben/projects/qm-athena` will
appear to be missing these files. Harvest from the worktree that has `deploy-latest` checked out:
`/home/reuben/projects/qm-athena/.claude/worktrees/mvp-golden-path/` (paths below are relative to
that base). If that worktree is gone, check out branch `deploy-latest` (or ask whether it has since
merged to `main`).

| Rewind core piece | harvest from | notes |
|---|---|---|
| git snapshot backend (Tier 0) | `src/sandbox/git-tracked-sandbox.ts` | pure git; the MVP backend |
| effect barrier | `src/audit/effect-ledger.ts` | genericize action vocab + authority |
| evidence hash chain | `src/audit/evidence-ledger.ts` + `src/audit/correlation.ts` | genericize; inject store |
| canonical JSON | the canonical-json helper used by the chain | keep byte-stable hashing |
| replay + cost accounting | `src/harness/recorded/*` | tokens/cost avoided sink |
| jail-enforcement gate (Tier 1) | `src/shepherd/shepherd-run.ts`, `shepherd-starter.ts` | later; wraps the substrate CLI |
| conformance model (tests only) | `scripts/effect_replay_barrier.py`, `scripts/reversion_completeness.py`, `scripts/probe_fork_revert.py` | Python probe, not a second impl |
| Python carriers (Tier 1+) | `deploy/layers/athena/snapshot-carrier`, `deploy/layers/athena/replay-provider` | stay Python, extract as-is later |

Base substrate: `/home/reuben/projects/shepherd` (`shepherd-workspace` v0.3.0, MIT). Tier 0 git and
copy-on-write snapshotting is already implemented there; harvest it rather than rebuild it.

## Keeping it inside the larger product

The larger product depends on the published `@rewind/core` and injects its own store, action
vocabulary and authority resolver. That is the whole mechanism: one implementation, consumed in two
places. The extraction task that unlocks this is genericizing the two coupling points in the evidence
chain, which today hard-code the product's action vocabulary and import its authority resolver. Do that
first, then flip the product's imports from its local copies to the package.
