import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm, stat, lstat, mkdir, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createGitBackend } from "../src/world/git-backend.ts";

/** Run `body` in a throwaway workspace dir, always cleaning it up. */
async function inTempDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rewind-"));
  try {
    await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Whether this filesystem supports reflink copy-on-write (probes the same way the backend does). */
function reflinkAvailable(dir: string): boolean {
  try {
    execFileSync("sh", ["-c", 'printf x > "$1/.rl-src" && cp --reflink=always "$1/.rl-src" "$1/.rl-dst"; rc=$?; rm -f "$1/.rl-src" "$1/.rl-dst"; exit $rc', "sh", dir]);
    return true;
  } catch {
    return false;
  }
}

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

// ---------------------------------------------------------------------------
// Adversarial hardening — git backend edge cases (nested dirs, binary, symlinks,
// exotic filenames, permission bits, concurrency, empty/no-change snapshots,
// garbage refs, .gitignore, self-exclusion, reflink fallback).
// ---------------------------------------------------------------------------

// REGRESSION for a real bug: diff() used a newline-delimited, DEFAULT-quoted parse, so any path with
// a non-ASCII byte came back octal-escaped and double-quoted (`café.txt` -> `"caf\303\251.txt"`) and
// a path with a newline would be split in half. The fix drives diff with `-z` + core.quotePath=false
// so paths are raw bytes. This guards it.
test("diff returns exotic filenames (unicode, spaces, newline) as raw paths", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "a.txt"), "one");
    const be = createGitBackend({ cwd: dir });
    const s1 = await be.snapshot("first");
    await writeFile(join(dir, "café.txt"), "u"); // non-ASCII
    await writeFile(join(dir, "my file.txt"), "s"); // space
    await writeFile(join(dir, "wei\nrd.txt"), "n"); // literal newline in the name
    const s2 = await be.snapshot("second");

    const changed = new Set((await be.diff(s1, s2)).map((c) => c.path));
    assert.ok(changed.has("café.txt"), `expected raw 'café.txt', got ${JSON.stringify([...changed])}`);
    assert.ok(changed.has("my file.txt"), "space filename must survive verbatim");
    assert.ok(changed.has("wei\nrd.txt"), "newline filename must not be split");
    // and the mangled quoted form must NOT appear
    for (const p of changed) assert.ok(!p.startsWith('"'), `path should not be git-quoted: ${JSON.stringify(p)}`);
  });
});

// REGRESSION for a real bug: concurrent snapshot() calls raced on the shared index + the single
// `refs/heads/main` tip. Last update-ref won, orphaning the others off the chain, so log() (which
// walks from the tip) silently lost them — breaking the documented append-only guarantee. The fix
// serialises mutating ops through an in-process queue. This guards it.
test("concurrent snapshots all land on the append-only chain", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "a.txt"), "one");
    const be = createGitBackend({ cwd: dir });
    const N = 6;
    const refs = await Promise.all(Array.from({ length: N }, (_, i) => be.snapshot(`c${i}`)));

    const entries = await be.log();
    assert.equal(entries.length, N, "every concurrent snapshot must be reachable from the tip");
    // ids must be unique (no two snapshots collapsed onto the same commit)
    assert.equal(new Set(refs.map((r) => r.id)).size, N, "snapshot ids must be distinct");
    // and every one of them must still be individually restorable
    for (const r of refs) assert.deepEqual(await be.restore(r.id), { restoredTo: r.id });
  });
});

test("nested directories and binary files round-trip through restore byte-exact", async () => {
  await inTempDir(async (dir) => {
    await mkdir(join(dir, "a/b/c"), { recursive: true });
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 127, 128]);
    await writeFile(join(dir, "a/b/c/deep.bin"), bytes);
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();
    execFileSync("bash", ["-c", "rm -rf a"], { cwd: dir });
    await be.restore(snap);
    assert.ok(Buffer.compare(await readFile(join(dir, "a/b/c/deep.bin")), bytes) === 0, "binary bytes must be identical");
  });
});

test("a symlink replaced by a regular file is restored as a symlink", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "target.txt"), "target");
    await symlink("target.txt", join(dir, "link.txt"));
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();
    execFileSync("bash", ["-c", "rm link.txt && echo notalink > link.txt"], { cwd: dir });
    assert.equal((await lstat(join(dir, "link.txt"))).isSymbolicLink(), false, "precondition: now a regular file");
    await be.restore(snap);
    const ls = await lstat(join(dir, "link.txt"));
    assert.ok(ls.isSymbolicLink(), "restore must return link.txt to a symlink, not a regular file");
    assert.equal(await readFile(join(dir, "link.txt"), "utf8"), "target", "the symlink must resolve to its original target");
  });
});

