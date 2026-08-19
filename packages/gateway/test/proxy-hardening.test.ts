import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import { createMemoryReplaySavings } from "@agent-rewind/core";

import { createMemoryRecordStore } from "../src/record-store.ts";
import { createReplayer } from "../src/replay.ts";
import { startProxy, isRecordableSuccess, type RunningProxy } from "../src/proxy.ts";

/**
 * Hardening from the cross-vendor review: never freeze a transient 200-error as a replay; force
 * uncompressed upstream responses; key on output-affecting headers; and honour strict-mode misses.
 */

interface Stub {
  server: Server;
  base: string;
  hits: number;
  lastAcceptEncoding: string | undefined;
  close(): Promise<void>;
}

function startStub(reply: { status?: number; contentType?: string; body: (n: number) => string }): Promise<Stub> {
  const state = { hits: 0, lastAcceptEncoding: undefined as string | undefined };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      state.hits += 1;
      const ae = req.headers["accept-encoding"];
      state.lastAcceptEncoding = Array.isArray(ae) ? ae.join(",") : ae;
      res.writeHead(reply.status ?? 200, { "content-type": reply.contentType ?? "application/json" });
      res.end(reply.body(state.hits));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        get hits() {
          return state.hits;
        },
        get lastAcceptEncoding() {
          return state.lastAcceptEncoding;
        },
        close: () => new Promise((r) => server.close(() => r())),
      } as Stub);
    });
  });
}

function post(proxy: RunningProxy, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rewind-scope": "h", ...headers },
    body: JSON.stringify(body),
  });
}

// --- isRecordableSuccess unit ---

test("isRecordableSuccess: rejects JSON errors, incomplete/error SSE; accepts complete ones", () => {
  assert.equal(isRecordableSuccess(Buffer.from(JSON.stringify({ type: "message", content: [] })), "application/json"), true);
  assert.equal(isRecordableSuccess(Buffer.from(JSON.stringify({ type: "error", error: { type: "overloaded_error" } })), "application/json"), false);
  assert.equal(isRecordableSuccess(Buffer.from("not json"), "application/json"), false);

  const goodSse = `event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`;
  const errSse = `event: message_start\ndata: {"type":"message_start"}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error"}}\n\n`;
  const truncatedSse = `event: message_start\ndata: {"type":"message_start"}\n\n`;
  assert.equal(isRecordableSuccess(Buffer.from(goodSse), "text/event-stream"), true);
  assert.equal(isRecordableSuccess(Buffer.from(errSse), "text/event-stream"), false);
  assert.equal(isRecordableSuccess(Buffer.from(truncatedSse), "text/event-stream"), false);
});

// --- #4: a 200 carrying an error is not frozen as a replay ---

test("a 200-JSON error body is NOT recorded — a retry re-hits upstream", async () => {
  const stub = await startStub({ body: () => JSON.stringify({ type: "error", error: { type: "overloaded_error" } }) });
  const store = createMemoryRecordStore();
  const proxy = await startProxy({ upstreamBase: stub.base, replayer: createReplayer(store, createMemoryReplaySavings()), store });
  try {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
    await (await post(proxy, body)).text();
    await (await post(proxy, body)).text();
    assert.equal(stub.hits, 2, "the transient error must not have been recorded/replayed");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

// --- #5: uncompressed upstream ---

test("the proxy forces accept-encoding: identity upstream (so records are decodable)", async () => {
  const stub = await startStub({ body: (n) => JSON.stringify({ type: "message", n, usage: { input_tokens: 1 } }) });
  const store = createMemoryRecordStore();
  const proxy = await startProxy({ upstreamBase: stub.base, replayer: createReplayer(store, createMemoryReplaySavings()), store });
  try {
    await (await post(proxy, { model: "m", messages: [{ role: "user", content: "hi" }] }, { "accept-encoding": "gzip, br" })).text();
    assert.equal(stub.lastAcceptEncoding, "identity", "the client's gzip/br must be overridden to identity");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

// --- #2: output-affecting headers are part of replay identity ---

test("a different anthropic-beta header is NOT served a stale replay", async () => {
  const stub = await startStub({ body: (n) => JSON.stringify({ type: "message", n, usage: { input_tokens: 1 } }) });
  const store = createMemoryRecordStore();
  const proxy = await startProxy({ upstreamBase: stub.base, replayer: createReplayer(store, createMemoryReplaySavings()), store });
  try {
    const body = { model: "m", messages: [{ role: "user", content: "hi" }] };
    const r1 = await post(proxy, body, { "anthropic-beta": "feature-a" });
    await r1.text();
    assert.equal(r1.headers.get("x-rewind"), "live");

    // Same body, DIFFERENT beta → must miss (the beta can change what the model does).
    const r2 = await post(proxy, body, { "anthropic-beta": "feature-b" });
    await r2.text();
    assert.equal(r2.headers.get("x-rewind"), "live", "different beta must not replay");
    assert.equal(stub.hits, 2);

    // Same body, SAME beta as the first → replay.
    const r3 = await post(proxy, body, { "anthropic-beta": "feature-a" });
    await r3.text();
    assert.equal(r3.headers.get("x-rewind"), "replay");
    assert.equal(stub.hits, 2, "the identical (body+beta) request replays");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

// --- #7: strict-mode miss is refused, not silently forwarded ---

test("strict replayer: a miss returns 409 and does NOT reach upstream", async () => {
  const stub = await startStub({ body: () => JSON.stringify({ type: "message", usage: { input_tokens: 1 } }) });
  const store = createMemoryRecordStore();
  const strict = createReplayer(store, createMemoryReplaySavings(), { strict: true });
  const proxy = await startProxy({ upstreamBase: stub.base, replayer: strict, store });
  try {
    const r = await post(proxy, { model: "m", messages: [{ role: "user", content: "unrecorded" }] });
    assert.equal(r.status, 409);
    assert.equal(r.headers.get("x-rewind"), "strict-miss");
    assert.equal(stub.hits, 0, "strict mode must NOT pay for the forbidden call");
  } finally {
    await proxy.close();
    await stub.close();
  }
});
