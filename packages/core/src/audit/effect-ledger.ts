import type { ScopeId } from "../types.ts";
import { createKeyedQueue } from "../util/async.ts";
import { EvidenceLedgerError, type AuditEntry, type EvidenceLedger } from "./evidence-ledger.ts";

// The effect barrier owns exactly two actions. These are the GENERIC values (no product-specific
// `external_` prefix); the injected evidence ledger's vocabulary must include both.
export const EFFECT_EMITTED = "effect_emitted";
export const EFFECT_REPLAY_REFUSED = "effect_replay_refused";

/**
 * The stable, agent-actionable reason a spent effect is refused across a rewind. It is written to the
 * chain AND handed back on the EffectRefusal, so an agent (via MCP/CLI) can read WHY and adapt — stop
 * retrying the effect — instead of blindly re-firing. One canonical string, used in both places, so the
 * recorded reason and the returned reason can never drift. This is the deny-reason half of RIP-LIST #11
 * only; no auto-approve/skip-permissions state is introduced.
 */
export const REPLAY_REFUSED_REASON =
  "the effect materialised outside the workspace and is not replayable across a revert";

export interface ExternalEffect {
  effectKey: string;
  scopeLabel: ScopeId;
  kind: string;
  actorId?: string;
  objectId?: string;
  detail?: string;
  /**
   * The provider-native `tool_use_id` (e.g. Anthropic `toolu_...`), a cheap per-call identity recorded
   * ALONGSIDE the authoritative effectKey for correlation/diagnostics. NEVER part of identity or the
   * dedup/refusal decision — it is client-supplied and unique only within a conversation, so trusting
   * it as sole identity would let a re-labelled effect slip the barrier. The SHA-256 canonical effectKey
   * stays the sole identity for the chain and the spent-check.
   */
  toolUseId?: string;
}

export interface EffectRefusal {
  refused: true;
  effectKey: string;
  firstEmittedSeq: number;
  /** Stable, agent-actionable explanation of the refusal — the same string recorded on the chain. */
  reason: string;
}

export interface EffectAdmission {
  refused: false;
  effectKey: string;
}

export type EffectOutcome = EffectAdmission | EffectRefusal;

export interface EffectLedgerOptions {}

export interface EffectLedger {
  emit(effect: ExternalEffect): Promise<EffectOutcome>;
  spentAt(scopeLabel: ScopeId, effectKey: string): Promise<number | undefined>;
}

function keyOf(entry: AuditEntry): string | undefined {
  if (entry.action !== EFFECT_EMITTED) return undefined;
  const detail = entry.detail as { effectKey?: unknown } | null;
  return detail && typeof detail.effectKey === "string" ? detail.effectKey : undefined;
}

export function createEffectLedger(ledger: EvidenceLedger, _opts: EffectLedgerOptions = {}): EffectLedger {
  // The barrier owns its OWN keyed queue — a separate instance from the evidence ledger's internal
  // one, so gating an emit here never contends with (and cannot self-deadlock against) the ledger's
  // per-scope append serialization. This closes the TOCTOU: the harvested `emit` read `spentAt`
  // (a list scan) and then `append`ed across two independent awaits, so two concurrent emits of the
  // same key both observed "unspent" and both admitted. Serializing the whole check-and-append per
  // scope makes the second emit see the first's spent entry and refuse.
  const gate = createKeyedQueue<string>();

  async function spentAt(scopeLabel: ScopeId, effectKey: string): Promise<number | undefined> {
    const entries = await ledger.list({ scopeLabel, action: EFFECT_EMITTED });
    for (const entry of entries) {
      if (keyOf(entry) === effectKey) return entry.seq;
    }
    return undefined;
  }

  return {
    spentAt,
    async emit(effect): Promise<EffectOutcome> {
      // Validate the key BEFORE touching the ledger. A non-string key (a real risk for a direct
      // core consumer, and for an MCP client since `z.string()` still admits ""), must surface the
      // domain error, not a raw `TypeError: ... reading 'trim'` from the guard itself — an
      // unclassifiable throw is harder for a caller to handle and leaks the implementation. `.trim()`
      // also rejects whitespace-only keys; note it is used ONLY for the emptiness check, never to
      // normalise the stored key, so " x " and "x" remain distinct effects by design.
      if (typeof effect.effectKey !== "string" || !effect.effectKey.trim()) {
        throw new EvidenceLedgerError("an external effect requires a non-empty string effectKey");
      }
      return gate(String(effect.scopeLabel), async () => {
        const already = await spentAt(effect.scopeLabel, effect.effectKey);
        if (already !== undefined) {
          await ledger.append({
            scopeLabel: effect.scopeLabel,
            action: EFFECT_REPLAY_REFUSED,
            ...(effect.actorId ? { actorId: effect.actorId } : {}),
            ...(effect.objectId ? { objectId: effect.objectId } : {}),
            detail: {
              effectKey: effect.effectKey,
              kind: effect.kind,
              firstEmittedSeq: already,
              reason: REPLAY_REFUSED_REASON,
            },
          });
          return { refused: true, effectKey: effect.effectKey, firstEmittedSeq: already, reason: REPLAY_REFUSED_REASON };
        }
        await ledger.append({
          scopeLabel: effect.scopeLabel,
          action: EFFECT_EMITTED,
          ...(effect.actorId ? { actorId: effect.actorId } : {}),
          ...(effect.objectId ? { objectId: effect.objectId } : {}),
          // The (scope, effectKey) uniqueness guarantee: the evidence ledger already dedupes on
          // idempotencyKey, so a future durable backend enforces one spent entry per effect too.
          idempotencyKey: `${effect.scopeLabel}:${effect.effectKey}`,
          // toolUseId is recorded for correlation only; it is deliberately NOT in idempotencyKey/identity.
          detail: {
            effectKey: effect.effectKey,
            kind: effect.kind,
            detail: effect.detail ?? null,
            ...(effect.toolUseId ? { toolUseId: effect.toolUseId } : {}),
          },
        });
        return { refused: false, effectKey: effect.effectKey };
      });
    },
  };
}
