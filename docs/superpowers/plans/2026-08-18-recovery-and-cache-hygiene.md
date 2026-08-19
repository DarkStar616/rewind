# Recovery (BP2) + Cache Hygiene — implementation plan

> **Executors:** TDD each task, `npm run check` (typecheck + tests) must stay green, commit per task.
> Pure logic above the WorldBackend — recovery reads checkpoint metadata + failure records, NEVER the
> filesystem (same discipline as the barrier/chain). Grounded in `docs/RESEARCH-ROADMAP.md`.

**Goal:** the two research-validated top levers — (accuracy) AgentRewind-style **selective rewind +
failure-memory**, and (savings) **cache-breakpoint hygiene** — shipped as pure, tested modules plus MCP
tools, so an agent can rewind-with-memory and users can see why their prompts do/don't cache.

**Architecture:** `@agent-rewind/core/recovery` = pure recovery policy (attempt log, backtrack candidates,
checkpoint-selection, sparsity gate). `@agent-rewind/mcp` = durable rewind-memory + `backtrack_candidates` /
`backtrack_commit` tools. `@agent-rewind/gateway/cache-hygiene` = static analyzer that flags prefix-poisoning
dynamic content + the 4-breakpoint cap, wired into the proxy + a `rewind cache-report` CLI.

**Tech stack:** Node 24 native TS, ESM, `.ts` imports, `node:test`, npm workspaces. FSL-1.1-ALv2.

## Global constraints
- Recovery logic is PURE: no `Date.now()`/fs/network — timestamps are injected. (Matches core's existing
  discipline; the durable adapter supplies real time.)
- The exact-replay correctness guarantee is untouched: nothing here rewrites outgoing request bytes.
- `backtrack_commit` REQUIRES a non-empty memory note (the AgentRewind "carry the failure forward"
  discipline). No note → refuse.
- Checkpoint sparsity gates on OBSERVED change (diff/effect), never a guess.

---

### Task 1: Recovery types + in-memory rewind-memory store
**Files:** Create `packages/core/src/recovery/recovery.ts`; Test `packages/core/test/recovery.test.ts`.
**Produces:** `AttemptRecord`, `RewindMemoryStore`, `createMemoryRewindStore()`.

```ts
export type Outcome = "failure" | "success" | "abandoned";
export interface AttemptRecord {
  seq: number; scope: string; checkpointId: string; goal: string;
  outcome: Outcome; note: string; at: number; // at is injected, never Date.now()
}
export interface RewindMemoryStore {
  record(a: AttemptRecord): void;
  all(scope: string): readonly AttemptRecord[];
  since(scope: string, checkpointId: string): readonly AttemptRecord[]; // attempts recorded at/after a checkpoint
}
export function createMemoryRewindStore(): RewindMemoryStore;
```
Tests: record→all returns in seq order; scope isolation; dedup by (scope,seq) — re-recording same seq is idempotent; `since` filters to attempts whose checkpointId matches or came after (by seq).

### Task 2: Backtrack candidates + checkpoint selection
**Files:** Modify `recovery.ts`; Test same file's test.
**Consumes:** `WorldRef` (from `../world/world-backend.ts`), Task 1 types.
**Produces:**
```ts
export interface BacktrackCandidate { checkpointId: string; label: string; ts: number; priorFailures: readonly AttemptRecord[]; }
export function backtrackCandidates(checkpoints: readonly WorldRef[], memory: RewindMemoryStore, scope: string): BacktrackCandidate[];
export function memoryForCheckpoint(memory: RewindMemoryStore, scope: string, checkpointId: string): readonly AttemptRecord[];
export function recommendedCheckpoint(candidates: readonly BacktrackCandidate[]): BacktrackCandidate | undefined;
```
`backtrackCandidates`: newest-first, each annotated with the failure attempts tied to it. `memoryForCheckpoint`: the failure notes to inject when re-attempting from that checkpoint (the accuracy mechanism). `recommendedCheckpoint`: SELECTIVE, not restart — the most-recent checkpoint that has ≥1 subsequent failure (rewind to just before the failed work), else the latest checkpoint.
Tests: candidates newest-first with correct priorFailures; recommended picks the checkpoint before the failure cluster (not the oldest = not a restart); empty history → latest checkpoint; no checkpoints → undefined.

### Task 3: Checkpoint-sparsity gate
**Files:** Modify `recovery.ts`; Test same.
**Produces:** `export function shouldCheckpoint(signal: { changedPaths: number; effectFired: boolean }): boolean;`
Rule: `changedPaths > 0 || effectFired`. Crab: >75% of turns are no-change → no checkpoint.
Tests: no change + no effect → false; any changed path → true; effect fired with 0 changes → true.

