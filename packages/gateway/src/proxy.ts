/**
 * proxy — the byte-transparent LLM proxy an agent points ANTHROPIC_BASE_URL at.
 *
 * It sits in front of the provider and does exactly one useful thing: when a request after a rewind
 * is byte-equivalent to one already recorded (same output-affecting fields), it serves the recorded
 * response with ZERO upstream call and books the avoided cost. Everything else is forwarded verbatim.
 *
 * The disciplines that keep it safe to put on an agent's critical path:
 *
 *   - **Byte-transparent.** The exact request-body bytes the agent sent are forwarded upstream (so the
 *     provider computes the same cache-prefix hashes), and a recorded response is replayed as the exact
 *     bytes that came back — we never re-serialize either. JSON and SSE replay identically because we
 *     store opaque bytes and only PARSE a copy to read usage.
 *   - **Fail-open, always.** If anything in the replay/record machinery throws, the request still goes
 *     upstream unchanged. Rewind can decline to help; it can never block a real call. A genuine upstream
 *     fault is surfaced to the client as-is — we never fabricate a response.
 *   - **Only records successes.** A non-2xx response is forwarded but NOT recorded, so a transient error
 *     is never frozen into a replay.
 *   - **No filesystem / clock of its own.** Records live in the injected store; savings in the injected
 *     sink. Swap either for a durable backend without touching this file.
 */
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import { request as httpsRequest } from "node:https";

import type { RecordStore, RecordedCall } from "./record-store.ts";
import type { Replayer } from "./replay.ts";
import { StrictReplayMissError } from "./replay.ts";
import { extractUsage } from "./usage.ts";
import { planCacheBreakpoints } from "./cache-preserve.ts";

/** The stored form of a recorded response: opaque bytes + just enough to replay them faithfully. */
export interface RecordedHttpResponse {
  status: number;
  contentType: string;
  bodyBase64: string;
}

export interface ProxyOptions {
  /** Port to bind; 0 lets the OS pick (read the real port back from the return value). */
  port?: number;
  /** Upstream base URL, e.g. "https://api.anthropic.com". */
  upstreamBase: string;
  /** The replay decision + savings booking (reads the store). */
  replayer: Replayer;
  /** The record store the proxy WRITES live responses into (same store the replayer reads). */
  store: RecordStore;
  /** The request path treated as a replay-able messages endpoint. Default "/v1/messages". */
  messagesPath?: string;
  /** Header naming the isolation scope for records. Default "x-rewind-scope"; absent → "default". */
  scopeHeader?: string;
  /**
   * Opt-in (default false): when the agent set NO cache_control, inject one ephemeral breakpoint on
   * the static prefix (tools/system) before forwarding, so the provider caches it. Departs from strict
   * byte-transparency for this benefit; leaves the replay key unchanged and never overrides an agent's
   * own breakpoints. OFF keeps the proxy strictly byte-transparent (Mechanism A only).
   */
  preserveCache?: boolean;
  log?: (message: string) => void;
}

export interface RunningProxy {
  server: Server;
  /** The actually-bound port (meaningful when `port: 0` was requested). */
  port: number;
  /** Base URL a client should point at, e.g. "http://127.0.0.1:53102". */
  url: string;
  close(): Promise<void>;
}

