import { test } from "node:test";
import assert from "node:assert/strict";
import type { ReplaySaving } from "@agent-rewind/core";
import {
  reconcileAgainstProviderBill,
  reconcileAgainstProviderBillWith,
  openAiUsageFetcher,
} from "../src/reconcile.ts";

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

const PERIOD = { since: "2026-08-01", until: "2026-08-31" };

test("OpenAI usage-API fetcher: input+output summed across buckets/results becomes the baseline", async () => {
  // The REAL organization usage shape: time buckets, each with a results[] carrying token fields.
  const fetchRaw = async () => ({
    data: [
      { results: [{ input_tokens: 500, output_tokens: 100 }] },
      { results: [{ input_tokens: 300, output_tokens: 100 }] },
    ],
  });
  const r = await reconcileAgainstProviderBillWith([s(100), s(50)], openAiUsageFetcher(fetchRaw), PERIOD);
  assert.equal(r.providerBaselineTokens, 1000, "(500+100)+(300+100) summed across every bucket's results");
  assert.equal(r.billableTokens, 150);
  assert.equal(r.withinBill, true);
});

test("OpenAI fetcher: multiple results within one bucket all count", async () => {
  const fetchRaw = async () => ({
    data: [{ results: [{ input_tokens: 40, output_tokens: 10 }, { input_tokens: 90, output_tokens: 10 }] }],
  });
  const r = await reconcileAgainstProviderBillWith([s(100)], openAiUsageFetcher(fetchRaw), PERIOD);
  assert.equal(r.providerBaselineTokens, 150, "40+10+90+10 across the two results in the bucket");
});

test("OpenAI fetcher: a chain claim exceeding the OpenAI-reported aggregate is flagged, never credited", async () => {
  const fetchRaw = async () => ({ data: [{ results: [{ input_tokens: 100, output_tokens: 50 }] }] });
  const r = await reconcileAgainstProviderBillWith([s(2000)], openAiUsageFetcher(fetchRaw), PERIOD);
  assert.equal(r.providerBaselineTokens, 150);
  assert.equal(r.withinBill, false, "2000 claimed against a 150-token aggregate is a flagged delta");
});

test("OpenAI fetcher: a missing/empty/garbage response fails closed to zero (any positive claim is flagged)", async () => {
  const partial = async () => ({ data: [{ results: [{ input_tokens: Number.NaN, output_tokens: 5 }] }] });
  const r = await reconcileAgainstProviderBillWith([s(10)], openAiUsageFetcher(partial), PERIOD);
  assert.equal(r.providerBaselineTokens, 5, "the finite field still counts; the non-finite one is dropped");
  assert.equal(r.withinBill, false);
  // No `data`, empty data, and missing results all yield a zero baseline (fail closed).
  const empty = async () => ({});
  const r2 = await reconcileAgainstProviderBillWith([s(10)], openAiUsageFetcher(empty), PERIOD);
  assert.equal(r2.providerBaselineTokens, 0);
  assert.equal(r2.withinBill, false);
});

test("the fetcher receives the reconciliation period verbatim", async () => {
  let seen: { since: string; until: string } | undefined;
  const fetchRaw = async (period: { since: string; until: string }) => {
    seen = period;
    return { data: [{ results: [{ input_tokens: 10, output_tokens: 0 }] }] };
  };
  await reconcileAgainstProviderBillWith([s(1)], openAiUsageFetcher(fetchRaw), PERIOD);
  assert.deepEqual(seen, PERIOD);
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
