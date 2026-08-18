import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryEvidenceLedger,
  createEffectLedger,
  EFFECT_EMITTED,
  EFFECT_REPLAY_REFUSED,
} from "../src/index.ts";

/**
 * RIP-LIST #11 (deny-reason only, no auto-approve state). When the barrier refuses a spent effect
 * across a rewind, it must hand the agent a stable, actionable REASON string so the agent adapts
 * instead of blindly retrying. The same reason is already written to the chain; it must also ride on
 * the returned EffectRefusal.
 */
test("a refusal returns a structured, agent-actionable reason string", async () => {
  const ledger = createMemoryEvidenceLedger({ vocabulary: [EFFECT_EMITTED, EFFECT_REPLAY_REFUSED] });
  const barrier = createEffectLedger(ledger);
  const eff = { effectKey: "charge:1", scopeLabel: "s", kind: "http" };

  const first = await barrier.emit(eff);
  assert.equal(first.refused, false, "the first emit is admitted");

  const refusal = await barrier.emit(eff);
  assert.equal(refusal.refused, true);
  assert.equal(typeof (refusal as { reason?: unknown }).reason, "string");
  assert.match((refusal as { reason: string }).reason, /spent|not replayable|across a revert/i);
});

test("the reason on the refusal matches the reason recorded on the chain", async () => {
  const ledger = createMemoryEvidenceLedger({ vocabulary: [EFFECT_EMITTED, EFFECT_REPLAY_REFUSED] });
  const barrier = createEffectLedger(ledger);
  const eff = { effectKey: "charge:1", scopeLabel: "s", kind: "http" };
  await barrier.emit(eff);
  const refusal = (await barrier.emit(eff)) as { refused: true; reason: string };

  const refusedEntries = await ledger.list({ scopeLabel: "s", action: EFFECT_REPLAY_REFUSED });
  const recorded = (refusedEntries[0].detail as { reason?: string }).reason;
  assert.equal(refusal.reason, recorded, "the returned reason is the SAME string the chain recorded");
});
