import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBenchArtifact, tokenBuckets, validateTraceProvenance } from "../bench/artifact.ts";

test("unknown, partial and malformed usage cannot invent measured tokens", () => {
  for (const usage of [undefined, {}, { input_tokens: 4 }, { input_tokens: -1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }]) {
    assert.equal(tokenBuckets(usage), null);
  }
  assert.deepEqual(tokenBuckets({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }), { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 });
});

test("artifact is reproducible, simulated, provenance-bound and includes unique negative", async () => {
  const a = await buildBenchArtifact();
  const b = await buildBenchArtifact();
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.schema, "rewind.benchmark/v1");
  assert.equal(a.evidence, "simulated");
  assert.equal(a.providerBilled, false);
  assert.equal(a.scenarios[0].report.billableSavedPct, 28.08);
  assert.equal(a.scenarios[1].report.billableSavedMicros, 0);
  assert.equal(a.scenarios[0].denominators.calls, 9);
  assert.equal(a.scenarios[0].denominators.replayedCalls, 3);
  assert.equal(a.sources[1].replayEligible, false);
  assert.equal(a.sources[1].pairedSavings, null);
  assert.match(a.corpusSha256, /^[a-f0-9]{64}$/);
  const measured = a.scenarios[0];
  const offTokens = measured.report.offTranscript.reduce((sum, call) => {
    const t = tokenBuckets(call.usage)!;
    return sum + t.input + t.output + t.cacheRead + t.cacheWrite;
  }, 0);
  const liveUncachedAndOutput = measured.report.onTranscript.filter((call) => call.servedBy === "upstream").reduce((sum, call) => {
    const t = tokenBuckets(call.usage)!;
    return sum + t.input + t.output;
  }, 0);
  assert.equal(measured.tokens.replayAvoided! + measured.tokens.providerCache!.read + measured.tokens.providerCache!.write + liveUncachedAndOutput, offTokens, "OFF tokens partition into avoided occurrences and live categories without overlap");
  assert.equal(a.scenarios[0].tokens.contextRemoved, 0);
  assert.equal(a.scenarios[0].tokens.controlPlane, 0);
  assert.ok(a.scenarios[0].tokens.replayAvoided! > 0);
  assert.ok(a.scenarios[0].tokens.providerCache!.read >= 0);
});


test("missing provenance fails closed instead of emitting a benchmark claim", () => {
  for (const fixture of [undefined, {}, { schema: "rewind.trace/v1", source: {}, steps: [{}] }]) {
    assert.throws(() => validateTraceProvenance(fixture), /provenance/);
  }
});
