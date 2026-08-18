import { test } from "node:test";
import assert from "node:assert/strict";

import { runBench, defaultTrajectory, formatReport } from "../bench/bench.ts";

/**
 * The bench proves — deterministically, with no API key — that the gateway saves money on the
 * rewind-and-re-run pattern, and that the billed number is the HONEST marginal saving over the
 * provider's own caching (measured by differencing two real runs), never the inflated gross.
 */

test("ON is cheaper than OFF: the rewind re-runs are avoided", async () => {
  const r = await runBench();
  assert.ok(r.onCostMicros < r.offCostMicros, `expected ON ${r.onCostMicros} < OFF ${r.offCostMicros}`);
  assert.ok(r.billableSavedMicros > 0, "a trajectory with re-runs must save something");
  assert.equal(r.avoidedCalls, 3, "the three re-run turns (3,4,5) are avoided");
  assert.equal(r.onUpstreamCalls, 6, "only the six first-occurrence turns reach upstream");
  assert.equal(r.offUpstreamCalls, 9, "OFF pays for all nine calls including the three re-runs");
});

test("fully deterministic: two runs produce byte-identical reports", async () => {
  const a = await runBench();
  const b = await runBench();
  // Strip the array fields' object identity by comparing the serialized reports.
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("golden-negative: a trajectory with NO re-runs bills EXACTLY 0", async () => {
  const r = await runBench([1, 2, 3, 4]);
  assert.equal(r.avoidedCalls, 0);
  assert.equal(r.billableSavedMicros, 0);
  assert.equal(r.billableSavedPct, 0);
  assert.equal(r.onCostMicros, r.offCostMicros);
});

test("billable saving never exceeds the gross replay upper bound", async () => {
  const r = await runBench();
  assert.ok(
    r.billableSavedMicros <= r.grossReplayMicros,
    `billable ${r.billableSavedMicros} must be <= gross ${r.grossReplayMicros}`,
  );
  // And strictly less here, because the re-runs would have been warm cache-reads upstream (cheaper
  // than the cold first-occurrence cost the record stored).
  assert.ok(r.billableSavedMicros < r.grossReplayMicros, "warm-repeat billing is below cold gross");
});

test("conservation: the billable saving equals exactly what OFF paid for the avoided re-runs", async () => {
  const r = await runBench();
  const traj = defaultTrajectory();
  // The avoided turns are the ones that appear a SECOND time in the trajectory.
  const seen = new Set<number>();
  const repeatPositions: number[] = [];
  traj.forEach((turn, i) => {
    if (seen.has(turn)) repeatPositions.push(i);
    else seen.add(turn);
  });
  const offRepeatCost = repeatPositions.reduce((sum, i) => sum + r.offTranscript[i].costMicros, 0);
  assert.equal(r.billableSavedMicros, offRepeatCost, "billable == summed OFF cost of the avoided re-runs");
});

test("the re-run calls in OFF are billed as warm provider cache-reads (baseline honesty)", async () => {
  const r = await runBench();
  const traj = defaultTrajectory();
  const seen = new Set<number>();
  traj.forEach((turn, i) => {
    if (seen.has(turn)) assert.equal(r.offTranscript[i].warm, true, `re-run at ${i} should be a warm cache hit`);
    else seen.add(turn);
  });
});

test("the report renders a shareable, self-consistent summary", async () => {
  const r = await runBench();
  const text = formatReport(r);
  assert.match(text, /billable saving/);
  assert.match(text, /NOT billed/);
  // attribution lines never double-count: preserve + shape are 0 until their mechanisms are wired.
  assert.equal(r.attribution.preserveMicros, 0);
  assert.equal(r.attribution.shapeMicros, 0);
  assert.equal(r.attribution.replayMicros, r.billableSavedMicros);
});
