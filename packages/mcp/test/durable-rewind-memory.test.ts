import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AttemptRecord } from "@rewind/core";
import { createFileRewindMemory } from "../src/durable-rewind-memory.ts";

/**
 * The durable attempt log bridges the process that records a failure to a later process that
 * re-attempts from the same checkpoint — so it must persist, dedup, and isolate scopes across
 * instances, exactly like the savings ledger.
 */

async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rewind-mem-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return { seq: 0, scope: "s", checkpointId: "cp0", goal: "g", outcome: "failure", note: "n", at: 1, ...over };
}

test("a failure recorded by one instance is readable by a fresh instance (cross-process)", async () => {
  await withTemp(async (dir) => {
    const path = join(dir, ".rewind", "rewind-memory.json");
    createFileRewindMemory({ path }).record(attempt({ seq: 1, note: "boom" }));
    const reader = createFileRewindMemory({ path });
    assert.equal(reader.all("s").length, 1);
    assert.equal(reader.all("s")[0].note, "boom");
    assert.equal(reader.since("s", "cp0").length, 1);
  });
});

test("dedup by (scope, seq) across instances", async () => {
  await withTemp(async (dir) => {
    const path = join(dir, "mem.json");
    createFileRewindMemory({ path }).record(attempt({ seq: 1, note: "first" }));
    createFileRewindMemory({ path }).record(attempt({ seq: 1, note: "second" }));
    const all = createFileRewindMemory({ path }).all("s");
    assert.equal(all.length, 1);
    assert.equal(all[0].note, "first");
  });
});

test("scope isolation and seq ordering persist", async () => {
  await withTemp(async (dir) => {
    const path = join(dir, "mem.json");
    const sink = createFileRewindMemory({ path });
    sink.record(attempt({ scope: "a", seq: 2, note: "a2" }));
    sink.record(attempt({ scope: "a", seq: 1, note: "a1" }));
    sink.record(attempt({ scope: "b", seq: 1, note: "b1" }));
    assert.deepEqual(sink.all("a").map((r) => r.note), ["a1", "a2"]);
    assert.deepEqual(sink.all("b").map((r) => r.note), ["b1"]);
  });
});

test("a fresh workspace reports empty", async () => {
  await withTemp(async (dir) => {
    assert.equal(createFileRewindMemory({ path: join(dir, "nope", "mem.json") }).all("s").length, 0);
  });
});

test("a corrupt file is rejected, never silently dropped", async () => {
  await withTemp(async (dir) => {
    const path = join(dir, "mem.json");
    await writeFile(path, "{ broken");
    assert.throws(() => createFileRewindMemory({ path }).all("s"), /corrupt/);
  });
});

test("a record with a non-numeric seq is dropped on load (cannot poison seq allocation into NaN)", async () => {
  await withTemp(async (dir) => {
    const path = join(dir, "mem.json");
    // A structurally-parseable file with one BAD record (seq: "oops") and one good one.
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        byScope: {
          s: {
            oops: { seq: "oops", scope: "s", checkpointId: "cp", goal: "g", outcome: "failure", note: "bad", at: 1 },
            "0": { seq: 0, scope: "s", checkpointId: "cp", goal: "g", outcome: "failure", note: "good", at: 1 },
          },
        },
      }),
    );
    const store = createFileRewindMemory({ path });
    const all = store.all("s");
    assert.equal(all.length, 1, "the malformed record is dropped");
    assert.equal(all[0].note, "good");
    // A subsequent append allocates a finite seq (not NaN) and persists.
    store.record({ seq: 1, scope: "s", checkpointId: "cp", goal: "g", outcome: "failure", note: "new", at: 2 });
    assert.deepEqual(createFileRewindMemory({ path }).all("s").map((r) => r.note), ["good", "new"]);
  });
});
