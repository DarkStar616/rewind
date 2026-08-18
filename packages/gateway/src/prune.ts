/**
 * prune — deterministic, lossless context pruning for long agent runs (the savings lever the
 * deep-research + deep-prospect passes ranked #2, done the replay-safe way).
 *
 * Coding agents re-read the same files and re-run the same commands constantly, so the exact same
 * tool_result content appears many times in a long conversation. This collapses byte-identical
 * duplicate tool results: the FIRST occurrence is kept verbatim, and every later identical one is
 * replaced with a short marker that points back to it.
 *
 * Why this is the safe pruning to ship first (vs a model-based line skimmer):
 *   - **Deterministic by construction.** No model, no sampling — a pure function of the request bytes.
 *     Same input → same output, so a pruned request keys and records identically on replay. The
 *     exact-replay invariant is preserved without any "record the skim call" machinery.
 *   - **Lossless.** The elided content is byte-identical to a kept earlier copy; the model still sees
 *     the content once, and the marker references it. Only genuine duplicates are removed.
 *   - **Keep-FIRST, elide-later** — deliberately, for two reasons: it reads as a natural back-reference,
 *     and it leaves the cacheable PREFIX untouched (eliding early content would bust the prompt cache),
 *     so it composes with cache-preservation instead of fighting it.
 *   - **Only tool_result (observations) are touched** — never tool_use (the agent's own actions/inputs),
 *     so a side-effecting call's request is never elided.
 */
import { canonicalize } from "@rewind/core";

const DEFAULT_MIN_LENGTH = 200;
const ELIDED_MARKER = "[elided by rewind: identical to an earlier tool result in this conversation]";

export interface PruneOptions {
  /** Minimum content length (chars) before a tool_result is eligible to be elided. Tiny outputs are
   *  not worth a marker. Default 200. */
  minLength?: number;
}

export interface PruneResult {
  /** A pruned COPY of the body (the input is never mutated). Byte-stable for a given input. */
  body: unknown;
  /** How many duplicate tool_result blocks were collapsed. */
  elided: number;
  /** Approximate characters removed (original content length minus the marker length, summed). */
  charsSaved: number;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A stable, key-sorted serialization for the duplicate-detection key. */
function stableKey(content: unknown): string {
  try {
    return canonicalize(content);
  } catch {
    return JSON.stringify(content) ?? "";
  }
}

function contentLength(content: unknown): number {
  return typeof content === "string" ? content.length : stableKey(content).length;
}

/**
 * Collapse byte-identical duplicate tool_result blocks in an Anthropic-native request. Returns a pruned
 * copy plus stats. A body without a `messages` array is returned unchanged with zero savings.
 */
export function pruneToolOutputs(body: unknown, options: PruneOptions = {}): PruneResult {
  const minLength = options.minLength ?? DEFAULT_MIN_LENGTH;
  if (!isObject(body) || !Array.isArray(body.messages)) {
    return { body, elided: 0, charsSaved: 0 };
  }
  // Deep clone via JSON (the body is JSON from the API — no functions/cycles) so the input is untouched.
  const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  const messages = clone.messages as unknown[];

  const seen = new Set<string>();
  let elided = 0;
  let charsSaved = 0;

  for (const msg of messages) {
    if (!isObject(msg)) continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue; // only block-array messages carry tool_result blocks
    for (const block of content) {
      if (!isObject(block) || block.type !== "tool_result") continue;
      const inner = block.content;
      const len = contentLength(inner);
      if (len < minLength) continue; // too small to be worth eliding
      const key = stableKey(inner);
      if (seen.has(key)) {
        // A later identical result — elide it, pointing back to the first occurrence (kept verbatim).
        block.content = ELIDED_MARKER;
        elided += 1;
        charsSaved += Math.max(0, len - ELIDED_MARKER.length);
      } else {
        seen.add(key);
      }
    }
  }

  return { body: clone, elided, charsSaved };
}
