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

## Deferred (documented, not built — resisting scope creep)

- **BP2 recovery-policy** (AgentRewind two-tool `backtrack_candidates`/`backtrack_commit` + rewind-memory
  + checkpoint-sparsity): the *accuracy* feature. A separate slice with its own design; not required for
  the token-saving thesis, which Mechanism A already delivers.
- **`bench --live` real-dollar proof:** the mechanism and meter are proven deterministically; only a run
  with a real key proves dollars against the live provider. Runbook: `packages/gateway/bench/LIVE-RUNBOOK.md`.
- **Durable record store:** records are per-gateway-session (in memory); the savings number is durable.
  Persisting recorded responses across gateway restarts is a later slice.
