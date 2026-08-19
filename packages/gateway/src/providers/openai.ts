/**
 * openai adapter — OpenAI and OpenAI-compatible providers (Nebius, Together, Groq, …). Recordable
 * endpoints: POST /v1/chat/completions and POST /v1/responses.
 *
 * Terminal detection: a streamed success ends with `data: [DONE]`, carries ≥1 chunk with a `choices`
 * array, and no frame carries a top-level `error` object. A non-streamed success is a JSON body with
 * a `choices` array and no top-level `error`. Usage comes from the final chunk's `usage` block (or the
 * body's `usage` for JSON), read through the shared field-picker.
 */
import type { ProviderAdapter } from "./provider-adapter.ts";
import { pickUsageFields, normalizeUsage, type ExtractedUsage } from "../usage.ts";
import type { ProviderUsage } from "../record-store.ts";

function looksLikeSse(text: string, contentType: string | undefined): boolean {
  const ct = (contentType ?? "").toLowerCase();
  return ct.includes("event-stream") || /^\s*data:\s*/m.test(text);
}

/** Iterate the JSON payloads of the `data:` frames in an SSE body (skipping `[DONE]` and garbage). */
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

export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  matchPath(method: string | undefined, url: string | undefined): boolean {
    if (method !== "POST") return false;
    const path = (url ?? "").split("?")[0];
    return path === "/v1/chat/completions" || path === "/v1/responses";
  },
  isRecordableSuccess(body: Buffer, contentType: string): boolean {
    const text = body.toString("utf8");
    if (looksLikeSse(text, contentType)) {
      const hasDone = /^\s*data:\s*\[DONE\]\s*$/m.test(text);
      let hasChunk = false;
      let hasError = false;
      for (const evt of sseFrames(text)) {
        if ("error" in evt && evt.error) hasError = true;
        if (Array.isArray(evt.choices)) hasChunk = true;
      }
      return hasDone && hasChunk && !hasError;
    }
    try {
      const parsed = JSON.parse(text) as { choices?: unknown; error?: unknown };
      if (parsed?.error) return false;
      return Array.isArray(parsed?.choices);
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
        if (evt.usage) usage = { ...usage, ...pickUsageFields(evt.usage) };
        if (typeof evt.model === "string") model = evt.model;
      }
    } else {
      try {
        const body = JSON.parse(text) as Record<string, unknown>;
        usage = pickUsageFields(body.usage);
        if (typeof body.model === "string") model = body.model;
      } catch {
        /* unparseable → all-zero usage below */
      }
    }
    return { usage: normalizeUsage(usage), model };
  },
};