test("the executable bit is restored in both directions", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "exec.sh"), "#!/bin/sh\n");
    await writeFile(join(dir, "plain.txt"), "data");
    await chmod(join(dir, "exec.sh"), 0o755);
    await chmod(join(dir, "plain.txt"), 0o644);
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();
    // flip both: clear exec on the script, set exec on the plain file
    await chmod(join(dir, "exec.sh"), 0o644);
    await chmod(join(dir, "plain.txt"), 0o755);
    await be.restore(snap);
    assert.notEqual((await stat(join(dir, "exec.sh"))).mode & 0o100, 0, "exec.sh must be executable again");
    assert.equal((await stat(join(dir, "plain.txt"))).mode & 0o100, 0, "plain.txt must be non-executable again");
  });
});

// DOCUMENTED LIMITATION (pinned): git records only the exec bit, not arbitrary permission bits — a
// non-exec file is stored as mode 100644 whatever its real permissions were. On restore the mode is
// therefore NOT the snapshot's original: git either rewrites the file to its checkout default
// (0666 & ~umask) or, when its racy-timestamp heuristic judges the working copy already current,
// leaves whatever mode the tree currently carries. Both outcomes occur run-to-run; NEITHER recovers
// the snapshot's mode. So a file snapshotted read-only (0400) is writable again after a rewind — its
// original permissions are silently lost. A stronger tier must preserve this; pinning keeps the
// claim honest and flags any silent behaviour change. Asserted umask-independently: every practical
// umask leaves the owner-write bit set in git's default, and the "leave as-is" branch keeps the 0600
// the test set — so owner-write is present either way, and the read-only 0400 is provably not back.
test("non-exec permission bits are NOT recovered on restore (documented Tier-0 limitation)", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "private.txt"), "secret");
    await chmod(join(dir, "private.txt"), 0o400); // snapshotted read-only
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();
    await chmod(join(dir, "private.txt"), 0o600); // add owner-write after the snapshot (content unchanged)
    await be.restore(snap);
    const restored = (await stat(join(dir, "private.txt"))).mode & 0o777;
    assert.notEqual(restored, 0o400, "restore must not be claimed to recover the original 0400 — it does not");
    assert.notEqual(restored & 0o200, 0, "the read-only mode is gone: owner-write is present after restore");
  });
});

test("empty workspace: snapshot succeeds and restore removes everything added after it", async () => {
  await inTempDir(async (dir) => {
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot("empty");
    await writeFile(join(dir, "new.txt"), "added");
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub/also.txt"), "added");
    await be.restore(snap);
    await assert.rejects(stat(join(dir, "new.txt")), "files added after an empty snapshot must be removed");
    await assert.rejects(stat(join(dir, "sub/also.txt")), "nested additions must be removed too");
  });
});

test("two snapshots with no changes between them are both recorded in the log", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "a.txt"), "same");
    const be = createGitBackend({ cwd: dir });
    const s1 = await be.snapshot("first");
    const s2 = await be.snapshot("second"); // no file changes at all
    assert.notEqual(s1.id, s2.id, "a no-op snapshot must still mint a distinct handle");
    const entries = await be.log();
    assert.equal(entries.length, 2, "a no-change snapshot must still be recorded");
    assert.equal(entries[0].id, s2.id);
    // diffing two identical snapshots yields no changes
    assert.deepEqual(await be.diff(s1, s2), []);
  });
});

test("a file deleted then re-created with the same name is restored to its original content", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "x.txt"), "ORIGINAL");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();
    execFileSync("bash", ["-c", "rm x.txt && echo IMPOSTER > x.txt"], { cwd: dir });
    assert.equal(await readFile(join(dir, "x.txt"), "utf8"), "IMPOSTER\n");
    await be.restore(snap);
    assert.equal(await readFile(join(dir, "x.txt"), "utf8"), "ORIGINAL", "restore must recover the original bytes, not keep the impostor");
  });
});

test("a file replaced by a directory of the same name is restored back to the file", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "x"), "was-a-file");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();
    execFileSync("bash", ["-c", "rm x && mkdir x && echo inner > x/inner.txt"], { cwd: dir });
    await be.restore(snap);
    const ls = await lstat(join(dir, "x"));
    assert.ok(ls.isFile(), "x must be a regular file again, not a directory");
    assert.equal(await readFile(join(dir, "x"), "utf8"), "was-a-file");
  });
});

test("garbage (non-hex) refs are refused by restore and diff without mutating the tree", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "a.txt"), "v1");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();
    execFileSync("bash", ["-c", "echo v2 > a.txt"], { cwd: dir });
    for (const bad of ["", "HEAD", "not-a-ref", "../../etc/passwd", "abc; rm -rf /", "main", "z".repeat(40)]) {
      await assert.rejects(be.restore(bad), `restore must refuse ${JSON.stringify(bad)}`);
      await assert.rejects(be.diff(bad, snap.id), `diff must refuse ${JSON.stringify(bad)}`);
    }
    // the working edit survived every refusal
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "v2\n");
  });
});

