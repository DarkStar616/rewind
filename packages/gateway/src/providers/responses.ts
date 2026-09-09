import { normalizeUsage, pickUsageFields, type ExtractedUsage } from "../usage.ts";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === "object" && !Array.isArray(value);

/** Responses input is inclusive of reads and writes; reasoning is already included in output. */
export function responsesUsage(response: ObjectValue): ExtractedUsage {
  const u = object(response.usage) ? response.usage : {};
  return { model: typeof response.model === "string" ? response.model : undefined,
    usage: normalizeUsage(pickUsageFields({ prompt_tokens: u.input_tokens, completion_tokens: u.output_tokens,
      prompt_tokens_details: u.input_tokens_details })) };
}

function complete(value: unknown): value is ObjectValue {
  if (!object(value) || value.object !== "response" || value.status !== "completed" || value.error ||
      value.incomplete_details || !Array.isArray(value.output)) return false;
  return validInclusiveUsage(value.usage, "responses");
}

export function validInclusiveUsage(usage: unknown, kind: "responses" | "chat"): boolean {
  if (usage === null || usage === undefined) return true;
  if (!object(usage)) return false;
  const u = usage;
  const input = kind === "responses" ? u.input_tokens : u.prompt_tokens;
  const output = kind === "responses" ? u.output_tokens : u.completion_tokens;
  const details = kind === "responses" ? u.input_tokens_details : u.prompt_tokens_details;
  if (details !== undefined && details !== null && !object(details)) return false;
  const read = object(details) ? details.cached_tokens ?? 0 : 0;
  const write = object(details) ? details.cache_write_tokens ?? 0 : 0;
  const counts = [input, output, read, write];
  return counts.every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0) &&
    (read as number) + (write as number) <= (input as number) &&
    Number.isSafeInteger((input as number) + (output as number));
}

/** Parse only complete SSE frames; malformed or post-terminal data cannot produce a replay. */
export function completedResponse(text: string, streaming: boolean): ObjectValue | undefined {
  try {
    if (!streaming) { const value: unknown = JSON.parse(text); return complete(value) ? value : undefined; }
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!normalized.endsWith("\n\n")) return undefined;
    let completed: ObjectValue | undefined;
    for (const frame of normalized.split("\n\n")) {
      const lines = frame.split("\n");
      const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (!data) continue;
      if (completed) return undefined;
      const event: unknown = JSON.parse(data);
      if (!object(event) || typeof event.type !== "string" || event.error || event.type === "error" ||
          ["response.failed", "response.incomplete", "response.cancelled"].includes(event.type)) return undefined;
      const label = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
      if (label && label !== event.type) return undefined;
      if (event.type === "response.completed") {
        if (!complete(event.response)) return undefined;
        completed = event.response;
      }
    }
    return completed;
  } catch { return undefined; }
}

export function looksLikeResponses(text: string): boolean {
  const matches = (value: unknown) => object(value) && (value.object === "response" ||
    (typeof value.type === "string" && value.type.startsWith("response.")));
  try { return matches(JSON.parse(text)); } catch { /* Try SSE frames. */ }
  for (const frame of text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n\n")) {
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
    try { if (matches(JSON.parse(data))) return true; } catch { /* Invalid frames are rejected by terminal validation. */ }
  }
  return false;
}
