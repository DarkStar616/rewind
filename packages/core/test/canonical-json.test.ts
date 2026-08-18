import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, CanonicalJsonError } from "../src/audit/canonical-json.ts";

// e-acute in two Unicode forms and an astral emoji, built from escapes so this file's on-disk
// byte encoding cannot silently normalise them into one another.
const E_COMPOSED = "é"; // single code point U+00E9
const E_DECOMPOSED = "é"; // 'e' + combining acute U+0301
const EMOJI = "\u{1f600}"; // grinning face, astral plane

test("key order does not change the canonical form", () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
});

test("key order is normalised deeply, not just at the top level", () => {
  const a = { outer: { z: 1, a: 2 }, list: [{ y: 1, x: 2 }] };
  const b = { list: [{ x: 2, y: 1 }], outer: { a: 2, z: 1 } };
  assert.equal(canonicalize(a), canonicalize(b));
});

test("rejects non-finite numbers (Infinity, -Infinity, NaN)", () => {
  assert.throws(() => canonicalize({ x: Infinity }), CanonicalJsonError);
  assert.throws(() => canonicalize({ x: -Infinity }), CanonicalJsonError);
  assert.throws(() => canonicalize({ x: NaN }), CanonicalJsonError);
  assert.throws(() => canonicalize(NaN), CanonicalJsonError);
});

test("rejects a non-finite number nested inside arrays and objects", () => {
  assert.throws(() => canonicalize({ a: { b: [1, 2, NaN] } }), CanonicalJsonError);
  assert.throws(() => canonicalize([{ ok: 1 }, { bad: Infinity }]), CanonicalJsonError);
});

test("rejects bigint, function, symbol and undefined at the top level", () => {
  assert.throws(() => canonicalize(10n), CanonicalJsonError);
  assert.throws(() => canonicalize(() => 1), CanonicalJsonError);
  assert.throws(() => canonicalize(Symbol("s")), CanonicalJsonError);
  assert.throws(() => canonicalize(undefined), CanonicalJsonError);
});

test("rejects a bigint or function nested in a value", () => {
  assert.throws(() => canonicalize({ n: 5n }), CanonicalJsonError);
  assert.throws(() => canonicalize({ f: () => 1 }), CanonicalJsonError);
});

test("rejects non-plain objects (Date, Map, class instance)", () => {
  assert.throws(() => canonicalize({ when: new Date() }), CanonicalJsonError);
  assert.throws(() => canonicalize({ m: new Map() }), CanonicalJsonError);
  class Widget {
    a = 1;
  }
  assert.throws(() => canonicalize(new Widget()), CanonicalJsonError);
});

test("a null-prototype object canonicalises the same as its plain twin", () => {
  const bare = Object.assign(Object.create(null), { a: 1, b: 2 });
  assert.equal(canonicalize(bare), canonicalize({ a: 1, b: 2 }));
});

test("array holes have no canonical form", () => {
  const holed = [1, , 3];
  assert.throws(() => canonicalize(holed), CanonicalJsonError);
  assert.throws(() => canonicalize({ list: [1, , 3] }), CanonicalJsonError);
});

test("undefined array elements are refused, but undefined object properties are dropped", () => {
  assert.throws(() => canonicalize([1, undefined, 3]), CanonicalJsonError);
  // an object property set to undefined is dropped, matching JSON.stringify
  assert.equal(canonicalize({ a: 1, b: undefined }), canonicalize({ a: 1 }));
});

test("top-level primitives canonicalise", () => {
  assert.equal(canonicalize(null), "null");
  assert.equal(canonicalize(true), "true");
  assert.equal(canonicalize(false), "false");
  assert.equal(canonicalize(0), "0");
  assert.equal(canonicalize("hi"), '"hi"');
});

test("negative zero and large numbers have a stable canonical form", () => {
  assert.equal(canonicalize({ n: -0 }), '{"n":0}');
  assert.equal(canonicalize({ n: 1e21 }), '{"n":1e+21}');
  assert.equal(canonicalize({ n: 0.1 }), '{"n":0.1}');
});

test("a circular reference is refused cleanly, not as a stack overflow", () => {
  const a: Record<string, unknown> = {};
  a.self = a;
  assert.throws(() => canonicalize(a), CanonicalJsonError);
  const arr: unknown[] = [];
  arr.push(arr);
  assert.throws(() => canonicalize(arr), CanonicalJsonError);
  // transitive cycle through a second container
  const x: Record<string, unknown> = {};
  const y: Record<string, unknown> = { x };
  x.y = y;
  assert.throws(() => canonicalize({ root: x }), CanonicalJsonError);
});

test("a DAG (the same object referenced twice, without a cycle) still canonicalises", () => {
  const shared = { v: 1 };
  assert.equal(canonicalize({ a: shared, b: shared }), '{"a":{"v":1},"b":{"v":1}}');
  const twice = [shared, shared];
  assert.equal(canonicalize(twice), '[{"v":1},{"v":1}]');
});

test("unicode and emoji keys sort by UTF-16 code unit and are not normalised", () => {
  // Composed e-acute, decomposed e-acute, and an astral emoji are three DISTINCT keys —
  // canonicalisation must not Unicode-normalise them together.
  const o: Record<string, number> = {};
  o["z"] = 0;
  o["a"] = 0;
  o[E_COMPOSED] = 1;
  o[E_DECOMPOSED] = 3;
  o[EMOJI] = 2;
  // 5 distinct keys (z, a, composed-é, decomposed-é, emoji); 4 would mean the two é forms collapsed
  assert.equal(Object.keys(o).length, 5);
  // UTF-16 code-unit order: 'a'(0x61) < decomposed(0x65..) < 'z'(0x7a) < composed(0xe9) < emoji(0xd83d..)
  const expected =
    "{" +
    '"a":0,' +
    `${JSON.stringify(E_DECOMPOSED)}:3,` +
    '"z":0,' +
    `${JSON.stringify(E_COMPOSED)}:1,` +
    `${JSON.stringify(EMOJI)}:2` +
    "}";
  assert.equal(canonicalize(o), expected);
});

test("golden: a representative nested value has a byte-stable canonical form", () => {
  const v = {
    z: [1, 2, { b: true, a: null }],
    a: "x",
    nested: { deep: [true, false, null], n: 0.5 },
  };
  assert.equal(
    canonicalize(v),
    '{"a":"x","nested":{"deep":[true,false,null],"n":0.5},"z":[1,2,{"a":null,"b":true}]}',
  );
});

test("canonicalising a __proto__ own key does not pollute Object.prototype", () => {
  const payload = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
  const out = canonicalize(payload);
  // the __proto__ own data property is recorded as ordinary content...
  assert.equal(out, '{"__proto__":{"polluted":true},"a":1}');
  // ...and nothing leaked onto the global prototype.
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("a moderately huge payload canonicalises deterministically", () => {
  const big = { items: Array.from({ length: 5000 }, (_, i) => ({ i, ok: i % 2 === 0 })) };
  const once = canonicalize(big);
  const twice = canonicalize(big);
  assert.equal(once, twice);
  assert.ok(once.length > 50000);
});
