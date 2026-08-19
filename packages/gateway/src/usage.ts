/**
 * usage — pull the provider's own token counts out of a raw Anthropic response, for metering.
 *
 * The proxy must record how many tokens a live call actually cost so a later replay can book that
 * many as avoided. Anthropic returns usage two ways, and we read BOTH from the provider's bytes —
 * never estimating from text length:
 *
 *   - **Non-streaming JSON** (`application/json`): a single `usage` object on the message body.
 *   - **Streaming SSE** (`text/event-stream`): `message_start` carries the input/cache token counts
 *     (and the model); `message_delta` frames carry the running `output_tokens`, the LAST of which is
 *     the final total. We scan the frames and take input/cache from the start, output from the last
 *     delta that reports it.
 *
 * Pure over the response bytes: no network, no clock, no filesystem. Unparseable input yields an
 * all-zero usage (the meter then bills 0 for it) rather than throwing — a malformed body must never
 * take the proxy down.
 */
import type { ProviderUsage } from "./record-store.ts";

export interface ExtractedUsage {
  usage: ProviderUsage;
  /** The model the response reports, if any — preferred over the request's model for pricing. */
  model?: string;
}

const ZERO: ProviderUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
};

/** Copy only the numeric usage fields we price; ignore anything else the provider includes.
 *
 *  Handles ALL THREE provider vocabularies so the gateway meters any provider from ONE field-picker
 *  (each adapter folds its own stream, but they all normalise usage through here):
 *   - **Anthropic:** `input_tokens` (uncached) / `output_tokens` / `cache_read_input_tokens` /
 *     `cache_creation_input_tokens`.
 *   - **OpenAI-compatible** (OpenAI, Nebius, Together, Groq, …): `prompt_tokens` / `completion_tokens`,
 *     with `prompt_tokens_details.cached_tokens` for the cached portion. OpenAI's `prompt_tokens`
 *     INCLUDES the cached tokens, so we map the UNCACHED remainder to `input_tokens` and the cached
 *     count to `cache_read_input_tokens` — matching Anthropic's semantics so the meter prices both the
 *     same way and never double-counts the cached tokens.
 *   - **Gemini** (`usageMetadata`): `promptTokenCount` / `candidatesTokenCount`, with
 *     `cachedContentTokenCount` for the cached portion, `thoughtsTokenCount` for thinking, and
 *     `toolUsePromptTokenCount` for tool-use prompts. Gemini's `promptTokenCount` INCLUDES the cached
 *     tokens (same as OpenAI), so it splits the same way; tool-use prompt tokens are reported SEPARATELY
 *     and added to input; and thinking is billed as OUTPUT but reported separately, so output =
 *     candidates + thoughts.
 *
 *  Fallbacks fire ONLY when the higher-priority field is absent, so a provider that reports more than
 *  one vocabulary is never double-mapped.
 */
