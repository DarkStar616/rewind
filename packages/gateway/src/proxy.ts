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
import { planCacheBreakpoints } from "./cache-preserve.ts";
import { analyzeCacheHygiene } from "./cache-hygiene.ts";
import { pruneToolOutputs } from "./prune.ts";
import { selectAdapter, type ProviderAdapter } from "./providers/provider-adapter.ts";
import { anthropicAdapter } from "./providers/anthropic.ts";

// Re-exported for backward compatibility: the Anthropic terminal-detection now lives in the anthropic
// adapter, but callers (and proxy-hardening.test.ts) import it from here.
export { isRecordableSuccess } from "./providers/anthropic.ts";

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
  /**
   * Which provider's record/replay adapter to use. Default: AUTO-DETECT by request path (the first
   * adapter whose endpoint matches — Anthropic `/v1/messages`, OpenAI `/v1/chat/completions`, Gemini
   * `…:generateContent`). Set it to pin one provider. When nothing auto-detects but the request hits
   * the legacy `messagesPath`, the Anthropic adapter is used, so existing callers are unaffected.
   */
  provider?: ProviderAdapter["id"];
  /** Header naming the isolation scope for records. Default "x-rewind-scope"; absent → "default". */
  scopeHeader?: string;
  /**
   * Opt-in (default false): when the agent set NO cache_control, inject one ephemeral breakpoint on
   * the static prefix (tools/system) before forwarding, so the provider caches it. Departs from strict
   * byte-transparency for this benefit; leaves the replay key unchanged and never overrides an agent's
   * own breakpoints. OFF keeps the proxy strictly byte-transparent (Mechanism A only).
   */
  preserveCache?: boolean;
  /**
   * Opt-in (default false): deterministically collapse byte-identical duplicate tool_result blocks
   * (an agent re-reading the same file / re-running the same command) before forwarding — a real token
   * saving on long runs. The prune is deterministic, so the replay key is computed over the PRUNED body
   * and replay stays exact. OFF forwards the request untouched.
   */
  pruneContext?: boolean;
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
      // Pick the provider adapter for this request. Explicit options.provider wins; otherwise the
      // first adapter whose endpoint matches the path. As a legacy fallback, a request hitting the
      // configured messagesPath that no adapter path-matched is treated as Anthropic — so existing
      // callers (and a customised messagesPath) keep recording exactly as before.
      const selected = selectAdapter({ provider: options.provider }, req.method, req.url);
      const pathMatches = selected?.matchPath(req.method, req.url) ?? false;
      const legacyMessages = req.method === "POST" && (req.url ?? "").split("?")[0] === messagesPath;
      const adapter: ProviderAdapter | undefined = pathMatches ? selected : legacyMessages ? anthropicAdapter : undefined;

      // Decide replay ONLY for a recordable model endpoint, and only when the body parses. Any failure
      // here falls through to a plain forward — Rewind never blocks a call it cannot help.
      if (adapter) {
        const scopeRaw = req.headers[scopeHeader];
        const scope = (Array.isArray(scopeRaw) ? scopeRaw[0] : scopeRaw) || "default";
        let parsed: Record<string, unknown> | undefined;
        let pruned = false; // did deterministic pruning change the body? (then forward the pruned bytes)
        let decision: { served: "replay" | "live"; keyed: string; response?: unknown } | undefined;
        try {
          parsed = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
          // Deterministic context pruning BEFORE keying, so the key reflects what the model actually
          // sees and replay stays exact over the pruned form.
          if (options.pruneContext) {
            const pr = pruneToolOutputs(parsed);
            if (pr.elided > 0) {
              parsed = pr.body as Record<string, unknown>;
              pruned = true;
              log(`proxy: pruned ${pr.elided} duplicate tool output(s) (~${pr.charsSaved} chars) scope=${scope}`);
            }
          }
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
          const rec = decision.response as RecordedHttpResponse | undefined;
          // Defensive: a well-formed record always carries a string bodyBase64 (recordResponse
          // guarantees it). If the store handed back something malformed (a corrupt/foreign backend),
          // fall through to a live forward rather than 502 — serving the real answer beats crashing.
          if (rec && typeof rec.bodyBase64 === "string" && typeof rec.status === "number") {
            const body = Buffer.from(rec.bodyBase64, "base64");
            res.writeHead(rec.status, {
              "content-type": typeof rec.contentType === "string" ? rec.contentType : "application/json",
              "content-length": String(body.length),
              "x-rewind": "replay",
            });
            res.end(body);
            log(`proxy: REPLAY scope=${scope} key=${decision.keyed.slice(0, 12)} (0 upstream tokens)`);
            return;
          }
          log(`proxy: replay record malformed for key ${decision.keyed.slice(0, 12)}; forwarding live instead`);
        }
        // MISS → the request will hit the provider, so cache friendliness matters here. Advisory only:
        // warn (never mutate/block) when the agent's own request poisons its cacheable prefix.
        if (parsed) {
          try {
            const hygiene = analyzeCacheHygiene(parsed);
            if (!hygiene.cacheable) {
              const first = hygiene.prefixPoisoners[0];
              log(
                `proxy: cache-hygiene scope=${scope} — ${hygiene.recommendation}` +
                  (first ? ` (e.g. ${first.path}: ${first.detail})` : ""),
              );
            }
          } catch {
            /* advisory only; never let hygiene analysis affect the forward */
          }
        }
        // Forward the pruned bytes if pruning changed the body (so the model sees the pruned form the
        // key was computed over); otherwise the exact original bytes. Cache-breakpoint injection (below)
        // may further transform this.
        //
        // NOTE on the keying boundary: the replay key was computed over the PRE-cache-injection body,
        // whereas the body forwarded below may carry injected cache_control (and a string `system`
        // promoted to array form). This asymmetry is deliberate and safe, and differs from pruning on
        // purpose: pruning changes the model-VISIBLE content, so we must key the pruned form; cache
        // breakpoint injection is output-NEUTRAL (cache_control only affects billing/latency, and it is
        // stripped from the key as noise), so keying the pre-injection body changes no answer while
        // keeping the key STABLE across the preserveCache flag — a record made with preserveCache on
        // still replays for the same caller request with it off, and never yields a false hit.
        let forwardBody = pruned && parsed ? Buffer.from(JSON.stringify(parsed), "utf8") : rawBody;
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
        await forward(forwardBody, { scope, replayKey: decision?.keyed, adapter });
        return;
      }

      // Non-messages traffic: forward transparently, no replay, no record.
      await forward(rawBody, undefined);
    }

    /** Forward the raw body upstream, stream the response back live, and (on a messages 2xx) record it. */
    function forward(
      rawBody: Buffer,
      record: { scope: string; replayKey?: string; adapter: ProviderAdapter } | undefined,
    ): Promise<void> {
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
              if (record?.replayKey && status >= 200 && status < 300 && record.adapter.isRecordableSuccess(full, contentType)) {
                try {
                  recordResponse(options.store, record.adapter, record.scope, record.replayKey, full, contentType, status);
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

/** Parse usage + model out of a live response and store it for future replay (validated caller-side). */
function recordResponse(
  store: RecordStore,
  adapter: ProviderAdapter,
  scope: string,
  replayKey: string,
  body: Buffer,
  contentType: string,
  status: number,
): void {
  const { usage, model } = adapter.extractUsage(body, contentType);
  const response: RecordedHttpResponse = { status, contentType, bodyBase64: body.toString("base64") };
  const record: RecordedCall = { response, usage, model: model ?? "unknown" };
  store.put({ scope, replayKey }, record);
}
