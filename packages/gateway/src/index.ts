export { canonicalizeRequest, NOISE_FIELDS } from "./canonical-request.ts";
export {
  createMemoryRecordStore,
  totalRecordedTokens,
} from "./record-store.ts";
export type {
  RecordStore,
  RecordKey,
  RecordedCall,
  ProviderUsage,
} from "./record-store.ts";
export { createReplayer, StrictReplayMissError } from "./replay.ts";
export type {
  Replayer,
  ReplayerOptions,
  ReplayOutcome,
  ReplayOutcomeReplay,
  ReplayOutcomeLive,
} from "./replay.ts";
export {
  avoidedCostMicros,
  meterAvoidance,
  totalUsageTokens,
  DEFAULT_PRICE_TABLE,
} from "./meter.ts";
export type { PriceTable, ComponentRates, MeteredAvoidance } from "./meter.ts";
export { extractUsage, pickUsageFields, normalizeUsage } from "./usage.ts";
export type { ExtractedUsage } from "./usage.ts";
export {
  selectAdapter,
  isRecordableSuccessFor,
  extractUsageFor,
  ADAPTERS,
} from "./providers/provider-adapter.ts";
export type { ProviderAdapter } from "./providers/provider-adapter.ts";
export { anthropicAdapter } from "./providers/anthropic.ts";
export { openaiAdapter } from "./providers/openai.ts";
export { geminiAdapter } from "./providers/gemini.ts";
export { startProxy } from "./proxy.ts";
export type { ProxyOptions, RunningProxy, RecordedHttpResponse } from "./proxy.ts";
export { planCacheBreakpoints, meterCachePreservation, hasCacheControl } from "./cache-preserve.ts";
export type { CachePlan, CachePreservationCredit } from "./cache-preserve.ts";
export { analyzeCacheHygiene } from "./cache-hygiene.ts";
export type { CacheHygieneReport, HygieneIssue, HygieneReason } from "./cache-hygiene.ts";
export { pruneToolOutputs } from "./prune.ts";
export type { PruneOptions, PruneResult } from "./prune.ts";
export { billableSavedTokens } from "./billable.ts";
export type { BillableSavings } from "./billable.ts";
export { redactValue, redactedExportView, DEFAULT_REDACTORS, DROP } from "./redact.ts";
export type { RedactFn, RedactContext } from "./redact.ts";
export { reconcileAgainstProviderBill, reconcileAgainstProviderBillWith, openAiUsageFetcher } from "./reconcile.ts";
export type {
  ReconciliationReport,
  ProviderUsageFetcher,
  OpenAiUsageAggregate,
  OpenAiUsageBucket,
  OpenAiUsageResult,
} from "./reconcile.ts";
export { divergeMessages } from "./diverge.ts";
export type { DivergenceReport, Divergence, DivergenceKind } from "./diverge.ts";
export { analyzeTraffic, attestAnalysis } from "./analysis.ts";
export type {
  AnalyzedCall,
  SavingsAnalysis,
  ScopeAnalysis,
  AnalysisTotals,
  AnalyzeOptions,
  AttestedAnalysis,
} from "./analysis.ts";
export { createFixedTenantResolver, encodeTrustedScope } from "./trusted-scope.ts";
export type { TrustedScope, ScopeRequest, ScopeResolver } from "./trusted-scope.ts";
export { openSqliteStorage } from "./storage/sqlite-store.ts";
export type { SqliteStorageOptions, StorageMutation, StorageValue, StorageCommit, SqliteStorage } from "./storage/sqlite-store.ts";
export { createEncryptedStaging } from "./storage/encrypted-staging.ts";
export type { StagingOptions, StagedObject, EncryptedStaging } from "./storage/encrypted-staging.ts";
