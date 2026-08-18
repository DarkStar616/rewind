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
 * Subcommands: checkpoint [label] | list | rewind <id> | replay <id> | guard <json> |
 *              savings [--scope <id>] [--since <window>] [--json] | mcp
 *
 * Honesty (CLAUDE.md / product brief): Tier 0 is REVERSIBILITY, not isolation or security. `guard`
 * refuses replaying a spent effect across a rewind and records the refusal on the tamper-evident
 * chain; a refusal exits 2 so a PreToolUse hook can BLOCK the offending tool call.
 */
import { writeSync } from "node:fs";
import { join } from "node:path";
import { argv, cwd, exit } from "node:process";
import type { Engine, ExternalEffect } from "@rewind/core";
import { createMemoryRecordStore, createReplayer, startProxy, analyzeCacheHygiene } from "@rewind/gateway";
import { buildAdapterEngine } from "./build-engine.ts";
import { createFileReplaySavings } from "./durable-savings.ts";
import { runStdioServer } from "./server.ts";
import { buildSavingsReceipt, formatReceiptLine, upsellLine } from "./savings.ts";

const USAGE =
  "usage: rewind <checkpoint [label] | list | rewind <id> | replay <id> | guard <json> | " +
  "savings [--scope <id>] [--since <window>] [--json] | cache-report <json> | " +
  "gateway [--port <n>] [--upstream <url>] | mcp>";

const DEFAULT_GATEWAY_PORT = 8788;
const DEFAULT_UPSTREAM = "https://api.anthropic.com";

/** One line of JSON to stdout, written synchronously so `exit()` cannot truncate it. */
function out(value: unknown): void {
  writeSync(1, `${JSON.stringify(value)}\n`);
}

/** A diagnostic line to stderr (never mixed into the machine-readable stdout stream). */
function errline(message: string): void {
  writeSync(2, `rewind: ${message}\n`);
}

/** Parse the `savings` subcommand flags: `--scope <id>`, `--since <window>`, `--json` (order-free). */
function parseSavingsFlags(args: readonly string[]): { scope?: string; since?: string; json: boolean } {
  let scope: string | undefined;
  let since: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--scope") scope = args[++i];
    else if (a === "--since") since = args[++i];
    else if (a.startsWith("--scope=")) scope = a.slice("--scope=".length);
    else if (a.startsWith("--since=")) since = a.slice("--since=".length);
    else if (scope === undefined && !a.startsWith("-")) scope = a; // tolerate a bare positional scope
  }
  return { scope, since, json };
}

/** Parse the `gateway` subcommand flags: `--port <n>`, `--upstream <url>` (order-free). */
function parseGatewayFlags(args: readonly string[]): { port: number; upstream: string } {
  let port = DEFAULT_GATEWAY_PORT;
  let upstream = DEFAULT_UPSTREAM;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") port = Number(args[++i]);
    else if (a.startsWith("--port=")) port = Number(a.slice("--port=".length));
    else if (a === "--upstream") upstream = args[++i];
    else if (a.startsWith("--upstream=")) upstream = a.slice("--upstream=".length);
  }
  return { port, upstream };
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
      const flags = parseSavingsFlags(rest);
      const receipt = buildSavingsReceipt(engine.savings(flags.scope), { window: flags.since });
      if (flags.json) {
        out(receipt);
        return 0;
      }
      // Human, shareable line. The cost figure is a marked estimate (the `~`), never a bill.
      writeSync(1, `${formatReceiptLine(receipt)}\n`);
      // The single upsell ask — only once cumulative LIFETIME savings (across all scopes) cross the
      // threshold; nothing else in the free, local product asks for an account.
      const upsell = upsellLine(engine.savings().tokens);
      if (upsell) writeSync(1, `${upsell}\n`);
      return 0;
    }
    case "cache-report": {
      // Static prompt-cache hygiene for a request body: does its stable prefix cache, or does dynamic
      // content poison it? Advisory — helps a user debug why their agent's requests do/don't cache.
      if (!rest[0]) {
        errline("cache-report requires a JSON request body");
        return 1;
      }
      let body: unknown;
      try {
        body = JSON.parse(rest[0]);
      } catch {
        errline(`cache-report: the request body is not valid JSON: ${rest[0]}`);
        return 1;
      }
      const report = analyzeCacheHygiene(body);
      out(report);
      // A non-cacheable prefix exits 1 so a script can gate on it; the report is still printed.
      return report.cacheable ? 0 : 1;
    }
    case "gateway": {
      // The token-saving proxy. Point your agent's ANTHROPIC_BASE_URL at it: a byte-equivalent
      // request after a rewind is served from the record with zero upstream call, and the avoided
      // cost is booked to the SAME durable savings file `rewind savings` reads. Records live in
      // memory for this gateway session; the savings number persists across processes.
      const { port, upstream } = parseGatewayFlags(rest);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        errline(`gateway: --port must be an integer 0-65535, got ${JSON.stringify(port)}`);
        return 1;
      }
      const savings = createFileReplaySavings({ path: join(cwd(), ".rewind", "savings.json") });
      const store = createMemoryRecordStore();
      const replayer = createReplayer(store, savings);
      const proxy = await startProxy({ port, upstreamBase: upstream, replayer, store, log: (m) => errline(m) });
      errline(`rewind gateway listening on ${proxy.url} → ${upstream}`);
      errline(`point your agent at it:  ANTHROPIC_BASE_URL=${proxy.url}`);
      errline("replays after a rewind cost 0 upstream tokens; run `rewind savings` to see the total. Ctrl-C to stop.");
      // Stay alive serving requests until a termination signal; close the listener cleanly then exit.
      await new Promise<void>((resolve) => {
        const stop = () => {
          errline("rewind gateway shutting down");
          void proxy.close().then(resolve, resolve);
        };
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
      });
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
