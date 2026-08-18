/**
 * Tier-0 WorldBackend: whole-workspace snapshots via git in a SIDE git dir.
 *
 * Adapted (not copied) from qm-athena's `git-tracked-sandbox.ts`. Differences that
 * matter for a standalone SDK:
 *  - It does NOT depend on the athena `Sandbox` type; it drives git directly with
 *    `node:child_process.execFile` and explicit `--git-dir`/`--work-tree`.
 *  - The snapshot chain is APPEND-ONLY: `snapshot()` advances `refs/heads/main`,
 *    but `restore()` materialises a tree with `read-tree -u --reset` WITHOUT moving
 *    any ref — so `log()` still shows every snapshot after a restore, and you can
 *    restore forward again.
 *  - The git dir defaults to `<cwd>/.rewind/snapshots.git` and is excluded from its
 *    own snapshots, so the workspace's own `.git` (if any) is never touched.
 *
 * This is REVERSIBILITY, not isolation. See world-backend.ts.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { Change, RestoreResult, WorldBackend, WorldRef } from "./world-backend.ts";
import { refId } from "./world-backend.ts";

/** Heavy build/dependency dirs kept out of snapshots (and, being excluded, out of `clean`). */
const HEAVY_DIRS = ["node_modules", ".venv", "venv", "__pycache__", ".cache", ".npm", "dist", "build", ".next"];

/** A snapshot id is a git object name: 7–64 hex chars. Anything else is refused. */
const REF_PATTERN = /^[0-9a-f]{7,64}$/i;

/** Field separator for `log` formatting — a byte that cannot appear in a commit subject. */
const FS = "\x1f";

/**
 * A restore that started mutating the work tree and then failed leaves the tree
 * partially reverted, not clean. We surface that loudly rather than pretend success.
 */
export class RevertIndeterminateError extends Error {
  readonly ref: string;
  readonly detail: string;
  constructor(ref: string, detail: string) {
    super(
      `rewind git-backend: restore to ${ref} left the work tree in an INDETERMINATE state (${detail}); ` +
        `the tree was mutated and is partially restored, not clean`,
    );
    this.name = "RevertIndeterminateError";
    this.ref = ref;
    this.detail = detail;
  }
}

export interface GitBackendOptions {
  /** The workspace whose tree is snapshotted. */
  cwd: string;
  /** Where the snapshot repo lives. Default: `<cwd>/.rewind/snapshots.git`. */
  gitDir?: string;
  /** Sink for advisory messages (e.g. the reflink/CoW fallback notice). Default: console.warn. */
  log?: (message: string) => void;
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: "rewind",
  GIT_AUTHOR_EMAIL: "rewind@localhost",
  GIT_COMMITTER_NAME: "rewind",
  GIT_COMMITTER_EMAIL: "rewind@localhost",
} as const;

