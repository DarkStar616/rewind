/**
 * `@agent-rewind/mcp` — the stdio MCP server: five tools over the @agent-rewind/core engine.
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
import { mcpProfile, type McpProfile } from "./mcp-profile.ts";
import { readFileSync } from "node:fs";
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
} from "@agent-rewind/core";
import type { ExternalEffect } from "@agent-rewind/core";
import { buildAdapterEngine } from "./build-engine.ts";
import { buildSavingsReceipt } from "./savings.ts";

/** The default recovery scope for the workspace (one attempt log per workspace in the MVP). */
const RECOVERY_SCOPE = "workspace";

/** Now in epoch ms — supplied by the durable adapter (the pure recovery core never reads a clock). */
function nowMs(): number {
  return Date.now();
}


/**
 * The MCP server's advertised version, DERIVED from package.json so the server identity can never drift
 * from the published release (codex round 11: a hard-coded "0.1.3" survived the 1.0.0 bump). Resolves in
 * BOTH dev and bundled form: `src/server.ts` and the bundled `dist/cli.js` each sit one directory below
 * the package root, so `../package.json` is the package's own manifest either way, and npm always ships
 * package.json in the tarball. The fallback is a visible sentinel — never a silent wrong version.
 */
const SERVER_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export interface RewindMcpServerOptions {
  /** Explicit tool surface; all preserves the existing tool names. */
  profile?: McpProfile;
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
  const manifest = mcpProfile(opts.profile);
  const enabled = new Set(manifest.tools);
  const { engine, store, rewindMemory } = buildAdapterEngine(opts.cwd, opts.log);
  // Server-level `instructions` are surfaced to the model by MCP clients (Claude Code, Cursor, …) on
  // connect, so the agent learns the WORKFLOW up front instead of reverse-engineering it from tool
  // descriptions. Keep it tight and actionable.
  const server = new McpServer(
    { name: "agent-rewind", version: SERVER_VERSION },
    {
      instructions: manifest.instructions,
    },
  );

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
  if (enabled.has("checkpoint")) server.registerTool(
    "checkpoint",
    {
      description: "Snapshot the whole workspace; keep the returned id for rewind.",
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
  if (enabled.has("list")) server.registerTool(
    "list",
    {
      description: "List checkpoints newest first. effects is the global emitted-effect count, not a per-checkpoint count.",
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
  if (enabled.has("rewind")) server.registerTool(
    "rewind",
    {
      description: "Restore the workspace to a checkpoint; report previously emitted effects that must not be repeated.",
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
  if (enabled.has("replay")) server.registerTool(
    "replay",
    {
      description: "Report estimated avoided replay tokens and cost for a checkpoint. Executes nothing (steps=0).",
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
  if (enabled.has("guard_effect")) server.registerTool(
    "guard_effect",
    {
      description: "Admit an external effect once per stable key, or refuse repetition. Returns the tamper-evident decision chain hash.",
      inputSchema: {
        descriptor: z.object({
          effectKey: z.string(),
          scopeLabel: z.string(),
          kind: z.string(),
          actorId: z.string().optional(),
          objectId: z.string().optional(),
          detail: z.string().optional(),
          // Provider-native per-call id, recorded for correlation only — never part of effect identity.
          toolUseId: z.string().optional(),
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
          // Lead with the barrier's own structured, agent-actionable reason (the same string on the
          // chain), then add the actionable context so the agent knows to stop re-firing this effect.
          reason:
            `${outcome.reason} — effect ${effect.effectKey} already fired (first at seq ${outcome.firstEmittedSeq}); ` +
            `do not re-fire it across the rewind`,
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
  if (enabled.has("savings")) server.registerTool(
    "savings",
    {
      description: "Report deduplicated avoided replay tokens and estimated USD cost. Excludes provider cache discounts; since is currently a label, not a filter.",
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
  if (enabled.has("backtrack_candidates")) server.registerTool(
    "backtrack_candidates",
    {
      description: "List checkpoints with failure memory. Recommended is the newest failing checkpoint.",
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
  if (enabled.has("backtrack_commit")) server.registerTool(
    "backtrack_commit",
    {
      description: "Restore a checkpoint and persist the required failure note for the next attempt. Returns accumulated failure memory.",
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
      // A whitespace-only note is not a lesson — reject it (schema min(1) alone would accept "   ").
      const note = args.note.trim();
      if (note.length === 0) {
        throw new Error("backtrack_commit requires a note with actual content (whitespace-only is not a lesson)");
      }
      // Validate the checkpoint exists BEFORE recording, so an unknown id pollutes nothing.
      const checkpoints = await engine.list();
      if (!checkpoints.some((c) => c.id === args.checkpointId)) {
        throw new Error(`backtrack_commit: unknown checkpoint ${args.checkpointId}`);
      }
      // Record the lesson FIRST: it is valid regardless of the rewind's outcome and must never be lost
      // to a mid-rewind failure. Retries are idempotent — an identical (checkpoint, note) already
      // recorded is NOT duplicated, so a lost response + client retry never inflates the memory. seq is
      // finite-filtered so a malformed record can never poison allocation into NaN.
      const alreadyRecorded = rewindMemory
        .since(RECOVERY_SCOPE, args.checkpointId)
        .some((a) => a.outcome === "abandoned" && a.note === note);
      if (!alreadyRecorded) {
        const seqs = rewindMemory.all(RECOVERY_SCOPE).map((a) => a.seq).filter((n) => Number.isFinite(n));
        const nextSeq = seqs.length === 0 ? 0 : Math.max(...seqs) + 1;
        rewindMemory.record({
          seq: nextSeq,
          scope: RECOVERY_SCOPE,
          checkpointId: args.checkpointId,
          goal: args.goal ?? "abandoned branch",
          outcome: "abandoned",
          note,
          at: nowMs(),
        });
      }
      // Then selectively rewind the world (surfaces spent effects now refusable on replay).
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
