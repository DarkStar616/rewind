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
 *   savings {scope?, since?}   -> { tokensSaved, costSaved, currency, window, breakdown }
 *
 * (checkpoint/list/rewind/replay/guard_effect are the MVP five; `savings` is the Slice 1.5 receipt.)
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
import {
  EFFECT_EMITTED,
  GENESIS_HASH,
  backtrackCandidates,
  memoryForCheckpoint,
  recommendedCheckpoint,
  type AttemptRecord,
} from "@rewind/core";
import type { ExternalEffect } from "@rewind/core";
import { buildAdapterEngine } from "./build-engine.ts";
import { buildSavingsReceipt } from "./savings.ts";

/** The default recovery scope for the workspace (one attempt log per workspace in the MVP). */
const RECOVERY_SCOPE = "workspace";

/** Now in epoch ms — supplied by the durable adapter (the pure recovery core never reads a clock). */
function nowMs(): number {
  return Date.now();
}

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
  const { engine, store, rewindMemory } = buildAdapterEngine(opts.cwd, opts.log);
  const server = new McpServer({ name: "rewind", version: "0.0.0" });

  const attemptShape = z.object({
    seq: z.number(),
    checkpointId: z.string(),
    goal: z.string(),
    outcome: z.enum(["failure", "success", "abandoned"]),
    note: z.string(),
    at: z.number(),
  });
  const publicAttempt = (a: AttemptRecord) => ({
    seq: a.seq,
    checkpointId: a.checkpointId,
    goal: a.goal,
    outcome: a.outcome,
    note: a.note,
    at: a.at,
  });

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

  // ── savings (Slice 1.5 honest receipt) ──────────────────────────────────────────────────────────
  server.registerTool(
    "savings",
    {
      description:
        `Report the honest token/cost savings: ONLY re-spend that was provably avoided (replay ` +
        `cache-hits, deduped by call id), never a whole rewound run, wall-clock, or the provider's own ` +
        `prompt-cache discount. Cost is a marked ESTIMATE from a per-model rate table, not a bill. ${TIER0_HONESTY}`,
      inputSchema: { scope: z.string().optional(), since: z.string().optional() },
      outputSchema: {
        tokensSaved: z.number(),
        costSaved: z.number(),
        currency: z.literal("USD"),
        window: z.string(),
        breakdown: z.object({ replayHits: z.number(), rewindAvoided: z.number() }),
        estimate: z.literal(true),
      },
    },
    async (args) => {
      // Same core receipt the CLI prints (one engine, thin adapters): read the deduped savings total.
      const receipt = buildSavingsReceipt(engine.savings(args.scope), { window: args.since });
      return ok({ ...receipt });
    },
  );

  // ── backtrack_candidates (recovery / accuracy) ───────────────────────────────────────────────────
  server.registerTool(
    "backtrack_candidates",
    {
      description:
        `List the checkpoints you could selectively rewind to, NEWEST FIRST, each annotated with the ` +
        `failures already recorded from it (the memory a re-attempt would inherit). 'recommended' is the ` +
        `most-recent FAILING checkpoint — rewind to just before the work that keeps failing, not a full ` +
        `restart. Pair with backtrack_commit. ${TIER0_HONESTY}`,
      inputSchema: {},
      outputSchema: {
        candidates: z.array(
          z.object({
            checkpointId: z.string(),
            label: z.string(),
            ts: z.number(),
            priorFailures: z.array(attemptShape),
          }),
        ),
        recommended: z.string().optional(),
      },
    },
    async () => {
      const checkpoints = await engine.list();
      const cands = backtrackCandidates(checkpoints, rewindMemory, RECOVERY_SCOPE);
      const recommended = recommendedCheckpoint(cands)?.checkpointId;
      const candidates = cands.map((c) => ({
        checkpointId: c.checkpointId,
        label: c.label,
        ts: c.ts,
        priorFailures: c.priorFailures.map(publicAttempt),
      }));
      return ok(recommended === undefined ? { candidates } : { candidates, recommended });
    },
  );

  // ── backtrack_commit (recovery / accuracy) ───────────────────────────────────────────────────────
  server.registerTool(
    "backtrack_commit",
    {
      description:
        `Selectively rewind the workspace to a checkpoint AND carry the failure forward. REQUIRES a ` +
        `non-empty 'note' saying why the current branch is being abandoned — that note is what makes the ` +
        `re-attempt smarter (this is the measured accuracy mechanism, not just undo). Returns the ` +
        `accumulated failure memory for that checkpoint to inject into your next attempt. ${TIER0_HONESTY}`,
      inputSchema: {
        checkpointId: z.string(),
        note: z.string().min(1, "a backtrack requires a non-empty note (the carried-forward lesson)"),
        goal: z.string().optional(),
      },
      outputSchema: {
        rewoundTo: z.string(),
        carriedMemory: z.array(attemptShape),
        refusedEffects: z.array(
          z.object({ effectKey: z.string(), scopeLabel: z.string(), firstEmittedSeq: z.number() }),
        ),
      },
    },
    async (args) => {
      // Record the abandoned branch's lesson AGAINST the checkpoint we return to, so a future
      // re-attempt from it sees what already failed. seq is monotonic per scope (dedup key).
      const existing = rewindMemory.all(RECOVERY_SCOPE);
      const nextSeq = existing.length === 0 ? 0 : Math.max(...existing.map((a) => a.seq)) + 1;
      rewindMemory.record({
        seq: nextSeq,
        scope: RECOVERY_SCOPE,
        checkpointId: args.checkpointId,
        goal: args.goal ?? "abandoned branch",
        outcome: "abandoned",
        note: args.note,
        at: nowMs(),
      });
      // Then selectively rewind the world (also surfaces spent effects now refusable on replay).
      const result = await engine.rewind(args.checkpointId);
      const carriedMemory = memoryForCheckpoint(rewindMemory, RECOVERY_SCOPE, args.checkpointId).map(publicAttempt);
      const refusedEffects = result.refusableEffects.map((e) => ({
        effectKey: e.effectKey,
        scopeLabel: e.scopeLabel,
        firstEmittedSeq: e.firstEmittedSeq,
      }));
      return ok({ rewoundTo: result.restoredTo, carriedMemory, refusedEffects });
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
