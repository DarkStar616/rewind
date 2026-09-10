/**
 * Advisory TypeScript adaptation of Headroom's history/block prefix classification.
 * Copyright 2025 Headroom Contributors. Licensed under Apache-2.0.
 * Source: headroom/cache/prefix_tracker.py at 7bd4dbaf8f40d00f579f1cfca4bc56716f508d85.
 * Modifications: exact JSON comparison without semantic-field stripping, complete
 * request-setting checks, bounded validation and content-free diagnostics. Unlike
 * upstream, block growth before later messages is divergence. No rewrite, cache
 * policy, replay identity, or provider-cache-hit authority is supplied here.
 * See ../third_party/headroom/LICENSE and NOTICE.
 */
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type ObjectJson = { [key: string]: Json };
export interface PrefixComparison {
  schema: "rewind.prefix-comparison/v1";
  relation: "exact" | "message-append" | "block-append" | "diverged";
  stableMessages: number;
  /** Equal leading content blocks in the first changed message, when comparable. */
  stableBlocks: number;
  firstChangedPath?: string;
  advisoryOnly: true;
  providerCacheHit: "unknown";
}
function invalid(): never { throw new Error("prefix comparison requires bounded plain JSON requests with message arrays"); }
const object = (v: Json): v is ObjectJson => v !== null && typeof v === "object" && !Array.isArray(v);

/** Validate parsed JSON without invoking ordinary accessors or serialization methods.
 * Arbitrary JavaScript Proxies are unsupported; the CLI supplies JSON.parse results. */
function validate(value: unknown, budget: { nodes: number; chars: number }, active = new Set<object>(), depth = 0): asserts value is Json {
  if (++budget.nodes > 100_000 || depth > 64) invalid();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid(); return; }
  if (typeof value === "string") { budget.chars += value.length; if (budget.chars > 2_000_000) invalid(); return; }
  if (typeof value !== "object" || active.has(value)) invalid();
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
  if (array && value.length > 10_000) invalid();
  active.add(value);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 10_001 || (array && keys.length !== value.length + 1)) invalid();
  for (const key of keys) {
    if (array && key === "length") continue;
    if (typeof key !== "string") invalid();
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) invalid();
    budget.chars += key.length;
    if (budget.chars > 2_000_000) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor)) invalid();
    validate(descriptor.value, budget, active, depth + 1);
  }
  active.delete(value);
}
function equal(a: Json, b: Json): boolean {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && equal((a as ObjectJson)[key], (b as ObjectJson)[key]));
}
function outside(a: ObjectJson, b: ObjectJson, excluded: string): boolean {
  const keys = Object.keys(a).filter(k => k !== excluded);
  return keys.length === Object.keys(b).filter(k => k !== excluded).length && keys.every(k => Object.hasOwn(b, k) && equal(a[k], b[k]));
}

/** Supports messages-style requests only. JSON object key order is not significant.
 * Limits cover both inputs together: 100k nodes, 2m UTF-16 code units, depth64,
 * and 10k entries per container. Does not parse bytes or establish wire identity.
 */
export function compareRequestPrefix(previous: unknown, current: unknown): PrefixComparison {
  const budget = { nodes: 0, chars: 0 };
  validate(previous, budget); validate(current, budget);
  if (!object(previous) || !object(current) || !Array.isArray(previous.messages) || !Array.isArray(current.messages)) invalid();
  const before = previous.messages, after = current.messages;
  if (!before.every(object) || !after.every(object)) invalid();
  const result: PrefixComparison = { schema: "rewind.prefix-comparison/v1", relation: "diverged", stableMessages: 0, stableBlocks: 0, advisoryOnly: true, providerCacheHit: "unknown" };
  if (!outside(previous, current, "messages")) return { ...result, firstChangedPath: "$.settings" };
  const limit = Math.min(before.length, after.length);
  let i = 0;
  while (i < limit && equal(before[i], after[i])) i++;
  result.stableMessages = i;
  if (i === limit) {
    if (after.length === before.length) return { ...result, relation: "exact" };
    return { ...result, relation: after.length > before.length ? "message-append" : "diverged", firstChangedPath: `$.messages[${i}]` };
  }
  result.firstChangedPath = `$.messages[${i}]`;
  const a = before[i] as ObjectJson, b = after[i] as ObjectJson;
  if (!outside(a, b, "content") || !Array.isArray(a.content) || !Array.isArray(b.content)) return result;
  let blocks = 0;
  while (blocks < Math.min(a.content.length, b.content.length) && equal(a.content[blocks], b.content[blocks])) blocks++;
  result.stableBlocks = blocks;
  result.firstChangedPath += `.content[${blocks}]`;
  if (i === before.length - 1 && blocks === a.content.length && b.content.length > a.content.length) result.relation = "block-append";
  return result;
}
