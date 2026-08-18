import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitBackend, RestoreFailedError, RevertIndeterminateError } from "../src/index.ts";

/**
 * A rewind's whole promise is atomicity: restoring to a checkpoint either fully succeeds or leaves the
 * work tree exactly as it was. The original restore() did `read-tree -u --reset` then `clean -fd` and,
 * on a mid-flight failure, threw RevertIndeterminateError with the tree half-applied — the worst
 * outcome for a reversibility tool. These tests pin the capture-then-rollback behaviour.
 */

// root bypasses the permission bits this test uses as its failure trigger, so under uid 0 the forward
// read-tree would SUCCEED and there would be nothing to roll back — skip rather than emit a false RED.
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

test(
  "a restore that fails mid-flight rolls the work tree BACK, not half-applied",
  { skip: IS_ROOT ? "permission-bit trigger is a no-op under root" : false },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "rewind-atomic-"));
    try {
      await writeFile(join(dir, "a.txt"), "v1");
      const be = createGitBackend({ cwd: dir, log: () => {} });
      const snap = await be.snapshot("v1");
      await writeFile(join(dir, "a.txt"), "v2-current"); // the state we must preserve if restore fails

      // Trigger: make the work-tree ROOT read-only (0555). The snapshot repo lives under the still-writable
      // `<dir>/.rewind/snapshots.git`, so the pre-restore CAPTURE (`add -A` + `write-tree`, both writing only
      // the index) still succeeds — but the forward `read-tree -u --reset` cannot unlink/replace a.txt in a
      // read-only directory and exits non-zero. The rollback `read-tree` targets the state already on disk,
      // so it needs no work-tree write and succeeds. Verified end-to-end against real git before writing.
      await chmod(dir, 0o555);

      let threw: unknown;
      try {
        await be.restore(snap.id);
      } catch (e) {
        threw = e;
      } finally {
        await chmod(dir, 0o755).catch(() => {}); // re-open so the assertions below can read the tree
      }

      // A recoverable failure surfaces as RestoreFailedError (tree back to pre-restore), NOT indeterminate.
      assert.ok(
        threw instanceof RestoreFailedError,
        `expected RestoreFailedError, got ${threw instanceof Error ? threw.name : String(threw)}`,
      );
      assert.ok(!(threw instanceof RevertIndeterminateError), "a rolled-back failure is never indeterminate");
      assert.equal(
        await readFile(join(dir, "a.txt"), "utf8"),
        "v2-current",
        "the work tree must be rolled back to its pre-restore state, not half-applied",
      );
    } finally {
      await chmod(dir, 0o755).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test("a normal restore still succeeds and fully reverts the tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-atomic-ok-"));
  try {
    await writeFile(join(dir, "a.txt"), "original");
    const be = createGitBackend({ cwd: dir, log: () => {} });
    const snap = await be.snapshot("before");
    await writeFile(join(dir, "a.txt"), "mutated");
    await writeFile(join(dir, "new.txt"), "created after the snapshot");

    const res = await be.restore(snap.id);
    assert.equal(res.restoredTo, snap.id);
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "original", "tracked file reverted");
    assert.equal(
      await readFile(join(dir, "new.txt"), "utf8").then(() => "exists").catch(() => "gone"),
      "gone",
      "a file created after the snapshot is removed by the restore",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
