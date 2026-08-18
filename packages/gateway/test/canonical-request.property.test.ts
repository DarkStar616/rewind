import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalizeRequest } from "../src/canonical-request.ts";

/**
 * Property/fuzz tests for the replay key — the correctness-critical invariant. A false HIT serves a
 * WRONG answer, so across many randomized requests we assert: (1) noise never changes the key,
 * (2) any output-affecting change ALWAYS changes it, and (3) the key is deterministic. Seeded PRNG so
 * a failure is reproducible.
 */

// A tiny deterministic LCG (Numerical Recipes constants) — reproducible fuzz, no Math.random.
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randInt(rng: () => number, n: number): number {
  return Math.floor(rng() * n);
}

function randText(rng: () => number): string {
  const words = ["fix", "the", "bug", "in", "module", "add", "test", "refactor", "parse", "cache", "token", "42"];
  const len = 3 + randInt(rng, 8);
  return Array.from({ length: len }, () => words[randInt(rng, words.length)]).join(" ");
}

function randRequest(rng: () => number): Record<string, unknown> {
  const nMsgs = 1 + randInt(rng, 4);
  const messages = Array.from({ length: nMsgs }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: randText(rng),
  }));
  const body: Record<string, unknown> = {
    model: ["claude-opus-4-8", "claude-sonnet-4-5", "gpt-5"][randInt(rng, 3)],
    max_tokens: 128 * (1 + randInt(rng, 8)),
    messages,
  };
  if (rng() < 0.5) body.temperature = randInt(rng, 100) / 100;
  if (rng() < 0.5) body.tools = [{ name: `tool_${randInt(rng, 5)}`, description: randText(rng) }];
  if (rng() < 0.5) body.system = randText(rng);
  return body;
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

test("property: noise fields NEVER change the key (200 randomized requests)", () => {
  const rng = makeRng(0xc0ffee);
  for (let i = 0; i < 200; i++) {
    const base = randRequest(rng);
    const key = canonicalizeRequest(base);
    // Add every category of noise; the key must be unchanged. (stream is deliberately NOT here — it
    // now keys, for wire-format safety: a JSON record must never be served to a streaming parser.)
    const noisy = clone(base);
    noisy.metadata = { user_id: `u_${randInt(rng, 1000)}` };
    noisy.prompt_cache_key = `sess_${randInt(rng, 1000)}`;
    noisy.api_key = `sk-${randInt(rng, 1e6)}`;
    // cache_control hints (deep-stripped) added WITHOUT restructuring content: on the message object and
    // at top level. (Restructuring a string into a text block would be a real change, not noise.)
    noisy.cache_control = { type: "ephemeral", ttl: "1h" };
    if (Array.isArray(noisy.messages) && noisy.messages.length > 0) {
      (noisy.messages[0] as Record<string, unknown>).cache_control = { type: "ephemeral" };
    }
    assert.equal(canonicalizeRequest(noisy), key, `iter ${i}: noise changed the key`);
    // And keying with noise HEADERS (auth/user-agent) is identical to no headers.
    assert.equal(canonicalizeRequest(base, { authorization: "Bearer x", "user-agent": "ua" }), key, `iter ${i}: auth header changed the key`);
  }
});

test("property: any output-affecting change ALWAYS changes the key (200 randomized requests)", () => {
  const rng = makeRng(0x1234);
  for (let i = 0; i < 200; i++) {
    const base = randRequest(rng);
    const key = canonicalizeRequest(base);

    // Mutate the model.
    const m1 = clone(base);
    m1.model = `${m1.model}-x`;
    assert.notEqual(canonicalizeRequest(m1), key, `iter ${i}: model change did not change key`);

    // Mutate the last message text.
    const m2 = clone(base);
    const msgs = m2.messages as { content: string }[];
    msgs[msgs.length - 1].content = `${msgs[msgs.length - 1].content} EXTRA`;
    assert.notEqual(canonicalizeRequest(m2), key, `iter ${i}: message change did not change key`);

    // Mutate max_tokens.
    const m3 = clone(base);
    m3.max_tokens = (m3.max_tokens as number) + 1;
    assert.notEqual(canonicalizeRequest(m3), key, `iter ${i}: max_tokens change did not change key`);

    // An output-affecting HEADER (anthropic-beta) must change the key.
    assert.notEqual(canonicalizeRequest(base, { "anthropic-beta": `feat-${i}` }), key, `iter ${i}: beta header ignored`);
  }
});

test("property: the key is deterministic across re-serialization and key order (200 requests)", () => {
  const rng = makeRng(0x9e3779b9);
  for (let i = 0; i < 200; i++) {
    const base = randRequest(rng);
    // A deep clone (different object identity, possibly different key insertion order via JSON) keys identically.
    assert.equal(canonicalizeRequest(clone(base)), canonicalizeRequest(base), `iter ${i}: not deterministic`);
    // Explicitly reversed top-level key order keys identically (canonical, not textual).
    const reversed: Record<string, unknown> = {};
    for (const k of Object.keys(base).reverse()) reversed[k] = (base as Record<string, unknown>)[k];
    assert.equal(canonicalizeRequest(reversed), canonicalizeRequest(base), `iter ${i}: key order mattered`);
  }
});
