/**
 * gemini adapter — Google Gemini generative API. Recordable endpoints:
 * POST /v1beta/models/<model>:generateContent and :streamGenerateContent.
 *
 * Terminal detection: a success carries at least one candidate with a `finishReason`, and no
 * top-level `error`. (A truncated stream has candidates but no finishReason yet.) Usage comes from the
 * `usageMetadata` block, read through the shared field-picker; the model is `modelVersion`.
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
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed?.error) return false;
      return hasFinished(parsed);
    } catch {
      return false;
    }
  },
  extractUsage(raw: Buffer | string, contentType: string | undefined): ExtractedUsage {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    let usage: ProviderUsage = {};
    let model: string | undefined;
    if (looksLikeSse(text, contentType)) {
      for (const evt of sseFrames(text)) {
        if (evt.usageMetadata) usage = { ...usage, ...pickUsageFields(evt.usageMetadata) };
        if (typeof evt.modelVersion === "string") model = evt.modelVersion;
      }
    } else {
      try {
        const body = JSON.parse(text) as Record<string, unknown>;
        usage = pickUsageFields(body.usageMetadata);
        if (typeof body.modelVersion === "string") model = body.modelVersion;
      } catch {
        /* unparseable → all-zero usage below */
      }
    }
    return { usage: normalizeUsage(usage), model };
  },
};
