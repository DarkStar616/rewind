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
 * Pure logic over the request body: no filesystem, no clock, no network. Reuses `@agent-rewind/core`'s
 * `canonicalize` for the deterministic, key-sorted serialization the hash is taken over.
 */
import { createHash } from "node:crypto";
import { validateHeaderName, validateHeaderValue } from "node:http";

import { canonicalize } from "@agent-rewind/core";

/**
 * Top-level fields removed before hashing because they provably do not change the model's output:
 * transport/caching hints, and auth material (auth belongs in headers — stripped defensively in case a
 * caller misplaces it in the body, so a secret is never hashed and a rotated key never busts the key).
 * Compared case-insensitively. Every addition needs evidence: excluding meaningful data can false-hit.
 */
export const NOISE_FIELDS: ReadonlySet<string> = new Set([
  // NOTE: `stream` is deliberately NOT here. It does not change the model's TEXT, but the wire format
  // (SSE vs JSON) differs and we replay opaque bytes — so a stream/non-stream pair MUST get different
  // keys or a JSON record would be served to a streaming parser. Keying on it keeps replay faithful.
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

/** Only understood hint shapes are noise; extensions stay in identity. */
function isCacheHint(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const hint = value as Record<string, unknown>;
  return (hint.type === "ephemeral" || hint.type === "persistent") &&
    Object.keys(hint).every(key => key === "type" || key === "ttl") &&
    (hint.ttl === undefined || hint.ttl === "5m" || hint.ttl === "1h");
}

function isPlain(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** Strip at a provider envelope/block boundary, never inside arbitrary user data. */
function stripBlockHint(value: unknown): unknown {
  if (!isPlain(value)) return value;
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(value)) {
    if (key === "cache_control" && isCacheHint(value[key])) continue;
    out[key] = value[key];
  }
  return out;
}

function projectMessage(value: unknown): unknown {
  const out = stripBlockHint(value);
  if (isPlain(out) && Array.isArray(out.content)) out.content = out.content.map(stripBlockHint);
  return out;
}

/**
 * Hint removal is structural: request, system/tool blocks and message envelopes/
 * content blocks. Tool arguments, schemas, results and unknown fields remain
 * opaque even when user data looks exactly like a provider cache directive.
 */
function project(body: unknown): unknown {
  if (!isPlain(body)) return body;
  const out: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(body)) {
    if (NOISE_FIELDS.has(key.toLowerCase())) continue;
    if (key === "cache_control" && isCacheHint(body[key])) continue;
    const value = body[key];
    if ((key === "system" || key === "tools") && Array.isArray(value)) out[key] = value.map(stripBlockHint);
    else if (key === "messages" && Array.isArray(value)) out[key] = value.map(projectMessage);
    else out[key] = value;
  }
  return out;
}

/** Historically named examples; this is not an exhaustive header allowlist. */
export const KEY_HEADERS: readonly string[] = ["anthropic-version", "anthropic-beta"];

// Only established auth/local/transport fields are omitted. Unknown provider
// headers remain part of identity; a new feature flag must never silently vanish.
const HEADER_NOISE = new Set([
  "authorization", "x-api-key", "api-key", "proxy-authorization", "user-agent",
  "host", "content-length", "accept-encoding", "connection",
  "keep-alive", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade",
]);

function pickKeyHeaders(headers: Record<string, string | string[] | undefined> | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = key.toLowerCase();
    if (value === undefined || HEADER_NOISE.has(name) || name.startsWith("x-rewind-")) continue;
    if (Object.hasOwn(out, name)) throw new Error("ambiguous duplicate request header");
    try {
      validateHeaderName(name);
      if (typeof value !== "string" && !(Array.isArray(value) && value.every(v => typeof v === "string"))) throw new Error();
      const normalized = Array.isArray(value) ? value.join(", ") : value;
      validateHeaderValue(name, normalized);
      out[name] = normalized;
    } catch { throw new Error("invalid request header"); }
  }
  return out;
}

/**
 * Query-string parameters that are AUTH material and must never enter the key: Gemini passes its API
 * key as `?key=<API_KEY>`, and some gateways accept `access_token`/`api_key`. Dropping them keeps
 * secrets out of the hash and stops a rotated key from busting an otherwise-identical request.
 */
