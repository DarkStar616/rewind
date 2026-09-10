import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSqliteStorage } from "../src/storage/sqlite-store.ts";
import { createSqliteRecordStoreV2, type HttpOccurrence } from "../src/record-store-v2.ts";
import { canonicalizeRequest } from "../src/canonical-request.ts";
const wrappingKey = Buffer.alloc(32, 11);
const replayKey = canonicalizeRequest({ model: "test", messages: [{ role: "user", content: "same stochastic prompt" }] });

test("provider bytes are the authority for occurrence model and usage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-tape-usage-"));
  const storage = await openSqliteStorage({ directory, tenant: "tenant", wrappingKey });
  try {
    const tape = createSqliteRecordStoreV2(storage);
    await tape.createEpoch("scope", "epoch", "create");
    await assert.rejects(tape.append({ ...occurrence(0, "first"), usage: { input_tokens: 1_000_000, output_tokens: 500_000 } }, "inflated"), /usage/);
    const rec = occurrence(0, "first");
    rec.response.body = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(rec.response.body).toString()), model: "real-model" }));
    await assert.rejects(tape.append(rec, "wrong-model"), /model/);
    assert.equal((await tape.epoch("scope", "epoch")).length, 0);
  } finally { await storage.close(); await rm(directory, { recursive: true, force: true }); }
});

test("strict consume policy is captured before asynchronous lookup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-tape-policy-"));
  const storage = await openSqliteStorage({ directory, tenant: "tenant", wrappingKey });
  try {
    const tape = createSqliteRecordStoreV2(storage);
    await tape.createEpoch("scope", "epoch", "create");
    const cursor = await tape.openCursor("scope", "epoch", "cursor", "open");
    const policy = { strict: true };
    const pending = tape.consume(cursor, replayKey, "consume", policy);
    policy.strict = false;
    await assert.rejects(pending, /strict replay miss/);
  } finally { await storage.close(); await rm(directory, { recursive: true, force: true }); }
});
function occurrence(ordinal: number, text: string): HttpOccurrence {
  return { scope: "scope", epoch: "epoch", ordinal, replayKey, provider: "anthropic", model: "test", usage: { input_tokens: 10, output_tokens: 2 }, response: { status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify({ type: "message", content: [{ type: "text", text }], usage: { input_tokens: 10, output_tokens: 2 } })) } };
}

test("same-key stochastic occurrences stay immutable and replay in order after reopening", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-tape-"));
  let storage = await openSqliteStorage({ directory, tenant: "tenant", wrappingKey });
  try {
    let tape = createSqliteRecordStoreV2(storage);
    await tape.createEpoch("scope", "epoch", "create");
    assert.equal((await tape.append(occurrence(0, "first"), "record-first")).replayed, false);
    assert.equal((await tape.append(occurrence(0, "first"), "record-first")).replayed, true);
    await tape.append(occurrence(1, "second"), "record-second");
    assert.equal((await tape.epoch("scope", "epoch")).length, 2);
    await assert.rejects(tape.append(occurrence(0, "overwritten"), "record-new"), /immutable|conflict/);
    let cursor = await tape.openCursor("scope", "epoch", "cursor", "open");
    await storage.close(); storage = await openSqliteStorage({ directory, tenant: "tenant", wrappingKey }); tape = createSqliteRecordStoreV2(storage);
    cursor = (await tape.cursor("scope", "cursor"))!;
    const first = (await tape.consume(cursor, replayKey, "consume-first"))!;
    assert.deepEqual(first.occurrence.response.body, occurrence(0, "first").response.body);
    assert.equal((await tape.consume(cursor, replayKey, "consume-first"))!.replayed, true);
    const second = (await tape.consume(first.cursor, replayKey, "consume-second"))!;
    assert.deepEqual(second.occurrence.response.body, occurrence(1, "second").response.body);
    assert.equal(second.cursor.ordinal, 2);
    const rewound = await tape.rewind(second.cursor, 0, "rewind");
    assert.deepEqual((await tape.peek(rewound, replayKey))!.response.body, occurrence(0, "first").response.body);
  } finally { await storage.close(); await rm(directory, { recursive: true, force: true }); }
});

test("mismatch and strict miss do not move cursor; concurrent claims consume once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-tape-claims-"));
  const storage = await openSqliteStorage({ directory, tenant: "tenant", wrappingKey });
  const other = await openSqliteStorage({ directory, tenant: "tenant", wrappingKey });
  try {
    const tape = createSqliteRecordStoreV2(storage), concurrent = createSqliteRecordStoreV2(other);
    await tape.createEpoch("scope", "epoch", "create"); await tape.append(occurrence(0, "first"), "record");
    const cursor = await tape.openCursor("scope", "epoch", "cursor", "open");
    assert.equal(await tape.consume(cursor, "b".repeat(64), "mismatch"), undefined);
    await assert.rejects(tape.consume(cursor, "b".repeat(64), "strict", { strict: true }), /strict.*miss/i);
    assert.equal((await tape.cursor("scope", "cursor"))!.revision, cursor.revision);
    const results = await Promise.allSettled([tape.consume(cursor, replayKey, "a"), concurrent.consume(cursor, replayKey, "b")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await tape.cursor("scope", "cursor"))!.ordinal, 1);
  } finally { await other.close(); await storage.close(); await rm(directory, { recursive: true, force: true }); }
});

