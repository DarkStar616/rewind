import { test } from "node:test";
import { once } from "node:events";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSqliteStorage } from "../src/storage/sqlite-store.ts";
const key = Buffer.alloc(32, 7);

test("encrypted binary state survives restart and transaction retries are idempotent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-storage-"));
  try {
    let store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key });
    const value = Buffer.from([0, 255, 1, 128]);
    const mutations = [{ namespace: "records", key: "private-request-label", value, expectedRevision: null }];
    const first = await store.commit("transaction-private", mutations);
    assert.equal(first.replayed, false);
    assert.equal((await store.commit("transaction-private", mutations)).replayed, true);
    await assert.rejects(store.commit("transaction-private", [{ ...mutations[0], value: Buffer.from("different") }]), /conflict/i);
    assert.deepEqual((await store.get("records", "private-request-label"))?.value, value);
    await store.close();
    store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key });
    assert.deepEqual((await store.get("records", "private-request-label"))?.value, value);
    await store.close();
    const bytes = await readFile(join(dir, "storage.sqlite"));
    assert.equal(bytes.includes(Buffer.from("private-request-label")), false);
    assert.equal(bytes.includes(Buffer.from("transaction-private")), false);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, "storage.sqlite"))).mode & 0o777, 0o600);
    await assert.rejects(openSqliteStorage({ directory: dir, tenant: "other", wrappingKey: key }), /identity|key/i);
    await assert.rejects(openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: Buffer.alloc(32, 9) }), /identity|key/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("atomic conditional mutations, scoped scan, TTL and bounds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-storage-"));
  const store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key, maxValueBytes: 128, maxQueuedBytes: 4096, maxResponseBytes: 1024 });
  try {
    const first = await store.commit("first", [{ namespace: "records", key: "one", value: Buffer.from("one"), expectedRevision: null }]);
    await assert.rejects(store.commit("conflict", [{ namespace: "records", key: "two", value: Buffer.from("two") }, { namespace: "records", key: "one", value: Buffer.from("bad"), expectedRevision: null }]), /conflict/i);
    assert.equal(await store.get("records", "two"), undefined);
    await store.commit("update", [{ namespace: "records", key: "one", value: Buffer.from("updated"), expectedRevision: first.revisions[0] }, { namespace: "records", key: "expired", value: Buffer.from("expired"), expiresAt: Date.now() - 1 }]);
    assert.equal(await store.get("records", "expired"), undefined);
    assert.equal((await store.scan("records", { limit: 1 })).items.length, 1);
    assert.equal((await store.scan("other", { limit: 1 })).items.length, 0);
    await assert.rejects(store.commit("too-big", [{ namespace: "records", key: "big", value: Buffer.alloc(129) }]), /limit|size/i);
    await assert.rejects(store.commit("duplicate", [{ namespace: "records", key: "same", value: Buffer.alloc(1) }, { namespace: "records", key: "same", value: Buffer.alloc(1) }]), /duplicate/i);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("two OS processes serialize conditional admission and preserve all independent writes", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const dir = await mkdtemp(join(tmpdir(), "rewind-storage-process-"));
  const moduleUrl = new URL("../src/storage/sqlite-store.ts", import.meta.url).href;
  const script = `import {openSqliteStorage} from ${JSON.stringify(moduleUrl)};
    const s=await openSqliteStorage({directory:process.argv[1],tenant:'tenant',wrappingKey:Buffer.alloc(32,7)});
    try { await s.commit('admit-'+process.argv[2],[{namespace:'effects',key:'shared',value:Buffer.from(process.argv[2]),expectedRevision:null}]); } catch(e) { if(!e.message.includes('conflict')) throw e; }
    for(let i=0;i<12;i++) await s.commit(process.argv[2]+'-'+i,[{namespace:'records',key:process.argv[2]+'-'+i,value:Buffer.from('value-'+i),expectedRevision:null}]);
    await s.close();`;
  try {
    const run = promisify(execFile);
    await Promise.all(["a", "b"].map((id) => run(process.execPath, ["--input-type=module", "-e", script, dir, id])));
    const store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key });
    try { assert.equal((await store.scan("records", { limit: 128 })).items.length, 24); assert.equal((await store.scan("effects")).items.length, 1); }
    finally { await store.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("row swaps and corrupted authentication tags fail visibly", async () => {
  const { createRequire } = await import("node:module");
  const Database = createRequire(import.meta.url)("better-sqlite3");
  const dir = await mkdtemp(join(tmpdir(), "rewind-storage-corrupt-"));
  let store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key });
  try {
    await store.commit("seed", ["a", "b"].map((label) => ({ namespace: "records", key: label, value: Buffer.from("sensitive-body-" + label) })));
    await store.close();
    const db = new Database(join(dir, "storage.sqlite"));
    const rows = db.prepare("SELECT id,payload FROM values_store ORDER BY id").all();
    db.prepare("UPDATE values_store SET payload=? WHERE id=?").run(rows[1].payload, rows[0].id);
    db.close();
    store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key });
    await assert.rejects(store.scan("records"), /authentication/);
    await store.close();
    const corrupt = new Database(join(dir, "storage.sqlite"));
    corrupt.prepare("UPDATE values_store SET payload=zeroblob(length(payload))").run(); corrupt.close();
    store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key });
    await assert.rejects(store.get("records", "a"), /authentication/);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("bounded request queue rejects excess work and close drains admitted operations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-storage-queue-"));
  const store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key, maxQueuedRequests: 1 });
  try {
    const first = store.get("records", "one");
    await assert.rejects(store.get("records", "two"), /queue/);
    await first;
    const pending = store.get("records", "three");
    await store.close(); await pending;
    await assert.rejects(store.get("records", "four"), /closed/);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("encrypted staging hides incomplete data, bounds chunks and survives reopening", async () => {
  const { createEncryptedStaging } = await import("../src/storage/encrypted-staging.ts");
  const dir = await mkdtemp(join(tmpdir(), "rewind-storage-stage-"));
  let store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key });
  try {
    let staging = createEncryptedStaging(store, { maxStageBytes: 8 });
    const handle = await staging.begin();
    await staging.append(handle, 0, Buffer.from("one"));
    await staging.append(handle, 0, Buffer.from("one"));
    await assert.rejects(staging.read(handle).next(), /incomplete/);
    await assert.rejects(staging.append(handle, 1, Buffer.alloc(6)), /limit/);
    await store.close();
    store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key });
    staging = createEncryptedStaging(store, { maxStageBytes: 8 });
    await staging.append(handle, 1, Buffer.from("two"));
    assert.equal((await staging.seal(handle)).bytes, 6);
    const chunks: Buffer[] = [];
    for await (const chunk of staging.read(handle)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), "onetwo");
    await assert.rejects(staging.append(handle, 2, Buffer.from("x")), /sealed/);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("missing optional native driver gives an actionable failure rather than memory fallback", async () => {
  const { copyFile } = await import("node:fs/promises");
  const { Worker } = await import("node:worker_threads");
  const dir = await mkdtemp(join(tmpdir(), "rewind-storage-no-driver-"));
  try {
    const file = join(dir, "storage-worker.ts");
    await copyFile(new URL("../src/storage/storage-worker.ts", import.meta.url), file);
    const worker = new Worker(file, { execArgv: [], workerData: {} });
    try {
      const [message] = await once(worker, "message");
      assert.match(message.startupError, /optional better-sqlite3@12.11.1/);
      assert.match(message.startupError, /no memory fallback/);
    } finally { await worker.terminate(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unknown schema is refused and database quota rolls back atomically", async () => {
  const { createRequire } = await import("node:module");
  const Database = createRequire(import.meta.url)("better-sqlite3");
  const dir = await mkdtemp(join(tmpdir(), "rewind-storage-quota-"));
  let store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key, maxDatabaseBytes: 65536, maxValueBytes: 20000, maxResponseBytes: 22000, maxQueuedBytes: 65536 });
  try {
    await store.commit("one", [{ namespace: "records", key: "one", value: Buffer.alloc(20000, 8) }]);
    await assert.rejects(store.commit("two", [{ namespace: "records", key: "two", value: Buffer.alloc(20000, 9) }]), /quota|SQLite/);
    assert.equal(await store.get("records", "two"), undefined);
    assert.equal((await store.get("records", "one"))?.value.length, 20000);
    await store.close();
    const db = new Database(join(dir, "storage.sqlite")); db.pragma("user_version=99"); db.close();
    await assert.rejects(openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key }), /schema/);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("expired ciphertext is collected and revisions never repeat after collection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-storage-expiry-"));
  const store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key });
  try {
    const first = await store.commit("expired", [{ namespace: "staging", key: "orphan", value: Buffer.from("orphan"), expiresAt: Date.now() - 1 }]);
    assert.equal(await store.collectExpired(), 1);
    const second = await store.commit("new", [{ namespace: "staging", key: "orphan", value: Buffer.from("new"), expectedRevision: null }]);
    assert.ok(second.revisions[0] > first.revisions[0]);
    await assert.rejects(store.commit("stale", [{ namespace: "staging", key: "orphan", value: Buffer.from("stale"), expectedRevision: first.revisions[0] }]), /conflict/);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});


