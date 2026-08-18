import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReplaySaving } from "@rewind/core";
import { reconcileAgainstProviderBill } from "../src/reconcile.ts";

const s = (t: number): ReplaySaving => ({ scope: "s", tokensAvoided: t, costMicros: t, model: "m", callId: `s ${t}` });

test("billable within the provider-attested baseline reconciles clean", () => {
  const r = reconcileAgainstProviderBill([s(100), s(50)], 1000);
  assert.equal(r.billableTokens, 150);
  assert.equal(r.providerBaselineTokens, 1000);
  assert.equal(r.withinBill, true);
});

test("billable exceeding the provider baseline is flagged, never silently over-credited", () => {
  const r = reconcileAgainstProviderBill([s(2000)], 1000);
  assert.equal(r.withinBill, false);
});

test("a non-finite or negative provider baseline is treated as zero (fails closed, flags the report)", () => {
  const r = reconcileAgainstProviderBill([s(10)], Number.NaN);
  assert.equal(r.providerBaselineTokens, 0);
  assert.equal(r.withinBill, false, "with no trustworthy baseline, a positive claim cannot be vouched for");
  const neg = reconcileAgainstProviderBill([s(10)], -5);
  assert.equal(neg.providerBaselineTokens, 0);
  assert.equal(neg.withinBill, false);
});

test("zero savings reconcile clean against any baseline", () => {
  const r = reconcileAgainstProviderBill([], 0);
  assert.equal(r.billableTokens, 0);
  assert.equal(r.withinBill, true, "0 <= 0 is within bill");
});

test("reconciliation dedupes overlapping rewinds via the billable definition", () => {
  const dup: ReplaySaving[] = [
    { scope: "s", tokensAvoided: 100, costMicros: 5, model: "m", callId: "dup" },
    { scope: "s", tokensAvoided: 100, costMicros: 5, model: "m", callId: "dup" },
  ];
  const r = reconcileAgainstProviderBill(dup, 1000);
  assert.equal(r.billableTokens, 100, "the duplicate callId is not double-counted");
  assert.equal(r.realizedReplays, 1);
});
