import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalizeRequest } from "../src/canonical-request.ts";

/**
 * The replay key is a SHA-256 over the OUTPUT-AFFECTING fields of an Anthropic-native
 * `/v1/messages` body. Two requests that would make the model emit the same tokens share a key;
 * anything that only changes caching, streaming, auth, ids, or timestamps does NOT change the key,
 * because those never change the model's output. This is what lets a byte-different-but-equivalent
 * request after a rewind hit the record.
 */

/** A realistic request that exercises every nesting site where a cache hint can appear. */
function baseRequest(): Record<string, unknown> {
  return {
    model: "claude-opus-4-8",
    max_tokens: 1024,
    temperature: 0.2,
    top_p: 0.9,
    system: [
      {
        type: "text",
        text: "You are a careful assistant.",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    tools: [
      {
        name: "get_weather",
        description: "Look up the weather.",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
        cache_control: { type: "ephemeral" },
      },
    ],
    tool_choice: { type: "auto" },
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "What is the weather in Paris?",
            cache_control: { type: "ephemeral", ttl: "5m" },
          },
        ],
      },
    ],
  };
}

const HEX_SHA256 = /^[0-9a-f]{64}$/;

test("the replay key is a 64-char lowercase hex SHA-256", () => {
  const key = canonicalizeRequest(baseRequest());
  assert.match(key, HEX_SHA256);
});

test("identical requests produce the same key", () => {
  assert.equal(canonicalizeRequest(baseRequest()), canonicalizeRequest(baseRequest()));
});

test("key is independent of top-level key ORDER (canonical, not textual)", () => {
  const a = { model: "m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] };
  const b = { messages: [{ role: "user", content: "hi" }], max_tokens: 8, model: "m" };
  assert.equal(canonicalizeRequest(a), canonicalizeRequest(b));
});

test("nested cache_control (and its ttl) does not affect the key", () => {
  const withHints = baseRequest();
  const withoutHints = baseRequest();
  // strip every cache_control by hand from the "control" request
  (withoutHints.system as any[])[0].cache_control = undefined;
  delete (withoutHints.system as any[])[0].cache_control;
  delete (withoutHints.tools as any[])[0].cache_control;
  delete ((withoutHints.messages as any[])[0].content as any[])[0].cache_control;
  assert.equal(canonicalizeRequest(withHints), canonicalizeRequest(withoutHints));
});

test("only the ttl differing does not affect the key", () => {
  const oneHour = baseRequest();
  const fiveMin = baseRequest();
  (fiveMin.system as any[])[0].cache_control = { type: "ephemeral", ttl: "5m" };
  assert.equal(canonicalizeRequest(oneHour), canonicalizeRequest(fiveMin));
});

test("a top-level prompt_cache_key does not affect the key", () => {
  const withKey = { ...baseRequest(), prompt_cache_key: "session-abc" };
  assert.equal(canonicalizeRequest(withKey), canonicalizeRequest(baseRequest()));
});

test("the stream flag does not affect the key", () => {
  const streaming = { ...baseRequest(), stream: true };
  const blocking = { ...baseRequest(), stream: false };
  assert.equal(canonicalizeRequest(streaming), canonicalizeRequest(baseRequest()));
  assert.equal(canonicalizeRequest(blocking), canonicalizeRequest(baseRequest()));
});

test("known-noise + auth body fields do not affect the key", () => {
  // These are provably-non-output fields (transport/caching) and auth material (which belongs in
  // headers; stripped defensively so a misplaced secret is never hashed).
  const noisy = {
    ...baseRequest(),
    api_key: "sk-ant-secret",
    authorization: "Bearer nope",
    metadata: { user_id: "u_42" },
    prompt_cache_key: "sess-1",
    stream: true,
  };
  assert.equal(canonicalizeRequest(noisy), canonicalizeRequest(baseRequest()));
});

test("FAIL-SAFE: an UNRECOGNIZED field changes the key (unknown → miss, never a false hit)", () => {
  // The safety asymmetry: a field this code has never heard of might change the model's output, so it
  // MUST force a miss rather than collide onto an unrelated record. A future output-affecting API
  // parameter is exactly this case.
  const withUnknown = { ...baseRequest(), some_future_output_param: "reasoning_v2" };
  assert.notEqual(canonicalizeRequest(withUnknown), canonicalizeRequest(baseRequest()));

  // And two requests differing ONLY in that unknown field get DIFFERENT keys.
  const a = { ...baseRequest(), mcp_servers: [{ url: "https://a.example" }] };
  const b = { ...baseRequest(), mcp_servers: [{ url: "https://b.example" }] };
  assert.notEqual(canonicalizeRequest(a), canonicalizeRequest(b));
});

test("a changed user message produces a DIFFERENT key", () => {
  const other = baseRequest();
  ((other.messages as any[])[0].content as any[])[0].text = "What is the weather in Berlin?";
  assert.notEqual(canonicalizeRequest(other), canonicalizeRequest(baseRequest()));
});

test("a changed tool definition produces a DIFFERENT key", () => {
  const other = baseRequest();
  (other.tools as any[])[0].description = "Look up the forecast.";
  assert.notEqual(canonicalizeRequest(other), canonicalizeRequest(baseRequest()));
});

test("a changed sampling parameter produces a DIFFERENT key", () => {
  const other = baseRequest();
  other.temperature = 0.7;
  assert.notEqual(canonicalizeRequest(other), canonicalizeRequest(baseRequest()));
});

test("a changed model produces a DIFFERENT key", () => {
  const other = baseRequest();
  other.model = "claude-sonnet-4-8";
  assert.notEqual(canonicalizeRequest(other), canonicalizeRequest(baseRequest()));
});

test("a changed max_tokens produces a DIFFERENT key", () => {
  const other = baseRequest();
  other.max_tokens = 2048;
  assert.notEqual(canonicalizeRequest(other), canonicalizeRequest(baseRequest()));
});

test("adding a stop sequence produces a DIFFERENT key", () => {
  const other = { ...baseRequest(), stop_sequences: ["\n\nHuman:"] };
  assert.notEqual(canonicalizeRequest(other), canonicalizeRequest(baseRequest()));
});