test("tampered deletion, expiry or revision cannot become a miss or conditional overwrite", async () => {
  const { createRequire } = await import("node:module");
  const Database = createRequire(import.meta.url)("better-sqlite3");
  for (const assignment of ["deleted=1", "expires=1", "revision=999"]) {
    const dir = await mkdtemp(join(tmpdir(), "rewind-storage-metadata-"));
    const store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key });
    try {
      await store.commit("seed", [{ namespace: "records", key: "one", value: Buffer.from("authentic") }]);
      const db = new Database(join(dir, "storage.sqlite")); db.exec(`UPDATE values_store SET ${assignment}`); db.close();
      await assert.rejects(store.get("records", "one"), /authentication/);
      await assert.rejects(store.get("records", "absent"), /disabled/);
      await assert.rejects(store.commit("replace", [{ namespace: "records", key: "one", value: Buffer.from("overwritten"), expectedRevision: null }]), /disabled/);
    } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
  }
});


test("sealed staging verifies each chunk before yielding any changed bytes", async () => {
  const { createEncryptedStaging } = await import("../src/storage/encrypted-staging.ts");
  const dir = await mkdtemp(join(tmpdir(), "rewind-storage-stage-integrity-"));
  const store = await openSqliteStorage({ directory: dir, tenant: "tenant", wrappingKey: key });
  try {
    const staging = createEncryptedStaging(store);
    const handle = await staging.begin();
    await staging.append(handle, 0, Buffer.from("original")); await staging.seal(handle);
    await store.commit("replace-chunk", [{ namespace: "staging", key: `${handle}/chunk/0`, value: Buffer.from("changed!") }]);
    await assert.rejects(staging.read(handle).next(), /integrity/);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
