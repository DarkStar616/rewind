import { createHash } from "node:crypto";
import { validateHeaderValue } from "node:http";
import { canonicalize } from "@agent-rewind/core";
import { ADAPTERS, type ProviderAdapter } from "./providers/provider-adapter.ts";
import type { ProviderUsage } from "./record-store.ts";
import type { SqliteStorage, StorageValue } from "./storage/sqlite-store.ts";

export interface HttpOccurrence {
  scope: string;
  epoch: string;
  ordinal: number;
  /** Output of canonicalizeRequest, accepted verbatim. Storage never changes replay identity. */
  replayKey: string;
  /** Provider endpoint path used for terminal-format validation. */
  requestUrl?: string;
  provider: ProviderAdapter["id"];
  model: string;
  usage: ProviderUsage;
  response: { status: number; contentType: string; body: Uint8Array };
  expiresAt?: number;
}
export interface TapeEpoch { scope: string; epoch: string; length: number; revision: number }
export interface TapeCursor { scope: string; epoch: string; cursorId: string; ordinal: number; revision: number }
export interface ConsumedOccurrence { occurrence: HttpOccurrence; cursor: TapeCursor; replayed: boolean }
export interface RecordStoreV2 {
  createEpoch(scope: string, epoch: string, transactionId: string): Promise<void>;
  epoch(scope: string, epoch: string): Promise<TapeEpoch>;
  append(occurrence: HttpOccurrence, transactionId: string): Promise<{ revision: number; replayed: boolean }>;
  openCursor(scope: string, epoch: string, cursorId: string, transactionId: string, ordinal?: number): Promise<TapeCursor>;
  cursor(scope: string, cursorId: string): Promise<TapeCursor | undefined>;
  cursorForClaim(scope: string, cursorId: string, transactionId: string): Promise<TapeCursor | undefined>;
  rewind(cursor: TapeCursor, ordinal: number, transactionId: string): Promise<TapeCursor>;
  peek(cursor: TapeCursor, replayKey: string, options?: { strict?: boolean }): Promise<HttpOccurrence | undefined>;
  consume(cursor: TapeCursor, replayKey: string, transactionId: string, options?: { strict?: boolean }): Promise<ConsumedOccurrence | undefined>;
}
export interface RecordStoreV2Options { maxBodyBytes?: number }
interface Epoch { schema: "rewind.epoch/v1"; scope: string; epoch: string; length: number }
interface CursorState { schema: "rewind.cursor/v1"; scope: string; epoch: string; cursorId: string; ordinal: number }
interface FrameMetadata extends Omit<HttpOccurrence, "response"> {
  schema: "rewind.occurrence/v1";
  transactionDigest: string;
  status: number;
  contentType: string;
  bodyLength: number;
  bodySha256: string;
}
const MAX_METADATA = 16 * 1024;
const sha = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const coordinate = (kind: string, parts: unknown[]): string => sha(canonicalize([kind, ...parts]));
const bytes = (value: unknown): Buffer => Buffer.from(canonicalize(value));
const text = (value: unknown, max = 128): void => {
  if (typeof value !== "string" || !value.length || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f]/.test(value) || Buffer.from(value).toString("utf8") !== value) throw new Error("invalid tape identity");
};
const ordinal = (value: unknown): void => { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("invalid tape ordinal"); };
function position(value: Pick<HttpOccurrence, "scope" | "epoch" | "ordinal">): void { text(value.scope, 1024); text(value.epoch); ordinal(value.ordinal); }
function key(value: unknown): void { if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid canonical replay key"); }
function cursorState(cursor: TapeCursor): CursorState {
  position(cursor); text(cursor.cursorId);
  if (!Number.isSafeInteger(cursor.revision) || cursor.revision < 1) throw new Error("invalid cursor revision");
  return { schema: "rewind.cursor/v1", scope: cursor.scope, epoch: cursor.epoch, cursorId: cursor.cursorId, ordinal: cursor.ordinal };
}
const occurrenceKey = (value: Pick<HttpOccurrence, "scope" | "epoch" | "ordinal">): string => coordinate("occurrence", [value.scope, value.epoch, value.ordinal]);
const cursorKey = (scope: string, cursorId: string): string => coordinate("cursor", [scope, cursorId]);

/** Encrypted substrate must be bound to one fixed tenant; no caller-supplied tenant coordinate. */
export function createSqliteRecordStoreV2(storage: SqliteStorage, options: RecordStoreV2Options = {}): RecordStoreV2 {
  const maxBody = options.maxBodyBytes ?? 512 * 1024;
  if (!Number.isSafeInteger(maxBody) || maxBody <= 0) throw new Error("invalid occurrence body limit");
  function validate(record: HttpOccurrence): void {
    position(record); if (record.ordinal === Number.MAX_SAFE_INTEGER) throw new Error("occurrence ordinal overflow"); key(record.replayKey); text(record.model, 256);
    if (record.expiresAt !== undefined && (!Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0)) throw new Error("invalid occurrence expiry");
    if (record.requestUrl !== undefined) text(record.requestUrl, 4096);
    const response = record.response;
    if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300 || typeof response.contentType !== "string" || response.contentType.length > 256 || !(response.body instanceof Uint8Array) || response.body.byteLength > maxBody) throw new Error("invalid occurrence HTTP response/size");
    validateHeaderValue("content-type", response.contentType);
    if (!record.usage || typeof record.usage !== "object" || Array.isArray(record.usage)) throw new Error("invalid occurrence usage");
    const counts = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"].map((field) => (record.usage as Record<string, unknown>)[field] === undefined ? 0 : (record.usage as Record<string, unknown>)[field]);
    if (!counts.every((count) => Number.isSafeInteger(count) && (count as number) >= 0) || !Number.isSafeInteger((counts as number[]).reduce((a, b) => a + b, 0))) throw new Error("invalid occurrence usage counts");
    const adapter = ADAPTERS.find((candidate) => candidate.id === record.provider);
    if (!adapter || !adapter.isRecordableSuccess(Buffer.from(response.body), response.contentType, record.requestUrl)) throw new Error("occurrence is not a complete provider success");
    const extracted = adapter.extractUsage(Buffer.from(response.body), response.contentType);
    const fields = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
    if (fields.some((field) => (record.usage[field] ?? 0) !== (extracted.usage[field] ?? 0))) throw new Error("occurrence usage differs from provider bytes");
    if (extracted.model !== undefined && extracted.model !== record.model) throw new Error("occurrence model differs from provider bytes");
  }
  function encode(record: HttpOccurrence, transactionId: string): Buffer {
    validate(record); text(transactionId, 256);
    const { response, ...fields } = record;
    const metadata: FrameMetadata = { ...fields, schema: "rewind.occurrence/v1", transactionDigest: sha(transactionId), status: response.status, contentType: response.contentType, bodyLength: response.body.byteLength, bodySha256: sha(response.body) };
    const json = bytes(metadata);
    if (json.length > MAX_METADATA) throw new Error("occurrence metadata size limit exceeded");
    const header = Buffer.alloc(8); header.write("RW01", 0, "ascii"); header.writeUInt32BE(json.length, 4);
    return Buffer.concat([header, json, Buffer.from(response.body)]);
  }
  function decode(raw: Buffer, expected: Pick<HttpOccurrence, "scope" | "epoch" | "ordinal">): HttpOccurrence {
    if (raw.length < 8 || raw.length > maxBody + MAX_METADATA + 8 || raw.subarray(0, 4).toString() !== "RW01") throw new Error("corrupt occurrence frame");
    const length = raw.readUInt32BE(4);
    if (length > MAX_METADATA || raw.length < length + 8) throw new Error("corrupt occurrence metadata size");
    const meta = JSON.parse(raw.subarray(8, 8 + length).toString()) as FrameMetadata;
    const body = Buffer.from(raw.subarray(8 + length));
    if (meta.schema !== "rewind.occurrence/v1" || meta.scope !== expected.scope || meta.epoch !== expected.epoch || meta.ordinal !== expected.ordinal || meta.bodyLength !== body.length || typeof meta.bodySha256 !== "string" || meta.bodySha256 !== sha(body) || typeof meta.transactionDigest !== "string" || !/^[a-f0-9]{64}$/.test(meta.transactionDigest)) throw new Error("corrupt occurrence coordinates/digest");
    const record: HttpOccurrence = { scope: meta.scope, epoch: meta.epoch, ordinal: meta.ordinal, replayKey: meta.replayKey, ...(meta.requestUrl === undefined ? {} : { requestUrl: meta.requestUrl }), provider: meta.provider, model: meta.model, usage: meta.usage, response: { status: meta.status, contentType: meta.contentType, body }, ...(meta.expiresAt === undefined ? {} : { expiresAt: meta.expiresAt }) };
    validate(record); return record;
  }
  async function load(location: Pick<HttpOccurrence, "scope" | "epoch" | "ordinal">): Promise<{ row: StorageValue; record: HttpOccurrence } | undefined> {
    position(location);
    const id = occurrenceKey(location);
    if (await storage.get("quarantine", id)) throw new Error("occurrence quarantined");
    const row = await storage.get("occurrences", id);
    if (!row) return undefined;
    try {
      const record = decode(row.value, location);
      if (record.expiresAt !== row.expiresAt) throw new Error("corrupt occurrence expiry binding");
      return { row, record };
    } catch {
      // A structurally malformed authenticated frame gets a persistent refusal marker. Native AEAD
      // failures already disable the substrate and never reach this decoder.
      let quarantined = false;
      try { await storage.commit(coordinate("quarantine", [id, sha(row.value)]), [{ namespace: "quarantine", key: id, value: bytes({ schema: "rewind.quarantine/v1", digest: sha(row.value), reason: "malformed-occurrence" }), expectedRevision: null }]); quarantined = true; } catch { /* another refusal or disabled storage; still fail closed */ }
      throw new Error(quarantined ? "corrupt occurrence quarantined; explicit repair required" : "corrupt occurrence refused; quarantine persistence unavailable");
    }
  }
  async function epoch(scope: string, id: string): Promise<{ row: StorageValue; value: Epoch }> {
    text(scope, 1024); text(id);
    const row = await storage.get("epochs", coordinate("epoch", [scope, id]));
    if (!row) throw new Error("epoch missing");
    const value = JSON.parse(row.value.toString()) as Epoch;
    if (value.schema !== "rewind.epoch/v1" || value.scope !== scope || value.epoch !== id) throw new Error("corrupt epoch metadata");
    ordinal(value.length); return { row, value };
  }
  async function readCursor(scope: string, id: string): Promise<TapeCursor | undefined> {
    text(scope, 1024); text(id);
    const row = await storage.get("cursors", cursorKey(scope, id));
    if (!row) return undefined;
    const state = JSON.parse(row.value.toString()) as CursorState;
    if (state.schema !== "rewind.cursor/v1" || state.scope !== scope || state.cursorId !== id) throw new Error("corrupt cursor metadata");
    const cursor = { scope: state.scope, epoch: state.epoch, cursorId: state.cursorId, ordinal: state.ordinal, revision: row.revision };
    cursorState(cursor); return cursor;
  }
  async function transition(kind: "consume" | "rewind", cursor: TapeCursor, target: number, transactionId: string, detail: unknown): Promise<{ cursor: TapeCursor; replayed: boolean }> {
    const current = cursorState(cursor); ordinal(target); text(transactionId, 256);
    const id = coordinate(kind, [cursor.scope, cursor.cursorId, transactionId]);
    const claim = bytes({ schema: "rewind.cursor-claim/v1", kind, cursor, target, detail });
    const previous = await storage.get("claims", id);
    if (previous) { if (!previous.value.equals(claim)) throw new Error("cursor transaction identity conflict"); }
    else {
      const actual = await readCursor(cursor.scope, cursor.cursorId);
      if (!actual || canonicalize(actual) !== canonicalize(cursor)) throw new Error("cursor revision conflict");
    }
    const next = { ...current, ordinal: target };
    const committed = await storage.commit(id, [
      { namespace: "claims", key: id, value: claim, expectedRevision: null },
      { namespace: "cursors", key: cursorKey(cursor.scope, cursor.cursorId), value: bytes(next), expectedRevision: cursor.revision },
    ]);
    return { cursor: { scope: cursor.scope, epoch: cursor.epoch, cursorId: cursor.cursorId, ordinal: target, revision: committed.revisions[1] }, replayed: committed.replayed };
  }
  const peek = async (cursor: TapeCursor, replayKey: string, strict = false): Promise<{ row: StorageValue; record: HttpOccurrence } | undefined> => {
    cursorState(cursor); key(replayKey);
    const found = await load(cursor);
    if (!found || found.record.replayKey !== replayKey) {
      if (strict) throw new Error("strict replay miss: occurrence absent or canonical key differs");
      return undefined;
    }
    return found;
  };
  return {
    async createEpoch(scope, id, transactionId) {
      text(scope, 1024); text(id); text(transactionId, 256);
      await storage.commit(coordinate("create-epoch", [scope, id, transactionId]), [{ namespace: "epochs", key: coordinate("epoch", [scope, id]), value: bytes({ schema: "rewind.epoch/v1", scope, epoch: id, length: 0 }), expectedRevision: null }]);
    },
    async epoch(scope, id) { const state = await epoch(scope, id); return { scope, epoch: id, length: state.value.length, revision: state.row.revision }; },
    async append(record, transactionId) {
      const encoded = encode(record, transactionId);
      // Own the input snapshot across awaits; caller mutations cannot change the committed frame.
      const owned = decode(encoded, record);
      const existing = await load(owned);
      if (existing) {
        if (!existing.row.value.equals(encoded)) throw new Error("immutable occurrence conflict");
        return { revision: existing.row.revision, replayed: true };
      }
      const state = await epoch(owned.scope, owned.epoch);
      if (state.value.length !== owned.ordinal) throw new Error("occurrence ordinal conflict");
      const result = await storage.commit(coordinate("append", [owned.scope, owned.epoch, transactionId]), [
        { namespace: "occurrences", key: occurrenceKey(owned), value: encoded, expectedRevision: null, ...(owned.expiresAt === undefined ? {} : { expiresAt: owned.expiresAt }) },
        { namespace: "epochs", key: state.row.key, value: bytes({ ...state.value, length: owned.ordinal + 1 }), expectedRevision: state.row.revision },
      ]);
      return { revision: result.revisions[0], replayed: result.replayed };
    },
    async openCursor(scope, id, cursorId, transactionId, start = 0) {
      text(cursorId); text(transactionId, 256); ordinal(start);
      const state = await epoch(scope, id);
      if (start > state.value.length) throw new Error("cursor beyond epoch");
      const result = await storage.commit(coordinate("open-cursor", [scope, cursorId, transactionId]), [{ namespace: "cursors", key: cursorKey(scope, cursorId), value: bytes({ schema: "rewind.cursor/v1", scope, epoch: id, cursorId, ordinal: start }), expectedRevision: null }]);
      return { scope, epoch: id, cursorId, ordinal: start, revision: result.revisions[0] };
    },
    cursor: readCursor,
    async cursorForClaim(scope, cursorId, transactionId) {
      text(scope, 1024); text(cursorId); text(transactionId, 256);
      const prior = await storage.get("claims", coordinate("consume", [scope, cursorId, transactionId]));
      if (!prior) return undefined;
      let claim: any;
      try { claim = JSON.parse(prior.value.toString()); } catch { throw new Error("corrupt cursor claim"); }
      if (claim.schema !== "rewind.cursor-claim/v1" || claim.kind !== "consume" || claim.cursor?.scope !== scope || claim.cursor?.cursorId !== cursorId) throw new Error("corrupt cursor claim binding");
      cursorState(claim.cursor);
      return { ...claim.cursor };
    },
    async rewind(cursor, target, transactionId) {
      const snapshot = { ...cursor }; cursorState(snapshot); ordinal(target);
      if (target > (await epoch(snapshot.scope, snapshot.epoch)).value.length) throw new Error("rewind beyond epoch");
      return (await transition("rewind", snapshot, target, transactionId, null)).cursor;
    },
    async peek(cursor, replayKey, settings = {}) { return (await peek({ ...cursor }, replayKey, settings.strict))?.record; },
    async consume(cursor, replayKey, transactionId, settings = {}) {
      const snapshot = { ...cursor };
      const strict = settings.strict;
      cursorState(snapshot); key(replayKey); text(transactionId, 256);
      const prior = await storage.get("claims", coordinate("consume", [snapshot.scope, snapshot.cursorId, transactionId]));
      if (prior) {
        let claim: any;
        try { claim = JSON.parse(prior.value.toString()); } catch { throw new Error("corrupt cursor claim"); }
        if (claim.schema !== "rewind.cursor-claim/v1" || claim.kind !== "consume" || canonicalize(claim.cursor) !== canonicalize(snapshot) || claim.detail?.replayKey !== replayKey || claim.target !== snapshot.ordinal + 1) throw new Error("cursor transaction identity conflict");
      }
      const found = await peek(snapshot, replayKey, strict);
      if (!found) {
        if (prior) throw new Error("claimed occurrence unavailable; live fallback forbidden");
        return undefined;
      }
      const result = await transition("consume", snapshot, snapshot.ordinal + 1, transactionId, { replayKey, occurrenceDigest: sha(found.row.value) });
      return { occurrence: found.record, ...result };
    },
  };
}
