# `bench --live` runbook — the real-dollar proof (needs your API key)

The deterministic bench (`node packages/gateway/bench/run.ts`) proves the *mechanism* and the
*meter arithmetic* with no network and no key: it shows the gateway avoids the rewind re-run calls and
bills the honest marginal saving over the provider's own caching. What it cannot prove is **real
dollars against the live provider** — that requires your key, because only the real API reports the
real token counts and the real cache behaviour.

This runbook is that proof. It is intentionally a manual step: it spends real money (a few cents) and
must run with a real `ANTHROPIC_API_KEY`, so it is never part of the automated suite.

## What it demonstrates

Run the same short agent trajectory twice against `https://api.anthropic.com`:

1. **OFF** — straight to the API. The rewind re-runs are paid for again (the provider's own prompt
   cache discounts them, but they still cost).
2. **ON** — through `rewind gateway`. The byte-identical re-runs are served from the record with zero
   upstream call.

Then compare the provider's **own** reported usage/billing between the two runs. The dollar delta is
the live analogue of the deterministic bench's `billableSavedMicros`.

## Steps

```bash
# 1. Start the gateway (leave it running in one terminal). It listens locally and forwards to the API.
export ANTHROPIC_API_KEY=sk-ant-...            # your real key
npx -y @agent-rewind/mcp gateway --port 8788   # → http://127.0.0.1:8788

# 2. In another terminal, point your agent / script at the gateway instead of the API directly:
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788
export ANTHROPIC_API_KEY=sk-ant-...            # the gateway forwards this header verbatim

# 3. Run your agent through a real checkpoint → work → rewind → re-run cycle
#    (e.g. drive Claude Code or Cursor pointed at ANTHROPIC_BASE_URL, or a scripted loop).

# 4. Read the saving the gateway measured and booked:
npx -y @agent-rewind/mcp savings --json
```

`rewind savings` reports the tokens and cost the gateway **actually avoided** — booked only when a
replay genuinely served a recorded response, deduped by call identity. Cross-check it against the
provider's own usage dashboard for the two runs: the ON run's upstream token count should be lower
than the OFF run's by the reported avoided amount.

## Honesty

- The billable figure is the saving **over the provider's own auto-caching**, not over no-caching —
  the same discipline the deterministic bench enforces. Do not quote the "gross" cold-price number as
  the bill.
- Only `bench --live` proves dollars. The deterministic bench proves the mechanism and that the meter
  cannot be tricked into crediting a saving that did not happen.
