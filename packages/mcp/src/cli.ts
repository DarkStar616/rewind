#!/usr/bin/env node
/**
 * `rewind` — the universal terminal floor over the @rewind/core engine.
 *
 * A thin adapter: it builds one engine over the Tier-0 git backend in the current working directory,
 * dispatches a subcommand, and prints the engine's result as one line of JSON on stdout (advisory
 * notices and errors go to stderr). All durable state lives on disk under `.rewind/` — the snapshot
 * repo (git's own store) and the evidence chain (store.ts) — so nothing is held in process memory
 * between invocations; each subcommand is a fresh, stateless process keyed by the handles it is given.
 *
 * Subcommands: checkpoint [label] | list | rewind <id> | replay <id> | guard <json> | savings [scope] | mcp
 *
 * Honesty (CLAUDE.md / product brief): Tier 0 is REVERSIBILITY, not isolation or security. `guard`
 * refuses replaying a spent effect across a rewind and records the refusal on the tamper-evident
 * chain; a refusal exits 2 so a PreToolUse hook can BLOCK the offending tool call.
 */
import { writeSync } from "node:fs";
import { argv, cwd, exit } from "node:process";
import { join } from "node:path";
import {
  createEngine,
  createGitBackend,
  createMemoryReplaySavings,
  EFFECT_EMITTED,
  EFFECT_REPLAY_REFUSED,
} from "@rewind/core";
import type { Engine, ExternalEffect } from "@rewind/core";
import { createFileEvidenceLedger } from "./store.ts";

const USAGE =
  "usage: rewind <checkpoint [label] | list | rewind <id> | replay <id> | guard <json> | savings [scope] | mcp>";

/** One line of JSON to stdout, written synchronously so `exit()` cannot truncate it. */
function out(value: unknown): void {
  writeSync(1, `${JSON.stringify(value)}\n`);
}

/** A diagnostic line to stderr (never mixed into the machine-readable stdout stream). */
function errline(message: string): void {
  writeSync(2, `rewind: ${message}\n`);
}

function buildEngine(workdir: string): Engine {
  const rewindDir = join(workdir, ".rewind");
  const backend = createGitBackend({ cwd: workdir, log: (m) => errline(m) });
  // The barrier owns exactly two actions; the durable ledger's vocabulary admits precisely those.
  const store = createFileEvidenceLedger({
    path: join(rewindDir, "evidence.json"),
    vocabulary: [EFFECT_EMITTED, EFFECT_REPLAY_REFUSED],
  });
  // Savings accounting is in-memory for the CLI floor; the durable honest-metering receipt is a
  // later slice. `replay`/`savings` therefore report the current process's recorded savings only.
  const savings = createMemoryReplaySavings();
  return createEngine({ cwd: workdir, store, backend, savings });
}

async function run(cmd: string | undefined, rest: readonly string[], engine: Engine): Promise<number> {
  switch (cmd) {
    case "checkpoint": {
      out(await engine.checkpoint(rest[0]));
      return 0;
    }
    case "list": {
      out(await engine.list());
      return 0;
    }
    case "rewind": {
      if (!rest[0]) {
        errline("rewind requires a checkpoint id");
        return 1;
      }
      out(await engine.rewind(rest[0]));
      return 0;
    }
    case "replay": {
      if (!rest[0]) {
        errline("replay requires a checkpoint id");
        return 1;
      }
      out(await engine.replay(rest[0]));
      return 0;
    }
    case "guard": {
      if (!rest[0]) {
        errline("guard requires a JSON effect descriptor");
        return 1;
      }
      let effect: unknown;
      try {
        effect = JSON.parse(rest[0]);
      } catch {
        errline(`guard: the effect descriptor is not valid JSON: ${rest[0]}`);
        return 1;
      }
      const outcome = await engine.guard(effect as ExternalEffect);
      out(outcome);
      // A refusal is the barrier working as intended; exit 2 lets a PreToolUse hook block the call.
      return outcome.refused ? 2 : 0;
    }
    case "savings": {
      out(engine.savings(rest[0]));
      return 0;
    }
    case "mcp": {
      errline("the stdio MCP server is wired in a later slice (Task 10); `rewind mcp` is not available yet");
      return 1;
    }
    default: {
      errline(`unknown subcommand ${JSON.stringify(cmd)}`);
      errline(USAGE);
      return 1;
    }
  }
}

async function main(): Promise<number> {
  const [, , cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help") {
    errline(USAGE);
    return cmd ? 0 : 1;
  }
  return run(cmd, rest, buildEngine(cwd()));
}

main().then(
  (code) => exit(code),
  (err) => {
    errline(err instanceof Error ? err.message : String(err));
    exit(1);
  },
);
