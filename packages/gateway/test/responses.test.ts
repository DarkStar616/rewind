import { test } from "node:test";
import assert from "node:assert/strict";
import { openaiAdapter as adapter } from "../src/providers/openai.ts";
import { canonicalizeRequest } from "../src/canonical-request.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { createMemoryReplaySavings } from "@agent-rewind/core";
import { createMemoryRecordStore } from "../src/record-store.ts";
import { createReplayer } from "../src/replay.ts";
import { startProxy } from "../src/proxy.ts";

const response = { object: "response", id: "resp_test", model: "gpt-5-codex", status: "completed", error: null,
  output: [{ type: "function_call", call_id: "call_1", name: "inspect", arguments: '{"path":"a.ts"}' }],
  usage: { input_tokens: 150, output_tokens: 20, input_tokens_details: { cached_tokens: 100, cache_write_tokens: 30 }, output_tokens_details: { reasoning_tokens: 10 } } };
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const event = (type: string, fields: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

test("Responses route and complete JSON preserve tools and disjoint cache usage", () => {
  assert.equal(adapter.matchPath("POST", "/v1/responses?trace=yes"), true);
  assert.equal(adapter.isRecordableSuccess(json(response), "application/json"), true);
  assert.deepEqual(adapter.extractUsage(json(response), "application/json"), { model: response.model,
    usage: { input_tokens: 20, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 30 } });
});

test("equivalent JSON escape spellings retain the same Responses usage", () => {
  const escaped = JSON.stringify(response).replace('"response"', '"respon\\u0073e"');
  assert.equal(adapter.isRecordableSuccess(Buffer.from(escaped), "application/json", "/v1/responses"), true);
  assert.deepEqual(adapter.extractUsage(escaped, "application/json"), adapter.extractUsage(json(response), "application/json"));
});

test("Chat rejects impossible inclusive cache counts before normalization", () => {
  for (const count of [-50, 200, 1.5, "50"]) {
    const chat = { choices: [], usage: { prompt_tokens: 100, completion_tokens: 2, prompt_tokens_details: { cache_write_tokens: count } } };
    assert.equal(adapter.isRecordableSuccess(json(chat), "application/json", "/v1/chat/completions"), false);
  }
});

test("Responses SSE needs an intact completed terminal and folds its nested usage", () => {
  const stream = event("response.created", { response: { ...response, status: "in_progress", usage: null } }) +
    event("response.output_text.delta", { delta: "pong" }) + event("response.completed", { response });
  assert.equal(adapter.isRecordableSuccess(Buffer.from(stream), "text/event-stream"), true);
  assert.deepEqual(adapter.extractUsage(stream, "text/event-stream"), adapter.extractUsage(json(response), "application/json"));
  for (const bad of [stream.slice(0, -2), stream + 'data: {broken}\n\n', stream + event("error", { message: "failed" }),
    event("response.completed", { response: { ...response, status: "incomplete" } }), event("response.created", { response })]) {
    assert.equal(adapter.isRecordableSuccess(Buffer.from(bad), "text/event-stream"), false);
  }
});

test("Responses failed, incomplete, queued and impossible usage never become records", () => {
  for (const status of ["failed", "incomplete", "in_progress", "queued", "cancelled"]) {
    assert.equal(adapter.isRecordableSuccess(json({ ...response, status }), "application/json"), false);
  }
  for (const usage of [{ ...response.usage, input_tokens: 1 }, { ...response.usage, output_tokens: -1 }, { ...response.usage, input_tokens: "150" }]) {
    assert.equal(adapter.isRecordableSuccess(json({ ...response, usage }), "application/json"), false);
  }
  assert.equal(adapter.isRecordableSuccess(json({ ...response, incomplete_details: { reason: "max_output_tokens" } }), "application/json"), false);
});

test("Responses output-affecting inputs remain in the canonical identity", () => {
  const body = { model: "gpt-5-codex", input: "hi", reasoning: { effort: "low" }, previous_response_id: "resp_a", tools: [{ type: "function", name: "a" }] };
  for (const change of [{ input: "other" }, { reasoning: { effort: "high" } }, { previous_response_id: "resp_b" }, { tools: [] }, { future_field: true }]) {
    assert.notEqual(canonicalizeRequest(body, {}, "/v1/responses"), canonicalizeRequest({ ...body, ...change }, {}, "/v1/responses"));
  }
});

test("gateway replays exact Responses bytes, but incomplete streams keep reaching upstream", async () => {
  let hits = 0;
  const body = event("response.completed", { response });
  const server = createServer(async (req, res) => {
    let request = "";
    for await (const chunk of req) request += chunk;
    hits++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(request.includes("incomplete") ? body.slice(0, -2) : body);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const store = createMemoryRecordStore(), savings = createMemoryReplaySavings();
  const proxy = await startProxy({ upstreamBase: `http://127.0.0.1:${address.port}`, store, replayer: createReplayer(store, savings) });
  try {
    for (const [input, expected] of [["ok", "live"], ["ok", "replay"], ["incomplete", "live"], ["incomplete", "live"]]) {
      const reply = await fetch(`${proxy.url}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "gpt-5-codex", input, stream: true }) });
      assert.equal(reply.headers.get("x-rewind"), expected);
      assert.equal(await reply.text(), input === "ok" ? body : body.slice(0, -2));
    }
    assert.equal(hits, 3);
  } finally { await proxy.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
