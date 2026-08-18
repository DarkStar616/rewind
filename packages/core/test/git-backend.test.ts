import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createGitBackend } from "../src/world/git-backend.ts";

test("snapshot → shell edit → restore returns the tree to the snapshot", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-"));
  try {
    await writeFile(join(dir, "a.txt"), "original");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot("before");
    execFileSync("bash", ["-c", "echo mutated > a.txt"], { cwd: dir }); // change via bash
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "mutated\n");
    await be.restore(snap);
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "original");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restore removes files added after the snapshot and restores deleted ones", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-"));
  try {
    await writeFile(join(dir, "keep.txt"), "keep");
    await writeFile(join(dir, "gone.txt"), "will be deleted then restored");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();
    // add a brand-new file and delete a snapshotted one, both via shell
    execFileSync("bash", ["-c", "echo added > added.txt && rm gone.txt"], { cwd: dir });
    await be.restore(snap);
    // added.txt must be gone; gone.txt must be back with its original bytes
    await assert.rejects(stat(join(dir, "added.txt")), "file added after the snapshot must be removed");
    assert.equal(await readFile(join(dir, "gone.txt"), "utf8"), "will be deleted then restored");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the workspace's own .git is left untouched by snapshot/restore", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-"));
  try {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    await writeFile(join(dir, ".git", "USER_MARKER"), "user");
    await writeFile(join(dir, "a.txt"), "v1");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();
    execFileSync("bash", ["-c", "echo v2 > a.txt"], { cwd: dir });
    await be.restore(snap);
    // the side git dir must not have clobbered the workspace's own repo
    assert.equal(await readFile(join(dir, ".git", "USER_MARKER"), "utf8"), "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("log lists snapshots newest-first and diff reports A/M/D between them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-"));
  try {
    await writeFile(join(dir, "a.txt"), "one");
    const be = createGitBackend({ cwd: dir });
    const s1 = await be.snapshot("first");
    execFileSync("bash", ["-c", "echo two > a.txt && echo b > b.txt"], { cwd: dir });
    const s2 = await be.snapshot("second");

    const entries = await be.log();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].id, s2.id, "log is newest-first");
    assert.equal(entries[1].id, s1.id);
    assert.equal(entries[0].label, "second");

    const changes = await be.diff(s1, s2);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c.status]));
    assert.equal(byPath["a.txt"], "M");
    assert.equal(byPath["b.txt"], "A");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restore rejects an unknown ref without mutating the tree", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-"));
  try {
    await writeFile(join(dir, "a.txt"), "original");
    const be = createGitBackend({ cwd: dir });
    await be.snapshot();
    execFileSync("bash", ["-c", "echo edited > a.txt"], { cwd: dir });
    await assert.rejects(be.restore("0000000000000000000000000000000000000000"));
    // the edit is still there — a rejected restore must not have partially reverted
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "edited\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
