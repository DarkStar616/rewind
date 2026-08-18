/**
 * Durable, file-backed RewindMemoryStore.
 *
 * The failure memory that makes a re-attempt smarter must survive across processes: the CLI/MCP
 * `backtrack_commit` in one invocation records a failure, and a later invocation re-attempting from the
 * same checkpoint must SEE it. So — exactly like the evidence chain and the savings ledger — the attempt
 * log persists to a JSON file under `.rewind/`, and every read re-reads the file.
 *
 * A faithful on-disk `RewindMemoryStore`, not a second model: same dedup-by-(scope,seq) semantics (first
 * write wins), same scope isolation, atomic temp+rename writes, corrupt-file fails closed. Single-writer
 * / multi-reader, matching durable-savings.ts.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { AttemptRecord, RewindMemoryStore } from "@rewind/core";

interface PersistShape {
  version: 1;
  /** scope -> (seq as string -> record). Nested so isolation + dedup are structural. */
  byScope: Record<string, Record<string, AttemptRecord>>;
}

export interface FileRewindMemoryOptions {
  /** Absolute path to the JSON file the attempt log persists to (created on first record). */
  path: string;
}

export function createFileRewindMemory(opts: FileRewindMemoryOptions): RewindMemoryStore {
  const path = opts.path;

  function load(): PersistShape {
    if (!existsSync(path)) return { version: 1, byScope: {} };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistShape;
      return { version: 1, byScope: parsed?.byScope ?? {} };
    } catch (err) {
      throw new Error(
        `rewind: the rewind-memory store at ${path} is corrupt and cannot be parsed (${(err as Error).message}); ` +
          `refusing to overwrite an unreadable attempt log`,
      );
    }
  }

  function flush(shape: PersistShape): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(shape));
    renameSync(tmp, path);
  }

  function ordered(scope: string): AttemptRecord[] {
    const shape = load();
    const m = shape.byScope[scope];
    if (!m) return [];
    return Object.values(m).sort((a, b) => a.seq - b.seq);
  }

  return {
    record(a: AttemptRecord): void {
      const shape = load();
      const scopeMap = shape.byScope[a.scope] ?? (shape.byScope[a.scope] = {});
      const key = String(a.seq);
      if (scopeMap[key]) return; // first write wins
      scopeMap[key] = { ...a };
      flush(shape);
    },
    all(scope: string): readonly AttemptRecord[] {
      return ordered(scope);
    },
    since(scope: string, checkpointId: string): readonly AttemptRecord[] {
      return ordered(scope).filter((r) => r.checkpointId === checkpointId);
    },
  };
}
