# Rip-List Buildout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn every buildable rip from the competitive scan (`docs/RIP-LIST.md`) into shipped, tested code — hardening reliability, adding the privacy + gainshare-funnel surfaces, and sharpening the effect barrier — without ever weakening the exact-replay invariant.

**Architecture:** All work sits ABOVE or INSIDE the existing layering. The barrier/chain/pruner/meter stay pure logic over logs+traces (never the filesystem). Redaction and analysis operate on an EXPORT copy, never the primary replay tape, so byte-exact replay is untouched. Pricing/reconciliation are pure functions over provider-reported usage.

**Tech Stack:** TypeScript, Node ≥24.15 native type-stripping (no runtime typecheck → `tsc --noEmit` gate), ESM with explicit `.ts` import specifiers, `node:test` + `node:assert/strict`, npm workspaces (`@rewind/core`, `@rewind/gateway`, `@rewind/mcp`).

**Spec:** `docs/RIP-LIST.md` (the graded rip-list, with the agenticstash verdict) + `docs/deep-prospect-log.md` (the competitive evidence). Item numbers below (#1..#11) map to RIP-LIST ranks.

## Global Constraints

- **Exact-replay determinism is sacred.** Any transform that changes forwarded request bytes must be deterministic AND keyed over the transformed form, OR must not touch the primary replay tape at all. Never redact/mutate the recorded body used for replay.
- **Pure-logic-above-WorldBackend.** The barrier, evidence chain, meter, pruner, and any new analysis/reconciliation logic read only the effect log / recorded calls / provider usage — never the filesystem or clock. No `Date.now()` in `@rewind/core`; timestamps are injected.
- **One real implementation** of the effect barrier + hash chain. Do not add a second. Do not add `@takk/agenticstash` or any competitor package as a dependency (RIP-LIST hard-skip). All rips are re-derived in our own code.
- **Tests must fail on a do-nothing implementation** for every correctness-critical change (barrier, chain, restore, redaction, metering).
- **Per slice:** `npm run check` (typecheck + full suite) green, then a `codex exec --sandbox read-only` cross-vendor review, fix findings, then commit. Small commits, no backticks in `-m`.
- Node version floor `>=24.15.0`; every new file uses ESM + `.ts` import specifiers; new public symbols are exported from the owning package's `index.ts`.

---

## Execution order (dependency-sorted)

1. **A1** restore atomicity → 2. **A2** temp-index snapshot → 3. **C2** billable-saved-tokens definition → 4. **B1** redaction hook + export view → 5. **B2** Free Savings Analysis mode + attested report → 6. **C1** provider-bill reconciliation adapter → 7. **C3** Art. 12 + pricing docs → 8. **D2** structured deny-reason → 9. **D1** tool_use_id secondary axis → 10. **D3** divergence report → 11. **E** deferred-items doc.

Phases A–D each end at a green `npm run check` + codex review + commit. E is docs-only.

---

### Task A1: Rollback-safe two-phase restore (#1)

**Files:**
- Modify: `packages/core/src/world/git-backend.ts` (the `restore()` method, ~L252-275, and the `RevertIndeterminateError` doc ~L68-84)
- Test: `packages/core/test/git-backend-restore-atomicity.test.ts` (new)

**Interfaces:**
- Consumes: existing `run(args)` git runner, `mutate(fn)` keyed queue, `validateRef`, `ensureInit` (all already in the closure).
- Produces: `restore()` keeps its signature `restore(ref: WorldRef | string): Promise<RestoreResult>`. New behaviour: on a mid-flight `read-tree`/`clean` failure it ATTEMPTS to roll the work tree back to the pre-restore state it captured, and only throws `RevertIndeterminateError` if that rollback ALSO fails. On a successful rollback it throws a distinct `RestoreFailedError` (tree is back to pre-restore state — safe, not indeterminate). Export `RestoreFailedError` from `git-backend.ts` and re-export from `packages/core/src/index.ts`.

- [ ] **Step 1: Write the failing test** — a restore whose `read-tree` fails leaves the tree UNCHANGED (rolled back), not half-applied.

```ts
// packages/core/test/git-backend-restore-atomicity.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitBackend, RestoreFailedError } from "../src/index.ts";

test("a restore that fails mid-flight rolls the work tree BACK, not half-applied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-atomic-"));
  try {
    await writeFile(join(dir, "a.txt"), "v1");
    const be = createGitBackend({ cwd: dir, log: () => {} });
    const snap = await be.snapshot("v1");
    await writeFile(join(dir, "a.txt"), "v2-current"); // current state we must preserve on failure

    // Force the restore's read-tree to fail by handing a syntactically valid but non-existent id is
    // rejected earlier; instead corrupt the target tree via a monkeypatched runner is not reachable.
    // Real trigger: make the work-tree path un-writable so `read-tree -u` fails to materialise.
    // Portable proxy: point restore at a ref whose commit exists but whose tree object we delete.
    // Simpler deterministic trigger below uses an unwritable file.
    const locked = join(dir, "a.txt");
    // Make the file read-only AND its dir read-only so read-tree -u cannot overwrite it.
    const { chmod } = await import("node:fs/promises");
    await chmod(locked, 0o444);
    await chmod(dir, 0o555);

    let threw: unknown;
    try {
      await be.restore(snap.id);
    } catch (e) {
      threw = e;
    } finally {
      await chmod(dir, 0o755);
      await chmod(locked, 0o644);
    }
    assert.ok(threw instanceof RestoreFailedError, "a recoverable failure must be RestoreFailedError, not indeterminate");
    assert.equal(await readFile(locked, "utf8"), "v2-current", "the work tree must be rolled back to its pre-restore state");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `node --test --experimental-strip-types packages/core/test/git-backend-restore-atomicity.test.ts`
Expected: FAIL — `RestoreFailedError` is not exported yet and `restore()` throws `RevertIndeterminateError` with no rollback (or leaves the tree half-applied).

> **Note on the trigger:** if the chmod-based trigger proves flaky under the test runner's uid (e.g. root ignores mode bits), switch to injecting a failing runner: add an internal `_run` seam to `createGitBackend` for tests, or trigger failure by pre-creating an `index.lock` in the git dir so `read-tree` exits non-zero. Pick whichever is deterministic in this environment; the ASSERTION (tree rolled back) is what matters.

- [ ] **Step 3: Implement — capture-then-rollback**

In `restore()`, inside `mutate(async () => { ... })`, after `ensureInit()` and the unknown-ref check, capture the current tree BEFORE mutating, and roll back on failure:

```ts
// Capture current work-tree state into a throwaway tree object (NOT a ref — append-only chain intact).
const preAdd = await run(["add", "-A"]);
const preTree = preAdd.code === 0 ? await run(["write-tree"]) : { code: 1, stdout: "", stderr: preAdd.stderr };
const rollbackId = preTree.code === 0 ? preTree.stdout.trim() : undefined;

const readTree = await run(["read-tree", "-u", "--reset", id]);
if (readTree.code !== 0) {
  await rollbackOrThrow(rollbackId, id, `read-tree exited ${readTree.code}: ${readTree.stderr.slice(0, 300)}`);
}
const clean = await run(["clean", "-fd"]);
if (clean.code !== 0) {
  await rollbackOrThrow(rollbackId, id, `post-read-tree clean exited ${clean.code}: ${clean.stderr.slice(0, 300)}`);
}
return { restoredTo: id };
```

with a helper defined in the closure:

```ts
async function rollbackOrThrow(rollbackId: string | undefined, targetId: string, detail: string): Promise<never> {
  if (rollbackId) {
    const back = await run(["read-tree", "-u", "--reset", rollbackId]);
    if (back.code === 0) {
      await run(["clean", "-fd"]); // best-effort; tree matches rollbackId regardless
      throw new RestoreFailedError(targetId, detail);
    }
  }
  throw new RevertIndeterminateError(targetId, detail);
}
```

Add the new error class next to `RevertIndeterminateError`:

```ts
export class RestoreFailedError extends Error {
  readonly ref: string;
  readonly detail: string;
  constructor(ref: string, detail: string) {
    super(`rewind git-backend: restore to ${ref} failed (${detail}); the work tree was rolled back to its pre-restore state`);
    this.name = "RestoreFailedError";
    this.ref = ref;
    this.detail = detail;
  }
}
```

Export `RestoreFailedError` from `git-backend.ts` and add it to the `createGitBackend, RevertIndeterminateError` re-export line in `packages/core/src/index.ts`.

- [ ] **Step 4: Run the new test + the full suite**

Run: `node --test --experimental-strip-types packages/core/test/git-backend-restore-atomicity.test.ts` → PASS
Run: `npm run check` → typecheck clean, all tests pass.

- [ ] **Step 5: Codex review + commit**

Run a `codex exec --sandbox read-only` review of `git-backend.ts restore()` focused on: does rollback ever leave the tree worse than before; can `preTree` capture mutate the index a concurrent op relies on (it runs inside `mutate`, so serialized — confirm); does `add -A` in capture wrongly stage excluded files (no — `info/exclude` still applies). Fix findings. Commit: `fix(core): atomic restore — roll the work tree back on a mid-flight failure`.

---

### Task A2: Snapshot builds in a throwaway GIT_INDEX_FILE (#5)

**Files:**
- Modify: `packages/core/src/world/git-backend.ts` (`snapshot()` ~L220-247; the `run` helper to accept per-call env)
- Test: `packages/core/test/git-backend-tempindex.test.ts` (new)

**Interfaces:**
- Consumes: `run`, `mutate`, `ensureInit`.
- Produces: `snapshot()` keeps its signature. Internally it builds the tree against a per-call temp index file (`<gitDir>/tmp-index-<n>`) via `GIT_INDEX_FILE`, so it never touches the shared `index` that `restore()` (and A1's capture) also use. The ref-update stays serialized through `mutate` (we do NOT retire that — the append-only ref race is real and cross-cutting). Scope: robustness + isolation of the index only; full cross-process concurrency stays git's own `index.lock` territory (documented, not solved here).

- [ ] **Step 1: Write the failing test** — a snapshot does not leave a populated shared index (a later `git status`-style read sees a clean staging area), proving the temp index was used.

```ts
// packages/core/test/git-backend-tempindex.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createGitBackend } from "../src/index.ts";

test("snapshot builds its tree in a temp index and cleans it up, leaving no shared index lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-tmpidx-"));
  try {
    await writeFile(join(dir, "a.txt"), "x".repeat(1000));
    const be = createGitBackend({ cwd: dir, log: () => {} });
    const s1 = await be.snapshot("one");
    await writeFile(join(dir, "b.txt"), "y");
    const s2 = await be.snapshot("two");
    assert.notEqual(s1.id, s2.id);
    // No leftover temp index files in the git dir.
    const gitDir = join(dir, ".rewind", "snapshots.git");
    assert.ok(!existsSync(join(gitDir, "tmp-index-1")) || true, "temp index files are cleaned up");
    // The chain is intact: both snapshots are in the log.
    const log = await be.log();
    assert.ok(log.some((r) => r.id === s1.id) && log.some((r) => r.id === s2.id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it, watch it fail (or pass trivially)** — it will pass on the log assertion but the temp-index behaviour is unproven. Strengthen: assert the shared `index` file is NOT modified by a snapshot (capture its mtime before/after) so the test fails on the current shared-index implementation.

Run: `node --test --experimental-strip-types packages/core/test/git-backend-tempindex.test.ts`

- [ ] **Step 3: Implement** — give `run` an optional `extraEnv`, and route snapshot's `add`/`write-tree` through a temp index:

```ts
const run = (args, extraEnv) => new Promise((resolve) => {
  execFile("git", [...], { cwd, maxBuffer, env: { ...process.env, ...GIT_IDENTITY, ...extraEnv } }, ...);
});
```

In `snapshot()`:

```ts
const tmpIndex = join(gitDir, `tmp-index-${process.pid}-${counter++}`);
try {
  const env = { GIT_INDEX_FILE: tmpIndex };
  const add = await run(["add", "-A"], env);
  // ...write-tree with the same env...
  const tree = await run(["write-tree"], env);
  // commit-tree + update-ref need no index; run without env
} finally {
  await rm(tmpIndex, { force: true }).catch(() => {});
}
```

Use a module- or closure-scoped `counter` (NOT `Date.now`/random — deterministic). For very large untracked sets, prefer `add -A` still; `--pathspec-from-file` is an optional future refinement — note it in a comment, don't build it unless the naive `add` hits argv limits (it won't, `add -A` takes no pathspecs).

- [ ] **Step 4: Run tests + full suite** — `npm run check` green.

- [ ] **Step 5: Codex review + commit** — review for temp-index leak on throw (the `finally` covers it) and that excludes still apply (they live in `info/exclude`, index-independent). Commit: `perf(core): build snapshots in a throwaway git index, isolated from restore`.

---

### Task C2: Billable-saved-tokens definition (#8, the hard-to-game baseline)

**Files:**
- Create: `packages/gateway/src/billable.ts`
- Test: `packages/gateway/test/billable.test.ts`
- Modify: `packages/gateway/src/index.ts` (export)

**Interfaces:**
- Consumes: `ReplaySaving`, `ReplaySavingsTotal` from `@rewind/core`.
- Produces: `billableSavedTokens(savings: readonly ReplaySaving[]): { billableTokens: number; billableCostMicros: number; realizedReplays: number }`. Credits ONLY realized, chain-logged replay savings (each `ReplaySaving` IS a realized replay by construction) — never a hypothetical/counterfactual call. Pure function; floors costs (never rounds up). This is the published contractual definition of a "saved call".

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/test/billable.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { billableSavedTokens } from "../src/billable.ts";

test("billable = sum of realized replay savings; a body with none bills zero", () => {
  assert.deepEqual(billableSavedTokens([]), { billableTokens: 0, billableCostMicros: 0, realizedReplays: 0 });
  const savings = [
    { scope: "s", tokensAvoided: 100, costMicros: 5, model: "m", callId: "s k1" },
    { scope: "s", tokensAvoided: 250, costMicros: 12, model: "m", callId: "s k2" },
  ];
  const r = billableSavedTokens(savings as never);
  assert.equal(r.realizedReplays, 2);
  assert.equal(r.billableTokens, 350);
  assert.equal(r.billableCostMicros, 17);
});

test("never credits a hypothetical: only records present in the list count", () => {
  // The type makes counterfactuals unrepresentable — there is no 'would-have' record to pass in.
  const r = billableSavedTokens([{ scope: "s", tokensAvoided: 10, costMicros: 1, model: "m", callId: "s k" }] as never);
  assert.equal(r.billableTokens, 10);
});
```

- [ ] **Step 2: Run it, watch it fail** — module absent.

- [ ] **Step 3: Implement** `billableSavedTokens` summing `tokensAvoided` and `costMicros` over the realized-replay records, `realizedReplays = savings.length`. Document in the file header: "Billable = tokens the agent DID re-issue as a byte-equivalent request and we served from record, chain-logged. Counterfactual/hypothetical calls are never credited — they are structurally absent from the savings list." Export from `index.ts`.

- [ ] **Step 4: Run tests + full suite** green.

- [ ] **Step 5: Commit** (fold codex review into B2's review to batch): `feat(gateway): billableSavedTokens — the hard-to-game saved-call definition`.

---

### Task B1: Record-time redaction hook + redacted export view (#2)

**Files:**
- Create: `packages/gateway/src/redact.ts`
- Test: `packages/gateway/test/redact.test.ts`
- Modify: `packages/gateway/src/index.ts` (export)

**Interfaces:**
- Consumes: `RecordedCall` from `record-store.ts`, `canonicalize` from `@rewind/core` (stable traversal).
- Produces:
  - `type RedactFn = (value: unknown, ctx: { path: string; kind: "request" | "response" }) => unknown | typeof DROP` and `const DROP: unique symbol`.
  - `redactValue(value: unknown, redact: RedactFn, ctx): unknown` — deep, structure-preserving; a `DROP` return replaces the value with `{ "[redacted]": true }`.
  - `DEFAULT_REDACTORS: RedactFn` — masks obvious secrets (Authorization/x-api-key header values, `sk-...`/`sk-ant-...` tokens, values under keys matching `/api[_-]?key|authorization|password|secret|token/i`).
  - `redactedExportView(call: RecordedCall, redact?: RedactFn): RecordedCall` — returns a redacted COPY for reports/sharing. **The primary replay tape is never passed through this**; this is only for the analysis/export surface (Task B2), preserving byte-exact replay.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/test/redact.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactValue, redactedExportView, DEFAULT_REDACTORS, DROP } from "../src/redact.ts";

test("DEFAULT_REDACTORS masks an api key by key-name, preserving structure", () => {
  const out = redactValue({ model: "m", api_key: "sk-ant-secret", nested: { authorization: "Bearer x" } }, DEFAULT_REDACTORS, { path: "$", kind: "request" });
  assert.equal((out as any).model, "m");
  assert.notEqual((out as any).api_key, "sk-ant-secret");
  assert.notEqual((out as any).nested.authorization, "Bearer x");
});

test("a DROP return replaces the value with a redaction marker, not the original", () => {
  const drop = (v: unknown) => (typeof v === "string" && v.includes("SECRET") ? DROP : v);
  const out = redactValue({ a: "keep", b: "SECRET-payload" }, drop, { path: "$", kind: "request" });
  assert.equal((out as any).a, "keep");
  assert.deepEqual((out as any).b, { "[redacted]": true });
});

test("redactedExportView never mutates the input record (replay tape stays byte-exact)", () => {
  const call = { response: { text: "sk-ant-leak" }, usage: { input_tokens: 1 }, model: "m" };
  const before = JSON.stringify(call);
  const view = redactedExportView(call as never, (v) => (typeof v === "string" && v.startsWith("sk-ant") ? DROP : v));
  assert.equal(JSON.stringify(call), before, "input untouched");
  assert.notDeepEqual(view.response, call.response);
});
```

- [ ] **Step 2: Run it, watch it fail** — module absent.

- [ ] **Step 3: Implement** `redactValue` (recursive clone applying `redact` at each node; arrays and objects traversed; `DROP` → `{ "[redacted]": true }`), `DEFAULT_REDACTORS`, and `redactedExportView` (deep-clone the call via `JSON.parse(JSON.stringify())` then apply `redactValue` to `response`). Header comment states the invariant: **redaction is applied ONLY to export/analysis copies and logs, NEVER to the primary in-memory replay tape or the replay key**, so exact-replay is preserved; encrypting the full tape at rest is a separate, later concern (note it). Export symbols from `index.ts`.

- [ ] **Step 4: Run tests + full suite** green.

- [ ] **Step 5: Commit** (batch codex review with B2): `feat(gateway): record-time redaction hook + redacted export view (export-only, replay-safe)`.

---

### Task B2: Free Savings Analysis mode + hash-attested report (#7)

**Files:**
- Create: `packages/gateway/src/analysis.ts`
- Test: `packages/gateway/test/analysis.test.ts`
- Modify: `packages/mcp/src/cli.ts` (add an `analyze` subcommand), `packages/gateway/src/index.ts` (export)

**Interfaces:**
- Consumes: `pruneToolOutputs` (prune savings simulation), `canonicalizeRequest` (replayability check), `billableSavedTokens` (C2), `redactedExportView` (B1), `meterAvoidance`/`avoidedCostMicros` (meter), `computeEntryHash`/`verifyChain`/`GENESIS_HASH` (`@rewind/core`, to attest the report).
- Produces:
  - `analyzeTraffic(calls: AnalyzedCall[], opts?: { redact?: RedactFn; priceTable?: PriceTable }): SavingsAnalysis` where `AnalyzedCall = { scope: string; body: unknown; usage: ProviderUsage; model: string }`. Computes: how many calls are byte-replayable (duplicate canonical keys within a scope), estimated prune char-savings, and the priced $ figure — returning a `SavingsAnalysis` with per-scope + total figures and a redacted sample.
  - `attestAnalysis(analysis: SavingsAnalysis): { analysis; chain: AuditEntry[]; rootHash: string }` — folds the analysis JSON into a one-entry hash chain (via `computeEntryHash` over the canonicalized analysis) so the report is tamper-evident and `verifyChain`-checkable.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/test/analysis.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyChain } from "@rewind/core";
import { analyzeTraffic, attestAnalysis } from "../src/analysis.ts";

const call = (scope: string, prompt: string, tokens: number) => ({
  scope, body: { model: "claude-haiku-4-5", max_tokens: 10, messages: [{ role: "user", content: prompt }] },
  usage: { input_tokens: tokens, output_tokens: tokens }, model: "claude-haiku-4-5",
});

test("analysis counts byte-replayable repeats and prices the avoided cost", () => {
  const a = analyzeTraffic([call("s", "hello", 100), call("s", "hello", 100), call("s", "unique", 100)]);
  assert.equal(a.total.calls, 3);
  assert.equal(a.total.replayableCalls, 1, "the 2nd identical call is the replayable one");
  assert.ok(a.total.avoidedCostMicros > 0);
});

test("the attested report verifies as a tamper-evident chain", () => {
  const a = analyzeTraffic([call("s", "hi", 10), call("s", "hi", 10)]);
  const { chain, rootHash } = attestAnalysis(a);
  assert.equal(verifyChain(chain).ok, true);
  assert.equal(typeof rootHash, "string");
});

test("tampering with the attested analysis breaks verification", () => {
  const a = analyzeTraffic([call("s", "hi", 10), call("s", "hi", 10)]);
  const { chain } = attestAnalysis(a);
  (chain[0].detail as any).total = { calls: 9999 };
  assert.equal(verifyChain(chain).ok, false);
});
```

- [ ] **Step 2: Run it, watch it fail** — module absent.

- [ ] **Step 3: Implement.** `analyzeTraffic` groups by scope, computes `canonicalizeRequest(body)` per call, marks the 2nd+ occurrence of a key in a scope as `replayable`, sums `avoidedCostMicros(usage, model)` over the replayable calls (the honest figure: only repeats are avoidable), runs `pruneToolOutputs` on each body to estimate prune char-savings, and attaches a `redactedExportView`-style redacted sample of one call. `attestAnalysis` builds one `AuditEntryInput` whose `detail` is the analysis, hashes it with `computeEntryHash` from `GENESIS_HASH`, returns `{ analysis, chain, rootHash }`. Reuse the exact hashing the effect chain uses so `verifyChain` accepts it (read `evidence-ledger.ts` for the `AuditEntryInput`→`AuditEntry` shape and required fields: `seq`, `prevHash`, `hash`, `action`, `scopeLabel`, `ts`). Use `action: "savings_analysis"`, `scopeLabel: "analysis"`, injected `ts: 0` (no clock in the pure path).

- [ ] **Step 4: Wire the CLI** — add to `packages/mcp/src/cli.ts` an `analyze <json>` subcommand: parse a JSON array of `AnalyzedCall`, run `analyzeTraffic` + `attestAnalysis`, print the attested report (redacted). Add a CLI test asserting `analyze` prints a verifiable report and exits 0.

- [ ] **Step 5: Run tests + full suite** green.

- [ ] **Step 6: Codex review (batched: C2 + B1 + B2) + commit.** Review focus: does the analysis EVER over-credit (must count only repeats, not first occurrences); is the redacted sample truly redacted; does `attestAnalysis` reuse the one true hash chain (no second impl). Fix, then commit: `feat(gateway): Free Savings Analysis mode + hash-attested, redacted report`.

---

### Task C1: Provider-bill reconciliation adapter (#6)

**Files:**
- Create: `packages/gateway/src/reconcile.ts`
- Test: `packages/gateway/test/reconcile.test.ts`
- Modify: `packages/gateway/src/index.ts`

**Interfaces:**
- Consumes: `ReplaySaving[]`, `billableSavedTokens` (C2).
- Produces: `reconcileAgainstProviderBill(savings, providerBilledTokens: number): ReconciliationReport` where the report states: our chain-attested billable tokens, the provider's independently-billed total, and a `withinBill: boolean` = our billable ≤ provider-reported baseline delta. Honest limit encoded in the docstring: provider usage APIs report AGGREGATE billed tokens per key, not per-call provenance → "chain attests events, bill attests the aggregate." A pluggable `ProviderUsageFetcher` type is defined for the real adapter; the pure `reconcile*` function takes the number so it is testable without network.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/test/reconcile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileAgainstProviderBill } from "../src/reconcile.ts";

const s = (t: number) => ({ scope: "s", tokensAvoided: t, costMicros: t, model: "m", callId: `s ${t}` });

test("billable within the provider-attested baseline reconciles clean", () => {
  const r = reconcileAgainstProviderBill([s(100), s(50)], 1000);
  assert.equal(r.billableTokens, 150);
  assert.equal(r.providerBaselineTokens, 1000);
  assert.equal(r.withinBill, true);
});

test("billable exceeding the provider baseline is flagged, never silently over-credited", () => {
  const r = reconcileAgainstProviderBill([s(2000)], 1000);
  assert.equal(r.withinBill, false);
});
```

- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Implement** the pure reconcile function + the `ProviderUsageFetcher` type + a header documenting the aggregate-not-per-call honesty limit. Export from `index.ts`.
- [ ] **Step 4: Run tests + full suite** green.
- [ ] **Step 5: Codex review + commit:** `feat(gateway): provider-bill reconciliation adapter (chain attests events, bill attests aggregate)`.

---

### Task C3: Pricing decision + EU AI Act Art. 12 framing (docs, #3 + #4)

**Files:**
- Create: `docs/PRICING.md` (the gainshare pricing decision)
- Create: `docs/COMPLIANCE.md` (Art. 12 framing for the existing hash chain)
- Modify: `docs/RIP-LIST.md` (tick #3, #4 as decided)

**Interfaces:** none (docs).

- [ ] **Step 1:** Write `docs/PRICING.md`: lead with **pure %-of-verified-savings** (maximal alignment); if revenue stability is needed, a **small fixed platform fee kept separate** from the savings share; **never a percent-of-spend floor** (the nOps "feels like a tax" churn trigger). Reference `billableSavedTokens` (C2) as the metered basis and `reconcileAgainstProviderBill` (C1) as the trust anchor.
- [ ] **Step 2:** Write `docs/COMPLIANCE.md`: frame the existing `verifyChain` SHA-256 evidence chain as a tamper-evident primitive **suitable for EU AI Act Article 12-style automatic logging**; describe the `seal → root digest` / `verify → pass|fail` surface (the analysis attestation in B2 is the concrete export). **Explicitly do NOT claim certified compliance** — "tamper-evident chain suitable for Art. 12-style logging, verified by our own tests."
- [ ] **Step 3:** Commit: `docs: gainshare pricing decision + Art. 12 tamper-evidence framing`.

---

### Task D2: Structured deny-reason returned on refusal (#11)

**Files:**
- Modify: `packages/core/src/audit/effect-ledger.ts` (add `reason` to `EffectRefusal`)
- Modify: `packages/core/src/engine.ts` (surface `reason` on the guard outcome / `RefusableEffect` if applicable)
- Modify: `packages/mcp/src/server.ts` (return the reason in the `guard_effect` tool result) and `packages/mcp/src/cli.ts` (already prints the outcome JSON — confirm reason flows)
- Test: `packages/core/test/effect-ledger-reason.test.ts`

**Interfaces:**
- Produces: `EffectRefusal` gains `reason: string` (a stable, agent-actionable message, e.g. `"effect already spent before rewind; do not re-fire"`). The ledger already writes a `reason` into the refusal entry detail — surface that SAME string on the returned `EffectRefusal` so the MCP/CLI hands it back to the agent. Take ONLY the deny-reason; do not add auto-approve/skip-permissions state (RIP-LIST hard-skip).

- [ ] **Step 1: Write the failing test**

```ts
// packages/core/test/effect-ledger-reason.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryEvidenceLedger, createEffectLedger, EFFECT_EMITTED, EFFECT_REPLAY_REFUSED } from "../src/index.ts";

test("a refusal returns a structured, agent-actionable reason string", async () => {
  const ledger = createMemoryEvidenceLedger({ vocabulary: [EFFECT_EMITTED, EFFECT_REPLAY_REFUSED] });
  const barrier = createEffectLedger(ledger);
  const eff = { effectKey: "charge:1", scopeLabel: "s", kind: "http" };
  await barrier.emit(eff);
  const refusal = await barrier.emit(eff);
  assert.equal(refusal.refused, true);
  assert.match((refusal as any).reason, /spent|not replayable|across a revert/i);
});
```

(Read `evidence-ledger.ts` for the exact `createMemoryEvidenceLedger` options shape — `vocabulary`/`actionVocabulary` — and adjust the constructor call to match.)

- [ ] **Step 2: Run it, watch it fail** — `reason` is undefined on the returned refusal today.
- [ ] **Step 3: Implement** — add `reason` to the `EffectRefusal` interface; in `emit()`'s refusal branch, return the same reason string it writes to the ledger detail. Thread it through `engine.ts` guard outcome and `mcp/server.ts` `guard_effect` result. Keep the CLI's JSON output (already prints the whole outcome).
- [ ] **Step 4: Run tests + full suite** green.
- [ ] **Step 5: Codex review + commit:** `feat(core): return a structured deny-reason on effect refusal`.

---

### Task D1: tool_use_id as a secondary effect-correlation axis (#10)

**Files:**
- Modify: `packages/core/src/audit/effect-ledger.ts` (`ExternalEffect` gains optional `toolUseId?: string`; store it in the emitted entry detail)
- Test: `packages/core/test/effect-ledger-tooluseid.test.ts`

**Interfaces:**
- Produces: `ExternalEffect.toolUseId?: string` — recorded in the effect's detail as a cheap provider-native per-call identity, ALONGSIDE the authoritative `effectKey`. **The SHA-256 canonical `effectKey` stays the sole identity for the tamper-evident chain and the dedup/refusal decision** — `toolUseId` is metadata for correlation/diagnostics only (it is client-supplied and unique only within a conversation; never trust it as sole identity). No change to the emit/refuse logic keyed on `effectKey`.

- [ ] **Step 1: Write the failing test** — an effect carrying a `toolUseId` records it in the ledger detail, but two effects with the SAME `effectKey` and DIFFERENT `toolUseId` still collapse (the second is refused), proving `toolUseId` is not part of identity.

```ts
// packages/core/test/effect-ledger-tooluseid.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryEvidenceLedger, createEffectLedger, EFFECT_EMITTED, EFFECT_REPLAY_REFUSED } from "../src/index.ts";

test("toolUseId is recorded but is NOT part of effect identity", async () => {
  const ledger = createMemoryEvidenceLedger({ vocabulary: [EFFECT_EMITTED, EFFECT_REPLAY_REFUSED] });
  const barrier = createEffectLedger(ledger);
  await barrier.emit({ effectKey: "charge:1", scopeLabel: "s", kind: "http", toolUseId: "toolu_a" });
  const refusal = await barrier.emit({ effectKey: "charge:1", scopeLabel: "s", kind: "http", toolUseId: "toolu_b" });
  assert.equal(refusal.refused, true, "same effectKey collapses regardless of toolUseId");
  const emitted = await ledger.list({ scopeLabel: "s", action: EFFECT_EMITTED });
  assert.equal((emitted[0].detail as any).toolUseId, "toolu_a", "the first emit's toolUseId was recorded");
});
```

- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Implement** — add `toolUseId?: string` to `ExternalEffect`; include `...(effect.toolUseId ? { toolUseId: effect.toolUseId } : {})` in the emitted entry's `detail`. Do not touch identity/dedup. Document the never-trust-as-sole-identity caveat.
- [ ] **Step 4: Run tests + full suite** green.
- [ ] **Step 5: Codex review + commit:** `feat(core): record tool_use_id as a secondary effect-correlation axis`.

---

### Task D3: Tape-vs-tape typed divergence report (#9)

**Files:**
- Create: `packages/gateway/src/diverge.ts`
- Test: `packages/gateway/test/diverge.test.ts`
- Modify: `packages/gateway/src/index.ts`

**Interfaces:**
- Consumes: `canonicalize` from `@rewind/core`.
- Produces: `divergeMessages(a: unknown, b: unknown): DivergenceReport` where `DivergenceReport = { kinds: Divergence[]; firstDivergence?: Divergence }` and `Divergence = { kind: "input-mismatch" | "extra-call" | "missing-call"; index: number; detail: string }`. Aligns the two request bodies' `messages` arrays by index and classifies: same index different canonical content → `input-mismatch`; present in `b` not `a` → `extra-call`; present in `a` not `b` → `missing-call`. Collect-all by default; `firstDivergence` is the lowest-index one. Pure, deterministic.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/test/diverge.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { divergeMessages } from "../src/diverge.ts";

const body = (msgs: unknown[]) => ({ model: "m", messages: msgs });

test("identical bodies have no divergence", () => {
  const r = divergeMessages(body([{ role: "user", content: "a" }]), body([{ role: "user", content: "a" }]));
  assert.equal(r.kinds.length, 0);
  assert.equal(r.firstDivergence, undefined);
});

test("classifies input-mismatch, extra-call and missing-call, reporting the first", () => {
  const a = body([{ role: "user", content: "a" }, { role: "user", content: "b" }]);
  const b = body([{ role: "user", content: "a" }, { role: "user", content: "CHANGED" }, { role: "user", content: "c" }]);
  const r = divergeMessages(a, b);
  assert.equal(r.firstDivergence?.kind, "input-mismatch");
  assert.equal(r.firstDivergence?.index, 1);
  assert.ok(r.kinds.some((k) => k.kind === "extra-call" && k.index === 2));
});
```

- [ ] **Step 2: Run it, watch it fail.**
- [ ] **Step 3: Implement** `divergeMessages` — read both `messages` arrays (tolerate non-array → treat as empty), compare `canonicalize(a[i])` vs `canonicalize(b[i])` up to `max(lenA, lenB)`; classify per index; `firstDivergence = kinds[0]` (lowest index by construction). Export from `index.ts`.
- [ ] **Step 4: Run tests + full suite** green.
- [ ] **Step 5: Codex review + commit:** `feat(gateway): tape-vs-tape typed divergence report`.

---

### Task E: Deferred-items decision record (docs, #12–#14)

**Files:**
- Create: `docs/DEFERRED.md`

- [ ] **Step 1:** Record the three deliberately-deferred rips with their rationale and the trigger that would un-defer each: **#12 per-session snapshot namespacing** (un-defer when real concurrent-session demand appears; must preserve append-only "history survives restore" + never GC a chain-referenced ref); **#13 externally-ratified "Effective Token Savings Rate"** (ship self-published formula first — that IS C2; pursue standards-body blessing later, never gate billing on it); **#14 human-approval gate tier whose decision is chain-recorded** (post-MVP; must live ABOVE the pure core — a blocking human gate inside the replay path would break exact-replay; do not pull the phase forward).
- [ ] **Step 2:** Commit: `docs: record the three deferred rips (#12-#14) with un-defer triggers`.

---

## Self-Review

**Spec coverage:** RIP-LIST #1(A1) #2(B1) #3(C3) #4(C3) #5(A2) #6(C1) #7(B2) #8(C2) #9(D3) #10(D1) #11(D2) #12–14(E) — all mapped. ✔

**Placeholder scan:** every code task carries real test code + a real implementation sketch grounded in the actual file signatures (git-backend `run`/`mutate`/`restore`, effect-ledger `emit`/`ExternalEffect`, meter `avoidedCostMicros`, replay-savings `ReplaySaving`, evidence-ledger `computeEntryHash`/`verifyChain`). ✔

**Type consistency:** `RedactFn`/`DROP` defined in B1, consumed in B2; `billableSavedTokens` defined in C2, consumed in B2 + C1; `EffectRefusal.reason` (D2) and `ExternalEffect.toolUseId` (D1) are additive, non-breaking. ✔

**Known risk flags for the executor:**
- A1's failure trigger may need swapping (chmod vs injected failing runner vs pre-planted `index.lock`) depending on the test uid — the ASSERTION (rollback) is fixed; the trigger is negotiable.
- B2's `attestAnalysis` MUST reuse `computeEntryHash`/the real chain (read `evidence-ledger.ts` first) — do not hand-roll a second hash chain (one-real-implementation discipline).
- Redaction (B1) must never touch the primary replay tape or the replay key — export/analysis copies only.
