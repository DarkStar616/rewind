# Rewind Gateway — build status (the token-saving engine)

The gateway is the piece that turns the savings receipt from a `0` into a real, billable number. It is
a local, byte-transparent LLM proxy an agent points `ANTHROPIC_BASE_URL` at.

## What's built and proven (branch `research-corrections`)

| Task | What it delivers | Proof |
|---|---|---|
| **G1** canonical-request | The replay key — a SHA-256 that ignores caching/stream/auth noise but **fails safe** (an unknown field forces a miss, never a stale hit) | 15 tests, incl. the fail-safe |
| **G2** record-store + replay | Content-addressed, scope-isolated replay (Mechanism A); strict mode hard-fails on a miss; cross-scope never serves | replay + record-store tests |
| **G3** meter | Per-component avoided-cost from the provider's OWN reported usage; dated/versioned price table; golden-negative; no local token estimation | 10 meter tests, hand-checked math |
| **G4** proxy | Byte-transparent HTTP proxy; tees the SSE stream; records only 2xx; **fail-open** (never blocks a call, never fabricates a response) | proxy + usage tests |
| **G5** mock + bench | Cache-faithful mock (injected clock) + deterministic OFF-vs-ON bench | **28% billable saving**, reproducible, no key |
| **G6** biting gates | No false credit; **no stale serve** for a near-match; cache-hint-only still replays; divergence credits only the shared portion | bench-gates tests |
| **G7** CLI + durable savings | `rewind gateway [--port N] [--upstream URL]`; savings persist to `.rewind/savings.json` and feed `rewind savings` across processes | durable-savings tests, CLI smoke-tested |
| **G8** cache-preserve | Mechanism B: injects a breakpoint on the static prefix when the agent set none; credits only what it caused; **opt-in**, separate meter (never double-counts A) | cache-preserve tests |
| **BP1** secrets excluded | A rewind can never revert a live `.env`/key (AgentRewind "excluded" class) | 7 secret-exclusion tests |

**176 tests green, `tsc --noEmit` clean.** (`npm run check` runs both gates.)

## The two mechanisms, kept separate

- **Mechanism A — replay (ours, billable):** a byte-equivalent request after a rewind is served from
  the record with zero upstream call. The billable number is the **measured** marginal saving over the
  provider's own caching (the bench differences two real runs), never the inflated cold-price "gross".
- **Mechanism B — cache-preservation (opt-in, helps, not yet billed):** marks the static prefix so the
  provider caches it. Credited only when the gateway injected the breakpoint AND a warm read resulted.

## How to run it

```bash
# Deterministic proof, no API key:
node packages/gateway/bench/run.ts

# Live:
npx rewind gateway --port 8788                 # forwards to https://api.anthropic.com
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788
# …run your agent (rewind → re-run) …
npx rewind savings --json                      # the tokens/cost actually avoided
```

## Cross-vendor review (codex, unsteered) — run and addressed

A different-vendor review pass (per the build method) surfaced 11 issues; the correctness and
over-credit ones are **fixed** (commit `f949365`):

- **Fixed (false-hit → wrong answer):** nested-`ttl` key collision; missing `anthropic-beta`/`-version`
  in the key; `stream`/non-stream sharing a key; a 200 SSE-error/truncated stream frozen as a replay;
  gzip/br responses replayed without their encoding; a strict-mode miss silently forwarded to a paid
  call.
- **Fixed (over-credit):** unknown-model fallback now the cheapest rate Anthropic ever charged;
  avoided-cost floors instead of rounding half-up.

**Known limitations (safe direction — they under-report or cost a redundant call, never over-credit or
serve a wrong answer):**

- **Concurrent identical misses** both reach upstream (no in-flight coalescing). Both get correct
  answers; dedup-by-callId means only one saving is booked. A per-key in-flight lock is a later slice.
- **Multiple gateway processes** sharing `.rewind/savings.json` can lose a record (last-flush-wins).
  Single-writer is the documented model; this under-reports, never over-credits. A durable multi-writer
  ledger is a later slice.
- **A saving is booked on avoidance** (when the upstream call is genuinely skipped), before the bytes
  finish streaming to the client. A client hang-up mid-replay still counts as avoided (the upstream
  call was skipped) — defensible; a malformed record falls through to a live forward rather than a 502.
- **Rewind-memory is single-writer**, like the savings ledger: two gateway/MCP processes sharing one
  `.rewind/rewind-memory.json` can lose a note (last-flush-wins). Under-reports failure memory; never
  corrupts or fabricates it. A durable multi-writer log is a later slice.
- **Cache-hygiene is a static advisory**: it flags text/values that *look* dynamic (dates, UUIDs,
  epoch-like numbers, id-fields). It cannot prove a given date/UUID actually changes between requests,
  so a static one is a false positive — harmless, since the output is only advice. The safe bias is
  toward flagging (a missed poisoner costs real cache savings; a false flag costs one spurious line).

## Shipped since (research-driven, `docs/RESEARCH-ROADMAP.md`)

- **BP2 recovery / accuracy engine** ✅ — the AgentRewind-style **selective rewind + failure-memory**
  (`@agent-rewind/core` recovery policy; durable attempt log; `backtrack_candidates` / `backtrack_commit` MCP
  tools; checkpoint-sparsity gate). `backtrack_commit` requires a non-empty note (the carried-forward
  lesson) and returns the accumulated failure memory for the target checkpoint. Memory survives across
  sessions/processes. This is the measured +25.6pp accuracy mechanism, and Mechanism A makes its
  re-exploration cheap.
- **Cache-breakpoint hygiene** ✅ — a static analyzer (`analyzeCacheHygiene`) that flags dynamic content
  poisoning the cacheable prefix (the #1 way ~78-80% of cache savings are silently lost) + the
  4-breakpoint cap; wired as a proxy advisory (never blocks/mutates → exact-replay-safe) and a
  `rewind cache-report` CLI.

## Deferred (documented, not built — resisting scope creep)
- **`bench --live` real-dollar proof:** the mechanism and meter are proven deterministically; only a run
  with a real key proves dollars against the live provider. Runbook: `packages/gateway/bench/LIVE-RUNBOOK.md`.
- **Durable record store:** records are per-gateway-session (in memory); the savings number is durable.
  Persisting recorded responses across gateway restarts is a later slice.
