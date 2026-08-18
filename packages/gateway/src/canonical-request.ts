/**
 * canonical-request — turn an LLM request body into a stable `replayKey`.
 *
 * The key is a SHA-256 over the request body with only KNOWN-NOISE fields removed. Two requests that
 * would produce the same output share a key; a request that differs only in a caching hint, the stream
 * flag, auth material, or a request id keeps the SAME key. That equivalence is what lets a
 * byte-different-but-semantically-identical request after a rewind hit the record.
 *
 * The safety asymmetry that dictates the design — READ THIS BEFORE CHANGING IT:
 *
 *   A false MISS costs one redundant paid upstream call (money). A false HIT serves a WRONG, stale
 *   answer for a request that should have produced a different one (a correctness disaster — the agent
 *   acts on a reply that was never generated for it). These are NOT symmetric, so the key is built to
 *   NEVER false-hit, at the cost of occasionally false-missing.
 *
 *   That is why this is a DENY-LIST, not an allow-list. Everything in the body is included in the key
 *   EXCEPT a small set of fields we are certain do not change the output. A field this code has never
 *   heard of — including a future output-affecting API parameter — is therefore INCLUDED, so a request
 *   carrying it gets its own key and MISSES rather than colliding onto an unrelated record. An
 *   allow-list would do the opposite: silently drop the unknown field and serve a stale reply. Missing
 *   a noise entry only reduces reuse; wrongly dropping an output field corrupts the answer.
 *
 * Pure logic over the request body: no filesystem, no clock, no network. Reuses `@rewind/core`'s
 * `canonicalize` for the deterministic, key-sorted serialization the hash is taken over.
 */
import { createHash } from "node:crypto";

import { canonicalize } from "@rewind/core";

/**
 * Top-level fields removed before hashing because they provably do not change the model's output:
 * transport/caching hints, and auth material (auth belongs in headers — stripped defensively in case a
 * caller misplaces it in the body, so a secret is never hashed and a rotated key never busts the key).
 * Compared case-insensitively. Adding to this list only widens reuse; it can never cause a false hit.
 */
export const NOISE_FIELDS: ReadonlySet<string> = new Set([
  "stream",
  "metadata",
  "prompt_cache_key",
  "anthropic_version",
  "anthropic_beta",
  "betas",
  "api_key",
  "apikey",
  "api-key",
  "x-api-key",
  "authorization",
]);

/**
 * Keys stripped wherever they appear in the retained sub-structure. `cache_control` (and its `ttl`)
 * rides on individual system blocks, tool definitions, and message content blocks — nested inside
 * fields we keep — so it cannot be removed at the top level alone.
 */
const DEEP_STRIPPED_KEYS: ReadonlySet<string> = new Set(["cache_control", "ttl", "prompt_cache_key"]);

function deepStrip(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(deepStrip);
  }
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      if (DEEP_STRIPPED_KEYS.has(key)) continue;
      out[key] = deepStrip(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * Project a request body to its key normal form: drop top-level noise, deep-strip nested cache hints,
 * and KEEP everything else (known or unknown) so an unrecognized field forces a miss, not a false hit.
 */
function project(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    // Non-object bodies have no top-level fields to filter; still strip nested hints for stability.
    return deepStrip(body);
  }
  const source = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (NOISE_FIELDS.has(key.toLowerCase())) continue;
    // Cache hints are noise wherever they sit — strip them at the top level too, not just when nested.
    if (DEEP_STRIPPED_KEYS.has(key)) continue;
    if (source[key] === undefined) continue;
    out[key] = deepStrip(source[key]);
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
