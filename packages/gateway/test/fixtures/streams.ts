/**
 * streams — three small but real, terminal-bearing streaming fixtures, one per provider, used by
 * providers.test.ts to prove the full record→replay→meter chain works for each.
 *
 * Each fixture carries the FULL stream (`body`, terminal present → recordable) and a `truncatedBody`
 * with the terminal removed (a cut-off stream → NOT recordable, must never be frozen into a replay).
 * The shapes match what each provider actually emits over SSE, including the usage frame the meter
 * reads. Token counts are deliberately non-zero so `meterAvoidance` returns a strictly-positive
 * tokens+cost figure.
 */

export interface StreamFixture {
  readonly id: "anthropic" | "openai" | "gemini";
  /** A path the provider's adapter matchPath() accepts. */
  readonly url: string;
  readonly contentType: string;
  /** The model the response reports (also the meter fallback if the body omits it). */
  readonly model: string;
  /** The full terminal-bearing stream (recordable). */
  readonly body: string;
  /** The same stream with its terminal frame removed (a truncated stream — NOT recordable). */
  readonly truncatedBody: string;
}

// --- Anthropic: message_start (input+cache usage) → content_block_delta → message_delta (output) →
//     message_stop. Terminal = message_stop. ---
const ANTHROPIC_HEAD = [
  `event: message_start`,
  `data: ${JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_01",
      model: "claude-opus-4-8",
      usage: { input_tokens: 1200, cache_read_input_tokens: 8000, cache_creation_input_tokens: 150, output_tokens: 1 },
    },
  })}`,
  ``,
  `event: content_block_delta`,
  `data: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } })}`,
  ``,
  `event: message_delta`,
  `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 340 } })}`,
  ``,
].join("\n");
const ANTHROPIC_STOP = [`event: message_stop`, `data: ${JSON.stringify({ type: "message_stop" })}`, ``, ``].join("\n");

export const ANTHROPIC_SSE: StreamFixture = {
  id: "anthropic",
  url: "/v1/messages",
  contentType: "text/event-stream",
  model: "claude-opus-4-8",
  body: ANTHROPIC_HEAD + ANTHROPIC_STOP,
  truncatedBody: ANTHROPIC_HEAD, // message_stop removed
};

// --- OpenAI: two content chunks with choices[].delta, a final chunk carrying usage (with
//     prompt_tokens_details.cached_tokens), then `data: [DONE]`. Terminal = [DONE]. ---
const OPENAI_HEAD = [
  `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model: "gpt-4o",
    choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }],
  })}`,
  ``,
  `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model: "gpt-4o",
    choices: [{ index: 0, delta: { content: " world" }, finish_reason: "stop" }],
  })}`,
  ``,
  `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    model: "gpt-4o",
    choices: [],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150, prompt_tokens_details: { cached_tokens: 30 } },
  })}`,
  ``,
].join("\n");
const OPENAI_DONE = [`data: [DONE]`, ``, ``].join("\n");

export const OPENAI_SSE: StreamFixture = {
  id: "openai",
  url: "/v1/chat/completions",
  contentType: "text/event-stream",
  model: "gpt-4o",
  body: OPENAI_HEAD + OPENAI_DONE,
  truncatedBody: OPENAI_HEAD, // [DONE] removed
};

// --- Gemini: GenerateContentResponse chunks; the last carries candidates[].finishReason + a
//     usageMetadata block. Terminal = a candidate with a finishReason. ---
const GEMINI_HEAD = [
  `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text: "Hello" }], role: "model" }, index: 0 }],
    modelVersion: "gemini-2.5-pro",
  })}`,
  ``,
].join("\n");
const GEMINI_FINAL = [
  `data: ${JSON.stringify({
    candidates: [{ content: { parts: [{ text: " world" }], role: "model" }, finishReason: "STOP", index: 0 }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, cachedContentTokenCount: 10, totalTokenCount: 150 },
    modelVersion: "gemini-2.5-pro",
  })}`,
  ``,
  ``,
].join("\n");

export const GEMINI_SSE: StreamFixture = {
  id: "gemini",
  url: "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
  contentType: "text/event-stream",
  model: "gemini-2.5-pro",
  body: GEMINI_HEAD + GEMINI_FINAL,
  truncatedBody: GEMINI_HEAD, // the finishReason + usageMetadata chunk removed
};
