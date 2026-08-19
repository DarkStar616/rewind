/**
 * provider-adapter — the small per-provider seam that makes the record/replay proxy provider-neutral.
 *
 * The byte-exact replay core, the effect barrier and the hash chain are ALREADY provider-agnostic and
 * do NOT change. Only three body-coupled decisions differ by provider, and they live here:
 *
 *   1. `matchPath` — is this request a recordable model call for this provider?
 *   2. `isRecordableSuccess` — is a 2xx body a COMPLETE, non-error terminal worth freezing?
 *   3. `extractUsage` — the provider's own reported tokens + model (for metering only).
 *
 * The replay KEY is deliberately NOT here: it is a generic hash over the canonicalised request body,
 * identical for every provider. No adapter may make the key provider-specific or introduce a false
 * cache hit — adapters touch recording/metering/terminal-detection only.
 */
import type { ExtractedUsage } from "../usage.ts";
import { anthropicAdapter } from "./anthropic.ts";
import { openaiAdapter } from "./openai.ts";
import { geminiAdapter } from "./gemini.ts";

export interface ProviderAdapter {
  readonly id: "anthropic" | "openai" | "gemini";
  /** Is this a recordable model call for this provider?
   *  anthropic: POST /v1/messages
   *  openai:    POST /v1/chat/completions (also /v1/responses)
   *  gemini:    POST /v1beta/models/<model>:generateContent|:streamGenerateContent */
  matchPath(method: string | undefined, url: string | undefined): boolean;
  /** COMPLETE, non-error 2xx worth freezing? Per-provider terminal:
   *  anthropic: SSE has message_stop & no error / JSON type!=="error"
   *  openai:    SSE ends with `data: [DONE]`, ≥1 chunk, no error object / JSON has choices, no top-level error
   *  gemini:    a candidate with finishReason and no `error` field */
  isRecordableSuccess(body: Buffer, contentType: string): boolean;
  /** Provider-reported usage + model, JSON or streamed. Reuses meter/usage semantics. */
  extractUsage(raw: Buffer | string, contentType: string | undefined): ExtractedUsage;
}

/** All adapters, in auto-detection precedence order (first whose matchPath() is true wins). */
export const ADAPTERS: readonly ProviderAdapter[] = [anthropicAdapter, openaiAdapter, geminiAdapter];

/**
 * Resolve the adapter for a request. An explicit `opts.provider` wins (by id); otherwise the first
 * adapter whose `matchPath()` accepts the method+url. `undefined` when nothing matches (the caller
 * then treats the request as ordinary, non-recordable traffic).
 */
export function selectAdapter(
  opts: { provider?: ProviderAdapter["id"] },
  method: string | undefined,
  url: string | undefined,
): ProviderAdapter | undefined {
  if (opts.provider) return ADAPTERS.find((a) => a.id === opts.provider);
  return ADAPTERS.find((a) => a.matchPath(method, url));
}

/** Convenience: terminal-detection by provider id (for a caller that already knows the provider). */
export function isRecordableSuccessFor(
  id: ProviderAdapter["id"],
  body: Buffer,
  contentType: string,
): boolean {
  const a = ADAPTERS.find((x) => x.id === id);
  return a ? a.isRecordableSuccess(body, contentType) : false;
}

/** Convenience: usage extraction by provider id (for a caller that already knows the provider). */
export function extractUsageFor(
  id: ProviderAdapter["id"],
  raw: Buffer | string,
  contentType: string | undefined,
): ExtractedUsage {
  const a = ADAPTERS.find((x) => x.id === id);
  return a ? a.extractUsage(raw, contentType) : { usage: {} };
}
