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
import { createKeyedQueue } from "../util/async.ts";

/** Heavy build/dependency dirs kept out of snapshots (and, being excluded, out of `clean`). */
const HEAVY_DIRS = ["node_modules", ".venv", "venv", "__pycache__", ".cache", ".npm", "dist", "build", ".next"];

/**
 * Secret / credential paths kept out of snapshots by DEFAULT (the "excluded" class of the AgentRewind
 * three-class model: tracked · excluded · volatile). Being in `info/exclude`, they are never captured
 * by `git add -A` and never touched by `restore` (which uses `clean -fd`, not `-x`) — so a rewind can
 * NEVER silently revert a developer's live `.env`, rotated key, or credential to a stale checkpoint
 * value. That would be a data-loss defect, not reversibility. Template files (`.env.example` and
 * friends, public keys) are re-included via negation because they carry no secrets and ARE part of the
 * reversible tree. Override with `snapshotSecrets: true` (track them) or extend with `extraExcludes`.
 */
const DEFAULT_SECRET_EXCLUDES = [
  ".env",
  ".env.*",
  "!.env.example",
  "!.env.sample",
  "!.env.template",
  "!.env.dist",
  "*.pem",
  "*.key",
  "!*.pub.key",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "*.p12",
  "*.pfx",
  "*.keystore",
  "*.jks",
  ".ssh/",
  ".aws/credentials",
  ".gnupg/",
  "secrets.json",
  "credentials.json",
];

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

/**
 * A restore that failed mid-flight but was successfully ROLLED BACK: the work tree is exactly as it was
 * before the restore was attempted — safe, not indeterminate. This is the good failure: the caller can
 * retry or investigate without fear of a half-applied tree. `RevertIndeterminateError` is reserved for
 * the strictly worse case where even the rollback failed.
 */