/** Hop-by-hop and length headers we must not copy blindly between the two connections. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

function forwardableRequestHeaders(headers: IncomingHttpHeaders, bodyLen: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (HOP_BY_HOP.has(k.toLowerCase())) continue;
    if (k.toLowerCase() === "accept-encoding") continue; // overridden below
    out[k] = Array.isArray(v) ? v.join(", ") : v;
  }
  out["content-length"] = String(bodyLen); // exact byte count of the body we forward
  // Force an UNCOMPRESSED upstream response. We store and replay opaque bytes and parse a copy for
  // usage; a gzip/br body would replay without its content-encoding (corrupt to the client) and read
  // as zero usage. The localhost hop loses nothing meaningful by skipping compression.
  out["accept-encoding"] = "identity";
  return out;
}

/** Read a whole request/response body into a single Buffer. */
function readBody(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  const messagesPath = options.messagesPath ?? "/v1/messages";
  const scopeHeader = (options.scopeHeader ?? "x-rewind-scope").toLowerCase();
  const log = options.log ?? (() => {});
  const upstream = new URL(options.upstreamBase);
  const client = upstream.protocol === "https:" ? httpsRequest : httpRequest;

  const server = createServer((req, res) => {
    // Everything is async; guard the whole handler so no throw escapes to crash the process.
    void handle().catch((err) => {
      log(`proxy: unhandled error, failing to a 502: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "rewind_proxy_error", message: "upstream unreachable" } }));
    });

    async function handle(): Promise<void> {
      const rawBody = await readBody(req);
      const isMessages = req.method === "POST" && (req.url ?? "").split("?")[0] === messagesPath;

      // Decide replay ONLY for the messages endpoint, and only when the body parses. Any failure here
      // falls through to a plain forward — Rewind never blocks a call it cannot help.
      if (isMessages) {
        const scopeRaw = req.headers[scopeHeader];
        const scope = (Array.isArray(scopeRaw) ? scopeRaw[0] : scopeRaw) || "default";
        let parsed: Record<string, unknown> | undefined;
        let decision: { served: "replay" | "live"; keyed: string; response?: unknown } | undefined;
        try {
          parsed = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
          decision = options.replayer.handle(scope, parsed, req.headers);
        } catch (err) {
          // A STRICT replay miss is a deliberate refusal to pay for a call the caller forbade — it must
          // NOT fall through to a paid upstream forward. Surface it; forward only on real parse faults.
          if (err instanceof StrictReplayMissError) {
            res.writeHead(409, { "content-type": "application/json", "x-rewind": "strict-miss" });
            res.end(JSON.stringify({ error: { type: "rewind_strict_replay_miss", message: err.message } }));
            log(`proxy: STRICT MISS refused scope=${scope} (no upstream call)`);
            return;
          }
          log(`proxy: replay decision skipped (${err instanceof Error ? err.message : String(err)}); forwarding`);
        }
        if (decision?.served === "replay") {
          const rec = decision.response as RecordedHttpResponse;
          const body = Buffer.from(rec.bodyBase64, "base64");
          res.writeHead(rec.status, {
            "content-type": rec.contentType,
            "content-length": String(body.length),
            "x-rewind": "replay",
          });
          res.end(body);
          log(`proxy: REPLAY scope=${scope} key=${decision.keyed.slice(0, 12)} (0 upstream tokens)`);
          return;
        }
        // MISS → optionally add a cache breakpoint (opt-in), then forward, tee, record under the
        // key the replayer already computed (the key is over the ORIGINAL body, unaffected by the hint).
        let forwardBody = rawBody;
        if (options.preserveCache && parsed) {
          try {
            const plan = planCacheBreakpoints(parsed);
            if (plan.injected) {
              forwardBody = Buffer.from(JSON.stringify(plan.body), "utf8");
              log(`proxy: cache-preserve ${plan.reason} scope=${scope}`);
            }
          } catch (err) {
            log(`proxy: cache-preserve skipped (${err instanceof Error ? err.message : String(err)})`);
          }
        }
        await forward(forwardBody, { scope, replayKey: decision?.keyed });
        return;
      }

      // Non-messages traffic: forward transparently, no replay, no record.
      await forward(rawBody, undefined);
    }

    /** Forward the raw body upstream, stream the response back live, and (on a messages 2xx) record it. */
    function forward(rawBody: Buffer, record: { scope: string; replayKey?: string } | undefined): Promise<void> {
      return new Promise((resolve) => {
        // Exactly one terminal path settles: a stream can emit both an upstream `error` and, on the
        // request object, an `error`, and the client can disconnect — without this guard two of them
        // would each call res.end() and the second throws ERR_STREAM_WRITE_AFTER_END inside an event
        // handler, crashing the proxy. Fail-open means the proxy stays up no matter what.
        let settled = false;
        const done = (): void => {
          if (settled) return;
          settled = true;
          resolve();
        };
        const endQuietly = (): void => {
          try {
            res.end();
          } catch {
            /* already ended by an earlier terminal path */
          }
        };
        const fail502 = (message: string): void => {
          if (settled) return;
          try {
            if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { type: "rewind_upstream_error", message } }));
          } catch {
            /* headers/body already flowed; nothing more we can safely send */
          }
          done();
        };
        // A client that hangs up mid-flight must not leave this promise pending forever.
        res.on("error", () => done());

        const upReq = client(
          {
            protocol: upstream.protocol,
            hostname: upstream.hostname,
            port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
            method: req.method,
            path: req.url,
            headers: forwardableRequestHeaders(req.headers, rawBody.length),
          },
          (upRes) => {
            const status = upRes.statusCode ?? 502;
            const contentType = (upRes.headers["content-type"] as string) ?? "application/json";
            // Copy response headers verbatim except hop-by-hop/length (we set our own length on end).
            const outHeaders: Record<string, string> = { "x-rewind": "live" };
            for (const [k, v] of Object.entries(upRes.headers)) {
              if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
              outHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
            }
            res.writeHead(status, outHeaders);
            const chunks: Buffer[] = [];
            upRes.on("data", (c: Buffer) => {
              chunks.push(c); // buffer a copy for metering...
              try {
                res.write(c); // ...while streaming live for TTFT (client may have gone — ignore)
              } catch {
                /* client write failed; the res 'error'/'close' path will settle */
              }
            });
            upRes.on("end", () => {
              endQuietly();
              const full = Buffer.concat(chunks);
              // Record only a genuine, COMPLETE success on the replay-able endpoint. A 2xx that carries
              // an SSE error or a truncated stream is transient and must never be frozen into a replay.
              if (record?.replayKey && status >= 200 && status < 300 && isRecordableSuccess(full, contentType)) {
                try {
                  recordResponse(options.store, record.scope, record.replayKey, full, contentType, status);
                  log(`proxy: LIVE recorded scope=${record.scope} key=${record.replayKey.slice(0, 12)}`);
                } catch (err) {
                  log(`proxy: record failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
                }
              } else if (record?.replayKey && status >= 200 && status < 300) {
                log(`proxy: NOT recording an incomplete/error 2xx response scope=${record.scope}`);
              }
              done();
            });
            upRes.on("error", () => {
              // Mid-stream upstream failure after headers were sent — we can't 502 now; just close.
              endQuietly();
              done();
            });
          },
        );
        upReq.on("error", (err) => {
          // Upstream genuinely unreachable (or errored before any response): surface a 502 if we still
          // can, else close. Never fabricate a model response.
          log(`proxy: upstream error: ${err instanceof Error ? err.message : String(err)}`);
          fail502("upstream request failed");
        });
        upReq.write(rawBody);
        upReq.end();
      });
    }
  });

  return new Promise((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : (options.port ?? 0);
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((res2, rej2) => server.close((e) => (e ? rej2(e) : res2()))),
      });
    });
  });
}

/**
 * Whether a 2xx response body is a genuine, COMPLETE success worth freezing into a replay. Anthropic
 * can return HTTP 200 and then deliver an error or a truncated stream — those must NOT be recorded, or
 * a transient failure would be replayed forever (and any partial usage credited as a saving).
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

/** Parse usage + model out of a live response and store it for future replay (validated caller-side). */
function recordResponse(
  store: RecordStore,
  scope: string,
  replayKey: string,
  body: Buffer,
  contentType: string,
  status: number,
): void {
  const { usage, model } = extractUsage(body, contentType);
  const response: RecordedHttpResponse = { status, contentType, bodyBase64: body.toString("base64") };
  const record: RecordedCall = { response, usage, model: model ?? "unknown" };
  store.put({ scope, replayKey }, record);
}
