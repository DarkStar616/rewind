import { test } from "node:test";
import assert from "node:assert/strict";
import { isRecordableSuccessFor, extractUsageFor, selectAdapter } from "../src/providers/provider-adapter.ts";
import { meterAvoidance } from "../src/meter.ts";
import { ANTHROPIC_SSE, OPENAI_SSE, GEMINI_SSE } from "./fixtures/streams.ts";

for (const f of [ANTHROPIC_SSE, OPENAI_SSE, GEMINI_SSE]) {
  test(`${f.id}: streamed 2xx is recordable, meters non-zero`, () => {
    const a = selectAdapter({ provider: f.id }, "POST", f.url);
    assert.ok(a, "adapter resolves by path");
    assert.equal(a!.matchPath("POST", f.url), true);
    assert.equal(a!.isRecordableSuccess(Buffer.from(f.body), f.contentType), true);
    const { usage, model } = a!.extractUsage(f.body, f.contentType);
    const metered = meterAvoidance(usage, model ?? f.model);
    assert.ok(metered.tokensAvoided > 0, "tokens avoided must be > 0");
    assert.ok(metered.costMicros > 0, "avoided cost must be > 0");
  });
  test(`${f.id}: a truncated stream (no terminal) is NOT recordable`, () => {
    const a = selectAdapter({ provider: f.id }, "POST", f.url)!;
    assert.equal(a.isRecordableSuccess(Buffer.from(f.truncatedBody), f.contentType), false);
  });
}

test("auto-detect: an OpenAI chat path selects the openai adapter, not anthropic", () => {
  const a = selectAdapter({}, "POST", "/v1/chat/completions");
  assert.equal(a?.id, "openai");
});
test("auto-detect: a Gemini generateContent path selects the gemini adapter", () => {
  const a = selectAdapter({}, "POST", "/v1beta/models/gemini-2.5-pro:streamGenerateContent");
  assert.equal(a?.id, "gemini");
});

// The by-id convenience helpers are part of the exported surface (used by callers that already know
// the provider, e.g. a fixed-provider proxy). They resolve the same adapter selectAdapter would.
test("isRecordableSuccessFor / extractUsageFor route by id", () => {
  assert.equal(isRecordableSuccessFor("anthropic", Buffer.from(ANTHROPIC_SSE.body), ANTHROPIC_SSE.contentType), true);
  const { usage } = extractUsageFor("openai", OPENAI_SSE.body, OPENAI_SSE.contentType);
  assert.ok((usage.output_tokens ?? 0) > 0, "openai output tokens folded from the stream");
});
