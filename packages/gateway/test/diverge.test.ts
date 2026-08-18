import { test } from "node:test";
import assert from "node:assert/strict";
import { divergeMessages } from "../src/diverge.ts";

const body = (msgs: unknown[]) => ({ model: "m", messages: msgs });

test("identical bodies have no divergence", () => {
  const r = divergeMessages(body([{ role: "user", content: "a" }]), body([{ role: "user", content: "a" }]));
  assert.equal(r.kinds.length, 0);
  assert.equal(r.firstDivergence, undefined);
});

test("object key order does not count as divergence (canonical comparison)", () => {
  const r = divergeMessages(body([{ role: "user", content: "a" }]), body([{ content: "a", role: "user" }]));
  assert.equal(r.kinds.length, 0, "same content, different key order, is identical after canonicalization");
});

test("classifies input-mismatch, extra-call and missing-call, reporting the first", () => {
  const a = body([{ role: "user", content: "a" }, { role: "user", content: "b" }]);
  const b = body([{ role: "user", content: "a" }, { role: "user", content: "CHANGED" }, { role: "user", content: "c" }]);
  const r = divergeMessages(a, b);
  assert.equal(r.firstDivergence?.kind, "input-mismatch");
  assert.equal(r.firstDivergence?.index, 1);
  assert.ok(r.kinds.some((k) => k.kind === "extra-call" && k.index === 2));
});

test("a shorter b yields a missing-call for the trailing message in a", () => {
  const a = body([{ role: "user", content: "a" }, { role: "user", content: "b" }]);
  const b = body([{ role: "user", content: "a" }]);
  const r = divergeMessages(a, b);
  assert.equal(r.kinds.length, 1);
  assert.equal(r.firstDivergence?.kind, "missing-call");
  assert.equal(r.firstDivergence?.index, 1);
});

test("a body with no messages array is tolerated as empty (no throw)", () => {
  const r = divergeMessages({ model: "m" }, body([{ role: "user", content: "a" }]));
  assert.equal(r.kinds.length, 1);
  assert.equal(r.firstDivergence?.kind, "extra-call");
});