const QUERY_AUTH_NOISE: ReadonlySet<string> = new Set(["key", "access_token", "api_key", "apikey"]);

/**
 * Reduce a request URL to its output-affecting target: the pathname plus the NON-auth query params.
 * Folded into the replay identity so two requests whose OUTPUT-AFFECTING target differs — but whose
 * bodies are byte-identical — never collide onto one key.
 *
 * `url` may be ABSOLUTE (scheme+host+path), in which case the upstream ORIGIN becomes part of the
 * identity too — this is how a shared record store is kept from serving a response recorded against a
 * different upstream (two OpenAI-compatible vendors both speak `/v1/chat/completions`). The origin is
 * simply the part of the target before the query, so no special-casing is needed here.
 *
 * Gemini is the motivating case on BOTH the path and query axes: the model lives only in the path
 * (…/gemini-2.5-pro:generateContent vs …:flash), and the JSON-vs-SSE wire choice can live only in the
 * query (`?alt=sse`). Keeping the pathname stops two models colliding; keeping the non-auth query
 * stops an SSE response being replayed to a caller that asked for JSON (byte-exact replay would break).
 * The AUTH params are dropped (QUERY_AUTH_NOISE) so secrets are never hashed. Anthropic/OpenAI carry
 * the model in the body, so this only distinguishes genuinely different endpoints for them. Per the
 * module deny-list discipline: an unknown query param is KEPT, so it forces a miss, never a false hit.
 *
 * The query is captured as the ORDERED SEQUENCE of `[name, value]` pairs (auth-stripped), not grouped
 * by name. An array preserves order and multiplicity exactly, and canonicalize() never reorders array
 * elements — so `?a=1&b=2&a=3` and `?a=1&a=3&b=2` (which an endpoint reading the full sequence may
 * interpret differently) key DIFFERENTLY, and `?p=a&p=b` never collides with `?p=a,b`. A pair-array
 * also sidesteps the `__proto__` hazard entirely: a param literally named `__proto__` is just a string
 * element, never an object key that could mutate a prototype and make the value non-plain.
 */
function keyTarget(url: string | undefined): { path: string; query: string[][] } {
  if (!url) return { path: "", query: [] };
  const qIdx = url.indexOf("?");
  const path = qIdx === -1 ? url : url.slice(0, qIdx);
  const query: string[][] = [];
  if (qIdx !== -1) {
    // URLSearchParams iterates in ARRIVAL order, duplicates included — exactly the sequence to preserve.
    for (const [name, value] of new URLSearchParams(url.slice(qIdx + 1))) {
      if (QUERY_AUTH_NOISE.has(name.toLowerCase())) continue;
      query.push([name, value]);
    }
  }
  return { path, query };
}

/**
 * canonicalizeRequest — the replay key for a request body (and the output-affecting headers, if given).
 *
 * @returns a 64-char lowercase hex SHA-256 over the request's normal form. When `headers` is provided,
 * all headers except established auth/local/transport noise is folded in under a reserved slot, so the same body
 * with a different `anthropic-beta`/`anthropic-version` produces a different key. When `url` is
 * provided, its pathname AND its non-auth query params are folded the same way, so the same body sent to
 * a different endpoint/model target (two Gemini models named only in the URL) — or the same target with
 * a different wire choice (`?alt=sse`) — produces a different key and can never false-hit. Auth query
 * params are dropped. Provider-NEUTRAL: the same fold runs for every provider; no adapter touches the key.
 */
export function canonicalizeRequest(
  body: unknown,
  headers?: Record<string, string | string[] | undefined>,
  url?: string,
): string {
  const keyHeaders = pickKeyHeaders(headers);
  // The reserved key uses a ` ` prefix that no real top-level body field can collide with.
  const normal: Record<string, unknown> = { " headers": keyHeaders, body: project(body) };
  // Only present when a url was supplied, so omitted URL remains distinct from an explicitly supplied target.
  if (url !== undefined) {
    const target = keyTarget(url);
    normal[" path"] = target.path;
    normal[" query"] = target.query;
  }
  // Domain separation invalidates every pre-repair key, including ordinary bodies
  // which could previously collide with requests carrying own __proto__ data.
  // Old tape bytes remain intact; only new-generation keys are eligible for lookup.
  return createHash("sha256").update("rewind.request/v2\0").update(canonicalize(normal)).digest("hex");
}
