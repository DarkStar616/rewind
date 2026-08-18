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
import type { Engine, ExternalEffect } from "@rewind/core";
import { buildAdapterEngine } from "./build-engine.ts";
import { runStdioServer } from "./server.ts";

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
  // Both adapters build the world identically; the shared builder owns the git backend + durable
  // evidence chain + savings sink wiring (see build-engine.ts).
  return buildAdapterEngine(workdir, (m) => errline(m)).engine;
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
      // Launch the stdio MCP server over the same workspace. It owns its own engine (built from the
      // durable store), so the throwaway `engine` above is unused here. Resolves when the client
      // closes the pipe (stdin ends); until then the process stays alive serving JSON-RPC on stdout.
      errline("starting the stdio MCP server (five tools: checkpoint, list, rewind, replay, guard_effect)");
      await runStdioServer({ cwd: cwd(), log: (m) => errline(m) });
      return 0;
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
