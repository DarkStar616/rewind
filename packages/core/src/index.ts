export { canonicalize, CanonicalJsonError } from "./audit/canonical-json.ts";
export {
  createMemoryEvidenceLedger,
  computeEntryHash,
  verifyChain,
  GENESIS_HASH,
  EvidenceLedgerError,
} from "./audit/evidence-ledger.ts";
export type {
  EvidenceLedger,
  AuditEntry,
  AuditEntryInput,
  VerifyResult,
  LedgerOptions,
  LedgerQuery,
  AuthorityResolver,
  UnhashedEntry,
} from "./audit/evidence-ledger.ts";
export {
  createEffectLedger,
  EFFECT_EMITTED,
  EFFECT_REPLAY_REFUSED,
  REPLAY_REFUSED_REASON,
} from "./audit/effect-ledger.ts";
export type {
  EffectLedger,
  EffectLedgerOptions,
  ExternalEffect,
  EffectOutcome,
  EffectAdmission,
  EffectRefusal,
} from "./audit/effect-ledger.ts";
export { createGitBackend, RevertIndeterminateError, RestoreFailedError } from "./world/git-backend.ts";
export type { GitBackendOptions } from "./world/git-backend.ts";
export { refId } from "./world/world-backend.ts";
export type { WorldBackend, WorldRef, RestoreResult, Change } from "./world/world-backend.ts";
export { createMemoryReplaySavings } from "./replay/replay-savings.ts";
export type { ReplaySavingsSink, ReplaySaving, ReplaySavingsTotal } from "./replay/replay-savings.ts";
export { createEngine } from "./engine.ts";
export type {
  Engine,
  EngineOptions,
  RewindResult,
  ReplayResult,
  RefusableEffect,
} from "./engine.ts";
export {
  createMemoryRewindStore,
  backtrackCandidates,
  memoryForCheckpoint,
  recommendedCheckpoint,
  shouldCheckpoint,
} from "./recovery/recovery.ts";
export type {
  AttemptRecord,
  Outcome,
  RewindMemoryStore,
  BacktrackCandidate,
} from "./recovery/recovery.ts";
