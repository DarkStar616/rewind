/**
 * Durable, file-backed ReplaySavings sink.
 *
 * The savings the gateway books must survive the process that booked them: the `rewind gateway` proxy
 * is a long-lived process, and `rewind savings` is a SEPARATE short-lived process that reads the
 * total. An in-memory sink cannot bridge them, so — exactly like the evidence chain in store.ts — the
 * savings persist to a JSON file under `.rewind/`, and every read re-reads the file so a later reader
 * always sees an earlier writer's committed savings.
 *
 * This is a faithful on-disk `ReplaySavingsSink`, not a second accounting model: it keeps core's
 * dedup-by-callId semantics (first write wins, so overlapping rewinds never double-count) and returns
 * the identical `{ tokens, costMicros }` total. Only the storage changes from a Map to a file.
 *
 * Writes are synchronous (the sink's `record` is synchronous by interface) and atomic (temp + rename),
 * so a reader never sees a half-written file. Concurrency model: single-writer (the one gateway
 * process), multi-reader (any number of `rewind savings` invocations). Each `record` re-reads, merges,
 * and atomically replaces, so the writer never loses its own earlier records; concurrent WRITERS are
 * not file-locked (last flush wins) — acceptable because only the gateway writes.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { ReplaySaving, ReplaySavingsSink, ReplaySavingsTotal } from "@rewind/core";

interface PersistShape {
  version: 1;
  /** Keyed by callId so dedup is structural and idempotent across processes. */
  byCallId: Record<string, ReplaySaving>;
}

export interface FileReplaySavingsOptions {
  /** Absolute path to the JSON file savings persist to (created on first record). */
  path: string;
}

export function createFileReplaySavings(opts: FileReplaySavingsOptions): ReplaySavingsSink {
  const path = opts.path;

  function load(): PersistShape {
    if (!existsSync(path)) return { version: 1, byCallId: {} };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistShape;
      return { version: 1, byCallId: parsed?.byCallId ?? {} };
    } catch (err) {
      throw new Error(
        `rewind: the savings store at ${path} is corrupt and cannot be parsed (${(err as Error).message}); ` +
          `refusing to overwrite an unreadable savings ledger`,
      );
    }
  }

  function flush(shape: PersistShape): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(shape));
    renameSync(tmp, path);
  }

  return {
    record(saving: ReplaySaving): void {
      const shape = load();
      if (shape.byCallId[saving.callId]) return; // first write wins — no double-count
      shape.byCallId[saving.callId] = { ...saving };
      flush(shape);
    },
    total(scope?: string): ReplaySavingsTotal {
      const shape = load();
      let tokens = 0;
      let costMicros = 0;
      for (const s of Object.values(shape.byCallId)) {
        if (scope !== undefined && s.scope !== scope) continue;
        tokens += s.tokensAvoided;
        costMicros += s.costMicros;
      }
      return { tokens, costMicros };
    },
  };
}
