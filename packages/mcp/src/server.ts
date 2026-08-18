/**
 * `@rewind/mcp` — the stdio MCP server: five tools over the @rewind/core engine.
 *
 * A thin adapter, exactly like the CLI. It builds ONE engine over the Tier-0 git backend and the
 * durable file-backed evidence chain for a workspace, and registers five tools against it:
 *   checkpoint {label?}        -> { id, ts }
 *   list                       -> { checkpoints: [{ id, label, ts, effects }] }
 *   rewind {id}                -> { revertedTo, refusedEffects[] }
 *   replay {id}                -> { steps, tokensAvoided, costAvoided }
 *   guard_effect {descriptor}  -> { decision, reason, chainHash }
 *
 * MCP stateless-core rule (CLAUDE.md): no per-connection / per-session state. Every stateful tool
 * mints or takes back an explicit handle, and ALL durable state lives in the substrate — the git
 * object store (checkpoint ids) and the on-disk evidence chain (store.ts), keyed by those handles.
 * A fresh process reconstructs everything from disk; nothing is held in transport/session memory.
 *
 * Honesty (product brief): Tier 0 is REVERSIBILITY, not isolation or security. That line rides on
 * the tool descriptions so an agent reading the tool list is not misled. The effect barrier and the
 * evidence chain read ONLY the effect log / trace, never the filesystem — `chainHash` and the
 * spent-effect count come from `store` reads (head/list), not from inspecting files.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EFFECT_EMITTED, GENESIS_HASH } from "@rewind/core";
import type { ExternalEffect } from "@rewind/core";
import { buildAdapterEngine } from "./build-engine.ts";

const TIER0_HONESTY = "Tier 0 is REVERSIBILITY, not isolation or security.";

export interface RewindMcpServerOptions {
  /** The workspace the server snapshots and guards. */
  cwd: string;
  /** Sink for advisory notices (reflink/CoW fallback, etc.). Default: console.warn via the backend. */
  log?: (message: string) => void;
}

/** A CallToolResult carrying both a text rendering and the validated structured payload. */
function ok(structured: Record<string, unknown>): {
  content: { type: "text"; text: string }[];
  structuredContent: Record<string, unknown>;
} {
  return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured };
}

/**
 * Build the rewind MCP server for `opts.cwd`, with all five tools registered against a single engine.
 * The caller connects it to a transport (`StdioServerTransport` in production, an in-memory linked
 * pair in tests).
 */
