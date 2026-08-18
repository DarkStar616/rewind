/**
 * WorldBackend — the swappable snapshot/restore surface underneath the engine.
 *
 * Tier 0 (the only MVP implementation) is `createGitBackend`: whole-workspace
 * git snapshots in a SIDE git dir. Higher tiers (copy-on-write worktrees, a
 * hosted sandbox, an OS jail) implement the same interface later without a rewrite.
 *
 * IMPORTANT: this is REVERSIBILITY, not isolation or security. A git snapshot
 * lets an agent rewind the workspace; it does not sandbox the agent. Do not
 * market a git backend as a security boundary.
 */

/** A durable handle to one snapshot of the world. `id` is the opaque restore key. */
export interface WorldRef {
  id: string;
  label?: string;
  /** Epoch milliseconds the snapshot was taken (commit time for `log()` entries). */
  ts: number;
}

/** Result of restoring the world to a snapshot. */
export interface RestoreResult {
  restoredTo: string;
}

/** One path that differs between two snapshots. Renames are decomposed to D+A. */
export interface Change {
  path: string;
  status: "A" | "M" | "D";
}

export interface WorldBackend {
  /** Capture the current workspace as a snapshot and return its handle. */
  snapshot(label?: string): Promise<WorldRef>;
  /** Return the whole workspace tree to a prior snapshot. */
  restore(ref: WorldRef | string): Promise<RestoreResult>;
  /** The paths that changed between snapshot `a` and snapshot `b`. */
  diff(a: WorldRef | string, b: WorldRef | string): Promise<Change[]>;
  /** All snapshots, newest first. */
  log(): Promise<readonly WorldRef[]>;
}

/** Normalize a `WorldRef | string` argument down to its restore id. */
export function refId(ref: WorldRef | string): string {
  return typeof ref === "string" ? ref : ref.id;
}
