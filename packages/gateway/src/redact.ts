// Record-time redaction hook + redacted export view (RIP-LIST #2, design re-derived, no imported code).
//
// INVARIANT — this NEVER touches the primary replay tape or the replay key. Redaction is applied only
// to EXPORT / ANALYSIS / LOG copies (the shareable "Free Savings Analysis" report in analysis.ts, and
// any sample surfaced to a human). The recorded body used for byte-exact replay, and the SHA-256
// canonical key computed over it, are left entirely alone — so exact-replay determinism is preserved.
// Encrypting the full replay tape at rest is a separate, later concern (not this module).
//
// Pure and structure-preserving: `redactValue` deep-clones as it walks, applying a caller-supplied
// `RedactFn` at every node. A `DROP` return replaces that value with a `{ "[redacted]": true }` marker.

import type { RecordedCall } from "./record-store.ts";

/** Sentinel a RedactFn returns to drop a value entirely (replaced by a redaction marker). */
export const DROP: unique symbol = Symbol("rewind.redact.DROP");

export interface RedactContext {
  /** JSON-path-ish location of the value, e.g. `$.messages[0].api_key`. Encodes the key names. */
  path: string;
  /** Which half of the recorded call is being redacted. */
  kind: "request" | "response";
}

/**
 * Decide what to do with one value at `ctx.path`. Return the value unchanged to keep it (and let the
 * walker recurse into it), a replacement to substitute it, or `DROP` to redact it out.
 */
export type RedactFn = (value: unknown, ctx: RedactContext) => unknown | typeof DROP;

/** The marker a DROP'd value becomes. Stable shape so downstream/report code can recognise it. */
const REDACTED_MARKER = Object.freeze({ "[redacted]": true });

/** Key names whose VALUE is a secret regardless of content. Matched against the value's own key. */
const SECRET_KEY = /(?:^|[._-])(?:api[_-]?key|authorization|auth[_-]?token|password|passwd|secret|token|client[_-]?secret|access[_-]?token|refresh[_-]?token|cookie|set[_-]?cookie)$/i;
/** Secret-shaped VALUES caught even under an innocuous key (provider keys, bearer tokens). */
const SECRET_VALUE = /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{6,}|xox[baprs]-[A-Za-z0-9-]{6,}|gh[pousr]_[A-Za-z0-9]{20,})\b/;

/** The last `.`-separated segment of a path, e.g. `$.a.b.api_key` -> `api_key` (array indices stripped). */
function lastSegment(path: string): string {
  const afterDot = path.slice(path.lastIndexOf(".") + 1);
  const bracket = afterDot.indexOf("[");
  return bracket === -1 ? afterDot : afterDot.slice(0, bracket);
}

/**
 * The default redactor: masks values whose KEY names a credential, and secret-shaped string VALUES
 * (sk-…, Bearer …, slack/github tokens) anywhere. Conservative — this feeds export copies only, where
 * over-redaction is safe and under-redaction leaks. Returns `"[redacted]"` for a masked string.
 */
export const DEFAULT_REDACTORS: RedactFn = (value, ctx) => {
  if (typeof value === "string") {
    if (SECRET_KEY.test(lastSegment(ctx.path))) return "[redacted]";
    if (SECRET_VALUE.test(value)) return value.replace(SECRET_VALUE, "[redacted]");
  }
  return value;
};

const isPlainContainer = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Deep, structure-preserving redaction. Applies `redact` at each node; a `DROP` return becomes a
 * redaction marker, any other returned value is substituted, and an unchanged return lets the walk
 * recurse into arrays/objects. Rebuilds containers fresh (never mutates the input) and assigns keys
 * with defineProperty so a hostile `__proto__` key in recorded data cannot pollute Object.prototype.
 */
export function redactValue(value: unknown, redact: RedactFn, ctx: RedactContext): unknown {
  const decision = redact(value, ctx);
  if (decision === DROP) return { ...REDACTED_MARKER };
  if (decision !== value) return decision;

  if (Array.isArray(value)) {
    return value.map((v, i) => redactValue(v, redact, { path: `${ctx.path}[${i}]`, kind: ctx.kind }));
  }
  if (isPlainContainer(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const child = redactValue(v, redact, { path: `${ctx.path}.${k}`, kind: ctx.kind });
      Object.defineProperty(out, k, { value: child, enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value; // primitive / null — leaf
}

/**
 * A redacted COPY of a recorded call, safe to put in a shareable report. The input record is never
 * mutated (deep-cloned first), so the primary replay tape stays byte-exact. Redacts the response body
 * (the payload most likely to carry model output / echoed secrets); usage is numeric and `model` is a
 * label, both carried through verbatim. Defaults to DEFAULT_REDACTORS.
 */
export function redactedExportView(call: RecordedCall, redact: RedactFn = DEFAULT_REDACTORS): RecordedCall {
  const clonedResponse = call.response === undefined ? undefined : JSON.parse(JSON.stringify(call.response));
  return {
    response: redactValue(clonedResponse, redact, { path: "$", kind: "response" }),
    usage: { ...call.usage },
    model: call.model,
  };
}
