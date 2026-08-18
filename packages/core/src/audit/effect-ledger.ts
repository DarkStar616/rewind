import type { ScopeId } from "../types.ts";
import { EvidenceLedgerError, type AuditEntry, type EvidenceLedger } from "./evidence-ledger.ts";

// The effect barrier owns exactly two actions. These are the GENERIC values (no product-specific
// `external_` prefix); the injected evidence ledger's vocabulary must include both.
export const EFFECT_EMITTED = "effect_emitted";
export const EFFECT_REPLAY_REFUSED = "effect_replay_refused";

export interface ExternalEffect {
  effectKey: string;
  scopeLabel: ScopeId;
  kind: string;
  actorId?: string;
  objectId?: string;
  detail?: string;
}

export interface EffectRefusal {
  refused: true;
  effectKey: string;
  firstEmittedSeq: number;
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
      if (!effect.effectKey.trim()) {
        throw new EvidenceLedgerError("an external effect requires a non-empty effectKey");
      }
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
            reason: "the effect materialised outside the workspace and is not replayable across a revert",
          },
        });
        return { refused: true, effectKey: effect.effectKey, firstEmittedSeq: already };
      }
      await ledger.append({
        scopeLabel: effect.scopeLabel,
        action: EFFECT_EMITTED,
        ...(effect.actorId ? { actorId: effect.actorId } : {}),
        ...(effect.objectId ? { objectId: effect.objectId } : {}),
        detail: { effectKey: effect.effectKey, kind: effect.kind, detail: effect.detail ?? null },
      });
      return { refused: false, effectKey: effect.effectKey };
    },
  };
}