export function pickUsageFields(u: unknown): ProviderUsage {
  if (!u || typeof u !== "object") return {};
  const o = u as Record<string, unknown>;
  const out: ProviderUsage = {};
  if (typeof o.input_tokens === "number") out.input_tokens = o.input_tokens;
  if (typeof o.output_tokens === "number") out.output_tokens = o.output_tokens;
  if (typeof o.cache_read_input_tokens === "number") out.cache_read_input_tokens = o.cache_read_input_tokens;
  if (typeof o.cache_creation_input_tokens === "number")
    out.cache_creation_input_tokens = o.cache_creation_input_tokens;

  // OpenAI-compatible fallbacks — only when the Anthropic field is absent, so a provider that reports
  // both never gets double-mapped.
  const details = o.prompt_tokens_details;
  const cached =
    details && typeof details === "object" && typeof (details as Record<string, unknown>).cached_tokens === "number"
      ? ((details as Record<string, unknown>).cached_tokens as number)
      : 0;
  if (out.input_tokens === undefined && typeof o.prompt_tokens === "number") {
    // Split OpenAI's all-inclusive prompt_tokens into uncached (input) + cached (cache_read).
    out.input_tokens = Math.max(0, o.prompt_tokens - cached);
    if (out.cache_read_input_tokens === undefined && cached > 0) out.cache_read_input_tokens = cached;
  }
  if (out.output_tokens === undefined && typeof o.completion_tokens === "number") {
    out.output_tokens = o.completion_tokens;
  }

  // Gemini usageMetadata fallbacks — only when nothing above supplied the field.
  const cachedG = typeof o.cachedContentTokenCount === "number" ? o.cachedContentTokenCount : 0;
  if (out.input_tokens === undefined && typeof o.promptTokenCount === "number") {
    // Split Gemini's all-inclusive promptTokenCount into uncached (input) + cached (cache_read), then
    // ADD tool-use prompt tokens: Gemini reports `toolUsePromptTokenCount` SEPARATELY from
    // promptTokenCount for tool-invoking responses, and it is billed as input — omitting it
    // under-reports both avoided tokens and cost on every such replay.
    const toolUse = typeof o.toolUsePromptTokenCount === "number" ? Math.max(0, o.toolUsePromptTokenCount) : 0;
    out.input_tokens = Math.max(0, o.promptTokenCount - cachedG) + toolUse;
    if (out.cache_read_input_tokens === undefined && cachedG > 0) out.cache_read_input_tokens = cachedG;
  }
  if (out.output_tokens === undefined && typeof o.candidatesTokenCount === "number") {
    // Gemini bills THINKING (thoughtsTokenCount) as output, but reports it SEPARATELY from
    // candidatesTokenCount. Sum both so a thinking-enabled response is metered at its true billed
    // output — mapping only candidatesTokenCount under-reports avoided tokens and cost.
    const thoughts = typeof o.thoughtsTokenCount === "number" ? o.thoughtsTokenCount : 0;
    out.output_tokens = o.candidatesTokenCount + Math.max(0, thoughts);
  }
  return out;
}

/** Normalise a partial usage block to a complete one (absent fields → 0) so metering sees every
 *  field. Shared by every adapter's fold. */
export function normalizeUsage(u: ProviderUsage): ProviderUsage {
  return mergeUsage(ZERO, u);
}

/** Merge b onto a, field by field, so streaming start (input/cache) + delta (output) compose. */
function mergeUsage(a: ProviderUsage, b: ProviderUsage): ProviderUsage {
  return {
    input_tokens: b.input_tokens ?? a.input_tokens,
    output_tokens: b.output_tokens ?? a.output_tokens,
    cache_read_input_tokens: b.cache_read_input_tokens ?? a.cache_read_input_tokens,
    cache_creation_input_tokens: b.cache_creation_input_tokens ?? a.cache_creation_input_tokens,
  };
}

function extractJson(text: string): ExtractedUsage {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const usage = pickUsageFields(body.usage);
    const model = typeof body.model === "string" ? body.model : undefined;
    return { usage, model };
  } catch {
    return { usage: {} };
  }
}

/**
 * Parse an SSE stream. Each frame is one or more lines; the `data:` line holds a JSON object with a
 * `type`. `message_start` nests `message.usage` (+ `message.model`); `message_delta` holds `usage`
 * with the cumulative `output_tokens`. We fold every frame so the final result reflects the whole
 * stream regardless of framing.
 */
function extractSse(text: string): ExtractedUsage {
  let usage: ProviderUsage = {};
  let model: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue; // a partial/garbage frame never derails the fold
    }
    if (evt.type === "message_start" && evt.message && typeof evt.message === "object") {
      const msg = evt.message as Record<string, unknown>;
      usage = mergeUsage(usage, pickUsageFields(msg.usage));
      if (typeof msg.model === "string") model = msg.model;
    } else if (evt.type === "message_delta") {
      usage = mergeUsage(usage, pickUsageFields(evt.usage));
    }
  }
  return { usage, model };
}

/**
 * Extract usage + model from a raw response body. `contentType` decides the parser; anything that
 * looks like SSE (event-stream) is folded frame-by-frame, otherwise JSON is tried. All-zero usage on
 * unparseable input.
 */
export function extractUsage(raw: Buffer | string, contentType: string | undefined): ExtractedUsage {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  const ct = (contentType ?? "").toLowerCase();
  const looksSse = ct.includes("event-stream") || /^\s*event:|^\s*data:\s*\{/m.test(text);
  const result = looksSse ? extractSse(text) : extractJson(text);
  // Normalise absent fields to 0 so downstream metering sees a complete object.
  return { usage: mergeUsage(ZERO, result.usage), model: result.model };
}
