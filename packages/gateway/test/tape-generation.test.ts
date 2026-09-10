import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStorage } from "../src/storage/sqlite-store.ts";
import { createSqliteRecordStoreV2 } from "../src/record-store-v2.ts";
import { startProxy } from "../src/proxy.ts";
import { createMemoryRecordStore } from "../src/record-store.ts";
import { createReplayer } from "../src/replay.ts";
import { createMemoryReplaySavings } from "@agent-rewind/core";

test("legacy epochs remain inspectable but cannot accept the new request generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-generation-"));
  const wrappingKey = randomBytes(32);
  let db = await openSqliteStorage({ directory, tenant: "t", wrappingKey });
  try {
    // Original epoch/v1 bytes, before identity-generation metadata existed.
    const scope = '["t","scope"]';
    const key = createHash("sha256").update(JSON.stringify(["epoch", scope, "old"])).digest("hex");
    const legacy = Buffer.from(JSON.stringify({ schema: "rewind.epoch/v1", scope, epoch: "old", length: 0 }));
    await db.commit("seed-legacy", [{ namespace: "epochs", key, value: legacy, expectedRevision: null }]);
    let tape = createSqliteRecordStoreV2(db);
    assert.equal((await tape.epoch(scope, "old") as {identityGeneration?: number}).identityGeneration, 1);
    await assert.rejects(tape.createEpoch(scope, "old", "new-writer"), /legacy.*generation/);
    await assert.rejects(tape.openCursor(scope, "old", "legacy-reader", "open"), /legacy.*generation/);
    await assert.rejects(tape.consume({ scope, epoch: "old", cursorId: "legacy-reader", ordinal: 0, revision: 1 }, "a".repeat(64), "consume"), /legacy.*generation/);
    assert.deepEqual((await db.get("epochs", key))!.value, legacy);
    for (const replayCursor of [undefined, "old-cursor"]) {
      const store = createMemoryRecordStore();
      const proxy = await startProxy({ upstreamBase: "http://127.0.0.1:1", resolveScope: () => ({ tenant: "t", scope: "scope" }), store, replayer: createReplayer(store, createMemoryReplaySavings()), tape: { store: tape, epoch: "old", replayCursor } });
      try {
        const response = await fetch(`${proxy.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-rewind-scope": "scope" }, body: '{"model":"m","messages":[]}' });
        assert.equal(response.status, 409);
        assert.equal(response.headers.get("x-rewind"), "legacy-identity");
        const body = await response.json() as {error:{type:string;message:string}};
        assert.equal(body.error.type, "rewind_legacy_identity");
        assert.match(body.error.message, /start a new epoch/);
        assert.equal(await tape.cursor(scope, "old-cursor"), undefined);
      } finally { await proxy.close(); }
    }
    assert.deepEqual((await db.get("epochs", key))!.value, legacy);
    await tape.createEpoch(scope, "new", "create");
    const newKey = createHash("sha256").update(JSON.stringify(["epoch", scope, "new"])).digest("hex");
    const newMetadata = JSON.parse((await db.get("epochs", newKey))!.value.toString());
    assert.equal(newMetadata.schema, "rewind.epoch/v2", "old writers must reject the new epoch schema");
    await db.close();
    db = await openSqliteStorage({ directory, tenant: "t", wrappingKey });
    tape = createSqliteRecordStoreV2(db);
    assert.equal((await tape.epoch(scope, "new") as {identityGeneration?: number}).identityGeneration, 2);
  } finally {
    await db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
