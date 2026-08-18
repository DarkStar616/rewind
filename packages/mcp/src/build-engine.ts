/**
 * Shared engine builder for the rewind adapters (CLI and the stdio MCP server).
 *
 * Both adapters compose @rewind/core the same way: one Tier-0 git backend over the workspace, one
 * durable file-backed evidence ledger (the barrier records on it; see store.ts for why the chain
 * MUST be on disk and NOT in connection/session memory), one in-memory savings sink, wired into the
 * single engine. Factoring it here keeps the two adapters bit-identical in how they build the world,
 * and hands the caller the `store` and `backend` references too — the MCP server needs the store to
 * read the chain head (`chainHash`) and the spent-effect count without going through a rewind, which
 * still reads ONLY the effect log / trace, never the filesystem.
 */
import { join } from "node:path";
import {
  createEngine,
  createGitBackend,
  createMemoryReplaySavings,
  EFFECT_EMITTED,
  EFFECT_REPLAY_REFUSED,
} from "@rewind/core";
import type { Engine, EvidenceLedger, ReplaySavingsSink, WorldBackend } from "@rewind/core";
import { createFileEvidenceLedger } from "./store.ts";

export interface AdapterEngine {
  engine: Engine;
  /** The durable evidence ledger the barrier records on — read-only reads (head, list) are safe. */
  store: EvidenceLedger;
  /** The Tier-0 git backend the snapshots live in. */
  backend: WorldBackend;
  /** The (process-lifetime) replay-savings sink. */
  savings: ReplaySavingsSink;
}

/**
 * Build one engine over the Tier-0 git backend and the durable evidence chain rooted at `workdir`.
 * `log` receives advisory notices (e.g. the reflink/CoW fallback message).
 */
export function buildAdapterEngine(workdir: string, log?: (message: string) => void): AdapterEngine {
  const rewindDir = join(workdir, ".rewind");
  const backend = createGitBackend(log === undefined ? { cwd: workdir } : { cwd: workdir, log });
  // The barrier owns exactly two actions; the durable ledger's vocabulary admits precisely those.
  const store = createFileEvidenceLedger({
    path: join(rewindDir, "evidence.json"),
    vocabulary: [EFFECT_EMITTED, EFFECT_REPLAY_REFUSED],
  });
  // Savings accounting is in-memory for the local adapters; the durable honest-metering receipt is a
  // later slice. `replay`/`savings` therefore report the current process's recorded savings only.
  const savings = createMemoryReplaySavings();
  const engine = createEngine({ cwd: workdir, store, backend, savings });
  return { engine, store, backend, savings };
}
