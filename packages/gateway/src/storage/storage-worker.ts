import { parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";
import { mkdirSync, lstatSync, openSync, closeSync, constants } from "node:fs";
import { join } from "node:path";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { SqliteStorageOptions, StorageMutation } from "./sqlite-store.ts";

const config = workerData as Required<SqliteStorageOptions>;
const port = parentPort!;
let db: any;
let dek: Buffer = Buffer.alloc(0);
let tenantTag: string;
let poisoned = false;
const schema = 1;
const fail = (message: string): never => { throw new Error(message); };
const hmac = (key: Buffer, value: string): string => createHmac("sha256", key).update(value).digest("hex");
const identity = (namespace: string, key: string): string => hmac(dek, JSON.stringify([namespace, key]));
function coordinates(namespace: unknown, key: unknown): void {
  if (typeof namespace !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(namespace) || typeof key !== "string" || !key.length || Buffer.byteLength(key) > 512 || Buffer.from(key).toString("utf8") !== key) fail("invalid storage coordinates");
}
function seal(key: Buffer, bytes: Buffer, aad: string): Buffer {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}
function unseal(key: Buffer, bytes: Buffer, aad: string): Buffer {
  try {
    if (bytes.length < 28) fail("short encrypted value");
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
  } catch { poisoned = true; return fail("storage authentication failed; corrupt value or wrong key"); }
}
const aad = (row: any): string => JSON.stringify([schema, tenantTag, row.namespace, row.id, row.revision, row.expires, row.deleted]);
function decode(row: any): any {
  try {
  if (row.payload.length > config.maxValueBytes + 544) fail("storage value size limit exceeded");
  const bytes = unseal(dek, row.payload, aad(row));
  const keyLength = bytes.readUInt32BE(0);
  if (keyLength > 512 || bytes.length < 4 + keyLength) fail("storage key framing corrupt");
  const key = bytes.subarray(4, 4 + keyLength).toString("utf8");
  if (identity(row.namespace, key) !== row.id) fail("storage key authentication failed");
  return { key, value: bytes.subarray(4 + keyLength), revision: row.revision, ...(row.expires === null ? {} : { expiresAt: row.expires }) };
  } catch { poisoned = true; return fail("storage authentication failed; corrupt value or incompatible size limit"); }
}
function init(): void {
  let Database: any;
  try { Database = createRequire(import.meta.url)("better-sqlite3"); }
  catch { fail("Durable storage unavailable: install optional better-sqlite3@12.11.1 with a native toolchain for this Node ABI; no memory fallback"); }
  mkdirSync(config.directory, { recursive: true, mode: 0o700 });
  const directory = lstatSync(config.directory);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) || (process.getuid && directory.uid !== process.getuid())) fail("storage requires an owner-only directory (0700)");
  const path = join(config.directory, "storage.sqlite");
  try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) || (process.getuid && file.uid !== process.getuid())) fail("storage requires an owner-only regular database (0600)");
  try { db = new Database(path); } catch { fail("Durable storage unavailable: SQLite native binding/open failed; install optional dependencies for this Node ABI; no memory fallback"); }
  db.pragma("busy_timeout = 5000"); db.pragma("journal_mode = WAL"); db.pragma("synchronous = FULL");
  const pageSize = db.pragma("page_size", { simple: true });
  if (db.pragma("page_count", { simple: true }) * pageSize > config.maxDatabaseBytes) fail("storage database quota exceeded at open");
  db.pragma(`max_page_count = ${Math.floor(config.maxDatabaseBytes / pageSize)}`);
  db.pragma("wal_autocheckpoint = 100"); db.pragma(`journal_size_limit = ${config.maxDatabaseBytes}`);
  const kek = Buffer.from(config.wrappingKey);
  tenantTag = hmac(kek, JSON.stringify(["tenant", config.tenant]));
  try {
    db.transaction(() => {
      const version = db.pragma("user_version", { simple: true });
      if (version !== 0 && version !== schema) fail("unsupported storage schema version");
      if (version === 0) {
        if (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get().n !== 0) fail("unrecognized storage schema");
        db.exec("CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1), tenant TEXT NOT NULL, wrapped BLOB NOT NULL, revision INTEGER NOT NULL); CREATE TABLE values_store(namespace TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,expires INTEGER,deleted INTEGER NOT NULL,payload BLOB NOT NULL, PRIMARY KEY(namespace,id)); CREATE TABLE transactions_store(id TEXT PRIMARY KEY,digest TEXT NOT NULL,result BLOB NOT NULL)");
        dek = randomBytes(32);
        db.prepare("INSERT INTO metadata VALUES(1,?,?,0)").run(tenantTag, seal(kek, dek, JSON.stringify([schema, tenantTag, "data-key"])));
        db.pragma(`user_version = ${schema}`);
      } else {
        const metadata = db.prepare("SELECT * FROM metadata WHERE id=1").get();
        if (!metadata || metadata.tenant !== tenantTag) fail("storage tenant identity or wrapping key mismatch");
        dek = unseal(kek, metadata.wrapped, JSON.stringify([schema, tenantTag, "data-key"]));
        if (dek.length !== 32) fail("invalid stored data key");
      }
    }).immediate();
  } finally { kek.fill(0); Buffer.from(config.wrappingKey.buffer, config.wrappingKey.byteOffset, config.wrappingKey.byteLength).fill(0); }
}
function get(namespace: string, key: string): any {
  coordinates(namespace, key);
  const row = db.prepare("SELECT * FROM values_store WHERE namespace=? AND id=?").get(namespace, identity(namespace, key));
  if (!row) return undefined;
  const decoded = decode(row);
  return row.deleted === 0 && (row.expires === null || row.expires > Date.now()) ? decoded : undefined;
}
function scan(args: any): any {
  coordinates(args.namespace, "scan");
  const limit = args.limit ?? 32;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128 || (args.cursor !== undefined && (typeof args.cursor !== "string" || !/^[a-f0-9]{64}$/.test(args.cursor)))) fail("invalid scan limit/cursor");
  const rows = db.prepare("SELECT * FROM values_store WHERE namespace=? AND id>? ORDER BY id").iterate(args.namespace, args.cursor ?? "");
  const items: any[] = []; let bytes = 0, cursor: string | undefined;
  for (const row of rows) {
    const decoded = decode(row);
    if (row.deleted !== 0 || (row.expires !== null && row.expires <= Date.now())) continue;
    if (items.length === limit || bytes + row.payload.length + 256 > config.maxResponseBytes) {
      if (!items.length) fail("scan response size limit exceeded");
      return { items, cursor };
    }
    items.push(decoded); bytes += row.payload.length + 256; cursor = row.id;
  }
  return { items };
}
function commit(transactionId: string, mutations: StorageMutation[]): any {
  if (typeof transactionId !== "string" || !transactionId.length || Buffer.byteLength(transactionId) > 512 || !Array.isArray(mutations) || !mutations.length || mutations.length > 128) fail("invalid transaction size or identity");
  const normalized = mutations.map((m) => {
    coordinates(m.namespace, m.key);
    if (m.expectedRevision !== undefined && m.expectedRevision !== null && (!Number.isSafeInteger(m.expectedRevision) || m.expectedRevision < 1)) fail("invalid expected revision");
    if (m.expiresAt !== undefined && (!Number.isSafeInteger(m.expiresAt) || m.expiresAt < 0)) fail("invalid expiry");
    if (m.value !== undefined && (!(m.value instanceof Uint8Array) || m.value.byteLength > config.maxValueBytes)) fail("storage value size limit exceeded");
    return { namespace: m.namespace, key: m.key, value: m.value === undefined ? null : Buffer.from(m.value).toString("base64"), expectedRevision: m.expectedRevision, expiresAt: m.expiresAt };
  });
  const ids = mutations.map((m) => identity(m.namespace, m.key));
  if (new Set(ids).size !== ids.length) fail("duplicate mutation coordinates");
  const tx = hmac(dek, JSON.stringify(["transaction", transactionId]));
  const digest = hmac(dek, JSON.stringify(normalized));
  return db.transaction(() => {
    const prior = db.prepare("SELECT * FROM transactions_store WHERE id=?").get(tx);
    if (prior) {
      if (prior.digest !== digest) fail("transaction identity conflict");
      return { ...JSON.parse(unseal(dek, prior.result, JSON.stringify([schema, tenantTag, tx, digest])).toString()), replayed: true };
    }
    const now = Date.now();
    for (const [i, m] of mutations.entries()) {
      const row = db.prepare("SELECT * FROM values_store WHERE namespace=? AND id=?").get(m.namespace, ids[i]);
      if (row) decode(row);
      const alive = row && row.deleted === 0 && (row.expires === null || row.expires > now);
      if (m.expectedRevision === null ? alive : m.expectedRevision !== undefined && (!alive || row.revision !== m.expectedRevision)) fail("storage revision conflict");
    }
    let revision = db.prepare("SELECT revision FROM metadata WHERE id=1").get().revision;
    if (!Number.isSafeInteger(revision) || revision > Number.MAX_SAFE_INTEGER - mutations.length) fail("storage revision overflow");
    const revisions: number[] = [];
    for (const [i, m] of mutations.entries()) {
      revision++; revisions.push(revision);
      const label = Buffer.from(m.key), length = Buffer.alloc(4); length.writeUInt32BE(label.length);
      const row = { namespace: m.namespace, id: ids[i], revision, expires: m.expiresAt ?? null, deleted: m.value === undefined ? 1 : 0 };
      const payload = seal(dek, Buffer.concat([length, label, Buffer.from(m.value ?? [])]), aad(row));
      db.prepare("INSERT INTO values_store VALUES(?,?,?,?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET revision=excluded.revision,expires=excluded.expires,deleted=excluded.deleted,payload=excluded.payload").run(row.namespace, row.id, row.revision, row.expires, row.deleted, payload);
    }
    db.prepare("UPDATE metadata SET revision=? WHERE id=1").run(revision);
    const result = { revisions, replayed: false };
    db.prepare("INSERT INTO transactions_store VALUES(?,?,?)").run(tx, digest, seal(dek, Buffer.from(JSON.stringify(result)), JSON.stringify([schema, tenantTag, tx, digest])));
    const size = db.prepare("SELECT (SELECT coalesce(sum(length(payload)),0) FROM values_store)+(SELECT coalesce(sum(length(result)+length(id)+length(digest)),0) FROM transactions_store) AS n").get().n;
    if (size > config.maxDatabaseBytes / 2) fail("storage database quota exceeded");
    return result;
  }).immediate();
}
try {
  init(); port.postMessage({ ready: true });
  port.on("message", ({ id, op, args }) => {
    try {
      if (poisoned && op !== "close") fail("storage disabled after authentication failure; reopen after repair");
      let result: unknown;
      switch (op) {
        case "get": result = get(args.namespace, args.key); break;
        case "scan": result = scan(args); break;
        case "commit": result = commit(args.transactionId, args.mutations); break;
        case "collect": result = db.transaction(() => {
          const expired: Array<{ namespace: string; id: string }> = [];
          for (const row of db.prepare("SELECT * FROM values_store").iterate()) {
            decode(row);
            if (row.expires !== null && row.expires <= Date.now()) expired.push({ namespace: row.namespace, id: row.id });
          }
          for (const row of expired) db.prepare("DELETE FROM values_store WHERE namespace=? AND id=?").run(row.namespace, row.id);
          return expired.length;
        }).immediate(); break;
        case "close": db.pragma("wal_checkpoint(TRUNCATE)"); db.close(); dek.fill(0); port.postMessage({ id, result: null }); port.close(); return;
        default: fail("unknown storage operation");
      }
      port.postMessage({ id, result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "storage operation failed";
      port.postMessage({ id, error: message.startsWith("storage") || message.startsWith("invalid") || message.startsWith("duplicate") || message.startsWith("transaction") ? message : "SQLite storage operation failed; transaction rolled back" });
    }
  });
} catch (error) {
  try { db?.close(); } catch { /* initialization cleanup */ }
  dek?.fill(0);
  const message = error instanceof Error ? error.message : "storage initialization failed";
  port.postMessage({ startupError: /^(Durable storage|storage|unsupported storage|unrecognized storage|invalid stored)/.test(message) ? message : "storage initialization failed: corrupt schema or unavailable filesystem" });
  port.close();
}
