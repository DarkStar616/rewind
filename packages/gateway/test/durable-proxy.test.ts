import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryReplaySavings } from "@agent-rewind/core";
import { createMemoryRecordStore } from "../src/record-store.ts";
import { createReplayer } from "../src/replay.ts";
import { createSqliteRecordStoreV2 } from "../src/record-store-v2.ts";
import { openSqliteStorage } from "../src/storage/sqlite-store.ts";
import { createFixedTenantResolver } from "../src/trusted-scope.ts";
import { startProxy, type RunningProxy } from "../src/proxy.ts";

async function send(proxy: RunningProxy, requestId: string, text = "same stochastic request") {
  const response = await fetch(`${proxy.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json", "x-rewind-request-id": requestId }, body: JSON.stringify({ model: "test", messages: [{ role: "user", content: text }] }) });
  return { status: response.status, body: await response.text(), mode: response.headers.get("x-rewind") };
}

test("durable record-only forwards identical requests; restart replays ordered bodies and stable retries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rewind-durable-proxy-"));
  let hits = 0, avoided = 0;
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) { /* consume */ }
    hits++; res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ type: "message", model: "test", content: [{ type: "text", text: `sample-${hits}` }], usage: { input_tokens: 10, output_tokens: 2 } }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const upstreamBase = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  let storage = await openSqliteStorage({ directory, tenant: "tenant", wrappingKey: Buffer.alloc(32, 7) });
  let proxy: RunningProxy | undefined;
  const open = (replayCursor?: string) => {
    const store = createMemoryRecordStore();
    return startProxy({ upstreamBase, store, replayer: createReplayer(store, createMemoryReplaySavings()), resolveScope: createFixedTenantResolver("tenant"), tape: { store: createSqliteRecordStoreV2(storage), epoch: "epoch", replayCursor, onAvoided: async () => { avoided++; } } });
  };
  try {
    proxy = await open();
    const first = await send(proxy, "record-a"), second = await send(proxy, "record-b");
    assert.equal(hits, 2); assert.notEqual(first.body, second.body);
    await proxy.close(); await storage.close();
    storage = await openSqliteStorage({ directory, tenant: "tenant", wrappingKey: Buffer.alloc(32, 7) });
    proxy = await open("cursor");
    assert.equal((await send(proxy, "replay-a", "mismatch")).status, 409); assert.equal(hits, 2);
    assert.equal((await send(proxy, "replay-a")).body, first.body);
    assert.equal((await send(proxy, "replay-a")).body, first.body); assert.equal(avoided, 1);
    await proxy.close(); await storage.close();
    storage = await openSqliteStorage({ directory, tenant: "tenant", wrappingKey: Buffer.alloc(32, 7) }); proxy = await open("cursor");
    assert.equal((await send(proxy, "replay-a")).body, first.body); assert.equal(avoided, 1);
    assert.equal((await send(proxy, "replay-b")).body, second.body); assert.equal(avoided, 2);
    assert.equal((await send(proxy, "replay-c")).status, 409); assert.equal(hits, 2);
  } finally { await proxy?.close(); await storage.close(); upstream.closeAllConnections(); await new Promise<void>((resolve) => upstream.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});

for (const failure of [false, true]) test(`durable delivery waits for append; reject=${failure}`, {timeout:5000}, async () => {
  let enter!:()=>void, release!:()=>void;
  const entered = new Promise<void>(r=>enter=r), gate = new Promise<void>(r=>release=r);
  const body = JSON.stringify({type:"message",model:"test",content:[],usage:{input_tokens:1,output_tokens:1}});
  const upstream=createServer((req,res)=>{ req.resume(); res.setHeader("content-type","application/json"); res.setHeader("content-length",Buffer.byteLength(body)); res.end(body); });
  upstream.listen(0,"127.0.0.1"); await once(upstream,"listening");
  const store=createMemoryRecordStore();
  const tape = {createEpoch:async()=>{},epoch:async()=>({length:0}),append:async()=>{enter();await gate;if(failure)throw new Error("write failed");}} as unknown as import("../src/record-store-v2.ts").RecordStoreV2;
  const proxy=await startProxy({store,replayer:createReplayer(store,createMemoryReplaySavings()),resolveScope:createFixedTenantResolver("t"),upstreamBase:`http://127.0.0.1:${(upstream.address() as {port:number}).port}`,tape:{store:tape,epoch:"e"}});
  let completed=false;
  const pending=fetch(`${proxy.url}/v1/messages`,{method:"POST",body:JSON.stringify({model:"test",messages:[]})}).then(async response=>{
    const chunks:Uint8Array[]=[]; for await (const chunk of response.body!) {completed=true;chunks.push(chunk);} return {body:Buffer.concat(chunks).toString()};
  }).catch(()=>undefined);
  try { await entered; await new Promise(r=>setTimeout(r,50)); assert.equal(completed,false,"Content-Length must not expose success before commit"); release(); const result=await pending; if(failure)assert.equal(result,undefined);else assert.equal(result?.body,body); }
  finally {release();await pending;await proxy.close();upstream.closeAllConnections();await new Promise<void>(r=>upstream.close(()=>r()));}
});

for (const abort of [true,false]) test(`durable stalled upstream releases queue after ${abort ? "client abort" : "deadline"}`, {timeout:5000}, async()=>{
  let hits=0, arrived!:()=>void; const arrival=new Promise<void>(r=>arrived=r);
  const upstream=createServer((req,res)=>{req.resume();if(++hits===1){arrived();return;}res.setHeader("content-type","application/json");res.end('{"type":"message","model":"test","content":[],"usage":{"input_tokens":1,"output_tokens":1}}');});
  upstream.listen(0,"127.0.0.1");await once(upstream,"listening");
  const store=createMemoryRecordStore(); const tape={createEpoch:async()=>{},epoch:async()=>({length:0}),append:async()=>{}} as unknown as import("../src/record-store-v2.ts").RecordStoreV2;
  const proxy=await startProxy({store,replayer:createReplayer(store,createMemoryReplaySavings()),resolveScope:createFixedTenantResolver("t"),upstreamBase:`http://127.0.0.1:${(upstream.address() as {port:number}).port}`,tape:{store:tape,epoch:"e",upstreamTimeoutMs:100}});
  const controller=new AbortController();const first=fetch(`${proxy.url}/v1/messages`,{method:"POST",signal:controller.signal,body:JSON.stringify({model:"test",messages:[]})}).then(r=>r.text(),()=>undefined);
  try {await arrival;if(abort)controller.abort();await first;assert.equal((await send(proxy,"next")).status,200);assert.equal(hits,2);}
  finally{controller.abort();upstream.closeAllConnections();await proxy.close();await new Promise<void>(r=>upstream.close(()=>r()));}
});
