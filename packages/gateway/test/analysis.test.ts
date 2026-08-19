import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyChain } from "@agent-rewind/core";
import { analyzeTraffic, attestAnalysis } from "../src/analysis.ts";
import { DROP } from "../src/redact.ts";

const call = (scope: string, prompt: string, tokens: number) => ({
  scope,
  body: { model: "claude-haiku-4-5", max_tokens: 10, messages: [{ role: "user", content: prompt }] },
  usage: { input_tokens: tokens, output_tokens: tokens },
  model: "claude-haiku-4-5",
  headers: {}, // declared: no output-affecting headers, so identical calls are genuine replays
  url: "https://api.anthropic.com/v1/messages", // absolute target — keyed exactly as the live gateway does
});

test("analysis counts byte-replayable repeats and prices the avoided cost", () => {
  const a = analyzeTraffic([call("s", "hello", 100), call("s", "hello", 100), call("s", "unique", 100)]);
  assert.equal(a.total.calls, 3);
  assert.equal(a.total.replayableCalls, 1, "the 2nd identical call is the replayable one");
  assert.ok(a.total.avoidedCostMicros > 0);
  assert.equal(a.total.avoidedTokens, 200, "the one replayable call avoids its 200 provider tokens");
});

test("a RELATIVE url cannot prove replayability — origin is unknown, so it is never counted (no over-credit)", () => {
  // Two byte-identical calls whose url is RELATIVE (`/v1/chat/completions`). A relative url loses the
  // upstream ORIGIN, and the live gateway namespaces the replay key by origin — so two such calls may in
  // fact target DIFFERENT vendors (both speak `/v1/chat/completions`) and the live proxy would MISS,
  // making a real paid call. The analysis must therefore treat a relative url as UNKNOWN and never count
  // it as a replay. (Fails on the pre-fix, path-only implementation, which over-credits this as 1.)
  const rel = {
    scope: "s",
    body: { model: "m", messages: [{ role: "user", content: "hi" }] },
    usage: { input_tokens: 40, output_tokens: 40 },
    model: "m",
    headers: {},
    url: "/v1/chat/completions",
  };
  const a = analyzeTraffic([rel, { ...rel }]);
  assert.equal(a.total.replayableCalls, 0, "relative url => origin unknown => not proven replayable");
});

test("two ABSOLUTE-URL calls to DIFFERENT origins (same path+body+headers) are NOT a replay — origin-namespaced like the live gateway", () => {
  const mk = (origin: string) => ({
    scope: "s",
    body: { model: "m", messages: [{ role: "user", content: "hi" }] },
    usage: { input_tokens: 40, output_tokens: 40 },
    model: "m",
    headers: {},
    url: `${origin}/v1/chat/completions`,
  });
  const a = analyzeTraffic([mk("https://api.openai.com"), mk("https://api.nebius.com")]);
  assert.equal(a.total.replayableCalls, 0, "different upstream origin => different key => not a replay");
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

test("same body but a different anthropic-beta header is NOT a replay (no over-credit)", () => {
  const mk = (beta: string) => ({
    scope: "s",
    body: { model: "claude-haiku-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] },
    usage: { input_tokens: 100, output_tokens: 100 },
    model: "claude-haiku-4-5",
    headers: { "anthropic-beta": beta },
    url: "https://api.anthropic.com/v1/messages",
  });
  const a = analyzeTraffic([mk("v1"), mk("v2")]);
  assert.equal(a.total.replayableCalls, 0, "different output-affecting header => different key => not a replay");
  // Whereas the SAME beta on both is a genuine replay.
  const b = analyzeTraffic([mk("v1"), mk("v1")]);
  assert.equal(b.total.replayableCalls, 1);
});

test("a malformed call missing usage is tolerated as zero, never a crash (under-counts, never over-credits)", () => {
  const noUsage = { scope: "s", body: { model: "m", messages: [{ role: "user", content: "hi" }] }, model: "m", headers: {}, url: "https://api.anthropic.com/v1/messages" } as never;
  const a = analyzeTraffic([noUsage, noUsage]);
  assert.equal(a.total.replayableCalls, 1, "still detected as a replay");
  assert.equal(a.total.avoidedTokens, 0, "missing usage avoids zero tokens, not a throw");
  assert.equal(a.total.avoidedCostMicros, 0);
});

test("calls with UNKNOWN headers (field omitted) are never counted as replayable — no over-credit", () => {
  // Identical body + usage, but headers omitted => unknown => cannot be proven replayable.
  const c = { scope: "s", body: { model: "m", messages: [{ role: "user", content: "hi" }] }, usage: { input_tokens: 9, output_tokens: 9 }, model: "m" };
  const a = analyzeTraffic([c, c]);
  assert.equal(a.total.calls, 2);
  assert.equal(a.total.replayableCalls, 0, "unknown-headers calls never match each other");
  assert.equal(a.total.avoidedCostMicros, 0, "and so credit nothing");
});

test("two calls to different URL-addressed models (same body) are NOT a replay — matches the live key", () => {
  // Gemini names the model in the URL, not the body. The live gateway keys on the URL path, so two
  // identical bodies to pro vs flash are distinct calls; the analysis must agree or it over-credits.
  const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  const mk = (model: string) => ({
    scope: "s",
    body,
    usage: { input_tokens: 100, output_tokens: 50 },
    model,
    headers: {},
    url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
  });
  const a = analyzeTraffic([mk("gemini-2.5-pro"), mk("gemini-2.5-flash")]);
  assert.equal(a.total.replayableCalls, 0, "different model target => different key => not a replay");
  // The SAME model target twice IS a genuine replay.
  const b = analyzeTraffic([mk("gemini-2.5-pro"), mk("gemini-2.5-pro")]);
  assert.equal(b.total.replayableCalls, 1);
});

test("calls with UNKNOWN url (field omitted) are never counted as replayable — no over-credit", () => {
  const c = { scope: "s", body: { model: "m", messages: [{ role: "user", content: "hi" }] }, usage: { input_tokens: 9, output_tokens: 9 }, model: "m", headers: {} };
  const a = analyzeTraffic([c, c]);
  assert.equal(a.total.replayableCalls, 0, "unknown-target calls never match each other");
  assert.equal(a.total.avoidedCostMicros, 0);
});

test("an empty traffic batch analyses and attests cleanly (no sample, still verifiable)", () => {
  const a = analyzeTraffic([]);
  assert.equal(a.total.calls, 0);
  assert.equal(a.perScope.length, 0);
  assert.equal(a.sample, undefined);
  const { chain, rootHash } = attestAnalysis(a);
  assert.equal(verifyChain(chain).ok, true, "an empty analysis still attests and verifies");
  assert.match(rootHash, /^[0-9a-f]{64}$/);
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
