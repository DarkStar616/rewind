import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The 1.0 public-API freeze for @agent-rewind/gateway.
//
// This test IS the freeze (docs/STABILITY.md): the exact set of names exported
// from src/index.ts — values AND types — is snapshotted below. Under semver:
//   - ADDING an export is a minor bump: add the name here in the same commit.
//   - REMOVING or RENAMING an export is a MAJOR bump: this test fails until the
//     name is restored or the major version is intentionally cut.
// The snapshot is DERIVED against the live index.ts on every run, so a silent
// removal cannot pass: it changes the derived set and the assertion breaks.

const INDEX = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** All names exported from an index module's `export { ... }` / `export type { ... }` blocks.
 *  For an aliased re-export (`X as Y`) the PUBLIC name is `Y` — the alias the consumer imports — so we
 *  record that, not the internal source name. (Otherwise swapping the impl behind an alias would leave
 *  the snapshot unchanged and silently pass while the public surface changed.) */
function exportedNames(path: string): string[] {
  const src = readFileSync(path, "utf8");
  // Fail CLOSED on any export form this brace-parser cannot enumerate. A star re-export
  // (`export * from …` / `export type * from …`) would add or remove public names invisibly to both
  // the brace parser and the runtime Object.keys check, leaving the "exact" snapshot green while the
  // surface drifted. The freeze REQUIRES every public export to be an explicit named brace export, so
  // an index that reaches for a star form must be refactored to name its exports (or this guard
  // widened deliberately) rather than silently escape the snapshot.
  if (/export\s+(?:type\s+)?\*/.test(src)) {
    throw new Error(
      `${path} uses a star re-export (export * / export type *), which bypasses the public-API freeze. ` +
        "Enumerate the exports by name so the snapshot can see them.",
    );
  }
  const re = /export\s+(?:type\s+)?\{([^}]*)\}/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    for (const part of m[1].split(",")) {
      const raw = part.trim();
      if (!raw) continue;
      const alias = raw.match(/\bas\s+(\w+)\s*$/); // `Source as Public` → the public name is the alias
      out.add(alias ? alias[1] : raw);
    }
  }
  return [...out].sort();
}

// The frozen surface — values + types. Keep sorted.
const FROZEN = [
  "ADAPTERS", "AnalysisTotals", "AnalyzeOptions", "TrafficAnalyzer", "TrafficAnalyzerOptions", "AnalyzedCall", "AttestedAnalysis", "BillableSavings",
  "CacheHygieneReport", "CachePlan", "CachePreservationCredit", "ComponentRates", "DEFAULT_PRICE_TABLE",
  "DEFAULT_REDACTORS", "DROP", "Divergence", "DivergenceKind", "DivergenceReport", "ExtractedUsage",
  "HygieneIssue", "HygieneReason", "MeteredAvoidance", "NOISE_FIELDS", "OpenAiUsageAggregate",
  "OpenAiUsageBucket", "OpenAiUsageResult", "PriceTable", "ProviderAdapter",
  "ProviderUsage", "ProviderUsageFetcher", "TapeProxyOptions", "ProxyOptions", "PruneOptions", "PruneResult",
  "ReconciliationReport", "RecordKey", "RecordStore", "RecordedCall", "RecordedHttpResponse",
  "RedactContext", "RedactFn", "ReplayOutcome", "ReplayOutcomeLive", "ReplayOutcomeReplay", "Replayer",
  "HttpOccurrence", "TapeEpoch", "TapeCursor", "ConsumedOccurrence", "RecordStoreV2", "RecordStoreV2Options",
  "TrustedScope", "ScopeRequest", "ScopeResolver",
  "SqliteStorageOptions", "StorageMutation", "StorageValue", "StorageCommit", "SqliteStorage", "StagingOptions", "StagedObject", "EncryptedStaging",
  "ReplayerOptions", "RunningProxy", "SavingsAnalysis", "ScopeAnalysis", "StrictReplayMissError",
  "analyzeCacheHygiene", "analyzeTraffic", "createTrafficAnalyzer", "anthropicAdapter", "attestAnalysis", "avoidedCostMicros",
  "createFixedTenantResolver", "encodeTrustedScope", "openSqliteStorage", "createEncryptedStaging", "createSqliteRecordStoreV2",
  "billableSavedTokens", "canonicalizeRequest", "createMemoryRecordStore", "createReplayer",
  "divergeMessages", "extractUsage", "extractUsageFor", "geminiAdapter", "hasCacheControl",
  "isRecordableSuccessFor", "meterAvoidance", "meterCachePreservation", "normalizeUsage",
  "openAiUsageFetcher", "openaiAdapter",
  "pickUsageFields", "planCacheBreakpoints", "pruneToolOutputs", "reconcileAgainstProviderBill",
  "reconcileAgainstProviderBillWith",
  "redactValue", "redactedExportView", "selectAdapter", "startProxy", "totalRecordedTokens",
  "totalUsageTokens",
].sort();

// The subset that must exist as runtime VALUES (not type-only). Derived by
// importing the module — a type-only export never appears here.
const FROZEN_VALUES = [
  "ADAPTERS", "DEFAULT_PRICE_TABLE", "DEFAULT_REDACTORS", "DROP", "NOISE_FIELDS", "StrictReplayMissError",
  "analyzeCacheHygiene", "analyzeTraffic", "createTrafficAnalyzer", "anthropicAdapter", "attestAnalysis", "avoidedCostMicros",
  "createFixedTenantResolver", "encodeTrustedScope", "openSqliteStorage", "createEncryptedStaging", "createSqliteRecordStoreV2",
  "billableSavedTokens", "canonicalizeRequest", "createMemoryRecordStore", "createReplayer",
  "divergeMessages", "extractUsage", "extractUsageFor", "geminiAdapter", "hasCacheControl",
  "isRecordableSuccessFor", "meterAvoidance", "meterCachePreservation", "normalizeUsage",
  "openAiUsageFetcher", "openaiAdapter",
  "pickUsageFields", "planCacheBreakpoints", "pruneToolOutputs", "reconcileAgainstProviderBill",
  "reconcileAgainstProviderBillWith",
  "redactValue", "redactedExportView", "selectAdapter", "startProxy", "totalRecordedTokens",
  "totalUsageTokens",
].sort();

test("gateway public API: the exported name set is frozen (values + types)", () => {
  assert.deepEqual(exportedNames(INDEX), FROZEN,
    "index.ts export surface drifted from the 1.0 freeze — a removal/rename is a MAJOR bump; an addition must be added to FROZEN and docs/STABILITY.md in the same commit");
});

test("gateway public API: every frozen value is actually importable at runtime", async () => {
  const mod = await import("../src/index.ts");
  assert.deepEqual(Object.keys(mod).sort(), FROZEN_VALUES,
    "runtime value exports drifted from the freeze");
  for (const name of FROZEN_VALUES) {
    assert.ok(name in mod && (mod as Record<string, unknown>)[name] !== undefined, `missing runtime export: ${name}`);
  }
});
