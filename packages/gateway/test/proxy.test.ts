import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";

import { createMemoryReplaySavings } from "@rewind/core";

import { createMemoryRecordStore } from "../src/record-store.ts";
import { createReplayer } from "../src/replay.ts";
import { startProxy, type RunningProxy } from "../src/proxy.ts";

/**
 * The proxy is byte-transparent and fail-open: a byte-equivalent request after a rewind is served
 * from the record with zero upstream call; everything else is forwarded verbatim; and if the replay
 * machinery or the upstream faults, the request still reaches the provider (or a 502 is surfaced —
 * never a fabricated model response).
 */

interface Stub {
  server: Server;
  base: string;
  hits: number;
  lastBody: Buffer | undefined;
  close(): Promise<void>;
}

/** A stub upstream: counts requests, captures the raw body it received, returns a configurable reply. */
function startStub(reply: {
  status?: number;
  contentType?: string;
  body: (n: number) => string;
}): Promise<Stub> {
  const state: Stub = {
    server: undefined as unknown as Server,
    base: "",
    hits: 0,
    lastBody: undefined,
    close: async () => {},
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      state.hits += 1;
      state.lastBody = Buffer.concat(chunks);
      const body = reply.body(state.hits);
      res.writeHead(reply.status ?? 200, { "content-type": reply.contentType ?? "application/json" });
      res.end(body);
    });
  });
  state.server = server;
  state.close = () => new Promise((r) => server.close(() => r()));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      state.base = `http://127.0.0.1:${port}`;
      resolve(state);
    });
  });
}

function anthropicJson(n: number): string {
  return JSON.stringify({
    id: `msg_${n}`,
    model: "claude-opus-4-8",
    content: [{ type: "text", text: `answer ${n}` }],
    usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  });
}

function post(proxy: RunningProxy, path: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${proxy.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rewind-scope": "test", ...headers },
    body,
  });
}

test("forward-on-miss records; the byte-equivalent replay then skips upstream", async () => {
  const stub = await startStub({ body: anthropicJson });
  const store = createMemoryRecordStore();
  const savings = createMemoryReplaySavings();
  const replayer = createReplayer(store, savings);
  const proxy = await startProxy({ upstreamBase: stub.base, replayer, store });
  try {
    const body = JSON.stringify({ model: "claude-opus-4-8", max_tokens: 100, messages: [{ role: "user", content: "hi" }] });

    const r1 = await post(proxy, "/v1/messages", body);
    const t1 = await r1.text();
    assert.equal(r1.headers.get("x-rewind"), "live");
    assert.equal(stub.hits, 1);
    assert.match(t1, /answer 1/);

    // A byte-different-but-semantically-identical repeat (extra whitespace) must resolve to the SAME
    // record and be served WITHOUT a second upstream call.
    const r2 = await post(proxy, "/v1/messages", body + " ");
    const t2 = await r2.text();
    assert.equal(r2.headers.get("x-rewind"), "replay");
    assert.equal(stub.hits, 1, "upstream must NOT be hit again on a replay");
    assert.equal(t2, t1, "replay serves the exact recorded bytes");

    // The avoided call was booked: 1000 + 50 tokens.
    assert.equal(savings.total("test").tokens, 1050);
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("byte-identity: the exact request bytes are forwarded upstream, key order preserved", async () => {
  const stub = await startStub({ body: anthropicJson });
  const store = createMemoryRecordStore();
  const replayer = createReplayer(store, createMemoryReplaySavings());
  const proxy = await startProxy({ upstreamBase: stub.base, replayer, store });
  try {
    // Deliberately non-canonical key order + unusual spacing; a re-serialization would change it.
    const body = `{"model":"claude-opus-4-8","z":1,"a":2,"messages":[{"role":"user","content":"hi"}]}`;
    await post(proxy, "/v1/messages", body);
    assert.equal(stub.lastBody?.toString("utf8"), body, "upstream must receive the exact bytes sent");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("fail-open: an unreachable upstream surfaces a 502, never a fabricated response, and does not crash", async () => {
  const store = createMemoryRecordStore();
  const replayer = createReplayer(store, createMemoryReplaySavings());
  // Port 1 is not listening → ECONNREFUSED.
  const proxy = await startProxy({ upstreamBase: "http://127.0.0.1:1", replayer, store });
  try {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const r = await post(proxy, "/v1/messages", body);
    assert.equal(r.status, 502);
    const j = (await r.json()) as { error?: { type?: string } };
    assert.equal(j.error?.type, "rewind_upstream_error");
  } finally {
    await proxy.close();
  }
});

test("a non-2xx upstream response is forwarded but NOT recorded (no frozen errors)", async () => {
  const stub = await startStub({ status: 500, body: () => JSON.stringify({ error: "boom" }) });
  const store = createMemoryRecordStore();
  const replayer = createReplayer(store, createMemoryReplaySavings());
  const proxy = await startProxy({ upstreamBase: stub.base, replayer, store });
  try {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const r1 = await post(proxy, "/v1/messages", body);
    assert.equal(r1.status, 500);
    // A retry must hit upstream AGAIN — the error was not cached.
    const r2 = await post(proxy, "/v1/messages", body);
    assert.equal(r2.status, 500);
    assert.equal(stub.hits, 2, "the 500 must not have been recorded/replayed");
  } finally {
    await proxy.close();
    await stub.close();
  }
});

test("a client that aborts mid-flight does not crash or wedge the proxy", async () => {
  // A deliberately slow upstream so the client can abort before the response completes.
  const slow = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("{"); // partial body, then stall
      setTimeout(() => res.end('"ok":true}'), 200);
    });
  });
  await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
  const slowAddr = slow.address();
  const slowBase = `http://127.0.0.1:${typeof slowAddr === "object" && slowAddr ? slowAddr.port : 0}`;

  const store = createMemoryRecordStore();
  const replayer = createReplayer(store, createMemoryReplaySavings());
  const proxy = await startProxy({ upstreamBase: slowBase, replayer, store });
  try {
    const ac = new AbortController();
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    const p = fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: ac.signal,
    }).catch(() => "aborted");
    ac.abort(); // hang up before the slow upstream finishes
    assert.equal(await p, "aborted");

    // The proxy must still be alive and serve a fresh request to completion.
    const r = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    assert.equal(r.status, 200);
    await r.text();
  } finally {
    await proxy.close();
    await new Promise<void>((r) => slow.close(() => r()));
  }
});

test("non-messages traffic is forwarded transparently and never recorded", async () => {
  const stub = await startStub({ body: () => JSON.stringify({ ok: true }) });
  const store = createMemoryRecordStore();
  const replayer = createReplayer(store, createMemoryReplaySavings());
  const proxy = await startProxy({ upstreamBase: stub.base, replayer, store });
  try {
    const r1 = await post(proxy, "/v1/models", "{}");
    assert.equal(r1.headers.get("x-rewind"), "live");
    assert.equal(stub.hits, 1);
    // Same path again still forwards (no replay on non-messages endpoints).
    await post(proxy, "/v1/models", "{}");
    assert.equal(stub.hits, 2);
  } finally {
    await proxy.close();
    await stub.close();
  }
});
