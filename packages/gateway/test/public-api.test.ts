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

/** All names exported from an index module's `export { ... }` / `export type { ... }` blocks. */
function exportedNames(path: string): string[] {
  const src = readFileSync(path, "utf8");
  const re = /export\s+(?:type\s+)?\{([^}]*)\}/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    for (const part of m[1].split(",")) {
      const name = part.trim();
      if (name) out.add(name.replace(/\s+as\s+\w+$/, "").trim());
    }
  }
  return [...out].sort();
}

// The frozen surface — values + types. Keep sorted.
const FROZEN = [
  "ADAPTERS", "AnalysisTotals", "AnalyzeOptions", "AnalyzedCall", "AttestedAnalysis", "BillableSavings",
  "CacheHygieneReport", "CachePlan", "CachePreservationCredit", "ComponentRates", "DEFAULT_PRICE_TABLE",
  "DEFAULT_REDACTORS", "DROP", "Divergence", "DivergenceKind", "DivergenceReport", "ExtractedUsage",
  "HygieneIssue", "HygieneReason", "MeteredAvoidance", "NOISE_FIELDS", "PriceTable", "ProviderAdapter",
  "ProviderUsage", "ProviderUsageFetcher", "ProxyOptions", "PruneOptions", "PruneResult",
  "ReconciliationReport", "RecordKey", "RecordStore", "RecordedCall", "RecordedHttpResponse",
  "RedactContext", "RedactFn", "ReplayOutcome", "ReplayOutcomeLive", "ReplayOutcomeReplay", "Replayer",
  "ReplayerOptions", "RunningProxy", "SavingsAnalysis", "ScopeAnalysis", "StrictReplayMissError",
  "analyzeCacheHygiene", "analyzeTraffic", "anthropicAdapter", "attestAnalysis", "avoidedCostMicros",
  "billableSavedTokens", "canonicalizeRequest", "createMemoryRecordStore", "createReplayer",
  "divergeMessages", "extractUsage", "extractUsageFor", "geminiAdapter", "hasCacheControl",
  "isRecordableSuccessFor", "meterAvoidance", "meterCachePreservation", "normalizeUsage", "openaiAdapter",
  "pickUsageFields", "planCacheBreakpoints", "pruneToolOutputs", "reconcileAgainstProviderBill",
  "redactValue", "redactedExportView", "selectAdapter", "startProxy", "totalRecordedTokens",
  "totalUsageTokens",
].sort();

// The subset that must exist as runtime VALUES (not type-only). Derived by
// importing the module — a type-only export never appears here.
const FROZEN_VALUES = [
  "ADAPTERS", "DEFAULT_PRICE_TABLE", "DEFAULT_REDACTORS", "DROP", "NOISE_FIELDS", "StrictReplayMissError",
  "analyzeCacheHygiene", "analyzeTraffic", "anthropicAdapter", "attestAnalysis", "avoidedCostMicros",
  "billableSavedTokens", "canonicalizeRequest", "createMemoryRecordStore", "createReplayer",
  "divergeMessages", "extractUsage", "extractUsageFor", "geminiAdapter", "hasCacheControl",
  "isRecordableSuccessFor", "meterAvoidance", "meterCachePreservation", "normalizeUsage", "openaiAdapter",
  "pickUsageFields", "planCacheBreakpoints", "pruneToolOutputs", "reconcileAgainstProviderBill",
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
