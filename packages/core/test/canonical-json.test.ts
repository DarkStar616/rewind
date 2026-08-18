import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize } from "../src/audit/canonical-json.ts";

test("key order does not change the canonical form", () => {
  assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
});
test("rejects non-finite numbers", () => {
  assert.throws(() => canonicalize({ x: Infinity }));
});
