import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitBackend } from "../src/world/git-backend.ts";

/**
 * BP1 — the "excluded" class of the three-class model (tracked · excluded · volatile). Secrets and
 * credentials are excluded from snapshots by default, so a rewind can NEVER silently revert a
 * developer's live `.env`, rotated key, or credential to a stale checkpoint value. Reverting secrets
 * would be data loss, not reversibility. Template files carry no secrets and stay tracked.
 */

async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rewind-secrets-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a rewind does NOT revert a live .env edited after the checkpoint", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "app.ts"), "v1");
    await writeFile(join(dir, ".env"), "API_KEY=old-secret\n");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot("before");

    // The developer rotates the key AND the agent edits tracked code, then a rewind is triggered.
    await writeFile(join(dir, ".env"), "API_KEY=rotated-new-secret\n");
    await writeFile(join(dir, "app.ts"), "v2");
    await be.restore(snap);

    // Tracked code is reverted; the live secret is UNTOUCHED (keeps the rotated value).
    assert.equal(await readFile(join(dir, "app.ts"), "utf8"), "v1", "tracked code reverts");
    assert.equal(
      await readFile(join(dir, ".env"), "utf8"),
      "API_KEY=rotated-new-secret\n",
      "the live .env must NOT be rolled back to the checkpoint value",
    );
  });
});

test("a .env created after the checkpoint survives a rewind (never deleted as 'untracked')", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "app.ts"), "v1");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();

    // A brand-new secret file appears after the snapshot. A rewind's `clean` must not delete it.
    await writeFile(join(dir, ".env"), "TOKEN=fresh\n");
    await be.restore(snap);

    assert.equal(await readFile(join(dir, ".env"), "utf8"), "TOKEN=fresh\n", ".env must survive the rewind");
  });
});

test("private keys are excluded — a rewind never reverts them", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "id_rsa"), "PRIVATE-KEY-v1");
    await writeFile(join(dir, "server.pem"), "CERT-v1");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();

    await writeFile(join(dir, "id_rsa"), "PRIVATE-KEY-v2");
    await writeFile(join(dir, "server.pem"), "CERT-v2");
    await be.restore(snap);

    assert.equal(await readFile(join(dir, "id_rsa"), "utf8"), "PRIVATE-KEY-v2", "id_rsa not reverted");
    assert.equal(await readFile(join(dir, "server.pem"), "utf8"), "CERT-v2", "*.pem not reverted");
  });
});

test("template files (.env.example) stay TRACKED and revert normally (negation re-includes them)", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, ".env.example"), "API_KEY=\n");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();

    // Delete the template after the snapshot; a rewind must bring it back (it's part of the tree).
    await rm(join(dir, ".env.example"));
    await be.restore(snap);
    assert.equal(await readFile(join(dir, ".env.example"), "utf8"), "API_KEY=\n", ".env.example is tracked");
  });
});

test("snapshotSecrets:true opts IN to tracking .env — then a rewind DOES revert it", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, ".env"), "API_KEY=old\n");
    const be = createGitBackend({ cwd: dir, snapshotSecrets: true });
    const snap = await be.snapshot();

    await writeFile(join(dir, ".env"), "API_KEY=new\n");
    await be.restore(snap);
    assert.equal(await readFile(join(dir, ".env"), "utf8"), "API_KEY=old\n", "opt-in tracks + reverts .env");
  });
});

test("extraExcludes adds custom excluded paths", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "app.ts"), "v1");
    await writeFile(join(dir, "scratch.local"), "keep-v1");
    const be = createGitBackend({ cwd: dir, extraExcludes: ["*.local"] });
    const snap = await be.snapshot();

    await writeFile(join(dir, "scratch.local"), "keep-v2");
    await be.restore(snap);
    assert.equal(await readFile(join(dir, "scratch.local"), "utf8"), "keep-v2", "custom excluded path not reverted");
  });
});

test("a normal tracked file is still snapshotted and reverted (no regression)", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "config.json"), "{\"a\":1}");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();
    await writeFile(join(dir, "config.json"), "{\"a\":2}");
    await be.restore(snap);
    assert.equal(await readFile(join(dir, "config.json"), "utf8"), "{\"a\":1}", "tracked files still revert");
    await assert.rejects(stat(join(dir, ".rewind", "does-not-exist")));
  });
});
