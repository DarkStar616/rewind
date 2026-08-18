import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryEvidenceLedger, verifyChain } from "../src/audit/evidence-ledger.ts";

test("verify passes on an untouched chain and fails when an interior field is edited", async () => {
  const led = createMemoryEvidenceLedger();
  await led.append({ scopeLabel: "s", action: "a", detail: { n: 1 } });
  await led.append({ scopeLabel: "s", action: "a", detail: { n: 2 } });
  assert.equal((await led.verify("s")).ok, true);
  const entries = [...(await led.list({ scopeLabel: "s" }))];
  const tampered = entries.map((e, i) => (i === 0 ? { ...e, detail: { n: 999 } } : e));
  const res = verifyChain(tampered);
  assert.equal(res.ok, false);
  assert.equal(res.brokenAtSeq, 0);
});

test("an unknown action is rejected when a vocabulary is injected", async () => {
  const led = createMemoryEvidenceLedger({ vocabulary: ["allowed"] });
  await assert.rejects(led.append({ scopeLabel: "s", action: "nope", detail: null }));
});
