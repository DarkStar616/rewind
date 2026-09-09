import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileRewindMemory } from "../src/durable-rewind-memory.ts";
import { createFileEvidenceLedger } from "../src/store.ts";

test("scope names matching Object prototype keys survive memory-store restart and stay isolated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-scope-"));
  try {
    const path = join(directory, "memory.json");
    const scopes = ["__proto__", "constructor", "toString", "ordinary"];
    for (const scope of scopes) {
      const store = createFileRewindMemory({ path });
      assert.deepEqual(store.all(scope), []);
      store.record({ scope, seq: 0, checkpointId: "cp", goal: "g", outcome: "failure", note: scope, at: 1 });
    }
    for (const scope of scopes) {
      const records = createFileRewindMemory({ path }).all(scope);
      assert.equal(records.length, 1); assert.equal(records[0].note, scope);
    }
    assert.equal(Object.hasOwn(Object.prototype, "0"), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("evidence chains persist prototype-named scopes across fresh ledger instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-ledger-scope-"));
  try {
    const path = join(directory, "evidence.json");
    for (const scopeLabel of ["__proto__", "constructor", "ordinary"]) {
      await createFileEvidenceLedger({ path }).append({ scopeLabel, action: "test", detail: { scopeLabel } });
    }
    for (const scopeLabel of ["__proto__", "constructor", "ordinary"]) {
      const ledger = createFileEvidenceLedger({ path });
      const entries = await ledger.list({ scopeLabel });
      assert.equal(entries.length, 1); assert.equal(entries[0].scopeLabel, scopeLabel);
      assert.equal((await ledger.verify(scopeLabel)).ok, true);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
