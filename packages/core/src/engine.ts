/**
 * The engine — the single thin driver that wires the WorldBackend, the effect barrier and the
 * replay-savings sink together into the surface the adapters (CLI, MCP server, plugin) consume.
 *
 * It owns NO snapshot/restore mechanics and NO barrier logic of its own; it composes the pieces
 * built in the earlier tasks. In particular:
 *  - checkpoint/list/rewind delegate to the injected WorldBackend; the handle is the WorldRef.id.
 *  - guard delegates to the effect barrier (createEffectLedger over the injected EvidenceLedger).
 *  - rewind restores the workspace tree AND reports which effects are now spent-but-refusable by
 *    reading the CHAIN (the EFFECT_EMITTED entries), never the filesystem. That is the whole point
 *    of the barrier sitting above the backend: the revert rolls back the world, but the record of
 *    what already fired outside the world persists, so a replay of a spent effect is refused.
 */
import {
  createEffectLedger,
  EFFECT_EMITTED,
  type EffectLedger,
  type EffectOutcome,
  type ExternalEffect,
} from "./audit/effect-ledger.ts";
import type { EvidenceLedger } from "./audit/evidence-ledger.ts";
import type { ReplaySavingsSink, ReplaySavingsTotal } from "./replay/replay-savings.ts";
import type { WorldBackend, WorldRef } from "./world/world-backend.ts";
import { refId } from "./world/world-backend.ts";

export interface EngineOptions {
  /** The workspace the backend snapshots. Carried for the adapters; the backend owns the git dir. */
  cwd: string;
  /** The tamper-evident evidence ledger the barrier records on. Injected so a consumer can swap it. */
  store: EvidenceLedger;
  /** The snapshot/restore backend (Tier-0 git in the MVP). */
  backend: WorldBackend;
  /** The replay-savings accounting sink. */
  savings: ReplaySavingsSink;
}

/** An effect that was emitted before a rewind and would now be refused if re-fired. */
export interface RefusableEffect {
  effectKey: string;
  scopeLabel: string;
  /** The seq of the original EFFECT_EMITTED entry a refusal would cite. */
  firstEmittedSeq: number;
}

export interface RewindResult {
  /** The snapshot id the workspace tree was returned to. */
  restoredTo: string;
  /** Effects that already fired and are now refusable-on-replay — read from the chain, not the FS. */
  refusableEffects: readonly RefusableEffect[];
}

export interface ReplayResult {
  /** The checkpoint id replay was requested from. */
  replayedFrom: string;
  /** Tokens replay makes available by avoiding re-execution (summed from the ReplaySaving records). */
  tokensAvoided: number;
  /** Cost avoided in integer micro-units, to avoid float drift. */
  costMicros: number;
}

export interface Engine {
  checkpoint(label?: string): Promise<WorldRef>;
  list(): Promise<readonly WorldRef[]>;
  rewind(id: WorldRef | string): Promise<RewindResult>;
  replay(id: WorldRef | string): Promise<ReplayResult>;
  guard(effect: ExternalEffect): Promise<EffectOutcome>;
  savings(scope?: string): ReplaySavingsTotal;
}

export function createEngine(opts: EngineOptions): Engine {
  const { store, backend, savings } = opts;
  // One barrier over the injected ledger. The ledger's vocabulary (if it declares one) must admit
  // EFFECT_EMITTED and EFFECT_REPLAY_REFUSED; the barrier owns those two actions.
  const barrier: EffectLedger = createEffectLedger(store);

  // The spent-but-refusable set, derived from the chain. Every EFFECT_EMITTED entry names an effect
  // that already materialised outside the workspace; after a revert, re-firing it would be refused.
  async function refusableEffects(): Promise<RefusableEffect[]> {
    const emitted = await store.list({ action: EFFECT_EMITTED });
    const out: RefusableEffect[] = [];
    for (const entry of emitted) {
      const detail = entry.detail as { effectKey?: unknown } | null;
      const effectKey = detail && typeof detail.effectKey === "string" ? detail.effectKey : undefined;
      if (effectKey === undefined) continue;
      out.push({ effectKey, scopeLabel: entry.scopeLabel, firstEmittedSeq: entry.seq });
    }
    return out;
  }

  return {
    checkpoint(label) {
      return backend.snapshot(label);
    },

    list() {
      return backend.log();
    },

    async rewind(id) {
      const result = await backend.restore(id);
      return { restoredTo: result.restoredTo, refusableEffects: await refusableEffects() };
    },

    async replay(id) {
      // MVP has no execution-recording provider, so replay does not re-run anything; it reports the
      // savings the recorded ReplaySaving entries represent, for a checkpoint that actually exists.
      // Refusing an unknown ref keeps the receipt honest rather than crediting a phantom checkpoint.
      const target = refId(id);
      const known = await backend.log();
      if (!known.some((ref) => ref.id === target)) {
        throw new Error(`rewind engine: cannot replay unknown checkpoint ${JSON.stringify(target)}`);
      }
      const total = savings.total();
      return { replayedFrom: target, tokensAvoided: total.tokens, costMicros: total.costMicros };
    },

    guard(effect) {
      return barrier.emit(effect);
    },

    savings(scope) {
      return savings.total(scope);
    },
  };
}
