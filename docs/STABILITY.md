# API Stability — Agent Rewind 1.0

This document is the public-API contract for the `@agent-rewind/*` packages as of **1.0.0**.
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
`createGitBackend`, `createMemoryEvidenceLedger`, `createMemoryReplaySavings`,
`createMemoryRewindStore`, `memoryForCheckpoint`, `recommendedCheckpoint`, `refId`,
`shouldCheckpoint`, `verifyChain`

Types:

`AttemptRecord`, `AuditEntry`, `AuditEntryInput`, `AuthorityResolver`, `BacktrackCandidate`,
`Change`, `EffectAdmission`, `EffectLedger`, `EffectLedgerOptions`, `EffectOutcome`,
`EffectRefusal`, `Engine`, `EngineOptions`, `EvidenceLedger`, `ExternalEffect`,
`GitBackendOptions`, `LedgerOptions`, `LedgerQuery`, `Outcome`, `RefusableEffect`,
`ReplayResult`, `ReplaySaving`, `ReplaySavingsSink`, `ReplaySavingsTotal`, `RestoreResult`,
`RewindMemoryStore`, `RewindResult`, `UnhashedEntry`, `VerifyResult`, `WorldBackend`, `WorldRef`

## Frozen surface — `@agent-rewind/gateway`

Values (runtime):

`ADAPTERS`, `DEFAULT_PRICE_TABLE`, `DEFAULT_REDACTORS`, `DROP`, `NOISE_FIELDS`,
`StrictReplayMissError`, `analyzeCacheHygiene`, `analyzeTraffic`, `anthropicAdapter`,
`attestAnalysis`, `avoidedCostMicros`, `billableSavedTokens`, `canonicalizeRequest`,
`createMemoryRecordStore`, `createReplayer`, `divergeMessages`, `extractUsage`,
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
