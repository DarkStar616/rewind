/**
 * canonical-request — turn an LLM request body into a stable `replayKey`.
 *
 * The key is a SHA-256 over ONLY the fields that change what the model emits. Two requests that
 * would produce the same output tokens share a key; a request that differs only in a caching hint,
 * the stream flag, auth material, an id, or a timestamp keeps the SAME key, because none of those
 * change the output. That equivalence is what lets a byte-different-but-semantically-identical
 * request after a rewind hit the record instead of paying for a fresh call.
 *
 * Two disciplines produce the key:
 *   1. An ALLOW-LIST of output-affecting top-level fields. Anything not on the list (stream,
 *      prompt_cache_key, metadata/ids, auth, anthropic_version, timestamps, …) is dropped by
 *      construction — the safe direction, because a newly-added noise field fails OUT of the key
 *      rather than silently perturbing it. New output-affecting fields must be added here.
 *   2. A DEEP STRIP of cache hints, which unlike the noise above are nested INSIDE retained fields:
 *      `cache_control` (and its `ttl`) rides on individual system blocks, tool definitions, and
 *      message content blocks, so it cannot be removed at the top level alone.
 *
 * Shape is Anthropic-native (`/v1/messages`). `stop`/`stop_sequences` are both accepted so the key
 * is stable whichever name a caller uses.
 *
 * Pure logic over the request body: no filesystem, no clock, no network. Reuses `@rewind/core`'s
 * `canonicalize` for the deterministic, key-sorted serialization the hash is taken over.
 */
import { createHash } from "node:crypto";

import { canonicalize } from "@rewind/core";

/**
 * Top-level request fields that can change the model's output. This is the ONLY place the key's
 * inputs are defined; a field absent here is intentionally invisible to the key.
 */
export const OUTPUT_AFFECTING_FIELDS: readonly string[] = [
  "model",
  "system",
  "messages",
  "tools",
  "tool_choice",
  "temperature",
  "top_p",
  "top_k",
  "max_tokens",
  "stop",
  "stop_sequences",
  "seed",
  "response_format",
  "thinking",
];

/**
 * Keys stripped wherever they appear in the retained sub-structure. `ttl` lives only inside
 * `cache_control`, but is listed explicitly so the intent survives any future flattening.
 */
const STRIPPED_KEYS: ReadonlySet<string> = new Set(["cache_control", "ttl", "prompt_cache_key"]);

function deepStrip(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepStrip);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      if (STRIPPED_KEYS.has(key)) continue;
      out[key] = deepStrip(source[key]);
    }
    return out;
  }
  return value;
}

/** Project a request body down to its output-affecting, cache-hint-free normal form. */
function project(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    // Non-object bodies have no allow-list to apply; still strip nested hints for stability.
    return deepStrip(body);
  }
  const source = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of OUTPUT_AFFECTING_FIELDS) {
    const present = Object.prototype.hasOwnProperty.call(source, field);
    if (present && source[field] !== undefined) {
      out[field] = deepStrip(source[field]);
    }
  }
  return out;
}

/**
 * canonicalizeRequest — the replay key for a request body.
 *
 * @returns a 64-char lowercase hex SHA-256 over the request's normal form.
 */
export function canonicalizeRequest(body: unknown): string {
  const normal = project(body);
  return createHash("sha256").update(canonicalize(normal)).digest("hex");
}
