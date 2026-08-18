import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryEvidenceLedger,
  createEffectLedger,
  EFFECT_EMITTED,
  EFFECT_REPLAY_REFUSED,
} from "../src/index.ts";

/**
 * RIP-LIST #10. `tool_use_id` is a cheap, provider-native per-call identity, recorded ALONGSIDE the
 * authoritative SHA-256 canonical effectKey for correlation/diagnostics. It must NEVER be part of
 * identity or the dedup/refusal decision — it is client-supplied and unique only within a conversation.
 */
test("toolUseId is recorded but is NOT part of effect identity", async () => {
  const ledger = createMemoryEvidenceLedger({ vocabulary: [EFFECT_EMITTED, EFFECT_REPLAY_REFUSED] });
  const barrier = createEffectLedger(ledger);

  await barrier.emit({ effectKey: "charge:1", scopeLabel: "s", kind: "http", toolUseId: "toolu_a" });
  // Same effectKey, DIFFERENT toolUseId — identity is the effectKey, so this must still collapse.
  const refusal = await barrier.emit({ effectKey: "charge:1", scopeLabel: "s", kind: "http", toolUseId: "toolu_b" });
  assert.equal(refusal.refused, true, "same effectKey collapses regardless of toolUseId");

  const emitted = await ledger.list({ scopeLabel: "s", action: EFFECT_EMITTED });
  assert.equal(emitted.length, 1, "only the first emit was admitted");
  assert.equal((emitted[0].detail as { toolUseId?: string }).toolUseId, "toolu_a", "the first emit's toolUseId was recorded");
});

test("an effect without a toolUseId records no toolUseId field (optional, absent by default)", async () => {
  const ledger = createMemoryEvidenceLedger({ vocabulary: [EFFECT_EMITTED, EFFECT_REPLAY_REFUSED] });
  const barrier = createEffectLedger(ledger);
  await barrier.emit({ effectKey: "charge:2", scopeLabel: "s", kind: "http" });
  const emitted = await ledger.list({ scopeLabel: "s", action: EFFECT_EMITTED });
  assert.equal("toolUseId" in (emitted[0].detail as object), false, "no toolUseId key when none was supplied");
});
