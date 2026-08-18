import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryReplaySavings } from "../src/replay/replay-savings.ts";

test("total sums recorded savings and dedupes by callId", () => {
  const sink = createMemoryReplaySavings();
  sink.record({ scope: "s", tokensAvoided: 100, costMicros: 1000, model: "m", callId: "c1" });
  sink.record({ scope: "s", tokensAvoided: 100, costMicros: 1000, model: "m", callId: "c1" }); // dup
  assert.deepEqual(sink.total("s"), { tokens: 100, costMicros: 1000 });
});

test("total across scopes sums distinct callIds; scope filter narrows", () => {
  const sink = createMemoryReplaySavings();
  sink.record({ scope: "s", tokensAvoided: 100, costMicros: 1000, model: "m", callId: "c1" });
  sink.record({ scope: "t", tokensAvoided: 50, costMicros: 500, model: "m", callId: "c2" });
  assert.deepEqual(sink.total(), { tokens: 150, costMicros: 1500 });
  assert.deepEqual(sink.total("s"), { tokens: 100, costMicros: 1000 });
  assert.deepEqual(sink.total("t"), { tokens: 50, costMicros: 500 });
});

test("total is 0 when nothing was recorded", () => {
  const sink = createMemoryReplaySavings();
  assert.deepEqual(sink.total(), { tokens: 0, costMicros: 0 });
  assert.deepEqual(sink.total("missing"), { tokens: 0, costMicros: 0 });
});