### Task 4: Durable rewind-memory (file-backed)
**Files:** Create `packages/mcp/src/durable-rewind-memory.ts`; Test `packages/mcp/test/durable-rewind-memory.test.ts`.
**Consumes:** Task 1 types. **Produces:** `createFileRewindMemory({ path }): RewindMemoryStore`.
Mirror `durable-savings.ts`: JSON file under `.rewind/rewind-memory.json`, atomic temp+rename, dedup by (scope,seq), corrupt-file fails closed. Cross-process readable.
Tests: record in one instance → readable in a fresh instance; scope isolation; corrupt file throws; dedup.

### Task 5: MCP tools `backtrack_candidates` + `backtrack_commit`
**Files:** Modify `packages/mcp/src/server.ts` (+ `build-engine.ts` to expose the durable memory + backend log); Test `packages/mcp/test/backtrack.test.ts`.
**Consumes:** Tasks 1-4, the engine (`rewind`, backend `log`).
Tools:
- `backtrack_candidates({})` → `{ candidates: BacktrackCandidate[], recommended?: string }` (reads backend.log + memory).
- `backtrack_commit({ checkpointId, note })` → REQUIRES non-empty `note`; records an `AttemptRecord{outcome:"abandoned", note}` for the current branch, rewinds the world to `checkpointId` (engine.rewind), returns `{ rewoundTo, carriedMemory: AttemptRecord[] }` (the accumulated failure notes to inject). Empty note → tool error.
Tests: commit without a note → error, no rewind; commit with note → world rewound + memory returned; candidates lists checkpoints with prior failures; a second failure from the same checkpoint accumulates memory.

### Task 6: Cache-hygiene analyzer (gateway)
**Files:** Create `packages/gateway/src/cache-hygiene.ts`; Test `packages/gateway/test/cache-hygiene.test.ts`.
**Produces:**
```ts
export type HygieneReason = "timestamp" | "uuid" | "session-id" | "epoch" | "too-many-breakpoints";
export interface HygieneIssue { path: string; reason: HygieneReason; detail: string; }
export interface CacheHygieneReport { breakpointCount: number; overBreakpointCap: boolean; prefixPoisoners: HygieneIssue[]; cacheable: boolean; recommendation: string; }
export function analyzeCacheHygiene(body: unknown): CacheHygieneReport;
```
Scan the STABLE prefix (system + tools + all-but-last message) for dynamic content that forfeits the
cache every turn: ISO-8601 timestamps, epoch (10-13 digit) numbers, UUIDs, and fields named
`session_id`/`request_id`/`trace_id`. Count `cache_control` markers; `> 4` → overBreakpointCap.
`cacheable` = no prefix poisoners and not over cap. Recommendation names the fix (push dynamic content to
the suffix).
Tests: clean request → cacheable, no issues; a timestamp in the system prompt → prefixPoisoner + not
cacheable; a UUID in a tool description → flagged; dynamic content in the LAST message (suffix) → NOT
flagged; 5 breakpoints → overBreakpointCap.

### Task 7: Wire hygiene into the proxy + `rewind cache-report` CLI
**Files:** Modify `packages/gateway/src/proxy.ts` (log a warning when a request poisons its own prefix),
`packages/gateway/src/index.ts` (export), `packages/mcp/src/cli.ts` (`cache-report <json>` subcommand);
Test `packages/gateway/test/cache-hygiene.test.ts` (+ a CLI assertion in an mcp test).
Proxy: on a messages request, run `analyzeCacheHygiene`; if `prefixPoisoners.length`, `log()` an advisory
(never blocks, never mutates the request — advisory only). CLI: `rewind cache-report '<json>'` prints the
report as JSON. Tests: proxy logs a warning for a poisoned request (capture via the `log` sink); CLI prints
a report.

### Task 8: Integration — the full recovery loop
**Files:** Test `packages/mcp/test/recovery-loop.test.ts`.
End-to-end in a temp git repo: checkpoint A → edit → checkpoint B → "fail" → `backtrack_commit(A, note1)`
→ world is at A, `carriedMemory` empty; edit again → "fail" again → `backtrack_commit(A, note2)` →
`carriedMemory` now contains note1 (the accumulated failure experience for A). Proves the +accuracy
mechanism: a re-attempt from A sees what failed before.

### Task 9: Cross-vendor review + docs + final verify
Run `codex exec review` (unsteered) over the new modules; fix real findings. Update
`docs/GATEWAY-STATUS.md` + `docs/RESEARCH-ROADMAP.md` (mark shipped). `npm run check` green; commit.
