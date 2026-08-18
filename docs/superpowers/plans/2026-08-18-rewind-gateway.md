# Rewind Gateway — build plan (the token-saving engine)

> Executors: TDD each task, `node --test` must stay green, commit per task. Harvest, don't rebuild.
> Read `docs/BUSINESS-MODEL.md` (billing basis), and the design synthesis in this repo's history.

**Goal:** `@rewind/gateway` — a local, byte-transparent LLM proxy that records/replays model calls and
preserves prompt-cache across rewinds, turning the savings receipt from `0` into a real, billable number.

## Two proven mechanisms (keep them SEPARATE, never double-count)
- **Mechanism A — REPLAY (100% avoided):** a byte-identical request after a rewind is served from the
  record with **zero** upstream call. Harvested from athena `recorded-response-harness.ts`
  (fingerprint → lookup → **hard-fail-on-miss** → `modelCalls:0` → book `tokensAvoided`). This is "ours."
- **Mechanism B — CACHE-PRESERVATION (~90% off the prefix):** both providers cache on exact-prefix
  hashes at 0.1×; a rewind that re-sends a byte-identical prefix re-hits the provider cache. Reference
  cost model: shepherd-experiments `bench_kv_cache_comprehensive.py`. Claim ONLY when the gateway caused
  the warm hit (a logged re-warm), else 0.

## Harvest sources (read-only; qm-athena `mvp-golden-path` worktree)
- `src/harness/recorded-response-harness.ts` — the replay engine (Mechanism A). PRIMARY.
- `src/harness/recorded/recorded-response-store.ts` — `indexRecordedTurns`, SHA-256 request fingerprint.
- `src/harness/recorded/replay-savings.ts` — already ported to `@rewind/core`.
- shepherd-experiments `exp/framework-perf/src/experiment_framework_perf/bench_kv_cache_comprehensive.py`
  — the cache cost model + rolling ephemeral breakpoint (Mechanism B reference).

## Package layout — `packages/gateway` (`@rewind/gateway`, FSL-1.1-ALv2, depends on `@rewind/core`)
```
src/canonical-request.ts   canonicalizeRequest(body) -> replayKey (SHA-256 over the OUTPUT-affecting
                           fields: model, system, messages, tools, tool_choice, temperature, top_p,
                           top_k, max_tokens, stop, seed, response_format, thinking; STRIP cache_control,
                           prompt_cache_key, ttl, stream, auth, ids, timestamps). Reuse core canonicalize.
src/record-store.ts        RecordStore: put/get({scope, replayKey}) -> {response, usage}. Scope-isolated,
                           content-addressed. Memory impl now; durable later.
src/meter.ts               avoidedTokens(usage, bucket, priceTable): Mechanism A = all input at cache-READ
                           rate + full output; Mechanism B = read*(p_in - p_read). Dated price table,
                           version stamped on every record. NEVER estimate tokens locally.
src/replay.ts              createReplayer(store, savingsSink): handle(scope, body) -> {served:'replay'|'live',
                           response?, keyed}. Hit -> serve recorded + book ReplaySaving. Miss -> 'live'.
src/proxy.ts               startProxy({port, upstreamBase, log}): POST /v1/messages (Anthropic native).
                           Forward RAW request bytes upstream via undici.request (NOT global fetch),
                           forward auth headers verbatim (x-api-key/Authorization/anthropic-version),
                           tee the SSE stream (pipe to client live for TTFT + parse a copy for usage).
                           Replay on hit, forward+record on miss. FAIL OPEN to upstream on any fault.
src/cache-preserve.ts      Anthropic ephemeral breakpoints: pin ttl:1h on the static tools+system prefix,
                           rotate 5m/1h across checkpoint boundaries; max_tokens:0 pre-warm on rewind.
                           Meter Mechanism B only when a re-warm was performed.
src/index.ts               exports
bench/mock-upstream.ts     cache-faithful mock: simulate KV-cache keyed by prefix hash + TTL + INJECTABLE
                           clock; return deterministic body + a usage block in the SAME fields as the real
                           API (input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output).
bench/bench.ts             scripted agent-with-rewinds loop; run gateway OFF vs ON; diff meters; emit a
                           report with three attribution lines (S_replay, S_preserve, S_shape).
```
CLI: add `rewind gateway [--port N] [--upstream URL]` to `packages/mcp/src/cli.ts` (start the proxy).

## Tasks (TDD)
- **G1 Scaffold + canonical-request** — package + `canonical-request.ts`. Tests: identical request→same
  key; cache-hint/stream/auth differences→SAME key; any message/tool/param change→different key.
- **G2 record-store + replay** — harvest the replay logic. Tests: miss→'live'; hit→recorded response +
  a ReplaySaving booked with `tokensAvoided` = recorded total; **cross-scope never serves**; strict mode
  hard-fails on miss (never silently forwards to a paid call when replay is required).
- **G3 meter** — conservative avoided-tokens. Tests: **golden-negative** (no avoided → exactly 0);
  Mechanism-A math on a known usage object; price-table version stamped; no local token estimation.
- **G4 proxy** — byte-transparent HTTP proxy against a stub upstream. Tests: forward-on-miss records the
  response; replay-on-hit skips upstream; **fail-open** when upstream errors; raw bytes preserved
  (a re-serialization would change the key — assert byte-identity of what's forwarded).
- **G5 mock-upstream + bench** — cache-faithful mock + the OFF-vs-ON loop → a deterministic, reproducible
  savings number, no API key. Assert ON < OFF cost and the number is stable across runs.
- **G6 bench gates (make them BITE)** — conservation (recompute totals from the transcript == meter);
  **golden-negative** (a do-nothing passthrough gateway reports EXACTLY 0%); hand-oracle (a tiny fixed
  trajectory with hand-computed savings); adversarial no-credit (volatile-timestamp busts cache→no
  saving; divergence-before-checkpoint→credit only shared portion; near-match must MISS, never serve).
- **G7 wire savings + CLI** — the gateway's ReplaySavings feed `rewind savings` (0 → real number); add the
  `rewind gateway` subcommand; a `bench --live` runbook stub (documented, needs real keys).
- **G8 cache-preserve** — breakpoint placement + `max_tokens:0` re-warm on rewind; Mechanism-B metering
  gated on a logged re-warm.

## Also in this run (finish + fold in the AgentRewind blueprint)
- **H4–H8 finish hardening** — adversarial passes on engine, CLI, MCP server, savings; then integration
  fuzz. (Independent of the gateway; each starts by discarding any uncommitted changes, runs the FULL
  suite, commits only if green.)
- **Path three-classes** (git backend) — *tracked* (snapshot/revert), *excluded* (`.git`, `.env`,
  secrets — NEVER snapshotted), *volatile* (caches — deleted on restore). AgentRewind §C.4/Table 14.
- **Recovery-policy module** (`@rewind/core`) — the two-tool interface (`backtrack_candidates` /
  `backtrack_commit` with a required memory note) + cumulative rewind-memory (worth ~+18pp accuracy);
  checkpoint-sparsity gate (Crab: >75% of turns need no checkpoint — gate on observed effect/diff).

## Honesty (bake into docs + `bench` output)
Bill on the **marginal** savings over the provider's own auto-caching (baseline B), not over no-caching.
Mechanism A is the ownable, unpublished number; Mechanism B is only the delta the gateway causes.
The deterministic bench proves mechanism + meter-correctness; only `bench --live` proves real dollars.
