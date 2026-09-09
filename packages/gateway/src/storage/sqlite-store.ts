import { Worker } from "node:worker_threads";
import { isAbsolute } from "node:path";

export interface SqliteStorageOptions {
  directory: string;
  tenant: string;
  wrappingKey: Uint8Array;
  maxValueBytes?: number;
  maxDatabaseBytes?: number;
  maxQueuedRequests?: number;
  maxQueuedBytes?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
}
export interface StorageMutation {
  namespace: string;
  key: string;
  /** Undefined deletes the value. Null revision requires absence; number requires an exact revision. */
  value?: Uint8Array;
  expectedRevision?: number | null;
  expiresAt?: number;
}
export interface StorageValue { key: string; value: Buffer; revision: number; expiresAt?: number }
export interface StorageCommit { revisions: number[]; replayed: boolean }
export interface SqliteStorage {
  get(namespace: string, key: string): Promise<StorageValue | undefined>;
  scan(namespace: string, options?: { cursor?: string; limit?: number }): Promise<{ items: StorageValue[]; cursor?: string }>;
  commit(transactionId: string, mutations: readonly StorageMutation[]): Promise<StorageCommit>;
  collectExpired(): Promise<number>;
  close(): Promise<void>;
}
/** All SQLite and cryptography run off the caller event loop; rejected durable opens never fall back. */
export async function openSqliteStorage(options: SqliteStorageOptions): Promise<SqliteStorage> {
  if (!isAbsolute(options.directory)) throw new Error("storage directory must be absolute");
  if (typeof options.tenant !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(options.tenant)) throw new Error("invalid fixed storage tenant");
  if (!(options.wrappingKey instanceof Uint8Array) || options.wrappingKey.byteLength !== 32) throw new Error("storage wrapping key must contain 32 bytes");
  const config = { ...options, wrappingKey: Buffer.from(options.wrappingKey), maxValueBytes: options.maxValueBytes ?? 1024 * 1024, maxDatabaseBytes: options.maxDatabaseBytes ?? 64 * 1024 * 1024, maxQueuedRequests: options.maxQueuedRequests ?? 32, maxQueuedBytes: options.maxQueuedBytes ?? 16 * 1024 * 1024, maxResponseBytes: options.maxResponseBytes ?? 4 * 1024 * 1024, timeoutMs: options.timeoutMs ?? 30_000 };
  for (const n of [config.maxValueBytes, config.maxDatabaseBytes, config.maxQueuedRequests, config.maxQueuedBytes, config.maxResponseBytes, config.timeoutMs]) if (!Number.isSafeInteger(n) || n <= 0) throw new Error("storage limits must be positive safe integers");
  if (config.maxResponseBytes > config.maxQueuedBytes || config.maxValueBytes + 768 > config.maxResponseBytes || config.maxDatabaseBytes < 65536) throw new Error("inconsistent storage limits");
  const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "./storage-worker.ts" : "./storage-worker.js", import.meta.url), { workerData: config, execArgv: [] });
  config.wrappingKey.fill(0);
  let sequence = 0, queuedBytes = 0, stopped = false, closing = false;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; bytes: number; timer: ReturnType<typeof setTimeout> }>();
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = (error: Error): void => {
    if (stopped) return;
    stopped = true; readyReject(error);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear(); queuedBytes = 0;
    void worker.terminate();
  };
  const startupTimer = setTimeout(() => fail(new Error("durable storage startup timed out")), config.timeoutMs);
  worker.on("error", () => fail(new Error("durable storage worker failed; no memory fallback")));
  worker.on("exit", () => { if (!stopped) fail(new Error("durable storage worker exited")); });
  worker.on("message", (message) => {
    if (message.ready) { clearTimeout(startupTimer); readyResolve(); return; }
    if (message.startupError) { clearTimeout(startupTimer); fail(new Error(message.startupError)); return; }
    const p = pending.get(message.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(message.id); queuedBytes -= p.bytes;
    if (message.error) p.reject(new Error(message.error)); else p.resolve(message.result);
  });
  try { await ready; } catch (error) { clearTimeout(startupTimer); throw error; }
  const rpc = (op: string, args: unknown, bytes: number): Promise<any> => {
    if (stopped || (closing && op !== "close")) return Promise.reject(new Error("durable storage is closed"));
    if (op !== "close" && (pending.size >= config.maxQueuedRequests || bytes > config.maxQueuedBytes - queuedBytes)) return Promise.reject(new Error("storage queue size limit exceeded"));
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => fail(new Error("storage operation timed out; retry the same transaction ID after reopening")), config.timeoutMs);
      pending.set(id, { resolve, reject, bytes, timer }); queuedBytes += bytes;
      try { worker.postMessage({ id, op, args }); } catch { fail(new Error("storage request could not be serialized")); }
    });
  };
  const coordinates = (namespace: string, key: string): void => {
    if (typeof namespace !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(namespace) || typeof key !== "string" || !key.length || Buffer.byteLength(key) > 512 || Buffer.from(key).toString("utf8") !== key) throw new Error("invalid storage coordinates");
  };
  const value = (row: any): StorageValue | undefined => row ? { ...row, value: Buffer.from(row.value) } : undefined;
  let closePromise: Promise<void> | undefined;
  return {
    async get(namespace, key) { coordinates(namespace, key); return value(await rpc("get", { namespace, key }, config.maxValueBytes + 768)); },
    async scan(namespace, scanOptions = {}) {
      coordinates(namespace, "scan");
      if (scanOptions.cursor !== undefined && (typeof scanOptions.cursor !== "string" || !/^[a-f0-9]{64}$/.test(scanOptions.cursor))) throw new Error("invalid scan cursor");
      if (scanOptions.limit !== undefined && (!Number.isSafeInteger(scanOptions.limit) || scanOptions.limit < 1 || scanOptions.limit > 128)) throw new Error("invalid scan limit");
      const result = await rpc("scan", { namespace, ...scanOptions }, config.maxResponseBytes);
      return { ...result, items: result.items.map(value) };
    },
    async commit(transactionId, mutations) {
      if (typeof transactionId !== "string" || !transactionId.length || Buffer.byteLength(transactionId) > 512 || !Array.isArray(mutations) || mutations.length < 1 || mutations.length > 128) throw new Error("invalid transaction size or identity");
      let bytes = 1024;
      for (const m of mutations) {
        if (typeof m.key !== "string" || Buffer.byteLength(m.key) > 512 || typeof m.namespace !== "string" || m.namespace.length > 32 || (m.value !== undefined && (!(m.value instanceof Uint8Array) || m.value.byteLength > config.maxValueBytes))) throw new Error("storage mutation size limit exceeded");
        bytes += (m.value?.byteLength ?? 0) + Buffer.byteLength(m.key) + 128;
      }
      return rpc("commit", { transactionId, mutations }, bytes);
    },
    async collectExpired() { return rpc("collect", {}, 1024); },
    close() {
      if (closePromise) return closePromise;
      if (stopped) return Promise.resolve();
      closing = true;
      closePromise = rpc("close", {}, 0).then(async () => { stopped = true; await worker.terminate(); });
      return closePromise;
    },
  };
}
