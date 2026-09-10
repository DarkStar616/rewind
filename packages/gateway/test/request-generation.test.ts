import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeRequest } from "../src/canonical-request.ts";

// New coverage authorized by the user against the OSS core-oracle review packet.
// Existing human-owned test files are unchanged.
for (const [label, wrap] of [
  ["top level", (x: unknown) => x],
  ["nested tool input", (x: unknown) => ({ messages: [{ content: [{ type: "tool_use", input: x }] }] })],
  ["array", (x: unknown) => [x]],
] as const) {
  test(`request identity preserves own prototype-named data: ${label}`, () => {
    const values = [null, 1, 2, "a", "b", { role: "a" }, { role: "b" }];
    const keys = values.map(value => {
      const obj = JSON.parse(`{"input":"x","__proto__":${JSON.stringify(value)}}`);
      const before = JSON.stringify(obj);
      const key = canonicalizeRequest(wrap(obj));
      assert.equal(JSON.stringify(obj), before, "projection must not mutate input");
      return key;
    });
    keys.push(canonicalizeRequest(wrap({ input: "x" })));
    assert.equal(new Set(keys).size, keys.length, "distinct own data must not collide");
  });
}

test("new request generation cannot reuse a pre-repair key", () => {
  // Captured from shipped generation 1 for {input:"x"}, without URL/headers.
  // Both own __proto__:1 and __proto__:2 collided with this ordinary body's key.
  const contaminatedKey = "1f558765afff9ca84a816076e716b44de917f654aa5ce9c52db8eb44b08aefd3";
  assert.notEqual(canonicalizeRequest({ input: "x" }), contaminatedKey);
});

test("own prototype-named data remains insensitive to object property order", () => {
  const a = JSON.parse('{"__proto__":{"b":2,"a":1},"input":"x"}');
  const b = JSON.parse('{"input":"x","__proto__":{"a":1,"b":2}}');
  assert.equal(canonicalizeRequest(a), canonicalizeRequest(b));
});

test("unclassified provider headers participate in identity with case-insensitive names", () => {
  const body = { input: "x" };
  const plain = canonicalizeRequest(body);
  for (const name of ["x-provider-behavior", "openai-project", "accept", "content-type", "__proto__", "constructor"]) {
    const a = Object.fromEntries([[name, "a"]]);
    const b = Object.fromEntries([[name, "b"]]);
    assert.notEqual(canonicalizeRequest(body, a), plain, `${name} cannot disappear`);
    assert.notEqual(canonicalizeRequest(body, a), canonicalizeRequest(body, b));
    assert.equal(canonicalizeRequest(body, a), canonicalizeRequest(body, Object.fromEntries([[name.toUpperCase(), "a"]])));
  }
});

test("local control and regenerated transport headers do not split replay identity", () => {
  const body = { input: "x" };
  const headers = { "x-rewind-scope": "a", "x-rewind-request-id": "retry-1", host: "localhost:1234", "content-length": "13", "accept-encoding": "gzip", connection: "close" };
  assert.equal(canonicalizeRequest(body, headers), canonicalizeRequest(body));
});

test("hint-shaped user data cannot disappear inside tool arguments or unknown fields", () => {
  const changed = (ttl: string) => ({ cache_control: { type: "ephemeral", ttl } });
  for (const wrap of [
    (x: unknown) => ({ messages: [{ role: "assistant", content: [{ type: "tool_use", input: x }] }] }),
    (x: unknown) => ({ tools: [{ name: "t", input_schema: { default: x } }] }),
    (x: unknown) => ({ future_feature: x }),
  ]) {
    assert.notEqual(canonicalizeRequest(wrap(changed("5m"))), canonicalizeRequest(wrap(changed("1h"))));
  }
});

test("unrecognized fields on cache-control hints remain in identity", () => {
  const body = (mode: string) => ({ system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", future_mode: mode } }] });
  assert.notEqual(canonicalizeRequest(body("a")), canonicalizeRequest(body("b")));
});

test("ambiguous or malformed supplied headers are rejected instead of being coerced", () => {
  for (const headers of [{ "X-Feature": "a", "x-feature": "b" }, { "x-feature": [1] }, { "x-feature": 1 }, { "bad\nname": "x" }, { "x-feature": "bad\r\nvalue" }]) {
    assert.throws(() => canonicalizeRequest({input:"x"}, headers as unknown as Record<string,string>));
  }
});
