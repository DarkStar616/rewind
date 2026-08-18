import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createMemoryRecordStore, createReplayer, startProxy } from "@rewind/gateway";
import { createFileReplaySavings } from "../src/durable-savings.ts";

/**
 * The durable savings sink is what bridges the long-lived `rewind gateway` process to a separate
 * `rewind savings` invocation: savings booked by one process must be readable by another, deduped by
 * callId, with the same total shape as the in-memory sink.
 */

async function withTemp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "rewind-savings-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a saving booked by one sink instance is readable by a fresh instance (cross-process)", async () => {
  await withTemp(async (dir) => {
    const path = join(dir, ".rewind", "savings.json");
    const writer = createFileReplaySavings({ path });
    writer.record({ scope: "s1", tokensAvoided: 1000, costMicros: 4200, model: "m", callId: "s1 k1" });

    // A brand-new instance (simulating the separate `rewind savings` process) sees it.
    const reader = createFileReplaySavings({ path });
    assert.deepEqual(reader.total("s1"), { tokens: 1000, costMicros: 4200 });
    assert.deepEqual(reader.total(), { tokens: 1000, costMicros: 4200 });
  });
});

test("dedup by callId across instances: the same avoided call is never counted twice", async () => {
  await withTemp(async (dir) => {
    const path = join(dir, "savings.json");
    createFileReplaySavings({ path }).record({ scope: "s", tokensAvoided: 500, costMicros: 100, model: "m", callId: "dup" });
    createFileReplaySavings({ path }).record({ scope: "s", tokensAvoided: 500, costMicros: 100, model: "m", callId: "dup" });
    assert.deepEqual(createFileReplaySavings({ path }).total("s"), { tokens: 500, costMicros: 100 });
  });
});

test("scope filter narrows the total; the unscoped total spans scopes", async () => {
  await withTemp(async (dir) => {
    const path = join(dir, "savings.json");
    const sink = createFileReplaySavings({ path });
    sink.record({ scope: "a", tokensAvoided: 10, costMicros: 1, model: "m", callId: "a1" });
    sink.record({ scope: "b", tokensAvoided: 20, costMicros: 2, model: "m", callId: "b1" });
    assert.deepEqual(sink.total("a"), { tokens: 10, costMicros: 1 });
    assert.deepEqual(sink.total("b"), { tokens: 20, costMicros: 2 });
    assert.deepEqual(sink.total(), { tokens: 30, costMicros: 3 });
  });
});

test("a fresh workspace reports 0 (no file yet)", async () => {
  await withTemp(async (dir) => {
    const sink = createFileReplaySavings({ path: join(dir, "nope", "savings.json") });
    assert.deepEqual(sink.total(), { tokens: 0, costMicros: 0 });
  });
});

test("a corrupt savings file is rejected, never silently zeroed", async () => {
  await withTemp(async (dir) => {
    const path = join(dir, "savings.json");
    await writeFile(path, "{ this is not json");
    assert.throws(() => createFileReplaySavings({ path }).total(), /corrupt/);
  });
});

test("end-to-end: a gateway replay books to the durable file that `rewind savings` reads", async () => {
  await withTemp(async (dir) => {
    // A stub upstream returning one Anthropic-shaped response with a usage block.
    const { createServer } = await import("node:http");
    const stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_1",
            model: "claude-opus-4-8",
            content: [{ type: "text", text: "hi" }],
            usage: { input_tokens: 2000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }),
        );
      });
    });
    await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
    const stubAddr = stub.address();
    const stubBase = `http://127.0.0.1:${typeof stubAddr === "object" && stubAddr ? stubAddr.port : 0}`;

    const path = join(dir, ".rewind", "savings.json");
    const savings = createFileReplaySavings({ path });
    const store = createMemoryRecordStore();
    const replayer = createReplayer(store, savings);
    const proxy = await startProxy({ upstreamBase: stubBase, replayer, store });

    try {
      const body = JSON.stringify({ model: "claude-opus-4-8", max_tokens: 50, messages: [{ role: "user", content: "hi" }] });
      const doPost = () =>
        fetch(`${proxy.url}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-rewind-scope": "e2e" },
          body,
        });

      const r1 = await doPost(); // live: recorded
      await r1.text();
      assert.equal(r1.headers.get("x-rewind"), "live");
      const r2 = await doPost(); // replay: booked to the durable file
      await r2.text();
      assert.equal(r2.headers.get("x-rewind"), "replay");

      // A SEPARATE sink instance (what `rewind savings` uses) reads the persisted total: 2100 tokens.
      const asSavingsCli = createFileReplaySavings({ path });
      assert.deepEqual(asSavingsCli.total("e2e"), { tokens: 2100, costMicros: asSavingsCli.total("e2e").costMicros });
      assert.equal(asSavingsCli.total("e2e").tokens, 2100);
      assert.ok(asSavingsCli.total("e2e").costMicros > 0, "the replay booked a real cost");

      // And the file on disk is the single source of truth.
      const onDisk = JSON.parse(await readFile(path, "utf8")) as { byCallId: Record<string, unknown> };
      assert.equal(Object.keys(onDisk.byCallId).length, 1, "one deduped avoided call recorded");
    } finally {
      await proxy.close();
      await new Promise<void>((r) => stub.close(() => r()));
    }
  });
});
