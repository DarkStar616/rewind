/**
 * record-store — the content-addressed, scope-isolated home for recorded model calls.
 *
 * Harvested from qm-athena's `recorded/recorded-response-store.ts`, keeping the two disciplines
 * that make replay safe and dropping the product-specific session-store coupling:
 *
 *   - **Content-addressed.** A record is keyed by its `replayKey` — the SHA-256 of the
 *     output-affecting request fields (see `canonicalizeRequest`). A byte-different but
 *     semantically-identical request after a rewind resolves to the same key and hits the record.
 *   - **Scope-isolated.** Records live in a per-scope map, so one caller's recording is never
 *     served to another. This is stored structurally (a map keyed by scope, holding a map keyed by
 *     replayKey), NOT by concatenating scope + key into one string — concatenation with a delimiter
 *     could let one (scope, key) pair collide with another; nested maps make that impossible.
 *
 * Memory implementation now; a durable backend lands later behind the same `RecordStore` interface.
 * This module reads no filesystem, clock, or network — it is a pure in-memory index.
 */

/**
 * Anthropic-native usage block. Token counts are taken ONLY from the provider's own usage object;
 * nothing here is estimated from text length locally. Every field is optional because a given call
 * may omit the cache fields; a missing field counts as zero.
 */
export interface ProviderUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/** The (scope, replayKey) coordinate a record is stored and looked up under. */
export interface RecordKey {
  scope: string;
  replayKey: string;
}

/** A recorded model call: the raw response payload to serve on a hit, plus its provider usage. */
export interface RecordedCall {
  /** The raw provider response payload replayed verbatim on a hit. */
  response: unknown;
  /** The usage the original (now-avoided) call reported. */
  usage: ProviderUsage;
  /** The model the recorded call ran on, carried onto the booked ReplaySaving. */
  model: string;
}

export interface RecordStore {
  put(key: RecordKey, value: RecordedCall): void;
  get(key: RecordKey): RecordedCall | undefined;
}

/**
 * Total tokens the recorded call processed = every provider-reported token field summed. Because a
 * replay avoids the WHOLE upstream call, every one of those tokens is avoided. This is arithmetic
 * over the provider's own numbers, not a local estimate.
 */
export function totalRecordedTokens(usage: ProviderUsage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

export function createMemoryRecordStore(): RecordStore {
  // Nested by scope so isolation is structural, not delimiter-dependent.
  const byScope = new Map<string, Map<string, RecordedCall>>();
  return {
    put(key, value) {
      let scoped = byScope.get(key.scope);
      if (!scoped) {
        scoped = new Map<string, RecordedCall>();
        byScope.set(key.scope, scoped);
      }
      scoped.set(key.replayKey, value);
    },
    get(key) {
      return byScope.get(key.scope)?.get(key.replayKey);
    },
  };
}
