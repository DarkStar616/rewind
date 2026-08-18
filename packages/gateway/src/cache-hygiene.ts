/**
 * cache-hygiene — static analysis of a request's prompt-cache friendliness.
 *
 * The research is blunt (arXiv 2601.06007v2 + Anthropic docs): a cache hit needs a BYTE-IDENTICAL
 * prefix, and the #1 real-world way teams silently forfeit ~78-80% of possible cache savings is
 * putting dynamic content — a timestamp, a session id, a per-request uuid — EARLY in the prompt, so
 * the whole cacheable prefix changes every turn and never hits. This analyzer flags exactly that,
 * plus the hard 4-breakpoint cap (a 5th needed for auto-caching returns HTTP 400).
 *
 * It is ADVISORY and PURE: it reads the request, reports what would poison caching, and recommends
 * the fix (push dynamic content to the suffix). It never mutates the request and never blocks a call,
 * so it cannot affect exact-replay determinism.
 */

export type HygieneReason = "timestamp" | "epoch" | "uuid" | "session-id" | "too-many-breakpoints";

export interface HygieneIssue {
  /** Where in the request the poisoner sits (dotted/indexed path). */
  path: string;
  reason: HygieneReason;
  detail: string;
}

export interface CacheHygieneReport {
  /** Number of cache_control breakpoints found anywhere in the request. */
  breakpointCount: number;
  /** True when breakpointCount > 4 (Anthropic's hard cap). */
  overBreakpointCap: boolean;
  /** Dynamic content in the STABLE prefix (system + tools + all-but-last message) that forfeits caching. */
  prefixPoisoners: HygieneIssue[];
  /** True when the stable prefix is clean and the breakpoint cap is respected. */
  cacheable: boolean;
  /** A one-line, human-actionable recommendation. */
  recommendation: string;
}

// High-confidence "this is per-request dynamic content" patterns. Tuned to avoid flagging static text.
const ISO_DATETIME = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
// A bare ISO date (no time). Agents VERY commonly inject "Today's date is 2026-08-18" into the system
// prompt, which changes daily and forfeits the cache — a false negative we must not miss. The false
// positive (a static date mentioned in content) only costs a spurious advisory, so we accept it.
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
// Epoch seconds (10 digits, ~2001-2033) or ms (13 digits) starting with 1 — narrow to cut false positives.
const EPOCH_STR = /\b1\d{9}(\d{3})?\b/;
// Per-request id fields (session/run/thread/invocation/… _id, plus a bare nonce). Matched on the KEY.
const DYNAMIC_ID_KEY =
  /^((session|request|trace|correlation|conversation|turn|run|thread|invocation|message|call|tool)[_-]?id|nonce)$/i;

function truncate(s: string, n = 40): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** A real Anthropic cache breakpoint: an object whose `type` is "ephemeral" (NOT a schema property that
 *  merely happens to be named `cache_control`). */
function isEphemeralCacheControl(v: unknown): boolean {
  return !!v && typeof v === "object" && (v as Record<string, unknown>).type === "ephemeral";
}

/** A number that looks like a Unix epoch in seconds (2001-2033) or milliseconds — likely per-request. */
function looksLikeEpochNumber(n: number): boolean {
  if (!Number.isInteger(n)) return false;
  return (n >= 1_000_000_000 && n < 10_000_000_000) || (n >= 1_000_000_000_000 && n < 10_000_000_000_000);
}

/** Test a string for the first dynamic-content pattern it matches; push at most one issue per string. */
function checkString(value: string, path: string, issues: HygieneIssue[]): void {
  if (ISO_DATETIME.test(value) || ISO_DATE.test(value)) {
    issues.push({ path, reason: "timestamp", detail: `contains an ISO date/time ('${truncate(value)}')` });
  } else if (UUID.test(value)) {
    issues.push({ path, reason: "uuid", detail: `contains a UUID ('${truncate(value)}')` });
  } else if (EPOCH_STR.test(value)) {
    issues.push({ path, reason: "epoch", detail: `contains an epoch-like number ('${truncate(value)}')` });
  }
}

