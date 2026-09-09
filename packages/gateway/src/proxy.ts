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
import { createServer, request as httpRequest, validateHeaderValue, type IncomingHttpHeaders, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { request as httpsRequest } from "node:https";

import { canonicalizeRequest } from "./canonical-request.ts";
import { LegacyIdentityGenerationError, type RecordStoreV2, type ConsumedOccurrence } from "./record-store-v2.ts";
import { encodeTrustedScope, type ScopeResolver } from "./trusted-scope.ts";
import type { RecordStore, RecordedCall } from "./record-store.ts";
import type { Replayer } from "./replay.ts";
import { StrictReplayMissError } from "./replay.ts";
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

/** Validate transport bytes and terminal success before any avoidance is credited. */
function validHttpRecord(record: RecordedCall, adapter: ProviderAdapter, url?: string): boolean {
  const rec = record.response as RecordedHttpResponse | undefined;
  if (!rec || !Number.isInteger(rec.status) || rec.status < 200 || rec.status >= 300 ||
      typeof rec.contentType !== "string" || typeof rec.bodyBase64 !== "string") return false;
  try {
    validateHeaderValue("content-type", rec.contentType);
    const bytes = Buffer.from(rec.bodyBase64, "base64");
    if (bytes.toString("base64") !== rec.bodyBase64) return false;
    const counts = [record.usage?.input_tokens, record.usage?.output_tokens,
      record.usage?.cache_read_input_tokens, record.usage?.cache_creation_input_tokens].map((n) => n ?? 0);
    if (!counts.every((n) => Number.isSafeInteger(n) && n >= 0) ||
        !Number.isSafeInteger(counts.reduce((a, b) => a + b, 0))) return false;
    return adapter.isRecordableSuccess(bytes, rec.contentType, url);
  } catch { return false; }
}

export interface TapeProxyOptions {
  store: RecordStoreV2;
  epoch: string;
  replayCursor?: string;
  maxRecordBytes?: number;
  maxQueuedRequests?: number;
  /** Absolute upstream deadline, including response body, in milliseconds. */
  upstreamTimeoutMs?: number;
  /** Called only for a fresh persisted replay claim; failures never trigger an upstream call. */
  onAvoided?: (claim: ConsumedOccurrence, requestId: string) => Promise<void>;
}

export interface ProxyOptions {
  /** Explicit ordered mode. No cursor records live occurrences; a cursor permits strict replay only. */
  tape?: TapeProxyOptions;
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
  /** Trusted application/process identity. Omit only for legacy single-trust-domain compatibility. */
  resolveScope?: ScopeResolver;
  /** Unresolved identity refuses by default; explicit passthrough performs no optimization or credit. */
  scopeFailure?: "refuse" | "passthrough";
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

function forwardableRequestHeaders(headers: IncomingHttpHeaders, bodyLen: number, scopeHeader: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    if (k.toLowerCase().startsWith("x-rewind-") || k.toLowerCase() === scopeHeader) continue;
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

/**
 * The absolute upstream target used to namespace the replay key: the normalized upstream origin +
 * the request path/query. Resolving `reqUrl` against `upstreamBase` lowercases the host and drops the
 * default port, so `https://API.host` and `https://api.host:443` namespace identically. On any parse
 * failure it falls back to the raw request path — degrading to path-only keying (the prior behaviour),
 * never throwing on the request's critical path.
 */
function keyUrl(upstreamBase: string, reqUrl: string | undefined): string {
  try {
    return new URL(reqUrl ?? "/", upstreamBase).href;
  } catch {
    return reqUrl ?? "";
  }
}

/** Read a whole request/response body into a single Buffer. */
function readBody(stream: NodeJS.ReadableStream): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if ((stream as NodeJS.ReadableStream & { destroyed?: boolean }).destroyed) { reject(new Error("request closed before body read")); return; }
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

export function startProxy(options: ProxyOptions): Promise<RunningProxy> {
  if (options.scopeFailure !== undefined && !["refuse", "passthrough"].includes(options.scopeFailure)) throw new Error("invalid scope failure policy");
  if (options.tape && !options.resolveScope) throw new Error("durable tape requires a trusted scope resolver");
  if (options.tape && options.scopeFailure === "passthrough") throw new Error("tape mode requires refusal on scope failure");
  if (options.tape && (typeof options.tape.epoch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(options.tape.epoch) || (options.tape.replayCursor !== undefined && (typeof options.tape.replayCursor !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(options.tape.replayCursor))))) throw new Error("invalid tape epoch/cursor");
  const upstreamTimeoutMs = options.tape?.upstreamTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1 || upstreamTimeoutMs > 2_147_483_647) throw new Error("invalid upstream timeout");
  const maxRecordBytes = options.tape?.maxRecordBytes ?? 512 * 1024;
  const maxQueuedRequests = options.tape?.maxQueuedRequests ?? 64;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1 || !Number.isSafeInteger(maxQueuedRequests) || maxQueuedRequests < 1) throw new Error("invalid tape limits");
  let tapeTail = Promise.resolve();
  let queuedTapeRequests = 0;
  const messagesPath = options.messagesPath ?? "/v1/messages";
  const scopeHeader = (options.scopeHeader ?? "x-rewind-scope").toLowerCase();
  const log = options.log ?? (() => {});
  const upstream = new URL(options.upstreamBase);
  const client = upstream.protocol === "https:" ? httpsRequest : httpRequest;

  const server = createServer((req, res) => {
    // Install the error listener before an async resolver or queued request can be abandoned.
    req.on("error", () => {});
    const failed = (err: unknown): void => {
      log(options.tape ? "proxy: durable request failed; no automatic upstream fallback" : `proxy: unhandled error: ${err instanceof Error ? err.message : String(err)}`);
      if (res.headersSent) { res.destroy(); return; }
      res.writeHead(options.tape ? 503 : 502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { type: "rewind_proxy_error", message: options.tape ? "durable storage unavailable or cursor conflict" : "upstream unreachable" } }));
    };
    if (options.tape) {
      if (queuedTapeRequests >= maxQueuedRequests) { req.resume(); res.writeHead(503); res.end("durable request queue full"); return; }
      queuedTapeRequests++;
      const previous = tapeTail;
      let release!: () => void;
      tapeTail = new Promise<void>((resolve) => { release = resolve; });
      void previous.then(() => res.destroyed ? undefined : handle()).catch(failed).finally(() => { queuedTapeRequests--; release(); });
    } else void handle().catch(failed);

    async function handle(): Promise<void> {
      const scopeRaw = req.headers[scopeHeader];
      let scope = (Array.isArray(scopeRaw) ? scopeRaw[0] : scopeRaw) || "default";
      if (options.resolveScope) {
        try {
          scope = encodeTrustedScope(await options.resolveScope({ headers: req.headers, method: req.method, url: req.url }));
        } catch {
          log("proxy: trusted scope unresolved");
          if (options.scopeFailure === "passthrough") {
            await forward(await readBody(req), undefined);
          } else {
            req.resume();
            res.writeHead(403, { "content-type": "application/json", "x-rewind": "scope-refused" });
            res.end(JSON.stringify({ error: { type: "rewind_scope_unresolved", message: "trusted scope required" } }));
          }
          return;
        }
      }
      const rawBody = await readBody(req);
      if (res.destroyed) return;
      if (options.tape && rawBody.length > maxRecordBytes) {
        if (options.tape.replayCursor) { res.writeHead(409); res.end("strict replay request exceeds eligibility limit"); }
        else { log("proxy: request exceeds tape eligibility limit; forwarding without recording"); await forward(rawBody, undefined); }
        return;
      }
      // Pick the provider adapter for this request. Precedence, in order:
      //   1. An explicit `options.provider` pin wins outright — its adapter is used when it path-matches;
      //      a pinned request that does not match (and is not the anthropic legacy case) is treated as
      //      non-recordable rather than silently parsed with another provider's semantics.
      //   2. Otherwise, an EXPLICITLY-CUSTOMISED `messagesPath` that the request hits is a deliberate
      //      "record THIS path as Anthropic" and wins over auto-detection — so an existing Anthropic
      //      caller who set messagesPath to a path another adapter now recognises (e.g.
      //      /v1/chat/completions) keeps Anthropic semantics.
      //   3. Otherwise auto-detect: the first adapter whose endpoint path-matches.
      //   4. Otherwise, a request on the (default) messagesPath falls back to Anthropic — the legacy
      //      behaviour existing callers depend on.
      const selected = selectAdapter({ provider: options.provider }, req.method, req.url);
      const pathMatches = selected?.matchPath(req.method, req.url) ?? false;
      const hitsMessagesPath = req.method === "POST" && (req.url ?? "").split("?")[0] === messagesPath;
      const messagesPathCustomised = messagesPath !== "/v1/messages";
      let adapter: ProviderAdapter | undefined;
      if (options.provider) {
        adapter = pathMatches
          ? selected
          : hitsMessagesPath && options.provider === "anthropic"
            ? anthropicAdapter // pinned-anthropic honours a customised messagesPath its own matchPath misses
            : undefined;
      } else if (hitsMessagesPath && messagesPathCustomised) {
        adapter = anthropicAdapter; // explicit messagesPath config beats auto-detection
      } else if (pathMatches) {
        adapter = selected;
      } else if (hitsMessagesPath) {
        adapter = anthropicAdapter; // legacy default-path fallback
      } else {
        adapter = undefined;
      }

      // Decide replay ONLY for a recordable model endpoint, and only when the body parses. Any failure
      // here falls through to a plain forward — Rewind never blocks a call it cannot help.
      if (adapter) {
        let parsed: Record<string, unknown> | undefined;
        let pruned = false; // did deterministic pruning change the body? (then forward the pruned bytes)
        let decision: { served: "replay" | "live"; keyed: string; response?: unknown; commit?: () => void } | undefined;
        try {
          parsed = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
          // Key the same local-header-stripped view that reaches the provider.
          const identityHeaders = Object.fromEntries(Object.entries(req.headers).filter(([name]) => name.toLowerCase() !== scopeHeader));
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
          // Pass the ABSOLUTE upstream target so BOTH the endpoint path AND the upstream ORIGIN
          // co-determine the key. The path guards providers that name the model (or the JSON-vs-SSE
          // choice) in the URL — Gemini — from colliding two targets onto one record; the origin guards
          // a SHARED store (the SDK lets consumers inject their own) from serving a response recorded
          // against a DIFFERENT upstream — two OpenAI-compatible vendors both speak /v1/chat/completions
          // with identical bodies, and that must be a miss, never a cross-provider false hit. The
          // replayer strips the query (auth material) itself.
          if (options.tape) {
            const replayKey = canonicalizeRequest(parsed, identityHeaders, keyUrl(options.upstreamBase, req.url));
            if (options.tape.replayCursor) {
              await replayTape(scope, replayKey);
              return;
            }
            await options.tape.store.createEpoch(scope, options.tape.epoch, "gateway-epoch-v1");
            decision = { served: "live", keyed: replayKey };
          } else decision = options.replayer.prepare
            ? options.replayer.prepare(scope, parsed, identityHeaders, keyUrl(options.upstreamBase, req.url), (record) => validHttpRecord(record, adapter, req.url))
            : options.replayer.handle(scope, parsed, identityHeaders, keyUrl(options.upstreamBase, req.url));
        } catch (err) {
          if (err instanceof LegacyIdentityGenerationError) {
            res.writeHead(409, { "content-type": "application/json", "x-rewind": "legacy-identity" });
            res.end(JSON.stringify({ error: { type: "rewind_legacy_identity", message: err.message } }));
            return;
          }
          if (options.tape) {
            const status = err instanceof SyntaxError && options.tape.replayCursor ? 409 : 503;
            if (res.headersSent) res.destroy();
            else { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { type: "rewind_tape_unavailable", message: "invalid request, unavailable history, or cursor conflict" } })); }
            log("proxy: tape operation refused; no upstream call");
            return;
          }
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
            // The upstream branch is now irrevocably skipped. Accounting failure must not send a
            // paid request after a sink may already have persisted avoidance.
            try { decision.commit?.(); }
            catch { log("proxy: replay accounting failed; upstream remains skipped"); }
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
            // Preserve legacy cross-provider advisory behavior until provider-specific
            // hygiene policies are implemented; Anthropic owns its current capability.
            const hygiene = adapter.analyzeCacheHygiene?.(parsed) ?? analyzeCacheHygiene(parsed);
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
        // Cache-breakpoint injection is ANTHROPIC-ONLY: planCacheBreakpoints appends Anthropic's
        // `cache_control` object to the static prefix (tools/system). OpenAI caches automatically (no
        // such field) and Gemini uses a different explicit-cache mechanism — injecting `cache_control`
        // into their tool/message objects would make an otherwise-valid live request fail upstream. So
        // invoke the optional provider capability; only Anthropic implements it today.
        if (options.preserveCache && parsed && adapter.planCacheBreakpoints) {
          try {
            const plan = adapter.planCacheBreakpoints(parsed);
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

      if (options.tape?.replayCursor && req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(409); res.end("strict replay does not forward unsupported mutations"); return;
      }
      // Non-messages traffic: forward transparently, no replay, no record.
      await forward(rawBody, undefined);
    }

    async function replayTape(scope: string, replayKey: string): Promise<void> {
      const tape = options.tape!;
      const cursorId = tape.replayCursor!;
      if ((await tape.store.epoch(scope, tape.epoch)).identityGeneration !== 2) throw new LegacyIdentityGenerationError();
      const provided = req.headers["x-rewind-request-id"];
      if (provided !== undefined && (typeof provided !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(provided))) throw new Error("invalid replay request identity");
      const requestId = provided ?? randomUUID();
      let current = await tape.store.cursor(scope, cursorId);
      if (!current) current = await tape.store.openCursor(scope, tape.epoch, cursorId, "gateway-open-cursor-v1");
      if (current.epoch !== tape.epoch) throw new Error("cursor belongs to another epoch");
      const cursor = await tape.store.cursorForClaim(scope, cursorId, requestId) ?? current;
      if (res.destroyed) return;
      const claim = await tape.store.consume(cursor, replayKey, requestId);
      if (!claim) {
        res.writeHead(409, { "content-type": "application/json", "x-rewind": "strict-miss" });
        res.end(JSON.stringify({ error: { type: "rewind_strict_replay_miss", message: "ordered occurrence absent or request differs" } }));
        return;
      }
      const response = claim.occurrence.response;
      res.writeHead(response.status, { "content-type": response.contentType, "content-length": String(response.body.byteLength), "x-rewind": "replay", "x-rewind-request-id": requestId });
      if (!claim.replayed && tape.onAvoided) {
        try { await tape.onAvoided(claim, requestId); } catch { log("proxy: durable avoidance callback failed; upstream remains skipped"); }
      }
      res.end(Buffer.from(response.body));
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
        let settled = false, cancelled = false, committing = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let upstreamResponse: import("node:http").IncomingMessage | undefined;
        const cancel = (): void => {
          if (settled || res.writableFinished) return;
          cancelled = true;
          upReq.destroy(); upstreamResponse?.destroy();
          if (!committing) done();
        };
        const done = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          res.removeListener("close", cancel);
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
        res.on("error", () => { if (!options.tape) done(); });

        const upReq = client(
          {
            protocol: upstream.protocol,
            hostname: upstream.hostname,
            port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
            method: req.method,
            path: req.url,
            headers: forwardableRequestHeaders(req.headers, rawBody.length, scopeHeader),
          },
          (upRes) => {
            upstreamResponse = upRes;
            if (cancelled || settled) { upRes.destroy(); return; }
            const status = upRes.statusCode ?? 502;
            const contentType = (upRes.headers["content-type"] as string) ?? "application/json";
            // Copy response headers verbatim except hop-by-hop/length (we set our own length on end).
            const outHeaders: Record<string, string> = Object.assign(Object.create(null), { "x-rewind": "live" });
            for (const [k, v] of Object.entries(upRes.headers)) {
              if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
              outHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
            }
            res.writeHead(status, outHeaders);
            const chunks: Buffer[] = [];
            let buffered = 0, eligible = true;
            upRes.on("data", (c: Buffer) => {
              if (cancelled || settled) return;
              buffered += c.length;
              if (options.tape && eligible && buffered > maxRecordBytes) {
                eligible = false;
                for (const held of chunks) res.write(held);
                chunks.length = 0;
              }
              if (eligible) chunks.push(c);
              if (!options.tape || !eligible) res.write(c);
            });
            upRes.on("end", () => {
              clearTimeout(timer);
              if (cancelled || settled) { done(); return; }
              committing = true;
              void (async () => {
              if (!options.tape) endQuietly();
              const full = Buffer.concat(chunks);
              if (options.tape && !eligible) log("proxy: response exceeds tape eligibility limit; not recorded");
              // Record only a genuine, COMPLETE success on the replay-able endpoint. A 2xx that carries
              // an SSE error or a truncated stream is transient and must never be frozen into a replay.
              if (eligible && record?.replayKey && status >= 200 && status < 300 && record.adapter.isRecordableSuccess(full, contentType, req.url)) {
                try {
                  if (options.tape) {
                    const state = await options.tape.store.epoch(record.scope, options.tape.epoch);
                    if (cancelled) { done(); return; }
                    const { usage, model } = record.adapter.extractUsage(full, contentType);
                    await options.tape.store.append({ scope: record.scope, epoch: options.tape.epoch, ordinal: state.length, replayKey: record.replayKey, requestUrl: req.url, provider: record.adapter.id, model: model ?? "unknown", usage, response: { status, contentType, body: full } }, randomUUID());
                  } else recordResponse(options.store, record.adapter, record.scope, record.replayKey, full, contentType, status);
                  log(`proxy: LIVE recorded scope=${record.scope} key=${record.replayKey.slice(0, 12)}`);
                } catch (err) {
                  if (options.tape) throw err;
                  log(`proxy: record failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
                }
              } else if (eligible && record?.replayKey && status >= 200 && status < 300) {
                log(`proxy: NOT recording an incomplete/error 2xx response scope=${record.scope}`);
              }
              if (options.tape && !cancelled) { if (eligible) res.write(full); endQuietly(); }
              done();
              })().catch(() => { log("proxy: durable recording failed before response completion"); res.destroy(); done(); });
            });
            upRes.on("error", () => {
              // Mid-stream upstream failure after headers were sent — we can't 502 now; just close.
              if (options.tape) { cancelled = true; res.destroy(); if (!committing) done(); }
              else { endQuietly(); done(); }
            });
          },
        );
        if (options.tape) {
          res.once("close", cancel);
          timer = setTimeout(() => {
            if (settled) return;
            cancelled = true;
            if (!res.headersSent) { res.writeHead(504); res.end("upstream deadline exceeded"); }
            else res.destroy();
            upReq.destroy(); upstreamResponse?.destroy();
            if (!committing) done();
          }, upstreamTimeoutMs);
        }
        upReq.on("error", (err) => {
          if (cancelled || settled) return;
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
