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

test("gemini default JSON stream (a JSON ARRAY of chunks, no ?alt=sse) is recordable and meters non-zero", () => {
  const a = selectAdapter({ provider: "gemini" }, "POST", "/v1beta/models/gemini-2.5-pro:streamGenerateContent")!;
  // Default streamGenerateContent returns a JSON array of GenerateContentResponse chunks.
  const arr = JSON.stringify([
    { candidates: [{ content: { parts: [{ text: "he" }] } }], modelVersion: "gemini-2.5-pro" },
    {
      candidates: [{ content: { parts: [{ text: "llo" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, cachedContentTokenCount: 4 },
      modelVersion: "gemini-2.5-pro",
    },
  ]);
  assert.equal(a.isRecordableSuccess(Buffer.from(arr), "application/json"), true);
  const { usage, model } = a.extractUsage(arr, "application/json");
  const metered = meterAvoidance(usage, model ?? "gemini-2.5-pro");
  assert.ok(metered.tokensAvoided > 0, "usage folded from the JSON array");
  assert.ok(metered.costMicros > 0);
});

test("gemini JSON-array stream with NO finishReason (truncated) is NOT recordable", () => {
  const a = selectAdapter({ provider: "gemini" }, "POST", "/v1beta/models/gemini-2.5-pro:streamGenerateContent")!;
  const arr = JSON.stringify([{ candidates: [{ content: { parts: [{ text: "he" }] } }] }]);
  assert.equal(a.isRecordableSuccess(Buffer.from(arr), "application/json"), false);
});

test("gemini JSON-array stream carrying an error element is NOT recordable", () => {
  const a = selectAdapter({ provider: "gemini" }, "POST", "/v1beta/models/gemini-2.5-pro:streamGenerateContent")!;
  const arr = JSON.stringify([{ candidates: [{ finishReason: "STOP" }] }, { error: { code: 500 } }]);
  assert.equal(a.isRecordableSuccess(Buffer.from(arr), "application/json"), false);
});

test("auto-detect: an OpenAI chat path selects the openai adapter, not anthropic", () => {
  const a = selectAdapter({}, "POST", "/v1/chat/completions");
  assert.equal(a?.id, "openai");
});
test("auto-detect: a Gemini generateContent path selects the gemini adapter", () => {
  const a = selectAdapter({}, "POST", "/v1beta/models/gemini-2.5-pro:streamGenerateContent");
  assert.equal(a?.id, "gemini");
});

test("OpenAI selects Chat and Responses while terminal validation remains route-specific", () => {
  const a = selectAdapter({}, "POST", "/v1/responses")!;
  assert.equal(a.id, "openai");
  assert.equal(a.matchPath("POST", "/v1/chat/completions"), true);
  assert.equal(a.isRecordableSuccess(Buffer.from('{"choices":[]}'), "application/json", "/v1/responses"), false);
  assert.equal(a.isRecordableSuccess(Buffer.from('{"object":"response","status":"completed","output":[]}'), "application/json", "/v1/chat/completions"), false);
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
  // Auth query material is dropped from the key: a rotated `?key=` never busts (or leaks into) it.
  const proAuth = canonicalizeRequest(body, undefined, "/v1beta/models/gemini-2.5-pro:generateContent?key=SECRET");
  assert.equal(pro, proAuth, "auth query params (key/access_token) are not part of the key");
  const proAuth2 = canonicalizeRequest(body, undefined, "/v1beta/models/gemini-2.5-pro:generateContent?key=ROTATED");
  assert.equal(pro, proAuth2, "a rotated API key does not change the replay key");
});

test("stream vs non-stream Gemini targets key differently (SSE and JSON wire formats must not cross)", () => {
  const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  // The wire choice can live in the method suffix...
  const json = canonicalizeRequest(body, undefined, "/v1beta/models/gemini-2.5-pro:generateContent");
  const sse = canonicalizeRequest(body, undefined, "/v1beta/models/gemini-2.5-pro:streamGenerateContent");
  assert.notEqual(json, sse);
  // ...or ONLY in the query (`?alt=sse`): a NON-auth output-affecting param is kept, so JSON and SSE
  // to the same method never collide (else an SSE body would be replayed to a JSON parser).
  const sseAlt = canonicalizeRequest(body, undefined, "/v1beta/models/gemini-2.5-pro:generateContent?alt=sse");
  assert.notEqual(json, sseAlt, "?alt=sse must key differently from JSON — non-auth query is output-affecting");
  // Query order/auth mix is normalised: same non-auth params, different order + an auth param → same key.
  const sseAltKeyed = canonicalizeRequest(body, undefined, "/v1beta/models/gemini-2.5-pro:generateContent?key=SECRET&alt=sse");
  assert.equal(sseAlt, sseAltKeyed, "auth dropped, non-auth retained regardless of order");
});

test("repeated query values are unambiguous: ?p=a&p=b never collides with ?p=a,b", () => {
  const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  const base = "/v1beta/models/gemini-2.5-pro:generateContent";
  const repeated = canonicalizeRequest(body, undefined, `${base}?p=a&p=b`);
  const commaJoined = canonicalizeRequest(body, undefined, `${base}?p=a%2Cb`);
  assert.notEqual(repeated, commaJoined, "distinct multi-value targets must not share a key");
  // Value ORDER is PRESERVED, not sorted: an endpoint may interpret repeated params in order, so
  // ?p=a&p=b and ?p=b&p=a are DIFFERENT targets and must not collide (exact-replay contract).
  const reordered = canonicalizeRequest(body, undefined, `${base}?p=b&p=a`);
  assert.notEqual(repeated, reordered, "repeated-value order is significant, never normalised away");
  // GLOBAL sequence order matters too, not just per-name: interleaving differs even with the same
  // per-name value lists, so ?a=1&b=2&a=3 and ?a=1&a=3&b=2 must key differently.
  const interleaved1 = canonicalizeRequest(body, undefined, `${base}?a=1&b=2&a=3`);
  const interleaved2 = canonicalizeRequest(body, undefined, `${base}?a=1&a=3&b=2`);
  assert.notEqual(interleaved1, interleaved2, "the full query sequence is preserved, not grouped by name");
});

test("a query param literally named __proto__ does not crash the key (null-proto query map)", () => {
  const body = { contents: [{ role: "user", parts: [{ text: "hi" }] }] };
  const base = "/v1beta/models/gemini-2.5-pro:generateContent";
  // Must not throw (a plain-object query would have its prototype mutated → canonicalize throws).
  const withProto = canonicalizeRequest(body, undefined, `${base}?__proto__=x`);
  assert.match(withProto, /^[0-9a-f]{64}$/, "still produces a valid 64-hex key");
  // And it is a real, distinguishing param: a different value keys differently.
  const withProto2 = canonicalizeRequest(body, undefined, `${base}?__proto__=y`);
  assert.notEqual(withProto, withProto2);
  const plain = canonicalizeRequest(body, undefined, base);
  assert.notEqual(withProto, plain, "the __proto__ param is kept in the key, not silently dropped");
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
