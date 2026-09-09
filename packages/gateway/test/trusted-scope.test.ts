import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { createMemoryReplaySavings } from "@agent-rewind/core";
import { createMemoryRecordStore } from "../src/record-store.ts";
import { createReplayer } from "../src/replay.ts";
import { startProxy, type RunningProxy } from "../src/proxy.ts";
import { createFixedTenantResolver, encodeTrustedScope } from "../src/trusted-scope.ts";

async function fixture() {
  const requests: Array<{ headers: IncomingHttpHeaders; body: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ type: "message", content: [{ text: `response-${requests.length}` }], usage: { input_tokens: 10, output_tokens: 2 } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const proxies: RunningProxy[] = [];
  const store = createMemoryRecordStore();
  const savings = createMemoryReplaySavings();
  return { requests, store, savings, async proxy(options: Partial<Parameters<typeof startProxy>[0]> = {}) {
    const proxy = await startProxy({ upstreamBase: base, store, replayer: createReplayer(store, savings), ...options });
    proxies.push(proxy); return proxy;
  }, async close() { for (const proxy of proxies) await proxy.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
async function send(proxy: RunningProxy, headers: Record<string, string> = {}, path = "/v1/messages") {
  const body = JSON.stringify({ system: "static instructions", model: "model", messages: [{ role: "user", content: "hello" }] });
  const response = await fetch(proxy.url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { status: response.status, body: await response.text(), replay: response.headers.get("x-rewind"), sent: body };
}

test("trusted tenant namespaces cannot be selected by spoofed tenant headers", async () => {
  const f = await fixture();
  try {
    const a = await f.proxy({ resolveScope: createFixedTenantResolver("tenant-a") });
    const b = await f.proxy({ resolveScope: createFixedTenantResolver("tenant-b") });
    assert.equal((await send(a, { "x-rewind-tenant": "tenant-b", "x-rewind-scope": "one" })).replay, "live");
    assert.equal((await send(b, { "x-rewind-tenant": "tenant-a", "x-rewind-scope": "one" })).replay, "live");
    assert.equal((await send(a, { "x-rewind-scope": "one" })).replay, "replay");
    assert.equal((await send(a, { "x-rewind-scope": "two" })).replay, "live");
    assert.equal(f.requests.length, 3);
  } finally { await f.close(); }
});

test("Rewind and custom scope headers never reach recorded or pass-through endpoints", async () => {
  const f = await fixture();
  try {
    const proxy = await f.proxy({ scopeHeader: "X-Project-Scope" });
    for (const path of ["/v1/messages", "/health"]) await send(proxy, { "x-project-scope": "scope", "x-rewind-tenant": "spoof", "x-rewind-scope": "scope", "x-rewind-private": "secret", authorization: "Bearer keep-me" }, path);
    for (const req of f.requests) {
      assert.equal(req.headers.authorization, "Bearer keep-me");
      assert.equal(req.headers["x-project-scope"], undefined);
      assert.equal(Object.keys(req.headers).some((key) => key.startsWith("x-rewind-")), false);
    }
  } finally { await f.close(); }
});

test("resolver failure refuses by default or explicitly passes through without transforms/records", async () => {
  const f = await fixture();
  try {
    const resolveScope = () => { throw new Error("secret identity failure"); };
    const refused = await f.proxy({ resolveScope });
    const response = await send(refused);
    assert.equal(response.status, 403); assert.doesNotMatch(response.body, /secret/); assert.equal(f.requests.length, 0);
    const pass = await f.proxy({ resolveScope, scopeFailure: "passthrough", preserveCache: true, pruneContext: true });
    for (let i = 0; i < 2; i++) {
      const result = await send(pass);
      assert.equal(result.status, 200);
      assert.equal(f.requests.at(-1)?.body, result.sent);
    }
    assert.equal(f.requests.length, 2); assert.equal(f.savings.total().tokens, 0);
  } finally { await f.close(); }
});

test("trusted identity rejects empty/control/oversized identifiers and structural collisions", () => {
  for (const tenant of ["", "\n", "a".repeat(129)]) assert.throws(() => createFixedTenantResolver(tenant));
  const resolver = createFixedTenantResolver("tenant");
  for (const scope of ["", "\u0000", "a".repeat(129), "a, b"]) assert.throws(() => resolver({ headers: { "x-rewind-scope": scope } }));
  assert.notEqual(encodeTrustedScope({ tenant: "a:b", scope: "c" }), encodeTrustedScope({ tenant: "a", scope: "b:c" }));
});
