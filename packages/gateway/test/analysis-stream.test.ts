import { test } from "node:test";
import assert from "node:assert/strict";
import * as analysis from "../src/analysis.ts";

test("incremental analysis matches batch totals without retaining a prompt sample", () => {
  const calls = ["a", "b", "a"].map((input) => ({ scope: "scope", model: "test", body: { input },
    headers: {}, url: "https://provider.test/v1/responses", usage: { input_tokens: 10, output_tokens: 2 } }));
  const stream = analysis.createTrafficAnalyzer({ sample: "none", maxKeys: 3, maxScopes: 1 });
  for (const call of calls) stream.add(call);
  const result = stream.result();
  assert.deepEqual(result.total, analysis.analyzeTraffic(calls).total);
  assert.deepEqual(result.perScope, analysis.analyzeTraffic(calls).perScope);
  assert.equal(result.sample, undefined);
  result.total.calls = 999;
  result.perScope[0].calls = 999;
  assert.equal(stream.result().total.calls, 3, "returned snapshots cannot mutate accumulator state");
});

test("incremental analysis enforces cardinality bounds without partially adding a rejected call", () => {
  const stream = analysis.createTrafficAnalyzer({ sample: "none", maxKeys: 1, maxScopes: 1 });
  const call = { scope: "one", body: { input: "a" }, model: "test", headers: {}, url: "https://provider.test/v1/responses", usage: {} };
  stream.add(call);
  assert.throws(() => stream.add({ ...call, body: { input: "b" } }), /key.*limit/);
  assert.throws(() => stream.add({ ...call, scope: "two" }), /scope.*limit/);
  assert.equal(stream.result().total.calls, 1);
});

test("invalid usage and aggregate overflow are rejected atomically", () => {
  const stream = analysis.createTrafficAnalyzer();
  const call = { scope: "one", body: {}, model: "unknown", headers: {}, url: "https://provider.test/v1/responses", usage: {} };
  for (const count of ["100", -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => stream.add({ ...call, usage: { input_tokens: count as number } }), /invalid analysis usage/);
  }
  assert.equal(stream.result().total.calls, 0);
  stream.add(call);
  stream.add({ ...call, usage: { input_tokens: Number.MAX_SAFE_INTEGER } });
  const before = stream.result();
  assert.throws(() => stream.add({ ...call, usage: { input_tokens: 1 } }), /analysis counter limit exceeded/);
  assert.deepEqual(stream.result(), before);
  stream.add({ ...call, scope: "two" });
  const acrossScopes = stream.result();
  assert.throws(() => stream.add({ ...call, scope: "two", usage: { input_tokens: 1 } }), /analysis counter limit exceeded/);
  assert.deepEqual(stream.result(), acrossScopes);
});
