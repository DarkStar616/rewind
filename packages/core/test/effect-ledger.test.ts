import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryEvidenceLedger } from "../src/audit/evidence-ledger.ts";
import { createEffectLedger, EFFECT_REPLAY_REFUSED } from "../src/audit/effect-ledger.ts";

test("first emit is admitted; a second emit of the same key is refused and recorded citing the first", async () => {
  const led = createMemoryEvidenceLedger({ vocabulary: ["effect_emitted", "effect_replay_refused"] });
  const eff = createEffectLedger(led);
  const first = await eff.emit({ effectKey: "charge:42", scopeLabel: "s", kind: "http" });
  assert.equal(first.refused, false);
  const second = await eff.emit({ effectKey: "charge:42", scopeLabel: "s", kind: "http" });
  assert.equal(second.refused, true);
  assert.equal(second.firstEmittedSeq, 0);
  const refusals = await led.list({ scopeLabel: "s", action: EFFECT_REPLAY_REFUSED });
  assert.equal(refusals.length, 1);
  assert.equal((await led.verify("s")).ok, true);
});

test("concurrent double-emit of the same key yields exactly one admission and one spent entry", async () => {
  const led = createMemoryEvidenceLedger({ vocabulary: ["effect_emitted", "effect_replay_refused"] });
  const eff = createEffectLedger(led);
  const [a, b] = await Promise.all([
    eff.emit({ effectKey: "charge:99", scopeLabel: "s", kind: "http" }),
    eff.emit({ effectKey: "charge:99", scopeLabel: "s", kind: "http" }),
  ]);
  const admitted = [a, b].filter((r) => r.refused === false);
  assert.equal(admitted.length, 1, "exactly one emit may be admitted");
  const emitted = await led.list({ scopeLabel: "s", action: "effect_emitted" });
  assert.equal(emitted.length, 1, "exactly one spent entry may exist");
});
