import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeCacheHygiene } from "../src/cache-hygiene.ts";

/**
 * The analyzer flags dynamic content in the STABLE prefix (which silently forfeits ~78-80% of possible
 * cache savings) and the 4-breakpoint cap — advisory only, never mutating the request.
 */

test("a clean request with a stable prefix is cacheable, no issues", () => {
  const r = analyzeCacheHygiene({
    model: "m",
    system: "You are a careful coding assistant.",
    tools: [{ name: "search", description: "search the codebase" }],
    messages: [
      { role: "user", content: "first question" },
      { role: "assistant", content: "an answer" },
      { role: "user", content: "the fresh turn" },
    ],
  });
  assert.equal(r.cacheable, true);
  assert.equal(r.prefixPoisoners.length, 0);
});

test("an ISO timestamp in the system prompt is a prefix poisoner", () => {
  const r = analyzeCacheHygiene({
    model: "m",
    system: "You are helpful. Current time: 2026-08-18T14:30:00Z.",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.cacheable, false);
  assert.equal(r.prefixPoisoners[0].reason, "timestamp");
  assert.match(r.prefixPoisoners[0].path, /system/);
  assert.match(r.recommendation, /dynamic content/i);
});

test("a UUID in a tool description is flagged", () => {
  const r = analyzeCacheHygiene({
    model: "m",
    tools: [{ name: "t", description: "session 550e8400-e29b-41d4-a716-446655440000" }],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.cacheable, false);
  assert.equal(r.prefixPoisoners[0].reason, "uuid");
});

test("a session_id field anywhere in the prefix is flagged", () => {
  const r = analyzeCacheHygiene({
    model: "m",
    system: [{ type: "text", text: "static", session_id: "abc-123" }],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.cacheable, false);
  assert.equal(r.prefixPoisoners.some((p) => p.reason === "session-id"), true);
});

test("dynamic content in the LAST message (the suffix) is NOT flagged", () => {
  const r = analyzeCacheHygiene({
    model: "m",
    system: "You are helpful.",
    messages: [
      { role: "user", content: "old turn" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "now it is 2026-08-18T14:30:00Z, uuid 550e8400-e29b-41d4-a716-446655440000" },
    ],
  });
  assert.equal(r.cacheable, true, "the fresh suffix may vary freely without hurting the cache");
  assert.equal(r.prefixPoisoners.length, 0);
});

test("more than 4 cache_control breakpoints trips the cap", () => {
  const cc = { cache_control: { type: "ephemeral" } };
  const r = analyzeCacheHygiene({
    model: "m",
    system: [{ type: "text", text: "a", ...cc }],
    tools: [
      { name: "t1", ...cc },
      { name: "t2", ...cc },
      { name: "t3", ...cc },
      { name: "t4", ...cc },
    ],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.breakpointCount, 5);
  assert.equal(r.overBreakpointCap, true);
  assert.equal(r.cacheable, false);
  assert.match(r.recommendation, /4 or fewer/);
});

test("cache_control markers themselves are not mistaken for content poisoners", () => {
  const r = analyzeCacheHygiene({
    model: "m",
    system: [{ type: "text", text: "static instructions", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.cacheable, true);
  assert.equal(r.breakpointCount, 1);
});