export class RestoreFailedError extends Error {
  readonly ref: string;
  readonly detail: string;
  constructor(ref: string, detail: string) {
    super(
      `rewind git-backend: restore to ${ref} failed (${detail}); the work tree was rolled back to its ` +
        `pre-restore state and is clean`,
    );
    this.name = "RestoreFailedError";
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
  /**
   * Extra gitignore-syntax patterns to exclude from snapshots (the "excluded" class): never captured,
   * never reverted. Appended after the built-in secret + heavy-dir excludes.
   */
  extraExcludes?: readonly string[];
  /**
   * By default, secret/credential files (`.env`, private keys, …) are EXCLUDED so a rewind can never
   * revert a developer's live secrets. Set true to snapshot and revert them like any tracked file —
   * only when you understand that a rewind will then roll them back. Default: false.
   */
  snapshotSecrets?: boolean;
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
        // `-c core.quotePath=false` makes git emit path bytes RAW (UTF-8) instead of octal-escaping
        // and double-quoting any path with non-ASCII/control chars — otherwise `diff()` would hand
        // back a mangled `"caf\303\251.txt"` for `café.txt`, useless to any caller that opens it.
        ["--git-dir", gitDir, "--work-tree", cwd, "-c", "core.excludesFile=/dev/null", "-c", "core.quotePath=false", ...args],
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
    // Rewind's own control directory — the snapshot repo AND any durable adapter state (the CLI's
    // evidence chain, handle store) live under `<cwd>/.rewind/`. It must never enter a snapshot: if
    // it did, a `restore` (read-tree + `clean -fd`) would roll the evidence chain back with the tree,
    // and an effect already spent before the rewind would look unspent again — silently defeating the
    // refuse-across-rewind guarantee. `.rewind/` is rewind's reserved namespace; exclude it wholesale.
    lines.push(".rewind/");
    for (const d of HEAVY_DIRS) lines.push(`${d}/`);
    // Secrets are excluded by default so a rewind never reverts a live `.env`/key (see the constant).
    if (opts.snapshotSecrets !== true) lines.push(...DEFAULT_SECRET_EXCLUDES);
    // Caller-supplied extra excludes come last so they can further narrow or (via `!`) re-include.
    if (opts.extraExcludes) lines.push(...opts.extraExcludes);
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

  // snapshot() and restore() both mutate the shared git index (index.lock) and, for snapshot, the
  // single `refs/heads/main` tip. Run concurrently they RACE: each snapshot reads HEAD, builds a
  // commit, and `update-ref`s the tip — last writer wins, so the others are orphaned off the chain
  // and `log()` (which walks from the tip) silently loses them, breaking the append-only guarantee.
  // A restore's `read-tree`/`clean` racing a snapshot's `add` corrupts the index the same way. We
  // serialise every tree/ref-mutating op through one in-process queue keyed by this backend's git
  // dir; reads (diff/log) don't take index.lock and stay unserialised. Cross-PROCESS concurrency is
  // still git's own index.lock territory — this fixes concurrency within one backend instance.
  const serial = createKeyedQueue<string>();
  const mutate = <T>(fn: () => Promise<T>): Promise<T> => serial(gitDir, fn);

  return {
    // `async` (not a bare promise-returning fn) so any synchronous throw — e.g. validateRef on a
    // malformed ref — surfaces as a REJECTED promise, never a thrown exception the caller's
    // `.catch()`/`assert.rejects` would miss.
    async snapshot(label?: string): Promise<WorldRef> {
      return mutate(async () => {
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
      });
    },

    // `async` so validateRef's synchronous throw on a bad ref becomes a rejection (see snapshot).
    // The ref is validated BEFORE queueing, so a malformed ref is refused immediately and never
    // waits behind — or interferes with — in-flight mutations.
    async restore(ref: WorldRef | string): Promise<RestoreResult> {
      const id = refId(ref);
      validateRef(id);
      return mutate(async () => {
      await ensureInit();
      // Reject an unknown snapshot BEFORE touching the tree, so a bad id cannot leave a partial revert.
      const known = await run(["rev-parse", "-q", "--verify", `${id}^{commit}`]);
      if (known.code !== 0) {
        throw new Error(`rewind git-backend: unknown snapshot ref ${id}`);
      }
      // Capture the CURRENT work tree as a throwaway tree object BEFORE mutating anything, so a restore
      // that fails mid-flight can be rolled back to exactly where it started rather than left half-
      // applied. It writes a tree object only — no ref moves, so the append-only chain is untouched.
      // If even the capture fails we cannot promise rollback, so `rollbackId` stays undefined and any
      // later failure is (correctly) reported as indeterminate.
      const preAdd = await run(["add", "-A"]);
      const preTree = preAdd.code === 0 ? await run(["write-tree"]) : undefined;
      const rollbackId = preTree && preTree.code === 0 ? preTree.stdout.trim() : undefined;

      // Roll the work tree back to the captured pre-restore state, then classify the failure: a clean
      // rollback is a RestoreFailedError (tree is safe); a rollback that itself fails is the strictly
      // worse RevertIndeterminateError (tree may be half-applied).
      const rollbackOrThrow = async (detail: string): Promise<never> => {
        if (rollbackId) {
          const back = await run(["read-tree", "-u", "--reset", rollbackId]);
          if (back.code === 0) {
            await run(["clean", "-fd"]); // best-effort; the tree already matches rollbackId
            throw new RestoreFailedError(id, detail);
          }
        }
        throw new RevertIndeterminateError(id, detail);
      };

      // Reset index + work tree to the snapshot without moving any ref (append-only chain).
      const readTree = await run(["read-tree", "-u", "--reset", id]);
      if (readTree.code !== 0) {
        await rollbackOrThrow(`read-tree exited ${readTree.code}: ${readTree.stderr.slice(0, 300)}`);
      }
      // read-tree removes tracked files not in the target; `clean -fd` removes files created
      // since the snapshot (never `-x`, so excluded dirs like node_modules/.git survive).
      const clean = await run(["clean", "-fd"]);
      if (clean.code !== 0) {
        await rollbackOrThrow(`post-read-tree clean exited ${clean.code}: ${clean.stderr.slice(0, 300)}`);
      }
      return { restoredTo: id };
      });
    },

    async diff(a: WorldRef | string, b: WorldRef | string): Promise<Change[]> {
      const idA = refId(a);
      const idB = refId(b);
      validateRef(idA);
      validateRef(idB);
      await ensureInit();
      // `-z` emits NUL-delimited `<status>\0<path>\0` records with the path bytes VERBATIM. A
      // newline-delimited parse would corrupt any filename containing a newline, and the default
      // (non-`-z`) formatting octal-escapes and double-quotes non-ASCII paths — both mangle real,
      // legitimate filenames. `--no-renames` guarantees exactly one path per record (renames are
      // decomposed to D+A), so records are strict [status, path] pairs.
      const res = await run(["--no-pager", "diff", "--name-status", "--no-renames", "-z", idA, idB]);
      if (res.code !== 0) {
        throw new Error(`rewind git-backend: git diff failed (exit ${res.code}): ${res.stderr.slice(0, 300)}`);
      }
      const tokens = res.stdout.split("\0");
      const changes: Change[] = [];
      // Records come in pairs; a trailing empty token after the final NUL is ignored by the bound.
      for (let i = 0; i + 1 < tokens.length; i += 2) {
        const code = tokens[i];
        const path = tokens[i + 1];
        if (!code || !path) continue;
        const status: Change["status"] = code[0] === "A" ? "A" : code[0] === "D" ? "D" : "M";
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
