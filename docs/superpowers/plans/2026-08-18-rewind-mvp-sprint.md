# Rewind MVP Sprint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Ship `@rewind/core` + `@rewind/mcp` + a `rewind` CLI giving any coding agent whole-workspace
git checkpoint/rewind plus a deterministic refuse-and-record effect barrier and tamper-evident hash
chain, harvested from qm-athena and genericized.

**Architecture:** One `@rewind/core` (WorldBackend + effect barrier + evidence chain + replay-savings,
all pure logic above a swappable backend; barrier and chain never read the filesystem) driven by a thin
engine. Thin adapters reach every surface: a `rewind` CLI (universal terminal floor), an `@rewind/mcp`
stdio server (all local agents), and a Claude Code plugin. Harvest, don't rebuild.

**Tech Stack:** Node ≥24.15, native TypeScript (no bundler, `.ts` imports), ESM, `node:test`,
`@modelcontextprotocol/sdk` ^1.29, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-18-rewind-mvp-design.md` (and the depth in
`docs/ARCHITECTURE.md`, `docs/PLAN.md`, `docs/SAVINGS-RECEIPT.md`).

## Global Constraints

- Node ≥ 24.15 (`.node-version` = 24.18.0); ESM only (`"type":"module"`); native TS — `tsconfig`
  `module`/`moduleResolution` = `nodenext`, `verbatimModuleSyntax: true`, `allowImportingTsExtensions: true`;
  import sibling modules WITH the `.ts` extension.
- Test runner: `node --test` (node:test). No vitest/jest.
- Packages `@rewind/core` and `@rewind/mcp` are **PROPRIETARY / CLOSED SOURCE — NOT MIT**.
  `package.json` `"license": "UNLICENSED"`; proprietary EULA `LICENSE` file (final text from the licence
  decision, workflow `wlwjzoq7a`). Source repo private; any public npm artifact is a compiled/obfuscated
  build. npm workspaces. Paid access is gated by a license key + entitlement/metering backend (later).
- The effect barrier and the evidence chain read ONLY the effect log / trace, NEVER the filesystem.
  Exactly one real barrier implementation (this TypeScript one).
- Harvest read-only from `/home/reuben/projects/qm-athena/.claude/worktrees/mvp-golden-path/` (branch
  `deploy-latest`). NEVER modify any athena file.
- Barrier concurrency fix is mandatory (Task 5): spent-check + append must be atomic per scope, with a
  `(scope, effectKey)` uniqueness guarantee, proven by a concurrent-double-emit test that fails on the
  lifted-as-is code.
- Two injected coupling points with safe defaults: an action **vocabulary** and an **authority
  resolver** (no-op default returning `{ onBehalfOf: null, authorityChain: [] }`).

---

## File structure

```
rewind/
  package.json                      # workspaces: ["packages/*"]
  tsconfig.base.json
  packages/
    core/
      package.json                  # @rewind/core
      tsconfig.json
      src/
        types.ts                    # ScopeId, shared types
        util/async.ts               # createKeyedQueue (port as-is)
        audit/canonical-json.ts     # canonicalize (port as-is)
        audit/correlation.ts        # correlation id (port as-is)
        audit/evidence-ledger.ts    # chain, GENERICIZED (inject vocab + authority)
        audit/effect-ledger.ts      # barrier, GENERICIZED + CONCURRENCY FIX
        replay/replay-savings.ts    # savings sink (port, drop qm coupling)
        world/world-backend.ts      # WorldBackend interface (new)
        world/git-backend.ts        # Tier-0 git backend (adapt git-tracked-sandbox.ts)
        engine.ts                   # the single engine over core
        index.ts                    # public exports
      test/*.test.ts
    mcp/
      package.json                  # @rewind/mcp, bin: rewind
      src/
        server.ts                   # stdio MCP server, 5 tools
        store.ts                    # durable handle store
        cli.ts                      # rewind CLI (checkpoint|list|rewind|replay|guard|savings|mcp)
      test/*.test.ts
      dist-plugin/                  # Claude Code plugin (.mcp.json + hooks/hooks.json)
  docs/... (existing)
```

---

## SLICE 0 — `@rewind/core`

### Task 1: Scaffold the workspace

**Files:** Create `package.json`, `tsconfig.base.json`, `.node-version`, `packages/core/package.json`,
`packages/core/tsconfig.json`, `packages/core/src/types.ts`, `packages/core/src/index.ts`.

- [ ] **Step 1:** Create `.node-version` containing `24.18.0`.
- [ ] **Step 2:** Create root `package.json`:

```json
{
  "name": "rewind-monorepo",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*"],
  "engines": { "node": ">=24.15.0" },
  "scripts": { "test": "node --test packages/*/test/*.test.ts" }
}
```

- [ ] **Step 3:** Create `tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "esnext",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": true,
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 4:** Create `packages/core/package.json`:

```json
{
  "name": "@rewind/core",
  "version": "0.0.0",
  "type": "module",
  "license": "UNLICENSED",
  "exports": { ".": "./src/index.ts" }
}
```

- [ ] **Step 5:** Create `packages/core/tsconfig.json`: `{ "extends": "../../tsconfig.base.json" }`.
- [ ] **Step 6:** Create `packages/core/src/types.ts`:

```ts
export type ScopeId = string;
```

- [ ] **Step 7:** Create `packages/core/src/index.ts` with `export {};` (filled by later tasks).
- [ ] **Step 8:** Run `node --test` (expect: no tests found, exit 0) and commit.

```bash
git add -A && git commit -m "chore: scaffold rewind npm workspace + @rewind/core"
```

### Task 2: Canonical JSON (port as-is)

**Files:** Create `packages/core/src/audit/canonical-json.ts`, `packages/core/src/util/async.ts`,
`packages/core/src/audit/correlation.ts`, `test/canonical-json.test.ts`.

**Interfaces — Produces:** `canonicalize(value: unknown): string` (byte-stable),
`createKeyedQueue<K>(): (key: K, task: () => Promise<T>) => Promise<T>`,
`correlationIdForEvent(): string`.

- [ ] **Step 1:** Copy verbatim (read-only source → new file, do not edit athena):
  `mvp-golden-path/src/audit/canonical-json.ts` → `packages/core/src/audit/canonical-json.ts`;
  `mvp-golden-path/src/util/async.ts` → `packages/core/src/util/async.ts`;
  `mvp-golden-path/src/audit/correlation.ts` → `packages/core/src/audit/correlation.ts`. Fix any import
  path so `ScopeId` resolves to `../types.ts`.
- [ ] **Step 2: Write the failing test** `test/canonical-json.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../src/audit/canonical-json.ts";

test("key order does not change the canonical form", () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
});
test("rejects non-finite numbers", () => {
  assert.throws(() => canonicalize({ x: Infinity }));
});
```

- [ ] **Step 3:** Run `node --test packages/core/test/canonical-json.test.ts` — expect PASS (it's ported
  working code). If the reject-Infinity test fails, the wrong file was copied — recheck the source.
- [ ] **Step 4:** Commit: `git commit -am "feat(core): port canonical JSON, keyed queue, correlation"`.

### Task 3: Evidence chain — port + genericize (inject vocabulary + authority)

**Files:** Create `packages/core/src/audit/evidence-ledger.ts`, `test/evidence-ledger.test.ts`.

**Interfaces — Consumes:** `canonicalize`, `createKeyedQueue`, `correlationIdForEvent`.
**Produces:** `createMemoryEvidenceLedger(opts?: LedgerOptions): EvidenceLedger`;
`EvidenceLedger { durable; append(input): Promise<AuditEntry>; verify(scope): Promise<VerifyResult>;
list(query?): Promise<readonly AuditEntry[]>; head(scope): Promise<AuditEntry|undefined> }`;
`computeEntryHash`, `verifyChain`, `GENESIS_HASH`, `EvidenceLedgerError`; types `AuditEntry`,
`AuditEntryInput`, `VerifyResult`. **The action type becomes `string`** (validated against the injected
vocabulary), not a hard-coded union.

- [ ] **Step 1:** Copy `mvp-golden-path/src/audit/evidence-ledger.ts` → target. Then genericize (this
  removes the two coupling points):
  - **Vocabulary:** delete the hard-coded `AUDIT_ACTIONS`/`AuditAction`/`isAuditAction`. Add an options
    object; `action` typed `string`. Validate against an injected set:

    ```ts
    export interface AuthorityResolver {
      (input: { actorId: string; onBehalfOf?: string; authorityChain?: readonly string[]; subject: string; }):
        { onBehalfOf: string | null; authorityChain: readonly string[] };
    }
    export interface LedgerOptions {
      vocabulary?: readonly string[];            // undefined = accept any non-empty action
      approvalActions?: readonly string[];       // default []
      resolveAuthority?: AuthorityResolver;      // default no-op below
    }
    const NOOP_AUTHORITY: AuthorityResolver = () => ({ onBehalfOf: null, authorityChain: [] });
    ```
  - **Authority:** delete `import { resolveAuthority } from "../decisions/decision.ts"`. Use
    `opts.resolveAuthority ?? NOOP_AUTHORITY` inside `resolveEntryProvenance`. `approvalActions` drives
    `isApprovalAction` (default: nothing is an approval action → provenance always `{null, []}`).
  - `append` validates: if `vocabulary` provided and `action` not in it (or action is empty) → throw
    `EvidenceLedgerError`. Keep the per-scope `createKeyedQueue` serialization and the `idempotencyKey`
    map exactly as harvested.
  - Keep `computeEntryHash`/`verifyChain`/`GENESIS_HASH` byte-identical (hash stability matters).
- [ ] **Step 2: Write the failing tamper test** `test/evidence-ledger.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryEvidenceLedger, verifyChain } from "../src/audit/evidence-ledger.ts";

test("verify passes on an untouched chain and fails when an interior field is edited", async () => {
  const led = createMemoryEvidenceLedger();
  await led.append({ scopeLabel: "s", action: "a", detail: { n: 1 } });
  await led.append({ scopeLabel: "s", action: "a", detail: { n: 2 } });
  assert.equal((await led.verify("s")).ok, true);
  const entries = [...(await led.list({ scopeLabel: "s" }))];
  const tampered = entries.map((e, i) => (i === 0 ? { ...e, detail: { n: 999 } } : e));
  const res = verifyChain(tampered);
  assert.equal(res.ok, false);
  assert.equal(res.brokenAtSeq, 0);
});

test("an unknown action is rejected when a vocabulary is injected", async () => {
  const led = createMemoryEvidenceLedger({ vocabulary: ["allowed"] });
  await assert.rejects(led.append({ scopeLabel: "s", action: "nope", detail: null }));
});
```

- [ ] **Step 3:** Run the test — the tamper case MUST fail on a do-nothing `verifyChain`; confirm it
  passes on the real one and the vocabulary case rejects. Run:
  `node --test packages/core/test/evidence-ledger.test.ts`.
- [ ] **Step 4:** Export from `index.ts`. Commit: `feat(core): genericized tamper-evident evidence chain`.

### Task 4: Effect barrier — port refuse-and-record

**Files:** Create `packages/core/src/audit/effect-ledger.ts`, `test/effect-ledger.test.ts`.

**Interfaces — Consumes:** `EvidenceLedger`, `EvidenceLedgerError`.
**Produces:** `createEffectLedger(ledger, opts?): EffectLedger`;
`EffectLedger { emit(effect): Promise<EffectOutcome>; spentAt(scope, key): Promise<number|undefined> }`;
types `ExternalEffect`, `EffectOutcome = EffectAdmission | EffectRefusal`. Constants
`EFFECT_EMITTED = "effect_emitted"`, `EFFECT_REPLAY_REFUSED = "effect_replay_refused"`.

- [ ] **Step 1:** Copy `mvp-golden-path/src/audit/effect-ledger.ts` → target. Rename the action
  constants to the generic values above (no `external_` prefix) and ensure the ledger is created with a
  `vocabulary` that includes them (the barrier owns its two actions).
- [ ] **Step 2: Write the failing refuse-and-record test:**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryEvidenceLedger } from "../src/audit/evidence-ledger.ts";
import { createEffectLedger, EFFECT_REPLAY_REFUSED } from "../src/audit/effect-ledger.ts";

test("first emit is admitted; a second emit of the same key is refused and recorded citing the first", async () => {
  const led = createMemoryEvidenceLedger({ vocabulary: ["effect_emitted", "effect_replay_refused"] });
  const eff = createEffectLedger(led);
  const first = await eff.emit({ effectKey: "charge:42", scopeLabel: "s", kind: "http" });
  assert.equal(first.refused, false);
  const second = await eff.emit({ effectKey: "charge:42", scopeLabel: "s", kind: "http" });
  assert.equal(second.refused, true);
  assert.equal(second.firstEmittedSeq, 0);
  const refusals = await led.list({ scopeLabel: "s", action: EFFECT_REPLAY_REFUSED });
  assert.equal(refusals.length, 1);
  assert.equal((await led.verify("s")).ok, true);
});
```

- [ ] **Step 3:** Run `node --test packages/core/test/effect-ledger.test.ts` — expect PASS.
- [ ] **Step 4:** Commit: `feat(core): effect barrier — refuse-and-record on the chain`.

### Task 5: Barrier concurrency fix (MANDATORY — the known bug)

**Files:** Modify `packages/core/src/audit/effect-ledger.ts`; add to `test/effect-ledger.test.ts`.

**Problem:** harvested `emit` calls `spentAt` (a `list` scan) then `append` in two separate awaits, so
two concurrent emits of the same key both observe "unspent" and both append `EFFECT_EMITTED`.

- [ ] **Step 1: Write the failing concurrent test FIRST and watch it fail on the lifted-as-is code:**

```ts
test("concurrent double-emit of the same key yields exactly one admission and one spent entry", async () => {
  const led = createMemoryEvidenceLedger({ vocabulary: ["effect_emitted", "effect_replay_refused"] });
  const eff = createEffectLedger(led);
  const [a, b] = await Promise.all([
    eff.emit({ effectKey: "charge:99", scopeLabel: "s", kind: "http" }),
    eff.emit({ effectKey: "charge:99", scopeLabel: "s", kind: "http" }),
  ]);
  const admitted = [a, b].filter((r) => r.refused === false);
  assert.equal(admitted.length, 1, "exactly one emit may be admitted");
  const emitted = await led.list({ scopeLabel: "s", action: "effect_emitted" });
  assert.equal(emitted.length, 1, "exactly one spent entry may exist");
});
```

Run it: `node --test ...effect-ledger.test.ts`. Expect FAIL (2 admitted / 2 emitted) on the ported code.

- [ ] **Step 2: Implement the fix** — make check-and-append atomic per scope with a barrier-owned keyed
  queue (a SEPARATE `createKeyedQueue` instance from the ledger's, so no self-deadlock):

```ts
import { createKeyedQueue } from "../util/async.ts";
// inside createEffectLedger:
const gate = createKeyedQueue<string>();
async emit(effect) {
  if (!effect.effectKey.trim()) throw new EvidenceLedgerError("an external effect requires a non-empty effectKey");
  return gate(String(effect.scopeLabel), async () => {
    const already = await spentAt(effect.scopeLabel, effect.effectKey);
    // ...existing refuse-or-admit body, unchanged...
  });
}
```

Also pass `idempotencyKey: \`${scopeLabel}:${effectKey}\`` on the `EFFECT_EMITTED` append as the
durable-store uniqueness guarantee (the ledger already dedupes on `idempotencyKey`), so a future
durable backend enforces `(scope, effectKey)` uniqueness too.

- [ ] **Step 3:** Run the test — expect PASS. Re-run the whole core suite (`node --test`) — all green.
- [ ] **Step 4:** Commit: `fix(core): close barrier TOCTOU — atomic check-and-append per scope`.

### Task 6: WorldBackend + Tier-0 git backend

**Files:** Create `packages/core/src/world/world-backend.ts`, `packages/core/src/world/git-backend.ts`,
`test/git-backend.test.ts`.

**Interfaces — Produces:**

```ts
export interface WorldRef { id: string; label?: string; ts: number; }
export interface RestoreResult { restoredTo: string; }
export interface Change { path: string; status: "A" | "M" | "D"; }
export interface WorldBackend {
  snapshot(label?: string): Promise<WorldRef>;
  restore(ref: WorldRef | string): Promise<RestoreResult>;
  diff(a: WorldRef | string, b: WorldRef | string): Promise<Change[]>;
  log(): Promise<readonly WorldRef[]>;
}
export function createGitBackend(opts: { cwd: string; gitDir?: string }): WorldBackend;
```

- [ ] **Step 1:** Read `mvp-golden-path/src/sandbox/git-tracked-sandbox.ts` and `sandbox.ts`. Adapt the
  git mechanics — snapshot to a SIDE `GIT_DIR` (so the workspace `.git`, if any, is untouched),
  `git add -A` + commit-tree, `restore` via `read-tree`/`checkout-index`, `RevertIndeterminateError`
  fails loud on a partial revert. Implement `createGitBackend` against the interface above using
  `node:child_process` `execFile` with `--git-dir`/`--work-tree`. Do NOT depend on the athena Sandbox
  type — this is a standalone backend.
- [ ] **Step 2: Write the failing test** (uses a real temp git dir; includes a change made via a shell
  command, per the acceptance demo):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createGitBackend } from "../src/world/git-backend.ts";

test("snapshot → shell edit → restore returns the tree to the snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-"));
  try {
    await writeFile(join(dir, "a.txt"), "original");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot("before");
    execFileSync("bash", ["-c", "echo mutated > a.txt"], { cwd: dir });   // change via bash
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "mutated\n");
    await be.restore(snap);
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "original");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 3:** Run `node --test packages/core/test/git-backend.test.ts` — expect PASS. Detect
  reflink/CoW support and log a fallback message where unavailable (do not fail on ext4).
- [ ] **Step 4:** Commit: `feat(core): WorldBackend + Tier-0 git backend (snapshot/restore/diff/log)`.

### Task 7: Replay-savings sink (port, drop qm coupling)

**Files:** Create `packages/core/src/replay/replay-savings.ts`, `test/replay-savings.test.ts`.

**Interfaces — Produces:** `createMemoryReplaySavings(): ReplaySavingsSink`;
`ReplaySavingsSink { record(s: ReplaySaving): void; total(scope?: string): { tokens: number; costMicros: number } }`;
type `ReplaySaving { scope: string; tokensAvoided: number; costMicros: number; model: string; callId: string; }`.

- [ ] **Step 1:** Read `mvp-golden-path/src/harness/recorded/replay-savings.ts`; port the record shape
  and accounting, dropping any qm session-store coupling (keep the clean portable piece). `callId`
  dedupes overlapping rewinds.
- [ ] **Step 2: Write the failing test:**

```ts
test("total sums recorded savings and dedupes by callId", () => {
  const sink = createMemoryReplaySavings();
  sink.record({ scope: "s", tokensAvoided: 100, costMicros: 1000, model: "m", callId: "c1" });
  sink.record({ scope: "s", tokensAvoided: 100, costMicros: 1000, model: "m", callId: "c1" }); // dup
  assert.deepEqual(sink.total("s"), { tokens: 100, costMicros: 1000 });
});
```

- [ ] **Step 3:** Run test — expect PASS. **Step 4:** Commit: `feat(core): replay-savings sink`.

### Task 8: The engine + `index.ts`

**Files:** Create `packages/core/src/engine.ts`; update `src/index.ts`.

**Interfaces — Produces:** `createEngine(opts: { cwd: string; store: EvidenceLedger; backend: WorldBackend;
savings: ReplaySavingsSink }): Engine` with `checkpoint(label?)`, `list()`, `rewind(id)`, `replay(id)`,
`guard(effect)`, `savings(scope?)`. `rewind(id)` restores the backend to the snapshot AND returns the
effects that are now spent-but-refusable (read from the chain, never the FS).

- [ ] **Step 1:** Implement `createEngine` wiring backend + effect ledger + savings. `guard` calls
  `effectLedger.emit`. `checkpoint`/`list`/`rewind` call the backend; the handle is the `WorldRef.id`.
- [ ] **Step 2: Write an integration test** — the full acceptance demo at the engine level: checkpoint →
  bash edit → guard(effect A) admitted → rewind → guard(effect A again) REFUSED and recorded → verify
  chain ok. Run it; expect PASS.
- [ ] **Step 3:** Export the public surface from `index.ts`.
- [ ] **Step 4: SLICE 0 GATE:** run the whole `@rewind/core` suite `node --test`; all green. Commit:
  `feat(core): engine wiring — end-to-end checkpoint/rewind/guard`.

---

## SLICE 1 — `@rewind/mcp` (server + CLI + distribution)

### Task 9: The CLI (universal terminal floor)

**Files:** Create `packages/mcp/package.json` (bin `rewind` → `src/cli.ts`), `packages/mcp/src/cli.ts`,
`packages/mcp/src/store.ts`, `test/cli.test.ts`.

**Interfaces — Produces:** a `rewind` executable with subcommands `checkpoint [label]`, `list`,
`rewind <id>`, `replay <id>`, `guard <json>`, `savings`, `mcp`. `store.ts` provides a durable
handle→state store (a JSON file under `.rewind/`), keyed by checkpoint id.

- [ ] **Step 1:** `packages/mcp/package.json`:

```json
{
  "name": "@rewind/mcp", "version": "0.0.0", "type": "module", "license": "UNLICENSED",
  "bin": { "rewind": "./src/cli.ts" },
  "dependencies": { "@rewind/core": "0.0.0", "@modelcontextprotocol/sdk": "^1.29.0" }
}
```

- [ ] **Step 2:** Implement `src/store.ts` (durable JSON store keyed by handle; no per-connection state).
- [ ] **Step 3:** Implement `src/cli.ts`: parse argv, build the engine over the git backend in `cwd`,
  dispatch subcommands, print JSON or human lines. Shebang `#!/usr/bin/env node`.
- [ ] **Step 4: Write a failing CLI test** driving the acceptance demo through the built binary in a
  temp git repo (spawn `node src/cli.ts checkpoint`, mutate via bash, `rewind <id>`, `guard` twice,
  assert the second is refused). Run it; expect PASS.
- [ ] **Step 5:** Commit: `feat(mcp): rewind CLI over the core engine`.

### Task 10: The stdio MCP server (5 tools, handle-in/out)

**Files:** Create `packages/mcp/src/server.ts`; wire `rewind mcp` to launch it; `test/server.test.ts`.

**Interfaces — Produces:** an MCP server (official SDK, `StdioServerTransport`) exposing `checkpoint`
`{label?}→{id,ts}`, `list`→`[{id,label,ts,effects}]`, `rewind`{id}→`{revertedTo,refusedEffects[]}`,
`replay`{id}→`{steps,tokensAvoided,costAvoided}`, `guard_effect`{descriptor}→`{decision,reason,chainHash}`.
All state via `store.ts` keyed by the handle; nothing in connection/session memory.

- [ ] **Step 1:** Implement `server.ts` registering the five tools against the engine; each tool mints or
  accepts a handle. Tool descriptions carry the honesty line (Tier-0 = reversibility, not isolation).
- [ ] **Step 2: Write a test** that connects an in-memory MCP client to the server over a stdio pair and
  runs checkpoint→guard→rewind→guard(refused). Run it; expect PASS.
- [ ] **Step 3:** Commit: `feat(mcp): stdio MCP server exposing the five tools`.

### Task 11: Distribution artifacts

**Files:** Create `packages/mcp/dist-plugin/.claude-plugin/plugin.json`,
`packages/mcp/dist-plugin/.mcp.json`, `packages/mcp/dist-plugin/hooks/hooks.json`,
`packages/mcp/dist-plugin/scripts/guard.sh`; `docs/install/README.md`.

- [ ] **Step 1:** Write the two config snippets in `docs/install/README.md`: a JSON `mcpServers` block
  (`"type":"stdio"`, `npx -y @rewind/mcp mcp`) for Claude Code/Cursor/Cline/Windsurf, and a TOML
  `[mcp_servers.rewind]` block for Codex CLI; plus the `claude mcp add` / `codex mcp add` one-liners.
- [ ] **Step 2:** Write the Claude Code plugin: `.mcp.json` pointing at the bin, and `hooks/hooks.json`
  registering a `PreToolUse` matcher on `Bash|Write|Edit` that calls `guard.sh` (which calls
  `rewind guard`); exit 2 blocks a refused effect. Note the scoped-name caveat in a comment.
- [ ] **Step 3:** Add an "Add to Cursor" deeplink (`cursor://...mcp/install?...`) to the docs page.
- [ ] **Step 4:** Commit: `feat(mcp): Claude Code plugin + config snippets + Cursor deeplink`.

### Task 12: SLICE 1 GATE — live client verification

- [ ] **Step 1:** Add the server to a real Claude Code config and to one of Cursor/Codex CLI; run the
  acceptance demo end-to-end through the MCP tools. Record the transcript in `docs/install/VERIFIED.md`.
  This gate is manual and MUST pass before Slice 1 is done (do not self-certify).

---

## SLICE 1.5 — the savings receipt

### Task 13: `rewind savings` + `savings` MCP tool (honest metering)

**Files:** Modify `packages/mcp/src/cli.ts`, `src/server.ts`; add `test/savings.test.ts`. Spec:
`docs/SAVINGS-RECEIPT.md`.

**Interfaces — Produces:** `rewind savings [--since <window>] [--json]` prints
`Rewind recovered <N> tokens this <window> (~$<X> saved).`; MCP `savings` tool returns
`{ tokensSaved, costSaved, currency, window, breakdown: { replayHits, rewindAvoided } }`.

- [ ] **Step 1: Write the failing HONEST-METERING tests FIRST (the acceptance bar):**

```ts
test("savings reports 0 when no re-spend was avoided", async () => {
  // a session with no replay cache-hit
  const out = await runSavings(sessionWithNoReplay());
  assert.equal(out.tokensSaved, 0);   // MUST fail on any 'credit the whole run' implementation
});
test("savings equals the summed ReplaySaving records and never double-counts overlapping rewinds", async () => {
  const out = await runSavings(sessionWithOneReplayOf({ tokens: 1200, callId: "c1" }));
  assert.equal(out.tokensSaved, 1200);
});
```

- [ ] **Step 2:** Implement `savings` over `ReplaySavingsSink.total` — count ONLY replay cache-hits and
  rewind-avoided re-executions; never a whole failed run. Dedupe by `callId`. Static per-model rate
  table, overridable, marked estimate.
- [ ] **Step 3:** Run the tests — expect PASS. Add the threshold upsell line (one line, points at the
  paid team view; the only email ask).
- [ ] **Step 4: SLICE 1.5 GATE:** whole suite green. Commit: `feat(mcp): honest savings receipt`.

---

## Self-review (run before handing over)

- **Spec coverage:** Slice 0 (WorldBackend+git ✓ T6, canonical ✓ T2, chain ✓ T3, barrier+fix ✓ T4/5,
  replay-savings ✓ T7, injected vocab+authority ✓ T3, engine/CLI ✓ T8/9); Slice 1 (MCP 5 tools ✓ T10,
  npx+snippets+plugin+deeplink ✓ T11, live verify ✓ T12); Slice 1.5 (receipt ✓ T13). Out-of-scope
  (web HTTP adapter, hosted sandbox, Slice 2) correctly absent.
- **Placeholder scan:** none — every code/test step carries real content.
- **Type consistency:** `EvidenceLedger`, `EffectLedger`, `WorldBackend`, `ReplaySavingsSink`,
  `Engine` signatures are defined once (T3/4/6/7/8) and consumed by name thereafter.

## Execution options

1. **Subagent-Driven (recommended)** — a fresh subagent per task, two-stage review between tasks.
2. **Inline Execution** — batch with checkpoints via executing-plans.

Correctness-critical tasks (T3, T4, T5, T6, T13) should NOT be fully delegated without review — port
carefully and keep the barrier/chain in careful hands per the founding constraints.
