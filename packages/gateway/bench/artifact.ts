/** Reproducible offline measurement; mock usage is never provider-billed evidence. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BENCH_PRICES, runBench, type BenchReport } from "./bench.ts";

const sha = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export function tokenBuckets(value: unknown): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const counts = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].map((key) => usage[key]);
  if (!counts.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0)) return null;
  const [input, output, cacheRead, cacheWrite] = counts as number[];
  if (!Number.isSafeInteger(input + output + cacheRead + cacheWrite)) return null;
  return { input, output, cacheRead, cacheWrite };
}

function scenario(id: string, report: BenchReport) {
  let avoided = 0, read = 0, write = 0, unknownReplay = 0, unknownLive = 0;
  for (const [index, on] of report.onTranscript.entries()) {
    // Avoided tokens use OFF usage for this occurrence; live cache traffic uses ON usage only.
    // Replayed cached tokens are never included a second time under providerCache.
    const tokens = tokenBuckets(on.servedBy === "replay" ? report.offTranscript[index].usage : on.usage);
    if (on.servedBy === "replay") {
      if (!tokens) unknownReplay++;
      else avoided += tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
    } else {
      if (!tokens) unknownLive++;
      else { read += tokens.cacheRead; write += tokens.cacheWrite; }
    }
  }
  return {
    id, report,
    denominators: { calls: report.turns.length, replayEligibleCalls: report.turns.length, replayedCalls: report.avoidedCalls, liveCalls: report.onUpstreamCalls, unknownReplayUsageCalls: unknownReplay, unknownLiveUsageCalls: unknownLive },
    tokens: {
      replayAvoided: unknownReplay ? null : avoided,
      providerCache: unknownLive ? null : { read, write },
      contextRemoved: 0, // shaping disabled in this scenario
      controlPlane: 0, // no MCP/control-plane traffic in this scenario
    },
    // Cache traffic is discounted input, not eliminated tokens or a Rewind-caused saving.
    eliminatedTokens: unknownReplay ? null : avoided,
    gatewayCausedCacheSavingsMicros: null,
    taskSuccess: null,
  };
}

export function validateTraceProvenance(value: unknown): void {
  if (!value || typeof value !== "object") throw new Error("trace provenance missing");
  const trace = value as Record<string, any>;
  const source = trace.source;
  if (trace.schema !== "rewind.trace/v1" || !source ||
      typeof source.repository !== "string" || !source.repository.startsWith("https://") ||
      typeof source.path !== "string" || !source.path ||
      typeof source.license !== "string" || !source.license ||
      !/^[a-f0-9]{40}$/.test(source.revision ?? "") ||
      !/^[a-f0-9]{64}$/.test(source.sourceSha256 ?? "") ||
      !Array.isArray(trace.steps) || trace.steps.length === 0 || trace.replayEligible !== false) {
    throw new Error("trace provenance incomplete or unsupported replay eligibility");
  }
}

export async function buildBenchArtifact() {
  const fixtureBytes = readFileSync(new URL("./fixtures/atif-excerpt.json", import.meta.url));
  const fixture = JSON.parse(fixtureBytes.toString("utf8"));
  validateTraceProvenance(fixture);
  const files = ["bench.ts", "mock-upstream.ts", "artifact.ts"].map((file) => ({ file, sha256: sha(readFileSync(new URL(file, import.meta.url))) }));
  const sources = [
    { kind: "synthetic", revision: sha(JSON.stringify(files)), license: "FSL-1.1-ALv2", files, replayEligible: true, pairedSavings: "simulated" },
    { kind: "external-transcript-excerpt", ...fixture.source, fixtureSha256: sha(fixtureBytes), replayEligible: false, pairedSavings: null, tokenUsage: null, selectedSteps: fixture.steps.length, billing: fixture.billing, reason: fixture.reason },
  ];
  return {
    schema: "rewind.benchmark/v1", traceSchema: "rewind.trace/v1", evidence: "simulated", providerBilled: false,
    corpusSha256: sha(JSON.stringify(sources)), sources,
    configuration: { profile: "compat", preserveCache: false, pruneContext: false, seed: "fixed-turns-v1", clock: "injected-0", mockTokenization: "UTF-8 bytes/4 rounded up", priceTable: BENCH_PRICES },
    categoryContract: "replayAvoided uses avoided OFF calls; providerCache uses live ON calls only; contextRemoved excludes replay/cache tokens; controlPlane is separately emitted Rewind traffic. Cache reads/writes are not eliminated tokens. Null means unknown, not zero.",
    scenarios: [scenario("rewind-nine-calls", await runBench()), scenario("unique-negative", await runBench([1, 2, 3, 4, 5, 6]))],
    externalCorpus: { selectedSteps: fixture.steps.length, executableProviderCalls: 0, savings: null, billing: "unavailable" },
    limitations: ["No real provider billing or task-success evaluation", "One mock model and two synthetic trajectories; no workload percentiles", "External excerpt validates provenance only, not replay or cost", "No cache/shaping attribution or restart/concurrency corpus yet"],
  };
}