export function createRewindMcpServer(opts: RewindMcpServerOptions): McpServer {
  const { engine, store } = buildAdapterEngine(opts.cwd, opts.log);
  const server = new McpServer({ name: "rewind", version: "0.0.0" });

  // ── checkpoint ────────────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "checkpoint",
    {
      description:
        `Snapshot the whole workspace and mint a durable checkpoint handle you pass back to rewind/replay. ${TIER0_HONESTY}`,
      inputSchema: { label: z.string().optional() },
      outputSchema: { id: z.string(), label: z.string().optional(), ts: z.number() },
    },
    async (args) => {
      const ref = await engine.checkpoint(args.label);
      const structured =
        ref.label === undefined ? { id: ref.id, ts: ref.ts } : { id: ref.id, label: ref.label, ts: ref.ts };
      return ok(structured);
    },
  );

  // ── list ──────────────────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "list",
    {
      description:
        `List every checkpoint, newest first, each with the count of external effects recorded on the ` +
        `chain so far (a global figure in the MVP — effects are not yet attributed to one checkpoint). ${TIER0_HONESTY}`,
      inputSchema: {},
      outputSchema: {
        checkpoints: z.array(
          z.object({ id: z.string(), label: z.string(), ts: z.number(), effects: z.number() }),
        ),
      },
    },
    async () => {
      const refs = await engine.list();
      // Spent-effect count derived from the chain (the effect log), never from the filesystem.
      const effects = (await store.list({ action: EFFECT_EMITTED })).length;
      const checkpoints = refs.map((r) => ({ id: r.id, label: r.label ?? "", ts: r.ts, effects }));
      return ok({ checkpoints });
    },
  );

  // ── rewind ────────────────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "rewind",
    {
      description:
        `Return the whole workspace tree to a checkpoint. Reports the effects that already fired and are ` +
        `now refusable-on-replay (read from the tamper-evident chain, never the filesystem). ${TIER0_HONESTY}`,
      inputSchema: { id: z.string() },
      outputSchema: {
        revertedTo: z.string(),
        refusedEffects: z.array(
          z.object({ effectKey: z.string(), scopeLabel: z.string(), firstEmittedSeq: z.number() }),
        ),
      },
    },
    async (args) => {
      const result = await engine.rewind(args.id);
      const refusedEffects = result.refusableEffects.map((e) => ({
        effectKey: e.effectKey,
        scopeLabel: e.scopeLabel,
        firstEmittedSeq: e.firstEmittedSeq,
      }));
      return ok({ revertedTo: result.restoredTo, refusedEffects });
    },
  );

  // ── replay ────────────────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "replay",
    {
      description:
        `Report the savings a checkpoint's recorded replays represent. The MVP re-runs nothing (steps=0); ` +
        `it sums only genuinely avoided re-execution, deduped by call id. ${TIER0_HONESTY}`,
      inputSchema: { id: z.string() },
      outputSchema: { steps: z.number(), tokensAvoided: z.number(), costAvoided: z.number() },
    },
    async (args) => {
      const r = await engine.replay(args.id);
      // No execution-recording provider in the MVP, so replay re-runs nothing: steps is honestly 0.
      return ok({ steps: 0, tokensAvoided: r.tokensAvoided, costAvoided: r.costMicros });
    },
  );

  // ── guard_effect ──────────────────────────────────────────────────────────────────────────────
  server.registerTool(
    "guard_effect",
    {
      description:
        `Admit or refuse an external effect. The first emit of a key is admitted and recorded; re-firing ` +
        `a spent key across a rewind is REFUSED and recorded, citing the original emit. chainHash is the ` +
        `tamper-evident chain head after the decision. ${TIER0_HONESTY}`,
      inputSchema: {
        descriptor: z.object({
          effectKey: z.string(),
          scopeLabel: z.string(),
          kind: z.string(),
          actorId: z.string().optional(),
          objectId: z.string().optional(),
          detail: z.string().optional(),
        }),
      },
      outputSchema: {
        decision: z.enum(["admitted", "refused"]),
        reason: z.string(),
        chainHash: z.string(),
        firstEmittedSeq: z.number().optional(),
      },
    },
    async (args) => {
      const effect = args.descriptor as ExternalEffect;
      const outcome = await engine.guard(effect);
      const head = await store.head(effect.scopeLabel);
      const chainHash = head ? head.hash : GENESIS_HASH;
      if (outcome.refused) {
        return ok({
          decision: "refused",
          reason:
            `effect ${effect.effectKey} already fired (first at seq ${outcome.firstEmittedSeq}) and is not ` +
            `replayable across a rewind`,
          chainHash,
          firstEmittedSeq: outcome.firstEmittedSeq,
        });
      }
      return ok({
        decision: "admitted",
        reason: `effect ${effect.effectKey} admitted and recorded on the tamper-evident chain`,
        chainHash,
      });
    },
  );

  return server;
}

/**
 * Build the server for `opts.cwd` and run it over stdio until the client closes the pipe. Resolves
 * when the transport closes (stdin ends), so the launcher can exit cleanly; rejects if connect fails.
 */
export function runStdioServer(opts: RewindMcpServerOptions): Promise<void> {
  const server = createRewindMcpServer(opts);
  const transport = new StdioServerTransport();
  return new Promise<void>((resolve, reject) => {
    transport.onclose = () => resolve();
    server.connect(transport).catch(reject);
  });
}
