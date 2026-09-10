/**
 * anthropic adapter — the reference provider. Its terminal-detection and usage-extraction are the
 * gateway's original behaviour, relocated here unchanged (proxy.ts re-exports `isRecordableSuccess`
 * for backward compatibility). Recordable endpoint: POST /v1/messages.
 */
import { planCacheBreakpoints } from "../cache-preserve.ts";
import { analyzeCacheHygiene } from "../cache-hygiene.ts";
import type { ProviderAdapter } from "./provider-adapter.ts";
import { extractUsage, type ExtractedUsage } from "../usage.ts";

/**
 * Whether a 2xx response body is a genuine, COMPLETE Anthropic success worth freezing into a replay.
 * Anthropic can return HTTP 200 and then deliver an error or a truncated stream — those must NOT be
 * recorded, or a transient failure would be replayed forever (and any partial usage credited).
 *
 *   - SSE: require a terminal `message_stop` and reject any `error` event. An incomplete stream (no
 *     stop) or an error frame is transient, not a cacheable answer.
 *   - JSON: reject a body whose `type` is `"error"`.
 *   - Anything we cannot parse: do NOT record (fail closed on the recording side — a miss just costs a
 *     redundant call, whereas recording garbage would serve garbage forever).
 */
export function isRecordableSuccess(body: Buffer, contentType: string): boolean {
  const text = body.toString("utf8");
  const ct = (contentType ?? "").toLowerCase();
  const looksSse = ct.includes("event-stream") || /^\s*event:|^\s*data:\s*\{/m.test(text);
  if (looksSse) {
    const hasStop = text.includes('"type":"message_stop"') || /^\s*event:\s*message_stop/m.test(text);
    const hasError = text.includes('"type":"error"') || /^\s*event:\s*error/m.test(text);
    return hasStop && !hasError;
  }
  try {
    const parsed = JSON.parse(text) as { type?: unknown };
    return parsed?.type !== "error";
  } catch {
    return false; // unparseable JSON → not a success we can safely replay
  }
}

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  planCacheBreakpoints,
  analyzeCacheHygiene,
  matchPath(method: string | undefined, url: string | undefined): boolean {
    return method === "POST" && (url ?? "").split("?")[0] === "/v1/messages";
  },
  isRecordableSuccess(body: Buffer, contentType: string): boolean {
    return isRecordableSuccess(body, contentType);
  },
  extractUsage(raw: Buffer | string, contentType: string | undefined): ExtractedUsage {
    return extractUsage(raw, contentType);
  },
};
