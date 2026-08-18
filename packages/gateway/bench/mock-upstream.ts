/**
 * mock-upstream — a cache-faithful stand-in for the Anthropic Messages API, for the deterministic
 * bench. It lets us prove the gateway's savings mechanism and the meter's arithmetic with NO API key
 * and NO network, and get the SAME number every run.
 *
 * Two faithfulness rules make the bench honest rather than self-flattering:
 *
 *   1. **Usage is reported in the real API's fields** (`input_tokens`, `output_tokens`,
 *      `cache_read_input_tokens`, `cache_creation_input_tokens`). The gateway's meter reads these
 *      exactly as it would read the provider's — the mock IS the provider here, so the meter still
 *      never estimates tokens locally.
 *   2. **The KV-cache is simulated the way the provider's actually behaves**: the cacheable prefix
 *      (everything up to the last `cache_control` breakpoint) is billed at the cheap cache-READ rate
 *      when the same prefix was seen within the TTL, and at the cache-WRITE rate otherwise. The clock
 *      is INJECTED, so TTL expiry is deterministic and testable — no `Date.now()`.
 *
 * Token counts are a deterministic function of content length (bytes/4, the standard rough proxy).
 * That is the mock's private accounting standing in for a real tokenizer; it is reported through the
 * provider-shaped usage block, and everything downstream treats it as ground truth.
 */
import { createServer, type Server } from "node:http";

/** An injected clock in milliseconds — deterministic, never `Date.now()`. */
export interface Clock {
  now(): number;
}

/** A clock the bench advances by hand, so cache-TTL behaviour is reproducible. */
export function manualClock(startMs = 0): Clock & { advance(ms: number): void; set(ms: number): void } {
  let t = startMs;
  return { now: () => t, advance: (ms) => (t += ms), set: (ms) => (t = ms) };
}

export interface MockUpstreamOptions {
  clock: Clock;
  /** Cache TTL in ms; a prefix seen longer ago than this is billed as a fresh write. Default 5 min. */
  cacheTtlMs?: number;
  /** Deterministic output token count per response. Default 64. */
  outputTokens?: number;
}

/** One recorded upstream call, for conservation-checking the bench against the transcript. */
export interface UpstreamCall {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** true when the cacheable prefix hit the warm cache within TTL. */
  warm: boolean;
}

export interface RunningMockUpstream {
  server: Server;
  base: string;
  /** Every call the mock actually served (i.e., every call the gateway did NOT avoid). */
  calls: UpstreamCall[];
  close(): Promise<void>;
}

/** bytes/4, floored at 1 for any non-empty content — a deterministic stand-in for a tokenizer. */
function toTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

/** A fast, dependency-free 32-bit hash for prefix identity (FNV-1a). Deterministic. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

interface AnthropicMessage {
  role: string;
  content: unknown;
}

/** Serialize a content value to a stable string for token counting + prefix hashing. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  return JSON.stringify(content);
}

/**
 * Split a request into (cacheable prefix, fresh suffix). The prefix is system + tools + every message
 * up to and including the last block that carries a `cache_control` marker; if nothing is marked, the
 * prefix is everything before the final message (the provider's implicit behaviour is out of scope —
 * we only credit EXPLICIT breakpoints, matching how the real cache is controlled).
 */
function splitPrefix(body: Record<string, unknown>): { prefix: string; suffix: string } {
  const staticParts: string[] = [];
  if (body.system !== undefined) staticParts.push(`system:${contentToText(body.system)}`);
  if (body.tools !== undefined) staticParts.push(`tools:${JSON.stringify(body.tools)}`);
  const messages = Array.isArray(body.messages) ? (body.messages as AnthropicMessage[]) : [];

  // Find the last message whose serialized content mentions a cache_control breakpoint.
  let lastBreak = -1;
  for (let i = 0; i < messages.length; i++) {
    if (JSON.stringify(messages[i]).includes("cache_control")) lastBreak = i;
  }
  const prefixEnd = lastBreak >= 0 ? lastBreak + 1 : Math.max(0, messages.length - 1);
  const prefixMsgs = messages.slice(0, prefixEnd).map((m) => `${m.role}:${contentToText(m.content)}`);
  const suffixMsgs = messages.slice(prefixEnd).map((m) => `${m.role}:${contentToText(m.content)}`);
  return {
    prefix: [...staticParts, ...prefixMsgs].join("\n"),
    suffix: suffixMsgs.join("\n"),
  };
}

export function startMockUpstream(options: MockUpstreamOptions): Promise<RunningMockUpstream> {
  const ttl = options.cacheTtlMs ?? 5 * 60 * 1000;
  const outTokens = options.outputTokens ?? 64;
  const calls: UpstreamCall[] = [];
  // prefix-hash → last-seen time (ms). A hit within TTL bills the prefix as a cheap cache read.
  const cacheSeen = new Map<string, number>();

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "invalid_request", message: "bad json" } }));
        return;
      }
      const { prefix, suffix } = splitPrefix(body);
      const prefixTokens = toTokens(prefix);
      const suffixTokens = toTokens(suffix);
      const now = options.clock.now();
      const seenAt = cacheSeen.get(hash(prefix));
      const warm = seenAt !== undefined && now - seenAt <= ttl && prefixTokens > 0;
      cacheSeen.set(hash(prefix), now);

      const usage = {
        input_tokens: suffixTokens, // the fresh, always-full-price tokens
        output_tokens: outTokens,
        cache_read_input_tokens: warm ? prefixTokens : 0,
        cache_creation_input_tokens: warm ? 0 : prefixTokens,
      };
      calls.push({
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        cacheWriteTokens: usage.cache_creation_input_tokens,
        warm,
      });

      // Deterministic response body derived from the request, so replay byte-identity is meaningful.
      const model = typeof body.model === "string" ? body.model : "unknown";
      const responseText = `reply:${hash(prefix + "|" + suffix)}`;
      const payload = JSON.stringify({
        id: `msg_${hash(suffix)}`,
        type: "message",
        role: "assistant",
        model,
        content: [{ type: "text", text: responseText }],
        stop_reason: "end_turn",
        usage,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({
        server,
        base: `http://127.0.0.1:${port}`,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
