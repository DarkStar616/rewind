/**
 * recovery — the AgentRewind-style accuracy engine: selective rewind + carried-forward failure memory.
 *
 * The measured win (AgentRewind, arXiv 2608.14380: +25.6pp task success) comes from TWO disciplines,
 * not just "undo":
 *   1. **Selective** rewind to the checkpoint just before the work that failed — NOT a full restart
 *      (naive environment-reset restart measured WORSE than simply continuing).
 *   2. **Carry the failure experience forward**: when you re-attempt from a checkpoint, you see what was
 *      already tried there and why it failed, so you don't repeat it. That memory IS the accuracy gain.
 *
 * This module is PURE LOGIC, exactly like the effect barrier and evidence chain: it reads an attempt
 * log and checkpoint metadata, never the filesystem. Timestamps are INJECTED (`at`), never read from a
 * clock here — the durable adapter supplies real time. That keeps recovery decisions deterministic and
 * testable, and lets the same logic run above any WorldBackend tier.
 */
import type { WorldRef } from "../world/world-backend.ts";

export type Outcome = "failure" | "success" | "abandoned";

/**
 * One attempt made from a checkpoint. `note` is the carried-forward lesson — required for a failure or
 * an abandoned (backtracked) branch, since a note-less rewind throws away the very experience that makes
 * the re-attempt smarter.
 */
export interface AttemptRecord {
  seq: number;
  scope: string;
  /** The checkpoint the attempt began from. */
  checkpointId: string;
  /** A short description of what was attempted. */
  goal: string;
  outcome: Outcome;
  /** Why it failed / what was learned — injected into the next attempt from this checkpoint. */
  note: string;
  /** Epoch ms — INJECTED by the caller, never read from a clock in this pure module. */
  at: number;
}

export interface RewindMemoryStore {
  record(a: AttemptRecord): void;
  /** All attempts in a scope, in seq order. */
  all(scope: string): readonly AttemptRecord[];
  /** Attempts tied to a checkpoint (recorded FROM it), in seq order — the memory to re-inject. */
  since(scope: string, checkpointId: string): readonly AttemptRecord[];
}

/**
 * In-memory attempt log. Dedup is by (scope, seq): re-recording the same seq is idempotent (first write
 * wins), so a retried append never double-counts. A durable, file-backed store lands behind the same
 * interface (see @rewind/mcp durable-rewind-memory).
 */
export function createMemoryRewindStore(): RewindMemoryStore {
  // scope -> (seq -> record); nested so scope isolation is structural, not delimiter-dependent.
  const byScope = new Map<string, Map<number, AttemptRecord>>();

  function scoped(scope: string): Map<number, AttemptRecord> {
    let m = byScope.get(scope);
    if (!m) {
      m = new Map<number, AttemptRecord>();
      byScope.set(scope, m);
    }
    return m;
  }

  function ordered(scope: string): AttemptRecord[] {
    const m = byScope.get(scope);
    if (!m) return [];
    return [...m.values()].sort((a, b) => a.seq - b.seq);
  }

  return {
    record(a) {
      const m = scoped(a.scope);
      if (m.has(a.seq)) return; // first write wins
      m.set(a.seq, { ...a });
    },
    all(scope) {
      return ordered(scope);
    },
    since(scope, checkpointId) {
      return ordered(scope).filter((a) => a.checkpointId === checkpointId);
    },
  };
}

/** A checkpoint you could rewind to, annotated with the failures already recorded from it. */
export interface BacktrackCandidate {
  checkpointId: string;
  label: string;
  ts: number;
  /** Failures/abandonments recorded from this checkpoint — the memory a re-attempt would inherit. */
  priorFailures: readonly AttemptRecord[];
}

/**
 * The checkpoints an agent could rewind to, NEWEST FIRST, each annotated with the failure memory tied
 * to it. Newest-first because selective rewind prefers the closest good checkpoint before the failure,
 * not the oldest (which would be a wasteful restart).
 */
export function backtrackCandidates(
  checkpoints: readonly WorldRef[],
  memory: RewindMemoryStore,
  scope: string,
): BacktrackCandidate[] {
  const newestFirst = [...checkpoints].sort((a, b) => b.ts - a.ts);
  return newestFirst.map((cp) => ({
    checkpointId: cp.id,
    label: cp.label ?? "",
    ts: cp.ts,
    priorFailures: memory.since(scope, cp.id).filter((a) => a.outcome !== "success"),
  }));
}

/** The failure memory to inject when re-attempting from a checkpoint (the accuracy mechanism). */
export function memoryForCheckpoint(
  memory: RewindMemoryStore,
  scope: string,
  checkpointId: string,
): readonly AttemptRecord[] {
  return memory.since(scope, checkpointId).filter((a) => a.outcome !== "success");
}

/**
 * SELECTIVE rewind target — the minimal-loss default. Rewind to the NEWEST checkpoint: it undoes only
 * the current failed branch and loses the least recovered progress. If that checkpoint already carries
 * failures, they come back as memory so the re-attempt is smarter; if it is clean, it is a fresh retry.
 *
 * Deliberately NOT "the most-recent checkpoint that ever failed": jumping back past a NEWER clean
 * checkpoint would throw away work already recovered. Escalating further back after repeated failures
 * from the newest point is the CALLER's decision — every candidate carries its `priorFailures` count so
 * the caller can choose to go deeper. `undefined` if there are no checkpoints.
 *
 * (This is still "selective, not restart": a restart is the OLDEST checkpoint — which measured worse
 * than continuing — whereas this is the newest.)
 */
export function recommendedCheckpoint(candidates: readonly BacktrackCandidate[]): BacktrackCandidate | undefined {
  // candidates are newest-first (see backtrackCandidates), so the newest is candidates[0].
  return candidates[0];
}

/**
 * Checkpoint-sparsity gate (Crab: >75% of turns need no checkpoint). Only checkpoint when a turn
 * actually changed the world — a file changed, or an effect fired. Gating on OBSERVED change (never a
 * guess) keeps the snapshot chain lean without ever missing a materially-different state.
 */
export function shouldCheckpoint(signal: { changedPaths: number; effectFired: boolean }): boolean {
  return signal.changedPaths > 0 || signal.effectFired;
}

export type { WorldRef };
