import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReplaySaving } from "@rewind/core";
import { billableSavedTokens } from "../src/billable.ts";

test("billable = sum of realized replay savings; a body with none bills zero", () => {
  assert.deepEqual(billableSavedTokens([]), { billableTokens: 0, billableCostMicros: 0, realizedReplays: 0 });
  const savings: ReplaySaving[] = [
    { scope: "s", tokensAvoided: 100, costMicros: 5, model: "m", callId: "s k1" },
    { scope: "s", tokensAvoided: 250, costMicros: 12, model: "m", callId: "s k2" },
  ];
  const r = billableSavedTokens(savings);
  assert.equal(r.realizedReplays, 2);
  assert.equal(r.billableTokens, 350);
  assert.equal(r.billableCostMicros, 17);
});

test("never credits a hypothetical: only records present in the list count", () => {
  // The type makes counterfactuals unrepresentable — there is no 'would-have' record to pass in.
  const r = billableSavedTokens([{ scope: "s", tokensAvoided: 10, costMicros: 1, model: "m", callId: "s k" }]);
  assert.equal(r.billableTokens, 10);
});

test("duplicate callIds collapse — an overlapping rewind never double-bills the same avoided call", () => {
  // Matches createMemoryReplaySavings' distinct-by-callId semantics: the same realized replay reported
  // twice (e.g. by two overlapping rewinds) is ONE billable event, not two. Over-crediting here would
  // charge a customer for savings that happened once — the exact failure the gainshare model must avoid.
  const savings: ReplaySaving[] = [
    { scope: "s", tokensAvoided: 100, costMicros: 5, model: "m", callId: "dup" },
    { scope: "s", tokensAvoided: 100, costMicros: 5, model: "m", callId: "dup" },
    { scope: "s", tokensAvoided: 40, costMicros: 2, model: "m", callId: "other" },
  ];
  const r = billableSavedTokens(savings);
  assert.equal(r.realizedReplays, 2, "two distinct callIds, not three records");
  assert.equal(r.billableTokens, 140);
  assert.equal(r.billableCostMicros, 7);
});

test("fractional inputs are floored, never rounded up (bill the customer no more than earned)", () => {
  const savings: ReplaySaving[] = [
    { scope: "s", tokensAvoided: 10.9, costMicros: 1.9, model: "m", callId: "a" },
    { scope: "s", tokensAvoided: 0.9, costMicros: 0.9, model: "m", callId: "b" },
  ];
  const r = billableSavedTokens(savings);
  assert.equal(r.billableTokens, 11, "floor(11.8) = 11");
  assert.equal(r.billableCostMicros, 2, "floor(2.8) = 2");
});
