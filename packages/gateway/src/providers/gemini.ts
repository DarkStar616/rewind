/**
 * gemini adapter — Google Gemini generative API. Recordable endpoints:
 * POST /v1beta/models/<model>:generateContent and :streamGenerateContent.
 *
 * Terminal detection: a success carries at least one candidate with a `finishReason`, and no
 * top-level `error`. (A truncated stream has candidates but no finishReason yet.) Usage comes from the
 * `usageMetadata` block, read through the shared field-picker; the model is `modelVersion`.
 *
 * THREE wire shapes are handled, because Gemini streams two different ways:
 *   - SSE (`streamGenerateContent?alt=sse`): `data:` frames — folded frame by frame.
 *   - Default JSON stream (`streamGenerateContent` with no `alt`): a JSON ARRAY of
 *     GenerateContentResponse chunks — iterated element by element.
 *   - Single JSON object (`generateContent`): one GenerateContentResponse.
 */
import type { ProviderAdapter } from "./provider-adapter.ts";
import { pickUsageFields, normalizeUsage, type ExtractedUsage } from "../usage.ts";
import type { ProviderUsage } from "../record-store.ts";

function looksLikeSse(text: string, contentType: string | undefined): boolean {
  const ct = (contentType ?? "").toLowerCase();
  return ct.includes("event-stream") || /^\s*data:\s*\{/m.test(text);
}

/** Iterate the JSON payloads of the `data:` frames in an SSE body (skipping garbage). */
function* sseFrames(text: string): Generator<Record<string, unknown>> {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice("data:".length).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const evt = JSON.parse(payload) as Record<string, unknown>;
      if (evt && typeof evt === "object") yield evt;
    } catch {
      /* a partial/garbage frame never derails the fold */
    }
  }
}

/** Does this GenerateContentResponse object carry a candidate with a finishReason (a terminal)? */
function hasFinished(obj: Record<string, unknown>): boolean {
  const candidates = obj.candidates;
  return (
    Array.isArray(candidates) &&
    candidates.some(
      (c) =>
        c &&
        typeof c === "object" &&
        typeof (c as Record<string, unknown>).finishReason === "string" &&
        ((c as Record<string, unknown>).finishReason as string).length > 0,
    )
  );
}

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",
  matchPath(method: string | undefined, url: string | undefined): boolean {
    if (method !== "POST") return false;
    const path = (url ?? "").split("?")[0];
    return /^\/v1(beta|)\/models\/[^/]+:(generateContent|streamGenerateContent)$/.test(path);
  },
  isRecordableSuccess(body: Buffer, contentType: string): boolean {
    const text = body.toString("utf8");
    if (looksLikeSse(text, contentType)) {
      let finished = false;
      let hasError = false;
      for (const evt of sseFrames(text)) {
        if ("error" in evt && evt.error) hasError = true;
        if (hasFinished(evt)) finished = true;
      }
      return finished && !hasError;
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      // Default streamGenerateContent (no ?alt=sse) returns a JSON ARRAY of response chunks; a
      // non-streamed generateContent returns a single object. Any element carrying an `error` makes the
      // whole response non-recordable; at least one candidate must have finished.
      if (Array.isArray(parsed)) {
        let finished = false;
        let hasError = false;
        for (const el of parsed) {
          if (el && typeof el === "object") {
            const o = el as Record<string, unknown>;
            if ("error" in o && o.error) hasError = true;
            if (hasFinished(o)) finished = true;
          }
        }
        return finished && !hasError;
      }
      const obj = parsed as Record<string, unknown>;
      if (obj?.error) return false;
      return hasFinished(obj);
    } catch {
      return false;
    }
  },
  extractUsage(raw: Buffer | string, contentType: string | undefined): ExtractedUsage {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let usage: ProviderUsage = {};
    let model: string | undefined;
    const foldOne = (o: Record<string, unknown>): void => {
      if (o.usageMetadata) usage = { ...usage, ...pickUsageFields(o.usageMetadata) };
      if (typeof o.modelVersion === "string") model = o.modelVersion;
    };
    if (looksLikeSse(text, contentType)) {
      for (const evt of sseFrames(text)) foldOne(evt);
    } else {
      try {
        const body = JSON.parse(text) as unknown;
        // A JSON array (default JSON stream) folds every chunk; a single object folds itself.
        if (Array.isArray(body)) {
          for (const el of body) if (el && typeof el === "object") foldOne(el as Record<string, unknown>);
        } else if (body && typeof body === "object") {
          foldOne(body as Record<string, unknown>);
        }
      } catch {
        /* unparseable → all-zero usage below */
      }
    }
    return { usage: normalizeUsage(usage), model };
  },
};