export function createGitBackend(opts: GitBackendOptions): WorldBackend {
  const cwd = opts.cwd;
  const gitDir = opts.gitDir ?? join(cwd, ".rewind", "snapshots.git");
  const emit = opts.log ?? ((m: string) => console.warn(m));

  const run = (args: readonly string[]): Promise<GitResult> =>
    new Promise((resolve) => {
      execFile(
        "git",
        // `-c core.excludesFile=/dev/null` neutralises the user's GLOBAL gitignore so it cannot
        // silently drop files from a snapshot; the per-repo info/exclude below is still honoured.
        ["--git-dir", gitDir, "--work-tree", cwd, "-c", "core.excludesFile=/dev/null", ...args],
        { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, ...GIT_IDENTITY } },
        (err, stdout, stderr) => {
          const code = !err ? 0 : typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 1;
          resolve({ code, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "" });
        },
      );
    });

  const excludeContents = (): string => {
    const lines: string[] = [];
    // Exclude the snapshot repo itself so it never enters its own tree.
    if (!isAbsolute(gitDir) || gitDir.startsWith(cwd)) {
      const rel = relative(cwd, gitDir);
      if (rel && !rel.startsWith("..")) lines.push(`${rel}/`);
    }
    lines.push(".git", "**/.git");
    for (const d of HEAVY_DIRS) lines.push(`${d}/`);
    return lines.join("\n") + "\n";
  };

  let initialized = false;
  const ensureInit = async (): Promise<void> => {
    if (initialized) return;
    await mkdir(join(gitDir, "info"), { recursive: true });
    await writeFile(join(gitDir, "info", "exclude"), excludeContents());
    if (!existsSync(join(gitDir, "HEAD"))) {
      const init = await run(["init", "-q", "-b", "main"]);
      if (init.code !== 0) {
        throw new Error(`rewind git-backend: git init failed (exit ${init.code}): ${init.stderr.slice(0, 300)}`);
      }
    }
    initialized = true;
    reflinkNotice();
  };

  // Advisory, best-effort, once per backend. Copy-on-write speed is filesystem-dependent
  // (APFS, btrfs, XFS, ReFS fast; ext4 and friends fall back to a full checkout). The git
  // backend works regardless; this only tells the operator which they're on. GNU-cp probe,
  // so a non-GNU `cp` (e.g. macOS) reports the fallback even on a CoW fs — acceptable for Tier 0.
  let reflinkChecked = false;
  const reflinkNotice = (): void => {
    if (reflinkChecked) return;
    reflinkChecked = true;
    const src = join(gitDir, ".reflink-probe-src");
    const dst = join(gitDir, ".reflink-probe-dst");
    execFile("sh", ["-c", `printf x > "${src}" && cp --reflink=always "${src}" "${dst}"; rc=$?; rm -f "${src}" "${dst}"; exit $rc`], (err) => {
      if (err) {
        emit(
          "rewind: copy-on-write (reflink) not available on this filesystem — snapshots use a full git checkout " +
            "(correct, just not CoW-accelerated). Fast on APFS/btrfs/XFS/ReFS.",
        );
      }
    });
  };

  const validateRef = (id: string): void => {
    if (!REF_PATTERN.test(id)) {
      throw new Error(`rewind git-backend: refusing to operate on unvalidated ref ${JSON.stringify(id)}`);
    }
  };

  return {
    async snapshot(label?: string): Promise<WorldRef> {
      await ensureInit();
      const add = await run(["add", "-A"]);
      if (add.code !== 0) {
        throw new Error(`rewind git-backend: git add failed (exit ${add.code}): ${add.stderr.slice(0, 300)}`);
      }
      const tree = await run(["write-tree"]);
      if (tree.code !== 0) {
        throw new Error(`rewind git-backend: git write-tree failed (exit ${tree.code}): ${tree.stderr.slice(0, 300)}`);
      }
      const treeId = tree.stdout.trim();
      const head = await run(["rev-parse", "-q", "--verify", "HEAD"]);
      const message = label ?? "snapshot";
      const commitArgs =
        head.code === 0 ? ["commit-tree", treeId, "-p", head.stdout.trim(), "-m", message] : ["commit-tree", treeId, "-m", message];
      const commit = await run(commitArgs);
      if (commit.code !== 0) {
        throw new Error(`rewind git-backend: git commit-tree failed (exit ${commit.code}): ${commit.stderr.slice(0, 300)}`);
      }
      const id = commit.stdout.trim();
      const ref = await run(["update-ref", "refs/heads/main", id]);
      if (ref.code !== 0) {
        throw new Error(`rewind git-backend: git update-ref failed (exit ${ref.code}): ${ref.stderr.slice(0, 300)}`);
      }
      return label === undefined ? { id, ts: Date.now() } : { id, label, ts: Date.now() };
    },

    async restore(ref: WorldRef | string): Promise<RestoreResult> {
      const id = refId(ref);
      validateRef(id);
      await ensureInit();
      // Reject an unknown snapshot BEFORE touching the tree, so a bad id cannot leave a partial revert.
      const known = await run(["rev-parse", "-q", "--verify", `${id}^{commit}`]);
      if (known.code !== 0) {
        throw new Error(`rewind git-backend: unknown snapshot ref ${id}`);
      }
      // Reset index + work tree to the snapshot without moving any ref (append-only chain).
      const readTree = await run(["read-tree", "-u", "--reset", id]);
      if (readTree.code !== 0) {
        throw new RevertIndeterminateError(id, `read-tree exited ${readTree.code}: ${readTree.stderr.slice(0, 300)}`);
      }
      // read-tree removes tracked files not in the target; `clean -fd` removes files created
      // since the snapshot (never `-x`, so excluded dirs like node_modules/.git survive).
      const clean = await run(["clean", "-fd"]);
      if (clean.code !== 0) {
        throw new RevertIndeterminateError(id, `post-read-tree clean exited ${clean.code}: ${clean.stderr.slice(0, 300)}`);
      }
      return { restoredTo: id };
    },

    async diff(a: WorldRef | string, b: WorldRef | string): Promise<Change[]> {
      const idA = refId(a);
      const idB = refId(b);
      validateRef(idA);
      validateRef(idB);
      await ensureInit();
      const res = await run(["--no-pager", "diff", "--name-status", "--no-renames", idA, idB]);
      if (res.code !== 0) {
        throw new Error(`rewind git-backend: git diff failed (exit ${res.code}): ${res.stderr.slice(0, 300)}`);
      }
      const changes: Change[] = [];
      for (const line of res.stdout.split("\n")) {
        if (!line.trim()) continue;
        const tab = line.indexOf("\t");
        if (tab < 0) continue;
        const code = line[0];
        const path = line.slice(tab + 1);
        const status: Change["status"] = code === "A" ? "A" : code === "D" ? "D" : "M";
        changes.push({ path, status });
      }
      return changes;
    },

    async log(): Promise<readonly WorldRef[]> {
      await ensureInit();
      const head = await run(["rev-parse", "-q", "--verify", "HEAD"]);
      if (head.code !== 0) return [];
      const res = await run(["--no-pager", "log", `--format=%H${FS}%ct${FS}%s`]);
      if (res.code !== 0) {
        throw new Error(`rewind git-backend: git log failed (exit ${res.code}): ${res.stderr.slice(0, 300)}`);
      }
      const out: WorldRef[] = [];
      for (const line of res.stdout.split("\n")) {
        if (!line.trim()) continue;
        const [id, ct, ...rest] = line.split(FS);
        out.push({ id, label: rest.join(FS), ts: Number(ct) * 1000 });
      }
      return out;
    },
  };
}