/** Recursively scan a value, recording poisoners with their path. Handles string AND numeric dynamics. */
function walk(value: unknown, path: string, issues: HygieneIssue[]): void {
  if (typeof value === "string") {
    checkString(value, path, issues);
  } else if (typeof value === "number") {
    if (looksLikeEpochNumber(value)) {
      issues.push({ path, reason: "epoch", detail: `numeric epoch-like value (${value})` });
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, issues));
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // A per-request id field, whether its value is a string or a number (run_id: 42, session_id: "…").
      if (DYNAMIC_ID_KEY.test(k) && ((typeof v === "string" && v.length > 0) || typeof v === "number")) {
        issues.push({
          path: path ? `${path}.${k}` : k,
          reason: "session-id",
          detail: `field '${k}' holds a per-request id ('${truncate(String(v))}')`,
        });
      }
      // cache_control is a hint, not content — never scan it as a poisoner; it's counted separately.
      if (k === "cache_control") continue;
      walk(v, path ? `${path}.${k}` : k, issues);
    }
  }
}

/** Count REAL cache breakpoints (ephemeral cache_control), not every key literally named cache_control. */
function countBreakpoints(value: unknown): number {
  if (Array.isArray(value)) return value.reduce<number>((n, v) => n + countBreakpoints(v), 0);
  if (value !== null && typeof value === "object") {
    let n = 0;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "cache_control" && isEphemeralCacheControl(v)) n += 1;
      else n += countBreakpoints(v);
    }
    return n;
  }
  return 0;
}

/** Does a value carry a real ephemeral cache breakpoint anywhere within it? */
function hasEphemeralCacheControl(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasEphemeralCacheControl);
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if ("cache_control" in o && isEphemeralCacheControl(o.cache_control)) return true;
    return Object.values(o).some(hasEphemeralCacheControl);
  }
  return false;
}

/**
 * Analyze a request body's cache friendliness. Scans only the STABLE prefix (system + tools + every
 * message except the last, which is the fresh turn) for dynamic content, and counts breakpoints.
 */
export function analyzeCacheHygiene(body: unknown): CacheHygieneReport {
  const issues: HygieneIssue[] = [];
  const breakpointCount = countBreakpoints(body);
  const overBreakpointCap = breakpointCount > 4;

  if (body !== null && typeof body === "object" && !Array.isArray(body)) {
    const b = body as Record<string, unknown>;
    if (b.system !== undefined) walk(b.system, "system", issues);
    if (b.tools !== undefined) walk(b.tools, "tools", issues);
    const messages = Array.isArray(b.messages) ? b.messages : [];
    const lastIdx = messages.length - 1;
    // All but the LAST message is prefix; the last message is normally the fresh suffix and may vary
    // freely. BUT if a breakpoint sits ON the last message, a cache write includes it, so its dynamic
    // content DOES poison that write — scan it too in that case.
    messages.slice(0, Math.max(0, lastIdx)).forEach((m, i) => walk(m, `messages[${i}]`, issues));
    if (lastIdx >= 0 && hasEphemeralCacheControl(messages[lastIdx])) {
      walk(messages[lastIdx], `messages[${lastIdx}]`, issues);
    }
  }

  if (overBreakpointCap) {
    issues.push({
      path: "(request)",
      reason: "too-many-breakpoints",
      detail: `${breakpointCount} cache_control breakpoints found; Anthropic allows at most 4`,
    });
  }

  const cacheable = issues.length === 0;
  const recommendation = cacheable
    ? "Prefix is cache-friendly."
    : overBreakpointCap
      ? `Reduce cache_control breakpoints to 4 or fewer (found ${breakpointCount}).`
      : "Move dynamic content (timestamps, session/request ids, uuids) to the LAST message so the static prefix stays byte-identical and caches.";

  return { breakpointCount, overBreakpointCap, prefixPoisoners: issues.filter((i) => i.reason !== "too-many-breakpoints"), cacheable, recommendation };
}
