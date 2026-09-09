import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createMemoryReplaySavings } from "@agent-rewind/core";
import { createMemoryRecordStore } from "../src/record-store.ts";
import { createReplayer } from "../src/replay.ts";
import { startProxy } from "../src/proxy.ts";

test("HTTP replay preserves own data and caller content type; custom scope is local only", async () => {
  let hits = 0;
  const upstream = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      assert.equal(req.headers["x-local-scope"], undefined);
      hits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", model: "m", content: [{ type: "text", text: String(hits) }], usage: { input_tokens: 10, output_tokens: 1 } }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const store = createMemoryRecordStore();
  const proxy = await startProxy({ upstreamBase: `http://127.0.0.1:${address.port}`, store, replayer: createReplayer(store, createMemoryReplaySavings()), scopeHeader: "x-local-scope" });
  const send = async (ownValue: number, contentType: string, scope?: string) => {
    const result = await fetch(`${proxy.url}/v1/messages`, {
      method: "POST", headers: { "content-type": contentType, ...(scope ? { "x-local-scope": scope } : {}) },
      body: `{"model":"m","messages":[],"__proto__":${ownValue}}`,
    });
    await result.text();
    return result.headers.get("x-rewind");
  };
  try {
    assert.equal(await send(1, "application/json"), "live");
    assert.equal(await send(2, "application/json"), "live");
    assert.equal(await send(2, "text/plain"), "live");
    assert.equal(await send(2, "application/json"), "replay");
    assert.equal(await send(2, "application/json", "default"), "replay");
    assert.equal(hits, 3);
  } finally {
    await proxy.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
});
