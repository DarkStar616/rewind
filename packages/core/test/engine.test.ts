import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createEngine } from "../src/engine.ts";
import { createMemoryEvidenceLedger } from "../src/audit/evidence-ledger.ts";
import { EFFECT_EMITTED, EFFECT_REPLAY_REFUSED } from "../src/audit/effect-ledger.ts";
import { createGitBackend } from "../src/world/git-backend.ts";
import { createMemoryReplaySavings } from "../src/replay/replay-savings.ts";

// The full SLICE-0 acceptance demo, driven at the engine level: checkpoint → a bash edit →
// guard(effect A) admitted → rewind the whole workspace → guard(effect A again) REFUSED and
// recorded on the chain → the tamper-evident chain still verifies. The refusable effects come
// from the chain, never the filesystem.
test("engine: checkpoint → bash edit → guard admitted → rewind → guard refused-and-recorded → chain verifies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-engine-"));
  try {
    await writeFile(join(dir, "a.txt"), "original");
    const store = createMemoryEvidenceLedger({ vocabulary: [EFFECT_EMITTED, EFFECT_REPLAY_REFUSED] });
    const backend = createGitBackend({ cwd: dir, log: () => {} });
    const savings = createMemoryReplaySavings();
    const engine = createEngine({ cwd: dir, store, backend, savings });

    const snap = await engine.checkpoint("before");

    // Mutate the workspace via a real shell command (the acceptance bar requires bash edits).
    execFileSync("bash", ["-c", "echo mutated > a.txt"], { cwd: dir });
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "mutated\n");

    // First fire of the external effect is admitted.
    const first = await engine.guard({ effectKey: "charge:42", scopeLabel: "s", kind: "http" });
    assert.equal(first.refused, false);

    // Rewind the whole workspace back to the checkpoint.
    const rewound = await engine.rewind(snap);
    assert.equal(rewound.restoredTo, snap.id);
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "original");

    // The spent effect is surfaced from the CHAIN as now-refusable (never read from the FS).
    assert.ok(
      rewound.refusableEffects.some((e) => e.effectKey === "charge:42" && e.scopeLabel === "s"),
      "the emitted effect must be reported as refusable-on-replay after a rewind",
    );

    // Re-firing the same effect across the rewind is REFUSED and recorded on the chain.
    const second = await engine.guard({ effectKey: "charge:42", scopeLabel: "s", kind: "http" });
    assert.equal(second.refused, true);
    if (second.refused) assert.equal(second.firstEmittedSeq, 0);
    const refusals = await store.list({ scopeLabel: "s", action: EFFECT_REPLAY_REFUSED });
    assert.equal(refusals.length, 1);

    // The tamper-evident chain still verifies after the whole demo.
    assert.equal((await store.verify("s")).ok, true);

    // The checkpoint shows up in the engine's log.
    const log = await engine.list();
    assert.ok(log.some((r) => r.id === snap.id));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("engine: savings() reflects the sink and replay() reports the recorded savings for a real checkpoint", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-engine-"));
  try {
    await writeFile(join(dir, "a.txt"), "x");
    const store = createMemoryEvidenceLedger({ vocabulary: [EFFECT_EMITTED, EFFECT_REPLAY_REFUSED] });
    const backend = createGitBackend({ cwd: dir, log: () => {} });
    const savings = createMemoryReplaySavings();
    const engine = createEngine({ cwd: dir, store, backend, savings });

    const snap = await engine.checkpoint();
    savings.record({ scope: "s", tokensAvoided: 1200, costMicros: 5000, model: "m", callId: "c1" });

    assert.deepEqual(engine.savings("s"), { tokens: 1200, costMicros: 5000 });

    const rep = await engine.replay(snap);
    assert.equal(rep.replayedFrom, snap.id);
    assert.equal(rep.tokensAvoided, 1200);
    assert.equal(rep.costMicros, 5000);

    // Replaying an unknown checkpoint is refused rather than silently reporting savings.
    await assert.rejects(engine.replay("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
