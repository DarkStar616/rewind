# API Stability — Agent Rewind 1.0

This document is the public-API contract for the `@agent-rewind/*` packages as of **1.1.1**.
It is enforced, not aspirational: the frozen export surfaces below are snapshotted by
`packages/core/test/public-api.test.ts` and `packages/gateway/test/public-api.test.ts`,
which derive the live export set from each package's `src/index.ts` on every run and fail
if it drifts from the freeze.

## What "stable under 1.0" means

We follow [semantic versioning](https://semver.org/).

- **Adding** a new named export is a **minor** release (`1.x.0`). It is backward compatible.
  The new name is added to the frozen snapshot in the same commit.
- **Removing or renaming** an exported name, or making a breaking change to the type or
  runtime contract of an existing export, is a **major** release (`2.0.0`). The snapshot
  test fails until either the name is restored or the major version is intentionally cut.
- **Bug fixes** that do not change the surface are **patch** releases (`1.0.x`).

The *stable surface* is exactly the set of names re-exported from each package's public
entry point (`index.ts`) — nothing reached by a deep import path (`@agent-rewind/core/src/...`)
is covered. Deep imports are unsupported and may change in any release.

The two package-private in-process substrate adapters (Python) are behind a CLI/JSON
boundary and are **not** part of this TypeScript surface.

## Invariants that outrank the surface

These hold across the entire 1.x line and are not negotiable per-minor:

- **The effect barrier and hash chain never read the filesystem.** They read the effect log
  and the trace only. This is what keeps them portable across backend tiers.
- **Exact-replay determinism is sacred.** The replay key is a generic hash over the
  canonicalised request body. No provider adapter makes the key provider-specific.
- **Meter only the provider's own reported tokens; floor, never round up.**
- **One real implementation** of the barrier/chain — the TypeScript one. Any Python copy is
  a conformance model, never a second implementation.
- **Tier 0 (git snapshots) is reversibility, not isolation.** Never marketed as security.

## Frozen surface — `@agent-rewind/core`

Values (runtime):

`CanonicalJsonError`, `EFFECT_EMITTED`, `EFFECT_REPLAY_REFUSED`, `EvidenceLedgerError`,
`GENESIS_HASH`, `REPLAY_REFUSED_REASON`, `RestoreFailedError`, `RevertIndeterminateError`,
`backtrackCandidates`, `canonicalize`, `computeEntryHash`, `createEffectLedger`, `createEngine`,
`createGitBackend`, `createMemoryEvidenceLedger`, `createMemoryMechanismLedger`, `createMemoryReplaySavings`,
`createMemoryRewindStore`, `memoryForCheckpoint`, `recommendedCheckpoint`, `refId`,
`shouldCheckpoint`, `verifyChain`

Types:

`AttemptRecord`, `AuditEntry`, `AuditEntryInput`, `AuthorityResolver`, `BacktrackCandidate`,
`Change`, `EffectAdmission`, `EffectLedger`, `EffectLedgerOptions`, `EffectOutcome`,
`EffectRefusal`, `Engine`, `EngineOptions`, `EvidenceLedger`, `ExternalEffect`,
`GitBackendOptions`, `LedgerOptions`, `LedgerQuery`, `MechanismEvent`, `MechanismQuery`,
`MechanismProjection`, `MechanismLedger`, `Outcome`, `RefusableEffect`,
`ReplayResult`, `ReplaySaving`, `ReplaySavingsSink`, `ReplaySavingsTotal`, `RestoreResult`,
`RewindMemoryStore`, `RewindResult`, `UnhashedEntry`, `VerifyResult`, `WorldBackend`, `WorldRef`

## Frozen surface — `@agent-rewind/gateway`

Values (runtime):

`ADAPTERS`, `DEFAULT_PRICE_TABLE`, `DEFAULT_REDACTORS`, `DROP`, `NOISE_FIELDS`,
`StrictReplayMissError`, `analyzeCacheHygiene`, `analyzeTraffic`, `anthropicAdapter`,
`attestAnalysis`, `avoidedCostMicros`, `billableSavedTokens`, `canonicalizeRequest`,
`createFixedTenantResolver`, `encodeTrustedScope`, `createMemoryRecordStore`, `createReplayer`, `divergeMessages`, `extractUsage`,
`extractUsageFor`, `geminiAdapter`, `hasCacheControl`, `isRecordableSuccessFor`,
`meterAvoidance`, `meterCachePreservation`, `normalizeUsage`, `openAiUsageFetcher`, `openaiAdapter`,
`pickUsageFields`, `planCacheBreakpoints`, `pruneToolOutputs`, `reconcileAgainstProviderBill`,
`reconcileAgainstProviderBillWith`, `redactValue`, `redactedExportView`, `selectAdapter`, `startProxy`,
`totalRecordedTokens`, `totalUsageTokens`

Types:

`AnalysisTotals`, `AnalyzeOptions`, `AnalyzedCall`, `AttestedAnalysis`, `BillableSavings`,
`CacheHygieneReport`, `CachePlan`, `CachePreservationCredit`, `ComponentRates`, `Divergence`,
`DivergenceKind`, `DivergenceReport`, `ExtractedUsage`, `HygieneIssue`, `HygieneReason`,
`MeteredAvoidance`, `OpenAiUsageAggregate`, `OpenAiUsageBucket`, `OpenAiUsageResult`, `PriceTable`,
`ProviderAdapter`, `ProviderUsage`, `ProviderUsageFetcher`,
`ProxyOptions`, `PruneOptions`, `PruneResult`, `ReconciliationReport`, `RecordKey`, `RecordStore`,
`RecordedCall`, `RecordedHttpResponse`, `RedactContext`, `RedactFn`, `ReplayOutcome`,
`ReplayOutcomeLive`, `ReplayOutcomeReplay`, `Replayer`, `ReplayerOptions`, `RunningProxy`,
`SavingsAnalysis`, `ScopeAnalysis`

## `@agent-rewind/mcp`

The MCP package ships the stdio server and CLI. Its stable surface is **behavioural**, not a
TypeScript export set: the MCP tool contract (`checkpoint`, `list`, `rewind`, `replay`,
`guard_effect`, plus the recovery/savings tools) and the `agent-rewind` CLI. These are covered
by `packages/mcp/test/e2e-stdio.test.ts` and the server/CLI suites. The MCP tool names and their
input/output handle shapes follow the same semver discipline as the library surfaces above.

Gateway v1.1 additionally exports types `TrustedScope`, `ScopeRequest`, and `ScopeResolver`.

## Additive v1.1 mechanism measurements

`createMemoryMechanismLedger` adds the pure `rewind.mechanism/v1` event contract. It does not replace
or change `ReplaySavingsSink` or wire production receipts. Records, request occurrences, events and
transport retry identities are distinct. IDs are tenant/scope-local; retry keys additionally include the mechanism so one transport request
can emit separate cache/shaping/control events. Query requires a tenant and uses
`since <= ts < until` numeric epoch milliseconds. Returned stored events are deeply frozen copies.
Conflicting retries and replay/cache/shaping overlap on one request fail explicitly.

Replay avoidance, live cache traffic, shaping, and control overhead have separate projections and
eligible-unit denominators. Character-only shaping is advisory; it never becomes tokens or dollars.
Cache reads/writes are discounted traffic, never eliminated tokens. Gateway attribution requires
provider-reported usage, non-simulated pricing evidence and gateway-owned policy. Five-minute/hour writes use separately supplied
rates; read discounts floor and premiums ceil in integer micro-USD. Net cache benefit can be negative.
Pricing basis/version and evidence/configuration provenance remain visible; mixed cost bases are
marked `mixed` and must not be presented as a provider bill. Producers remain responsible for truthful
measurement/evidence; this pure ledger validates structure and arithmetic, not provider authenticity.
Durable transactional integration, event production and CLI/MCP receipts are pending U21.
# v1.1 replay preparation

`Replayer.prepare` is an additive, optional side-effect-free lookup with transport validation and
an idempotent deferred `commit`. The shipped proxy uses it to validate a complete HTTP record before
crediting avoidance. `handle` keeps its existing immediate, content-addressed accounting contract.
Consumer-supplied legacy replayers without `prepare` still own their accounting side effects; use
the preparation contract for validated transport accounting.

## v1.1 trusted local scope

`ProxyOptions.resolveScope` injects an application-owned tenant/scope decision before optimization.
`createFixedTenantResolver` binds tenant identity to process configuration and validates caller-selected
subscopes; it never reads a tenant header. IDs are 1–128 ASCII letters/digits or `. _ : / -`, starting
with a letter/digit. `encodeTrustedScope` serializes a tuple, avoiding delimiter ambiguity.

Unresolved identity returns a generic 403. Explicit `scopeFailure: "passthrough"` forwards original
bytes without replay, cache mutation, pruning, recording or savings. Both paths strip all `x-rewind-*`
headers and the configured scope header from upstream traffic, including non-model endpoints.

Omitting the resolver retains legacy caller-selected scope behavior for 1.x consumers. A legacy
arbitrary-scope listener must never share a store with a trusted listener: its caller could supply a
serialized trusted tuple. The supported pilot runs one Athena-owned local process/store per tenant;
this injection seam is not remote authentication or a defense against other local processes.

## v1.1 optional transactional storage

Gateway adds values `openSqliteStorage`, `createEncryptedStaging` and types `SqliteStorageOptions`,
`StorageMutation`, `StorageValue`, `StorageCommit`, `SqliteStorage`, `StagingOptions`, `StagedObject`,
`EncryptedStaging`. Legacy stores are unchanged. `better-sqlite3@12.11.1` is an exact optional native
dependency. Explicit durable opens fail actionably when unavailable; there is no memory fallback.

The asynchronous worker API provides namespaced binary values, bounded scans, atomic mutation batches,
compare-revision/absence conditions, durable transaction-ID retries, TTL collection and staging. One
fixed tenant owns each private directory/database. Key labels and values are encrypted before SQL;
HMAC coordinates, random AES-256-GCM nonces and authenticated schema/tenant/namespace/revision/expiry
bind rows to their location. A random tenant data key is wrapped using the startup-supplied 32-byte
key; callers own external key custody. Keep namespace names public, not sensitive content. Returned
revision numbers are global monotonically increasing database revisions, avoiding ABA after expiry.

SQLite uses WAL, FULL synchronous durability, IMMEDIATE transactions and a five-second busy timeout.
Queue/value/response limits fail explicitly; database page and logical ciphertext quotas bound normal
storage. Transaction-receipt retention, physical erasure,
key rotation, migration beyond schema 1, corruption recovery, and the complete OS/architecture install
matrix remain unfinished. TTL means invisible to reads until explicit `collectExpired()` removes
rows; encrypted historical pages/WAL/backups require later lifecycle handling. `close()` attempts a WAL checkpoint; an external reader can prevent truncation.

Staging stores ordered encrypted chunks under the database quota and a common TTL; incomplete stages
cannot be read through the staging interface. Sealing authenticates the complete ordered digest.
Callers must schedule `collectExpired()` after crashes and periodically. Staging is not wired to HTTP
stream recording yet. Durable replay/event adapters and production receipts remain separate units.

## v1.1 ordered occurrence adapter

Gateway adds `createSqliteRecordStoreV2` and types `HttpOccurrence`, `TapeEpoch`, `TapeCursor`, `ConsumedOccurrence`,
`RecordStoreV2`, `RecordStoreV2Options`. Existing synchronous `RecordStore` and `Replayer` contracts
remain unchanged. The new adapter requires a fixed-tenant `SqliteStorage`; scope, epoch and ordinal
select an immutable occurrence. The caller supplies the unmodified key from `canonicalizeRequest`.
Identical prompts at different ordinals can retain different stochastic responses.

`createEpoch` initializes an append-only sequence; `epoch` reads its length/revision; `append` requires
its next ordinal. A transaction
retry with identical bytes is idempotent; different bytes cannot overwrite a recorded position.
`openCursor` creates an explicit replay cursor; `cursor` reloads its current revision. `peek` reads an
explicit position without advancing or crediting it. `consume` atomically records a unique claim and
advances the revision-bearing cursor. Independent competing claims conflict; retrying the same handle,
key and transaction ID returns the original committed result without advancing again. A mismatch or
strict miss never advances. Reusing a claimed ID with another request is an error, not live fallback.
`rewind` explicitly moves a current cursor to a recorded position; its transaction is also idempotent.
No equality-based stochastic auto-reuse occurs outside an explicitly selected tape cursor.

HTTP occurrences use a length-limited versioned metadata frame followed by raw binary response bytes;
bodies are not base64 JSON. Reads validate coordinates, expiry binding, exact body digest, HTTP status,
header safety, usage counts and the selected provider adapter's terminal predicate. Structurally
invalid authenticated frames receive a quarantine marker where storage permits; failures refuse
bytes regardless of marker persistence. AEAD failures disable the underlying storage worker. This
is corruption detection, not protection against an application deliberately rewriting all authenticated
metadata through its own storage credentials. Expired bodies remain unavailable, including to retries.

Gateway HTTP/CLI wiring, claim-to-accounting atomicity, incomplete-stream staging integration and the
full kill-point crash matrix are not delivered by this adapter packet. Storage
lifecycle residuals remain as documented above; durable mode is not yet a default profile.

## Responses adapter addition (v1.1.0)

The OpenAI adapter now recognizes POST `/v1/responses` as well as Chat Completions.
`ProviderAdapter.isRecordableSuccess` accepts an optional request URL so transport validation
rejects a Chat-shaped response on a Responses route and vice versa. Existing two-argument
adapters remain compatible. The canonicalizer and existing synchronous replay semantics are
unchanged; all Responses input, tools, reasoning and unknown fields retain their existing identity.

### Ordered SQLite gateway integration (v1.1.0)

`ProxyOptions.tape` and `TapeProxyOptions` add opt-in record-only or strict ordered
replay over `RecordStoreV2`. `HttpOccurrence.requestUrl` preserves endpoint-aware
response validation; `cursorForClaim` retrieves the original position for an
idempotent consume retry. Existing synchronous memory store/replayer contracts
are unchanged. An avoidance callback runs only for a fresh, committed consume;
callback failure cannot trigger an upstream call. It is not a transactional
accounting outbox: a crash can lose callback delivery (U21 remains pending).

Durable proxy responses within the eligibility limit are buffered until append
commits. Oversized responses flush and stream without recording. The additive
`TapeProxyOptions.upstreamTimeoutMs` sets an absolute upstream deadline (default
120 seconds); client disconnects cancel upstream work and release queued traffic.
Storage commits already underway settle before the next queued request begins.

## Managed WAL admission (v1.1.0)

`SqliteStorageOptions.maxWalBytes` adds a separate WAL allowance (default twice the database limit
plus 65,536 bytes). With cache spilling disabled and verified, each managed transaction reserves
space for every allowed database page plus WAL frame/header overhead before writing. Admission runs
under SQLite's IMMEDIATE writer lock. Near the allowance, the worker tries a non-waiting checkpoint;
a pinned reader causes actionable write refusal until checkpointing can reclaim space. A completed
transaction retry returns its receipt without requiring more write space.

Pinned-reader tests cover one and two independent workers, unchanged data on refusal, idempotent
retries and recovery when the reader finishes. This bounds cooperating Rewind writers under the same
configuration, not arbitrary external SQLite writes, backups, or the whole directory. An OS quota is
needed for those. Disabling spill can retain dirty database pages in worker memory until commit;
choose database and queue limits together. See SQLite's [cache spill documentation](https://sqlite.org/pragma.html#pragma_cache_spill)
and [WAL concurrency constraints](https://sqlite.org/wal.html).

## Incremental traffic analysis (v1.1.0)

`createTrafficAnalyzer` is additive, with bounded digest/scope indexes and optional
sample retention (off by default). Returned reports are snapshots. Existing
`analyzeTraffic` keeps the batch signature and sample behavior. Both reject malformed
usage and unsafe aggregate arithmetic before changing accumulator state. Missing usage
still counts as zero. The CLI supports file/stdin NDJSON and emits a compact attested
summary by default; `--legacy-json` restores the expanded report explicitly.
