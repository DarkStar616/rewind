import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createMemoryReplaySavings } from "@agent-rewind/core";
import { createMemoryRecordStore } from "../src/record-store.ts";
import { createReplayer, StrictReplayMissError } from "../src/replay.ts";
import { canonicalizeRequest } from "../src/canonical-request.ts";
import { startProxy } from "../src/proxy.ts";
import { replayEligible } from "../src/replay-eligibility.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { openSqliteStorage } from "../src/storage/sqlite-store.ts";
import { createSqliteRecordStoreV2 } from "../src/record-store-v2.ts";

test("client function envelopes remain replayable without inspecting their schemas or arguments", () => {
  for (const tools of [[], [{ name: "search" }],
    [{ name: "search", input_schema: { properties: { conversation: { type: "string" } } } }],
    [{ type: "function", function: { name: "search" } }], [{ type: "function", name: "search" }],
    [{ functionDeclarations: [{ name: "search" }] }]]) {
    const body = { tools, messages: [{ role: "user", content: "previous_response_id" }] };
    assert.equal(replayEligible(body), true);
    const store = createMemoryRecordStore();
    store.put({ scope: "s", replayKey: canonicalizeRequest(body) }, { response: "client function", model: "m", usage: {} });
    assert.equal(createReplayer(store, createMemoryReplaySavings(), { strict: true }).handle("s", body).served, "replay");
  }
  assert.equal(replayEligible({ tools: [{ functionDeclarations: [], googleSearch: {} }] }), false);
});

test("ordered tape never records remote-state requests or advances a strict cursor for them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-eligibility-"));
  const db = await openSqliteStorage({ directory, tenant: "t", wrappingKey: randomBytes(32) });
  const tape = createSqliteRecordStoreV2(db);
  let hits = 0;
  const upstream = createServer((req, res) => {
    req.resume(); req.on("end", () => { hits++; res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: "m", content: [{ type: "text", text: "live" }], usage: { input_tokens: 10 } })); });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const scope = '["t","s"]';
  await tape.createEpoch(scope, "e", "create");
  try {
    for (const replayCursor of [undefined, "cursor"]) {
      const store = createMemoryRecordStore();
      const proxy = await startProxy({ upstreamBase: `http://127.0.0.1:${address.port}`, store,
        replayer: createReplayer(store, createMemoryReplaySavings()), resolveScope: () => ({ tenant: "t", scope: "s" }),
        tape: { store: tape, epoch: "e", replayCursor } });
      try {
        for (const [index, remote] of requests.entries()) {
          const r = await fetch(`${proxy.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "m", messages: [], ...remote }) });
          await r.text(); assert.equal(r.status, replayCursor ? 409 : 200);
          assert.equal(hits, replayCursor ? requests.length : index + 1);
        }
        assert.equal((await tape.epoch(scope, "e")).length, 0);
        assert.equal(await tape.cursor(scope, "cursor"), undefined);
      } finally { await proxy.close(); }
    }
  } finally { await new Promise<void>(resolve => upstream.close(() => resolve())); await db.close(); await rm(directory, { recursive: true, force: true }); }
});

const requests = [
  { tools: [{ type: "web_search" }] },
  { tools: [{ type: "mcp", server_url: "https://example.invalid" }] },
  { tools: [{ googleSearch: {} }] },
  { tools: [{ type: "future_server_tool", name: "x" }] },
  { previous_response_id: "previous" },
  { conversation: "conversation" },
  { mcp_servers: [{ url: "https://example.invalid" }] },
  { cachedContent: "projects/example/cachedContents/1" },
  { model: "gpt-4o-search-preview" },
  { web_search_options: {} },
  { prompt: { id: "pmpt_123" } },
  { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://example.invalid/image" }] }] },
  { contents: [{ parts: [{ fileData: { fileUri: "gs://bucket/file" } }] }] },
  { container: "container_123" },
  { container: { id: "container_123", skills: [{ skill_id: "skill_123" }] } },
  { messages: [{ role: "assistant", audio: { id: "audio_123" } }] },
];
test("provider-hosted tools and opaque remote state cannot auto-reuse even an existing record", () => {
  for (const body of requests) {
    const store = createMemoryRecordStore(), savings = createMemoryReplaySavings();
    store.put({ scope: "s", replayKey: canonicalizeRequest(body) }, { response: "old remote result", model: "m", usage: { input_tokens: 10 } });
    assert.equal(createReplayer(store, savings).handle("s", body).served, "live");
    assert.equal(savings.total().tokens, 0);
    assert.throws(() => createReplayer(store, savings, { strict: true }).handle("s", body), StrictReplayMissError);
  }
});

test("hosted-tool traffic stays live and unrecorded while strict mode never forwards", async () => {
  let hits = 0;
  const upstream = createServer((req, res) => {
    req.resume(); req.on("end", () => {
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: "m", content: [{ type: "text", text: String(hits) }], usage: { input_tokens: 10 } }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const store = createMemoryRecordStore(), savings = createMemoryReplaySavings();
  let writes = 0;
  const put = store.put;
  store.put = (key, value) => { writes++; put(key, value); };
  const common = { upstreamBase: `http://127.0.0.1:${address.port}`, store };
  const proxy = await startProxy({ ...common, replayer: createReplayer(store, savings) });
  const body = JSON.stringify({ model: "m", messages: [], tools: [{ type: "web_search_20250305", name: "web_search" }] });
  const send = (url: string) => fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body });
  try {
    for (let i = 0; i < 2; i++) { const r = await send(proxy.url); await r.text(); assert.equal(r.headers.get("x-rewind"), "live"); }
    assert.equal(hits, 2); assert.equal(savings.total().tokens, 0); assert.equal(writes, 0);
    const strict = await startProxy({ ...common, replayer: createReplayer(store, savings, { strict: true }) });
    try { const r = await send(strict.url); await r.text(); assert.equal(r.status, 409); assert.equal(hits, 2); }
    finally { await strict.close(); }
    for (const allowLiveFallback of [undefined, false, true]) {
      const custom = await startProxy({ ...common, replayer: {
        allowLiveFallback,
        prepare() { throw new Error("must not invoke custom replay for ineligible traffic"); },
        handle() { throw new Error("must not invoke custom replay for ineligible traffic"); },
      } });
      try {
        const r = await send(custom.url); await r.text();
        assert.equal(r.status, allowLiveFallback === true ? 200 : 409);
        assert.equal(hits, allowLiveFallback === true ? 3 : 2);
        assert.equal(writes, 0);
      } finally { await custom.close(); }
    }
  } finally { await proxy.close(); await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
