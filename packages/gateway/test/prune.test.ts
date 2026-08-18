import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { createMemoryReplaySavings } from "@rewind/core";

import { pruneToolOutputs } from "../src/prune.ts";
import { createMemoryRecordStore } from "../src/record-store.ts";
import { createReplayer } from "../src/replay.ts";
import { startProxy } from "../src/proxy.ts";

/**
 * Deterministic, lossless duplicate tool-output collapse: keep the FIRST occurrence verbatim, elide
 * later byte-identical ones, never touch tool_use, and be a pure function of the input.
 */

const bigOutput = "LINE ".repeat(100); // ~500 chars, above the min-length threshold

function toolResult(id: string, content: unknown) {
  return { type: "tool_result", tool_use_id: id, content };
}

function req(messages: unknown[]): Record<string, unknown> {
  return { model: "m", max_tokens: 100, messages };
}

test("collapses a byte-identical duplicate tool_result, keeping the FIRST verbatim", () => {
  const body = req([
    { role: "user", content: "read the file" },
    { role: "user", content: [toolResult("a", bigOutput)] },
    { role: "assistant", content: "ok" },
    { role: "user", content: [toolResult("b", bigOutput)] }, // identical output, re-read
  ]);
  const r = pruneToolOutputs(body);
  assert.equal(r.elided, 1);
  assert.ok(r.charsSaved > 300);
  const msgs = (r.body as { messages: { content: { content: string }[] }[] }).messages;
  assert.equal(msgs[1].content[0].content, bigOutput, "first occurrence kept verbatim");
  assert.match(msgs[3].content[0].content, /elided by rewind/, "later duplicate elided");
});

test("distinct tool outputs are NOT collapsed (only byte-identical ones)", () => {
  const body = req([
    { role: "user", content: [toolResult("a", bigOutput)] },
    { role: "user", content: [toolResult("b", bigOutput + "CHANGED")] },
  ]);
  const r = pruneToolOutputs(body);
  assert.equal(r.elided, 0);
});

test("small duplicate outputs (below minLength) are left alone", () => {
  const small = "ok";
  const body = req([
    { role: "user", content: [toolResult("a", small)] },
    { role: "user", content: [toolResult("b", small)] },
  ]);
  assert.equal(pruneToolOutputs(body).elided, 0);
  // …but a lower threshold would collapse them.
  assert.equal(pruneToolOutputs(body, { minLength: 1 }).elided, 1);
});

test("tool_use blocks are NEVER pruned even if identical (only observations are collapsed)", () => {
  const useBlock = { type: "tool_use", id: "x", name: "run", input: { cmd: bigOutput } };
  const body = req([
    { role: "assistant", content: [useBlock] },
    { role: "assistant", content: [{ ...useBlock, id: "y" }] }, // identical input, different id
  ]);
  const r = pruneToolOutputs(body);
  assert.equal(r.elided, 0, "an agent action/input must never be elided");
});

test("three identical results: the first is kept, the next TWO are elided", () => {
  const body = req([
    { role: "user", content: [toolResult("a", bigOutput)] },
    { role: "user", content: [toolResult("b", bigOutput)] },
    { role: "user", content: [toolResult("c", bigOutput)] },
  ]);
  assert.equal(pruneToolOutputs(body).elided, 2);
});

test("a body with no messages array is returned unchanged", () => {
  const r = pruneToolOutputs({ model: "m" });
  assert.equal(r.elided, 0);
  assert.deepEqual(r.body, { model: "m" });
});

test("the input body is never mutated", () => {
  const body = req([
    { role: "user", content: [toolResult("a", bigOutput)] },
    { role: "user", content: [toolResult("b", bigOutput)] },
  ]);
  const before = JSON.stringify(body);
  pruneToolOutputs(body);
  assert.equal(JSON.stringify(body), before, "prune must not mutate its input");
});

// --- determinism / idempotence (replay-safety proof) ---

test("DETERMINISTIC: same input → byte-identical pruned output", () => {
  const body = req([
    { role: "user", content: [toolResult("a", bigOutput)] },
    { role: "user", content: [toolResult("b", bigOutput)] },
    { role: "user", content: [toolResult("c", bigOutput + "x".repeat(300))] },
  ]);
  const a = JSON.stringify(pruneToolOutputs(body).body);
  const b = JSON.stringify(pruneToolOutputs(JSON.parse(JSON.stringify(body))).body);
  assert.equal(a, b);
});

test("IDEMPOTENT: pruning an already-pruned body changes nothing more", () => {
  const body = req([
    { role: "user", content: [toolResult("a", bigOutput)] },
    { role: "user", content: [toolResult("b", bigOutput)] },
  ]);
  const once = pruneToolOutputs(body);
  const twice = pruneToolOutputs(once.body);
  assert.equal(twice.elided, 0, "the marker is short (< minLength) and there are no new duplicates");
  assert.equal(JSON.stringify(twice.body), JSON.stringify(once.body));
});

test("end-to-end: pruneContext forwards a SMALLER body upstream and replay stays exact", async () => {
  let received: Buffer | undefined;
  const stub = createServer((req2, res) => {
    const chunks: Buffer[] = [];
    req2.on("data", (c: Buffer) => chunks.push(c));
    req2.on("end", () => {
      received = Buffer.concat(chunks);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "message", usage: { input_tokens: 1 } }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const addr = stub.address();
  const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  const store = createMemoryRecordStore();
  const savings = createMemoryReplaySavings();
  const replayer = createReplayer(store, savings);
  const proxy = await startProxy({ upstreamBase: base, replayer, store, pruneContext: true });
  try {
    const body = JSON.stringify(
      req([
        { role: "user", content: [toolResult("a", bigOutput)] },
        { role: "user", content: [toolResult("b", bigOutput)] }, // duplicate → elided upstream
      ]),
    );
    const post = () =>
      fetch(`${proxy.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-rewind-scope": "p" },
        body,
      });

    const r1 = await post();
    await r1.text();
    assert.equal(r1.headers.get("x-rewind"), "live");
    // The upstream received the PRUNED body — smaller than the original, and the duplicate is elided.
    assert.ok(received !== undefined);
    assert.ok(received.length < Buffer.byteLength(body), "a smaller body reached upstream");
    assert.match(received.toString("utf8"), /elided by rewind/);

    // A byte-identical repeat of the ORIGINAL request still replays (the key is over the pruned form,
    // and pruning is deterministic, so the same original prunes to the same key).
    const r2 = await post();
    await r2.text();
    assert.equal(r2.headers.get("x-rewind"), "replay", "deterministic prune keeps replay exact");
  } finally {
    await proxy.close();
    await new Promise<void>((r) => stub.close(() => r()));
  }
});