test("malformed authenticated occurrences are quarantined and invalid inputs never append", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-tape-corrupt-"));
  const storage = await openSqliteStorage({ directory, tenant: "tenant", wrappingKey });
  try {
    const tape = createSqliteRecordStoreV2(storage);
    await tape.createEpoch("scope", "epoch", "create");
    await assert.rejects(tape.append({ ...occurrence(0, "first"), usage: { input_tokens: -1 } }, "bad"));
    await tape.append(occurrence(0, "first"), "record");
    const raw = (await storage.scan("occurrences")).items[0];
    assert.ok(raw.value.includes(Buffer.from(occurrence(0, "first").response.body)), "binary body is present directly in decrypted frame");
    await storage.commit("corrupt", [{ namespace: "occurrences", key: raw.key, value: Buffer.from("bad frame") }]);
    const cursor = await tape.openCursor("scope", "epoch", "cursor", "open");
    await assert.rejects(tape.peek(cursor, replayKey), /quarantin|corrupt/i);
    assert.equal((await storage.scan("quarantine")).items.length, 1);
    assert.equal((await tape.cursor("scope", "cursor"))!.ordinal, 0);
    await assert.rejects(tape.peek(cursor, replayKey), /quarantin/i);
  } finally { await storage.close(); await rm(directory, { recursive: true, force: true }); }
});

test("reused claim identity cannot turn a changed prompt into a live miss", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-tape-retry-"));
  const storage = await openSqliteStorage({ directory, tenant: "tenant", wrappingKey });
  try {
    const tape = createSqliteRecordStoreV2(storage);
    await tape.createEpoch("scope", "epoch", "create"); await tape.append(occurrence(0, "first"), "record");
    const cursor = await tape.openCursor("scope", "epoch", "cursor", "open");
    await tape.consume(cursor, replayKey, "claim");
    await assert.rejects(tape.consume(cursor, "b".repeat(64), "claim"), /identity conflict/);
  } finally { await storage.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a body digest mismatch is quarantined before returning provider bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-tape-digest-"));
  const storage = await openSqliteStorage({ directory, tenant: "tenant", wrappingKey });
  try {
    const tape = createSqliteRecordStoreV2(storage);
    await tape.createEpoch("scope", "epoch", "create"); await tape.append(occurrence(0, "first"), "record");
    const row = (await storage.scan("occurrences")).items[0];
    const changed = Buffer.from(row.value); changed[changed.length - 2] ^= 1;
    await storage.commit("corrupt", [{ namespace: "occurrences", key: row.key, value: changed }]);
    const cursor = await tape.openCursor("scope", "epoch", "cursor", "open");
    await assert.rejects(tape.consume(cursor, replayKey, "consume"), /corrupt|quarantin/);
    assert.equal((await tape.cursor("scope", "cursor"))!.ordinal, 0);
  } finally { await storage.close(); await rm(directory, { recursive: true, force: true }); }
});

test("scope and fixed-tenant storage separate otherwise identical tapes", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "rewind-tape-tenant-a-"));
  const secondDir = await mkdtemp(join(tmpdir(), "rewind-tape-tenant-b-"));
  const first = await openSqliteStorage({ directory: firstDir, tenant: "tenant-a", wrappingKey });
  const second = await openSqliteStorage({ directory: secondDir, tenant: "tenant-b", wrappingKey });
  try {
    const a = createSqliteRecordStoreV2(first), b = createSqliteRecordStoreV2(second);
    for (const [tape, text] of [[a, "tenant-a"], [b, "tenant-b"]] as const) {
      await tape.createEpoch("scope", "epoch", "create"); await tape.append(occurrence(0, text), "record");
      await tape.openCursor("scope", "epoch", "cursor", "open");
    }
    const ca = (await a.cursor("scope", "cursor"))!, cb = (await b.cursor("scope", "cursor"))!;
    assert.notDeepEqual((await a.peek(ca, replayKey))!.response.body, (await b.peek(cb, replayKey))!.response.body);
    assert.equal(await a.cursor("other-scope", "cursor"), undefined);
    await assert.rejects(openSqliteStorage({ directory: firstDir, tenant: "tenant-b", wrappingKey }), /identity|key/);
  } finally { await first.close(); await second.close(); await rm(firstDir, { recursive: true, force: true }); await rm(secondDir, { recursive: true, force: true }); }
});

test("expired occurrences miss without advancing, and unsafe HTTP/count metadata never records", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-tape-expiry-"));
  const storage = await openSqliteStorage({ directory, tenant: "tenant", wrappingKey });
  try {
    const tape = createSqliteRecordStoreV2(storage, { maxBodyBytes: 1024 });
    await tape.createEpoch("scope", "epoch", "create");
    const original = occurrence(0, "first");
    for (const response of [{ ...original.response, status: 500 }, { ...original.response, contentType: "application/json\r\ninjected: true" }, { ...original.response, body: Buffer.from('{"type":"error"}') }, { ...original.response, body: Buffer.alloc(1025) }]) {
      await assert.rejects(tape.append({ ...original, response }, "invalid"));
    }
    await assert.rejects(tape.append({ ...original, usage: { input_tokens: null as any } }, "invalid-usage"));
    await tape.append({ ...original, expiresAt: Date.now() - 1 }, "expired");
    const cursor = await tape.openCursor("scope", "epoch", "cursor", "open");
    assert.equal(await tape.consume(cursor, replayKey, "miss"), undefined);
    assert.equal((await tape.cursor("scope", "cursor"))!.revision, cursor.revision);
  } finally { await storage.close(); await rm(directory, { recursive: true, force: true }); }
});
