import { test } from "node:test";
import assert from "node:assert/strict";

import { extractUsage, pickUsageFields } from "../src/usage.ts";

test("Gemini thinking tokens (thoughtsTokenCount) are billed as output and added to candidates", () => {
  const u = pickUsageFields({ promptTokenCount: 30, candidatesTokenCount: 50, thoughtsTokenCount: 100, cachedContentTokenCount: 10 });
  assert.equal(u.output_tokens, 150, "output = candidatesTokenCount (50) + thoughtsTokenCount (100)");
  assert.equal(u.input_tokens, 20, "promptTokenCount (30) minus cached (10) = uncached input");
  assert.equal(u.cache_read_input_tokens, 10);
});

test("Gemini with no thinking tokens meters candidates alone (no phantom output)", () => {
  const u = pickUsageFields({ promptTokenCount: 30, candidatesTokenCount: 50 });
  assert.equal(u.output_tokens, 50);
});

test("Gemini tool-use prompt tokens are billed as input and added to the uncached input", () => {
  const u = pickUsageFields({ promptTokenCount: 30, candidatesTokenCount: 50, toolUsePromptTokenCount: 15, cachedContentTokenCount: 10 });
  // input = (promptTokenCount 30 - cached 10) + toolUse 15 = 35
  assert.equal(u.input_tokens, 35);
  assert.equal(u.cache_read_input_tokens, 10);
  assert.equal(u.output_tokens, 50);
});

/**
 * extractUsage reads the provider's OWN token counts from a raw response — JSON or SSE — and never
 * estimates from text length. A malformed body yields all-zero usage instead of throwing, so a bad
 * response can never take the proxy down.
 */

test("JSON: reads the usage block and the model", () => {
  const body = JSON.stringify({
    id: "msg_1",
    model: "claude-opus-4-8",
    usage: {
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 150,
    },
  });
  const { usage, model } = extractUsage(body, "application/json");
  assert.equal(model, "claude-opus-4-8");
  assert.deepEqual(usage, {
    input_tokens: 1200,
    output_tokens: 340,
    cache_read_input_tokens: 8000,
    cache_creation_input_tokens: 150,
  });
});

test("JSON: missing cache fields normalise to 0, not undefined", () => {
  const body = JSON.stringify({ model: "m", usage: { input_tokens: 10, output_tokens: 5 } });
  const { usage } = extractUsage(body, "application/json");
  assert.deepEqual(usage, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

test("SSE: input/cache come from message_start, output from the last message_delta", () => {
  const sse = [
    `event: message_start`,
    `data: ${JSON.stringify({
      type: "message_start",
      message: {
        model: "claude-sonnet-4-5",
        usage: { input_tokens: 500, cache_read_input_tokens: 3000, cache_creation_input_tokens: 20, output_tokens: 1 },
      },
    })}`,
    ``,
    `event: content_block_delta`,
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "hi" } })}`,
    ``,
    `event: message_delta`,
    `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 42 } })}`,
    ``,
    `event: message_delta`,
    `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 128 } })}`,
    ``,
    `data: [DONE]`,
    ``,
  ].join("\n");
  const { usage, model } = extractUsage(sse, "text/event-stream");
  assert.equal(model, "claude-sonnet-4-5");
  // input/cache from start; output from the LAST delta (128, not 42 or the start's placeholder 1).
  assert.deepEqual(usage, {
    input_tokens: 500,
    output_tokens: 128,
    cache_read_input_tokens: 3000,
    cache_creation_input_tokens: 20,
  });
});

test("SSE detected by shape even when contentType is absent", () => {
  const sse = `data: ${JSON.stringify({ type: "message_start", message: { model: "m", usage: { input_tokens: 7 } } })}\n\n`;
  const { usage, model } = extractUsage(sse, undefined);
  assert.equal(model, "m");
  assert.equal(usage.input_tokens, 7);
});

test("malformed body yields all-zero usage, never throws", () => {
  const { usage, model } = extractUsage("this is not json at all", "application/json");
  assert.equal(model, undefined);
  assert.deepEqual(usage, {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

test("a partial/garbage SSE frame is skipped, valid frames still fold", () => {
  const sse = [
    `data: {not valid json`,
    ``,
    `data: ${JSON.stringify({ type: "message_start", message: { model: "m", usage: { input_tokens: 99 } } })}`,
    ``,
    `data: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 3 } })}`,
    ``,
  ].join("\n");
  const { usage } = extractUsage(sse, "text/event-stream");
  assert.equal(usage.input_tokens, 99);
  assert.equal(usage.output_tokens, 3);
});

test("OpenAI-compatible usage (Nebius/OpenAI) maps prompt/completion tokens", () => {
  const body = JSON.stringify({ model: "meta-llama/Llama-3.3-70B-Instruct", usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
  const { usage, model } = extractUsage(body, "application/json");
  assert.equal(usage.input_tokens, 100, "prompt_tokens -> input_tokens");
  assert.equal(usage.output_tokens, 50, "completion_tokens -> output_tokens");
  assert.equal(model, "meta-llama/Llama-3.3-70B-Instruct");
});

test("OpenAI cached prompt tokens split out of input, never double-counted", () => {
  const body = JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } } });
  const { usage } = extractUsage(body, "application/json");
  assert.equal(usage.input_tokens, 70, "uncached remainder = 100 - 30");
  assert.equal(usage.cache_read_input_tokens, 30, "cached portion -> cache_read");
  assert.equal(usage.output_tokens, 20);
});

test("Anthropic shape still wins when its fields are present (no OpenAI override)", () => {
  const body = JSON.stringify({ usage: { input_tokens: 11, output_tokens: 22 } });
  const { usage } = extractUsage(body, "application/json");
  assert.equal(usage.input_tokens, 11);
  assert.equal(usage.output_tokens, 22);
});
