import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyChain } from "@rewind/core";
import { analyzeTraffic, attestAnalysis } from "../src/analysis.ts";
import { DROP } from "../src/redact.ts";

const call = (scope: string, prompt: string, tokens: number) => ({
  scope,
  body: { model: "claude-haiku-4-5", max_tokens: 10, messages: [{ role: "user", content: prompt }] },
  usage: { input_tokens: tokens, output_tokens: tokens },
  model: "claude-haiku-4-5",
});

test("analysis counts byte-replayable repeats and prices the avoided cost", () => {
  const a = analyzeTraffic([call("s", "hello", 100), call("s", "hello", 100), call("s", "unique", 100)]);
  assert.equal(a.total.calls, 3);
  assert.equal(a.total.replayableCalls, 1, "the 2nd identical call is the replayable one");
  assert.ok(a.total.avoidedCostMicros > 0);
  assert.equal(a.total.avoidedTokens, 200, "the one replayable call avoids its 200 provider tokens");
});

test("the FIRST occurrence is never counted as replayable — only genuine repeats are avoidable", () => {
  const a = analyzeTraffic([call("s", "only-once", 50)]);
  assert.equal(a.total.calls, 1);
  assert.equal(a.total.replayableCalls, 0);
  assert.equal(a.total.avoidedCostMicros, 0);
});

test("scopes are isolated — an identical body in a different scope is not a replay", () => {
  const a = analyzeTraffic([call("s1", "hello", 100), call("s2", "hello", 100)]);
  assert.equal(a.total.replayableCalls, 0, "same body, different scope, is not a cross-scope hit");
  assert.equal(a.perScope.length, 2);
});

test("the attested report verifies as a tamper-evident chain", () => {
  const a = analyzeTraffic([call("s", "hi", 10), call("s", "hi", 10)]);
  const { chain, rootHash } = attestAnalysis(a);
  assert.equal(verifyChain(chain).ok, true);
  assert.equal(typeof rootHash, "string");
  assert.equal(rootHash.length, 64);
});

test("tampering with the attested analysis breaks verification", () => {
  const a = analyzeTraffic([call("s", "hi", 10), call("s", "hi", 10)]);
  const { chain } = attestAnalysis(a);
  (chain[0].detail as any).total = { calls: 9999 };
  assert.equal(verifyChain(chain).ok, false);
});

test("attestation is deterministic — same analysis, same root hash (no clock/random)", () => {
  const mk = () => analyzeTraffic([call("s", "hi", 10), call("s", "hi", 10)]);
  assert.equal(attestAnalysis(mk()).rootHash, attestAnalysis(mk()).rootHash);
});

test("the redacted sample masks secrets from the shared report", () => {
  const withSecret = {
    scope: "s",
    body: { model: "claude-haiku-4-5", api_key: "sk-ant-supersecret01", messages: [{ role: "user", content: "hi" }] },
    usage: { input_tokens: 1, output_tokens: 1 },
    model: "claude-haiku-4-5",
  };
  const a = analyzeTraffic([withSecret], { redact: (v: unknown) => (typeof v === "string" && v.startsWith("sk-ant") ? DROP : v) });
  assert.ok(JSON.stringify(a.sample ?? {}).indexOf("sk-ant-supersecret01") === -1, "the api key must not appear in the sample");
});
