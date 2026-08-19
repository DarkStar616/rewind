import { test } from "node:test";
import assert from "node:assert/strict";
import { isRecordableSuccessFor, extractUsageFor, selectAdapter } from "../src/providers/provider-adapter.ts";
import { canonicalizeRequest } from "../src/canonical-request.ts";
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

test("the OpenAI Responses API endpoint is NOT matched (deferred post-1.0), so it never mis-records", () => {
  // /v1/responses has a different wire format (status/output, response.completed) we don't yet fold;
  // advertising it would reject every real result as non-recordable. Until then it must not match.
  assert.equal(selectAdapter({}, "POST", "/v1/responses"), undefined);
  const a = selectAdapter({ provider: "openai" }, "POST", "/v1/responses");
  assert.equal(a?.matchPath("POST", "/v1/responses"), false);
  assert.equal(a?.matchPath("POST", "/v1/chat/completions"), true);
});

test("replay identity folds the URL path: two Gemini models (named only in the URL) do NOT collide", () => {
  // The model lives in the path, not the body, so the SAME body sent to a different model must key
  // differently or the second request false-hits the first model's recorded reply.
  const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  const pro = canonicalizeRequest(body, undefined, "/v1beta/models/gemini-2.5-pro:generateContent");
  const flash = canonicalizeRequest(body, undefined, "/v1beta/models/gemini-2.5-flash:generateContent");
  assert.notEqual(pro, flash, "different model targets must produce different replay keys");
  // Same target, same body → same key (replay still works within one model).
  const proAgain = canonicalizeRequest(body, undefined, "/v1beta/models/gemini-2.5-pro:generateContent");
  assert.equal(pro, proAgain);
  // The query string is stripped from the key: an API key or rotated `?key=` never busts (or leaks into) it.
  const proKeyed = canonicalizeRequest(body, undefined, "/v1beta/models/gemini-2.5-pro:generateContent?key=SECRET&alt=sse");
  assert.equal(pro, proKeyed, "query (auth material) is not part of the key");
});

test("stream vs non-stream Gemini targets key differently (SSE and JSON wire formats must not cross)", () => {
  const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  const json = canonicalizeRequest(body, undefined, "/v1beta/models/gemini-2.5-pro:generateContent");
  const sse = canonicalizeRequest(body, undefined, "/v1beta/models/gemini-2.5-pro:streamGenerateContent");
  assert.notEqual(json, sse);
});

test("omitting the url keeps the legacy key stable (backward-compatible addition)", () => {
  // Existing callers that pass no url must get the exact same key they got before the path fold existed.
  const body = { model: "claude", messages: [{ role: "user", content: "hi" }] };
  const withHeaders = canonicalizeRequest(body, { "anthropic-version": "2023-06-01" });
  const explicitUndefined = canonicalizeRequest(body, { "anthropic-version": "2023-06-01" }, undefined);
  assert.equal(withHeaders, explicitUndefined, "url:undefined must not perturb the key");
});

// The by-id convenience helpers are part of the exported surface (used by callers that already know
// the provider, e.g. a fixed-provider proxy). They resolve the same adapter selectAdapter would.
test("isRecordableSuccessFor / extractUsageFor route by id", () => {
  assert.equal(isRecordableSuccessFor("anthropic", Buffer.from(ANTHROPIC_SSE.body), ANTHROPIC_SSE.contentType), true);
  const { usage } = extractUsageFor("openai", OPENAI_SSE.body, OPENAI_SSE.contentType);
  assert.ok((usage.output_tokens ?? 0) > 0, "openai output tokens folded from the stream");
});
