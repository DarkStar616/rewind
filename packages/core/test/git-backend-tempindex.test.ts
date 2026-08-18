import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createGitBackend } from "../src/index.ts";

/**
 * snapshot() must build its tree in a per-call throwaway index (GIT_INDEX_FILE), never the shared
 * `<gitDir>/index` that restore() and A1's pre-restore capture also touch. Proof: after snapshots-only,
 * the shared index does NOT exist (nothing wrote it), no temp-index files leak, and the append-only
 * chain still holds every snapshot. The OLD shared-index implementation fails the first assertion —
 * its `git add -A` writes `<gitDir>/index`.
 */
test("snapshot builds its tree in a temp index — no shared index, no leaked temp files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-tmpidx-"));
  try {
    await writeFile(join(dir, "a.txt"), "x".repeat(1000));
    const be = createGitBackend({ cwd: dir, log: () => {} });
    const s1 = await be.snapshot("one");
    await writeFile(join(dir, "b.txt"), "y");
    const s2 = await be.snapshot("two");
    assert.notEqual(s1.id, s2.id);

    const gitDir = join(dir, ".rewind", "snapshots.git");
    // The shared index must never be written by a snapshot — it belongs to restore()/capture alone.
    assert.ok(!existsSync(join(gitDir, "index")), "snapshot must not create the shared git index");
    // No temp-index files left behind (the finally cleans them up).
    const leftover = (await readdir(gitDir)).filter((f) => f.startsWith("tmp-index-"));
    assert.deepEqual(leftover, [], `temp index files must be cleaned up, found: ${leftover.join(", ")}`);

    // The append-only chain is intact: both snapshots are in the log.
    const log = await be.log();
    assert.ok(log.some((r) => r.id === s1.id) && log.some((r) => r.id === s2.id), "both snapshots survive in the log");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two backend instances on the same git dir serialize — concurrent snapshots both survive the chain", async () => {
  // Regression for the cross-instance race: since snapshot() stages into its own temp index (no shared
  // index.lock), two instances on one git dir must serialise through the process-global queue, or the
  // second's update-ref orphans the first's commit off the append-only chain.
  const dir = await mkdtemp(join(tmpdir(), "rewind-xinst-"));
  try {
    await writeFile(join(dir, "a.txt"), "seed");
    const be1 = createGitBackend({ cwd: dir, log: () => {} });
    // be2 names the SAME repo via a different path spelling (a `..` segment). Normalisation must map it
    // to the same queue key as be1's default gitDir, or the two would race despite the global queue.
    const be2 = createGitBackend({ cwd: dir, gitDir: join(dir, "x", "..", ".rewind", "snapshots.git"), log: () => {} });
    // Fire both snapshots concurrently against the SAME git dir (spelled two ways).
    const [s1, s2] = await Promise.all([be1.snapshot("from-1"), be2.snapshot("from-2")]);
    assert.notEqual(s1.id, s2.id, "the two snapshots are distinct commits");
    const log = await be1.log();
    assert.ok(log.some((r) => r.id === s1.id), "the first snapshot survives in the append-only log");
    assert.ok(log.some((r) => r.id === s2.id), "the second snapshot survives in the append-only log");
    assert.ok(log.length >= 2, "both commits are reachable from the tip — neither was orphaned");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a snapshot taken after a restore's capture still does not disturb the shared index it leaves", async () => {
  // restore() legitimately writes the shared index (its capture + read-tree). A later snapshot must
  // build in its own temp index and leave that shared index exactly as restore left it.
  const dir = await mkdtemp(join(tmpdir(), "rewind-tmpidx2-"));
  try {
    await writeFile(join(dir, "a.txt"), "v1");
    const be = createGitBackend({ cwd: dir, log: () => {} });
    const snap = await be.snapshot("v1");
    await writeFile(join(dir, "a.txt"), "v2");
    await be.restore(snap.id); // this DOES write the shared index
    const gitDir = join(dir, ".rewind", "snapshots.git");
    const hadIndex = existsSync(join(gitDir, "index"));
    const s2 = await be.snapshot("v1-again");
    // The snapshot did not delete or require the shared index; whatever restore left is still there.
    assert.equal(existsSync(join(gitDir, "index")), hadIndex, "snapshot must not disturb restore's shared index");
    const leftover = (await readdir(gitDir)).filter((f) => f.startsWith("tmp-index-"));
    assert.deepEqual(leftover, [], "no temp index leak");
    assert.ok((await be.log()).some((r) => r.id === s2.id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
