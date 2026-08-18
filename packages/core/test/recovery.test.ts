import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createMemoryRewindStore,
  backtrackCandidates,
  memoryForCheckpoint,
  recommendedCheckpoint,
  shouldCheckpoint,
  type AttemptRecord,
} from "../src/recovery/recovery.ts";
import type { WorldRef } from "../src/world/world-backend.ts";

/**
 * The rewind-memory store is the substrate of the accuracy gain: it records what was attempted from
 * each checkpoint so a re-attempt sees prior failures. Pure, scope-isolated, dedup-by-seq.
 */

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    seq: 0,
    scope: "s",
    checkpointId: "cp0",
    goal: "do the thing",
    outcome: "failure",
    note: "it broke",
    at: 1000,
    ...over,
  };
}

test("record → all returns attempts in seq order", () => {
  const m = createMemoryRewindStore();
  m.record(attempt({ seq: 2, note: "b" }));
  m.record(attempt({ seq: 1, note: "a" }));
  assert.deepEqual(
    m.all("s").map((a) => a.note),
    ["a", "b"],
  );
});

test("scope isolation: one scope's attempts are invisible to another", () => {
  const m = createMemoryRewindStore();
  m.record(attempt({ scope: "a", seq: 1 }));
  m.record(attempt({ scope: "b", seq: 1 }));
  assert.equal(m.all("a").length, 1);
  assert.equal(m.all("b").length, 1);
  assert.equal(m.all("c").length, 0);
});

test("dedup by (scope, seq): re-recording the same seq is idempotent (first write wins)", () => {
  const m = createMemoryRewindStore();
  m.record(attempt({ seq: 1, note: "first" }));
  m.record(attempt({ seq: 1, note: "second" }));
  assert.equal(m.all("s").length, 1);
  assert.equal(m.all("s")[0].note, "first");
});

test("since(checkpoint) returns only the attempts tied to that checkpoint", () => {
  const m = createMemoryRewindStore();
  m.record(attempt({ seq: 1, checkpointId: "cpA", note: "a1" }));
  m.record(attempt({ seq: 2, checkpointId: "cpB", note: "b1" }));
  m.record(attempt({ seq: 3, checkpointId: "cpA", note: "a2" }));
  assert.deepEqual(
    m.since("s", "cpA").map((a) => a.note),
    ["a1", "a2"],
  );
  assert.deepEqual(
    m.since("s", "cpB").map((a) => a.note),
    ["b1"],
  );
});

test("record copies the input (later mutation of the argument does not corrupt the store)", () => {
  const m = createMemoryRewindStore();
  const a = attempt({ seq: 1, note: "original" });
  m.record(a);
  a.note = "mutated";
  assert.equal(m.all("s")[0].note, "original");
});

// --- Tasks 2 & 3: candidates, selection, sparsity ---

function cp(id: string, ts: number, label = ""): WorldRef {
  return { id, ts, label };
}

test("backtrackCandidates are newest-first with their prior failures attached", () => {
  const m = createMemoryRewindStore();
  m.record(attempt({ seq: 1, checkpointId: "cpA", note: "a failed" }));
  const cands = backtrackCandidates([cp("cpA", 100), cp("cpB", 200)], m, "s");
  assert.deepEqual(
    cands.map((c) => c.checkpointId),
    ["cpB", "cpA"], // newest (ts 200) first
  );
  assert.equal(cands[1].priorFailures.length, 1);
  assert.equal(cands[0].priorFailures.length, 0);
});

test("recommendedCheckpoint is SELECTIVE — the most-recent FAILING checkpoint, not a restart", () => {
  const m = createMemoryRewindStore();
  // cpB (newer) has a failure; cpA (older) is clean. Selective rewind targets cpB, not the oldest.
  m.record(attempt({ seq: 1, checkpointId: "cpB", note: "b failed" }));
  const cands = backtrackCandidates([cp("cpA", 100), cp("cpB", 200), cp("cpC", 300)], m, "s");
  const rec = recommendedCheckpoint(cands);
  assert.equal(rec?.checkpointId, "cpB", "rewind to just before the failing work, not a full restart");
});

test("recommendedCheckpoint with NO failures falls back to the latest checkpoint", () => {
  const m = createMemoryRewindStore();
  const cands = backtrackCandidates([cp("cpA", 100), cp("cpB", 200)], m, "s");
  assert.equal(recommendedCheckpoint(cands)?.checkpointId, "cpB");
});

test("recommendedCheckpoint with no checkpoints is undefined", () => {
  assert.equal(recommendedCheckpoint([]), undefined);
});

test("memoryForCheckpoint returns only the non-success attempts to re-inject", () => {
  const m = createMemoryRewindStore();
  m.record(attempt({ seq: 1, checkpointId: "cpA", outcome: "failure", note: "f1" }));
  m.record(attempt({ seq: 2, checkpointId: "cpA", outcome: "success", note: "worked" }));
  m.record(attempt({ seq: 3, checkpointId: "cpA", outcome: "abandoned", note: "f2" }));
  assert.deepEqual(
    memoryForCheckpoint(m, "s", "cpA").map((a) => a.note),
    ["f1", "f2"],
  );
});

test("shouldCheckpoint gates on observed change only", () => {
  assert.equal(shouldCheckpoint({ changedPaths: 0, effectFired: false }), false);
  assert.equal(shouldCheckpoint({ changedPaths: 3, effectFired: false }), true);
  assert.equal(shouldCheckpoint({ changedPaths: 0, effectFired: true }), true);
});