test("restore accepts a WorldRef object as well as a bare id string", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, "a.txt"), "v1");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();
    execFileSync("bash", ["-c", "echo v2 > a.txt"], { cwd: dir });
    await be.restore(snap); // pass the WorldRef object, not snap.id
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "v1");
  });
});

// DOCUMENTED LIMITATION (pinned): the backend honours the WORKSPACE's own .gitignore (only the
// GLOBAL excludesFile is neutralised). So edits to a file the user's .gitignore ignores are NOT
// captured and NOT reverted by a rewind — a silent reversibility gap. Left intentionally un-fixed:
// force-adding ignored paths would sweep secrets (.env) and large artifacts into every snapshot and
// would also un-exclude node_modules. Pinned so the behaviour is explicit and any change is loud.
test("workspace .gitignore silently excludes files from reversibility (documented limitation)", async () => {
  await inTempDir(async (dir) => {
    await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
    await writeFile(join(dir, "ignored.txt"), "v1-ignored");
    await writeFile(join(dir, "tracked.txt"), "v1-tracked");
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();
    execFileSync("bash", ["-c", "echo v2 > ignored.txt && echo v2 > tracked.txt"], { cwd: dir });
    await be.restore(snap);
    // tracked file reverts; ignored file does NOT (this is the limitation being pinned)
    assert.equal(await readFile(join(dir, "tracked.txt"), "utf8"), "v1-tracked");
    assert.equal(await readFile(join(dir, "ignored.txt"), "utf8"), "v2\n", "ignored files are not reverted — documented gap");
  });
});

// INVARIANT: the snapshot repo (and rewind's whole `.rewind/` control dir) must never enter its own
// snapshots, or a restore would roll the evidence chain back with the tree. diff() between snapshots
// must therefore never surface a `.rewind/` or `.git/` path.
test("the snapshot repo (.rewind/) and workspace .git never appear in a diff", async () => {
  await inTempDir(async (dir) => {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir }); // give the workspace its own .git
    await writeFile(join(dir, "a.txt"), "one");
    const be = createGitBackend({ cwd: dir });
    const s1 = await be.snapshot("first");
    await writeFile(join(dir, "b.txt"), "two");
    const s2 = await be.snapshot("second");
    const paths = (await be.diff(s1, s2)).map((c) => c.path);
    assert.deepEqual(paths, ["b.txt"], `only the real edit should show, got ${JSON.stringify(paths)}`);
    for (const p of paths) {
      assert.ok(!p.startsWith(".rewind/"), "the snapshot repo must not enter its own tree");
      assert.ok(!p.startsWith(".git/") && p !== ".git", "the workspace .git must never be snapshotted");
    }
  });
});

// The reflink/CoW advisory is best-effort and fire-and-forget; it must route to the injected `log`
// sink (never console) and must not affect correctness. On a non-CoW fs it fires; on a CoW fs it
// stays silent. Branch on the actual filesystem so this is a real guard on ext4/CI, not a no-op.
test("reflink fallback advisory routes to the injected log sink", async () => {
  await inTempDir(async (dir) => {
    const messages: string[] = [];
    const be = createGitBackend({ cwd: dir, log: (m) => messages.push(m) });
    await be.snapshot(); // triggers ensureInit -> reflink probe (fire-and-forget)
    // wait (bounded) for the async cp probe to resolve
    const deadline = Date.now() + 3000;
    const wantsNotice = !reflinkAvailable(dir);
    while (wantsNotice && messages.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const cow = messages.filter((m) => m.includes("copy-on-write"));
    if (wantsNotice) {
      assert.equal(cow.length, 1, "on a non-CoW filesystem the advisory must be emitted via the sink");
    } else {
      assert.equal(cow.length, 0, "on a CoW filesystem no fallback advisory should be emitted");
    }
  });
});

test("a large (multi-MB) file round-trips through snapshot and restore exactly", async () => {
  await inTempDir(async (dir) => {
    const big = Buffer.alloc(6 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff; // deterministic, incompressible-ish
    await writeFile(join(dir, "big.bin"), big);
    const be = createGitBackend({ cwd: dir });
    const snap = await be.snapshot();
    execFileSync("bash", ["-c", "rm big.bin"], { cwd: dir });
    await be.restore(snap);
    assert.ok(Buffer.compare(await readFile(join(dir, "big.bin")), big) === 0, "large file must be restored byte-for-byte");
  });
});
