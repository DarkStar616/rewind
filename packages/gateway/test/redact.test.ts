import { test } from "node:test";
import assert from "node:assert/strict";
import { redactValue, redactedExportView, DEFAULT_REDACTORS, DROP } from "../src/redact.ts";

test("DEFAULT_REDACTORS masks an api key by key-name, preserving structure", () => {
  const out = redactValue(
    { model: "m", api_key: "sk-ant-secret", nested: { authorization: "Bearer x" } },
    DEFAULT_REDACTORS,
    { path: "$", kind: "request" },
  );
  assert.equal((out as any).model, "m", "non-secret fields are preserved verbatim");
  assert.notEqual((out as any).api_key, "sk-ant-secret", "api_key is masked");
  assert.notEqual((out as any).nested.authorization, "Bearer x", "nested authorization is masked");
});

test("DEFAULT_REDACTORS masks an sk- token by VALUE even under an innocuous key", () => {
  const out = redactValue({ note: "my key is sk-ant-api03-abcdefgh please" }, DEFAULT_REDACTORS, {
    path: "$",
    kind: "response",
  });
  assert.ok(!String((out as any).note).includes("sk-ant-api03-abcdefgh"), "the token substring is gone");
});

test("EVERY secret in a multi-credential string is masked, not just the first", () => {
  const out = redactValue(
    { note: "sk-ant-aaaaaa then ghp_12345678901234567890 and xoxb-abcdef done" },
    DEFAULT_REDACTORS,
    { path: "$", kind: "response" },
  );
  const note = String((out as any).note);
  assert.ok(!note.includes("sk-ant-aaaaaa"), "first token gone");
  assert.ok(!note.includes("ghp_12345678901234567890"), "second (github) token gone");
  assert.ok(!note.includes("xoxb-abcdef"), "third (slack) token gone");
});

test("a DROP return replaces the value with a redaction marker, not the original", () => {
  const drop = (v: unknown) => (typeof v === "string" && v.includes("SECRET") ? DROP : v);
  const out = redactValue({ a: "keep", b: "SECRET-payload" }, drop, { path: "$", kind: "request" });
  assert.equal((out as any).a, "keep");
  assert.deepEqual((out as any).b, { "[redacted]": true });
});

test("redaction is deep through arrays and nested objects", () => {
  const out = redactValue(
    { messages: [{ role: "user", api_key: "sk-ant-xyz1234567" }, { role: "assistant", content: "ok" }] },
    DEFAULT_REDACTORS,
    { path: "$", kind: "request" },
  );
  assert.notEqual((out as any).messages[0].api_key, "sk-ant-xyz1234567");
  assert.equal((out as any).messages[1].content, "ok");
});

test("redactedExportView never mutates the input record (replay tape stays byte-exact)", () => {
  const call = { response: { text: "sk-ant-leak000000" }, usage: { input_tokens: 1 }, model: "m" };
  const before = JSON.stringify(call);
  const view = redactedExportView(call as never, (v: unknown) => (typeof v === "string" && v.startsWith("sk-ant") ? DROP : v));
  assert.equal(JSON.stringify(call), before, "the input record is untouched");
  assert.notDeepEqual(view.response, call.response, "the export copy's response is redacted");
  assert.equal(view.model, "m", "non-secret metadata carries through");
});

test("a __proto__ key in recorded data does not pollute Object.prototype", () => {
  const out = redactValue(JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}'), DEFAULT_REDACTORS, {
    path: "$",
    kind: "response",
  });
  assert.equal((out as any).ok, 1);
  assert.equal(({} as any).polluted, undefined, "prototype was not polluted");
});
