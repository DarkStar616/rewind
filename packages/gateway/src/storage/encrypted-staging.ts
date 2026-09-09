import { randomUUID, createHash } from "node:crypto";
import type { SqliteStorage, StorageValue } from "./sqlite-store.ts";

export interface StagingOptions { maxStageBytes?: number; maxChunks?: number; ttlMs?: number }
export interface StagedObject { handle: string; bytes: number; chunks: number; expiresAt: number; sha256: string }
export interface EncryptedStaging {
  begin(): Promise<string>;
  append(handle: string, sequence: number, bytes: Uint8Array): Promise<void>;
  seal(handle: string): Promise<StagedObject>;
  read(handle: string): AsyncGenerator<Buffer>;
  collectExpired(): Promise<number>;
}
interface Stage { handle: string; bytes: number; chunks: number; expiresAt: number; status: "open" | "sealed"; sha256?: string; manifest?: Array<{ sha256: string; size: number }> }
/** Staging shares the encrypted DB quota. Incomplete chunks are never exposed through read(). */
export function createEncryptedStaging(store: SqliteStorage, options: StagingOptions = {}): EncryptedStaging {
  const maxBytes = options.maxStageBytes ?? 8 * 1024 * 1024;
  const maxChunks = options.maxChunks ?? 1024;
  const ttl = options.ttlMs ?? 300_000;
  for (const n of [maxBytes, maxChunks, ttl]) if (!Number.isSafeInteger(n) || n <= 0) throw new Error("invalid staging limit");
  const metadataKey = (handle: string): string => {
    if (typeof handle !== "string" || !/^[a-f0-9-]{36}$/.test(handle)) throw new Error("invalid stage handle");
    return `${handle}/metadata`;
  };
  const metadata = async (handle: string): Promise<{ stage: Stage; row: StorageValue }> => {
    const row = await store.get("staging", metadataKey(handle));
    if (!row) throw new Error("stage missing or expired");
    return { row, stage: JSON.parse(row.value.toString()) as Stage };
  };
  async function* chunks(stage: Stage) {
    for (let i = 0; i < stage.chunks; i++) {
      const row = await store.get("staging", `${stage.handle}/chunk/${i}`);
      if (!row) throw new Error("stage chunk missing or expired");
      if (stage.status === "sealed") {
        const expected = stage.manifest?.[i];
        if (!expected || expected.size !== row.value.length || createHash("sha256").update(row.value).digest("hex") !== expected.sha256) throw new Error("stage chunk integrity mismatch");
      }
      yield row.value;
    }
  }
  return {
    async begin() {
      const handle = randomUUID(), expiresAt = Date.now() + ttl;
      if (!Number.isSafeInteger(expiresAt)) throw new Error("staging expiry overflow");
      const stage: Stage = { handle, bytes: 0, chunks: 0, expiresAt, status: "open" };
      await store.commit(`stage/${handle}/begin`, [{ namespace: "staging", key: metadataKey(handle), value: Buffer.from(JSON.stringify(stage)), expiresAt, expectedRevision: null }]);
      return handle;
    },
    async append(handle, sequence, bytes) {
      if (!Number.isSafeInteger(sequence) || sequence < 0 || !(bytes instanceof Uint8Array)) throw new Error("invalid stage sequence/chunk");
      const { stage, row } = await metadata(handle);
      if (stage.status !== "open") throw new Error("stage already sealed");
      if (sequence < stage.chunks) {
        const prior = await store.get("staging", `${handle}/chunk/${sequence}`);
        if (prior && prior.value.equals(Buffer.from(bytes))) return;
        throw new Error("stage retry content conflict");
      }
      if (sequence !== stage.chunks || stage.chunks >= maxChunks || bytes.byteLength > maxBytes - stage.bytes) throw new Error("staging sequence or size limit exceeded");
      const next = { ...stage, bytes: stage.bytes + bytes.byteLength, chunks: stage.chunks + 1 };
      await store.commit(`stage/${handle}/chunk/${sequence}`, [
        { namespace: "staging", key: `${handle}/chunk/${sequence}`, value: bytes, expiresAt: stage.expiresAt, expectedRevision: null },
        { namespace: "staging", key: metadataKey(handle), value: Buffer.from(JSON.stringify(next)), expiresAt: stage.expiresAt, expectedRevision: row.revision },
      ]);
    },
    async seal(handle) {
      const { stage, row } = await metadata(handle);
      if (stage.status === "sealed") return { handle, bytes: stage.bytes, chunks: stage.chunks, expiresAt: stage.expiresAt, sha256: stage.sha256! };
      const hash = createHash("sha256"); let size = 0;
      const manifest: Array<{ sha256: string; size: number }> = [];
      for await (const bytes of chunks(stage)) { hash.update(bytes); size += bytes.length; manifest.push({ sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length }); }
      if (size !== stage.bytes) throw new Error("stage length mismatch");
      const sha256 = hash.digest("hex");
      await store.commit(`stage/${handle}/seal`, [{ namespace: "staging", key: metadataKey(handle), value: Buffer.from(JSON.stringify({ ...stage, status: "sealed", sha256, manifest })), expectedRevision: row.revision, expiresAt: stage.expiresAt }]);
      return { handle, bytes: size, chunks: stage.chunks, expiresAt: stage.expiresAt, sha256 };
    },
    async *read(handle) {
      const { stage } = await metadata(handle);
      if (stage.status !== "sealed") throw new Error("stage is incomplete");
      const hash = createHash("sha256"); let size = 0;
      for await (const bytes of chunks(stage)) { hash.update(bytes); size += bytes.length; yield bytes; }
      if (size !== stage.bytes || hash.digest("hex") !== stage.sha256) throw new Error("stage integrity mismatch");
    },
    collectExpired: () => store.collectExpired(),
  };
}
