// Tape-vs-tape typed divergence report (RIP-LIST #9, taxonomy re-derived, no imported code).
//
// When a replay does not match, "the tapes differ" is not debuggable. This turns a failed comparison
// into a typed object: which messages mismatched, which were extra, which were missing, and the FIRST
// point of divergence. It supports the gainshare audit story (show exactly where a customer's traffic
// stopped matching a recorded tape) and general replay debugging.
//
// Comparison is by CANONICAL content (via @rewind/core canonicalize), so object-key ordering — which is
// not semantically meaningful — never registers as a divergence. Pure and deterministic: no clock, no
// network. Aligns the two request bodies' `messages` arrays positionally; a body without a messages
// array is tolerated as empty rather than throwing.

import { canonicalize } from "@rewind/core";

export type DivergenceKind = "input-mismatch" | "extra-call" | "missing-call";

export interface Divergence {
  kind: DivergenceKind;
  /** Position in the aligned messages arrays where the divergence occurs. */
  index: number;
  /** Human-readable description of what diverged at this index. */
  detail: string;
}

export interface DivergenceReport {
  /** All divergences, in ascending index order (collect-all, not fail-fast). */
  kinds: Divergence[];
  /** The lowest-index divergence, or undefined when the two tapes align exactly. */
  firstDivergence?: Divergence;
}

/** The `messages` array of a request body, or [] if the body has none (tolerated, never throws). */
function messagesOf(body: unknown): unknown[] {
  if (body !== null && typeof body === "object" && Array.isArray((body as { messages?: unknown }).messages)) {
    return (body as { messages: unknown[] }).messages;
  }
  return [];
}

/** Canonical string form for comparison; falls back to JSON if a value has no canonical form. */
function canon(value: unknown): string {
  try {
    return canonicalize(value);
  } catch {
    return JSON.stringify(value) ?? "";
  }
}

/**
 * Classify how two request bodies' message tapes diverge. Aligns positionally and, at each index,
 * reports: `input-mismatch` (both present, different canonical content), `extra-call` (present in `b`,
 * not `a`), or `missing-call` (present in `a`, not `b`). `firstDivergence` is the lowest-index entry.
 */
export function divergeMessages(a: unknown, b: unknown): DivergenceReport {
  const ma = messagesOf(a);
  const mb = messagesOf(b);
  const kinds: Divergence[] = [];
  const n = Math.max(ma.length, mb.length);

  for (let i = 0; i < n; i++) {
    const inA = i < ma.length;
    const inB = i < mb.length;
    if (inA && inB) {
      if (canon(ma[i]) !== canon(mb[i])) {
        kinds.push({ kind: "input-mismatch", index: i, detail: `message ${i} differs in content between the two tapes` });
      }
    } else if (inB) {
      kinds.push({ kind: "extra-call", index: i, detail: `message ${i} is present in b but not a` });
    } else {
      kinds.push({ kind: "missing-call", index: i, detail: `message ${i} is present in a but not b` });
    }
  }

  // kinds is built in ascending index order, so the first element is the lowest-index divergence.
  return { kinds, firstDivergence: kinds[0] };
}
