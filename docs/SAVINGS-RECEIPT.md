# Savings receipt — spec (Slice 1.5)

The growth engine. One honest line that does three jobs: retention hook, shareable artifact, upsell
trigger. Its data source already exists in the harvest, so this is assembly, not invention — but the
**honesty of the number is the entire value**, so the metering rules below are the spec, not the
formatting.

## Data source (harvested — do not rebuild)

`src/harness/recorded/replay-savings.ts` (on qm-athena `deploy-latest`) already emits a `ReplaySaving`
record whenever a recorded turn is replayed with `modelCalls: 0` — i.e. a recorded model response was
returned **without contacting the provider**, and a recorded tool result **without invoking the tool**.
Each record carries the avoided input/output token counts (and the model, to price it). Port this sink
into `@agent-rewind/core` as the receipt's ledger. The durable variant (`postgres-replay-savings.ts`) is the
team-view/paid path; the MVP uses the local store.

## What counts as "saved" (the honest counterfactual — the acceptance bar)

"Saved" = tokens that would **provably** have been re-spent and were not. Exactly two sources qualify:

1. **Replay cache-hit.** A recorded turn returned with `modelCalls: 0`. The avoided tokens are the
   real input+output of that recorded call, priced at the recorded model's rate. This is the primary
   source and it is directly on the `ReplaySaving` record.
2. **Re-execution avoided by rewind.** After a `rewind` to a checkpoint, work that the replay engine
   served from the record (rather than re-running live) against a *real prior*. Same `ReplaySaving`
   mechanism — only counted when there is an actual recorded prior, never a projection.

**Never counted (these are how the number becomes a lie):**
- The whole cost of a failed run because we rewound it. We saved the *re-spend*, not the original spend.
- Wall-clock, "productivity", or any bill-agnostic estimate.
- The provider-side prompt-cache discount — that is the user's, from their provider, not ours to claim.
- Overlapping rewinds double-counting the same avoided call. Dedupe by the recorded call's identity.

If in doubt, report less. A conservative real number is a category we own (Lane C confirmed **no public
replay-savings figure exists**); an inflated one is discredited the first time an engineering manager
divides it by their actual invoice.

## Surface

- **CLI:** `agent-rewind savings [--scope <id>] [--since <window>] [--json]`
- **MCP tool:** `savings` — input `{ scope?, since? }`, output `{ tokensSaved, costSaved, currency,
  window, breakdown: { replayHits, rewindAvoided } }`.
- Both read the same core function; no logic duplicated (per `ARCHITECTURE.md`, one engine, thin
  adapters).

## Output

Default human line (the shareable thing):
```
Rewind recovered 4.2M tokens this week (~$63 saved).
```
- Token count from the summed `ReplaySaving` records in the window; `$` via the recorded per-model
  rate (ship a small static rate table, note it is an estimate, let it be overridden).
- `--json` for the dashboard/team-view consumer.

**Threshold upsell (the only email ask):** when cumulative lifetime savings cross a threshold, append
exactly one line:
```
You've recovered 12.4M tokens total. See your whole team's savings → <link>
```
Nothing else in the free, local product asks for an account.

## Tests (acceptance)

1. **Zero when nothing was avoided.** Feed a session with no replay cache-hit; `agent-rewind savings` reports
   `0 tokens`. This test guards against an inflated number and must fail on a "credit the whole run"
   implementation.
2. **Exact on a real hit.** A session with one recorded replay of a known-size call reports exactly
   that call's avoided tokens/cost.
3. **No double count.** Two overlapping rewinds over the same recorded call count it once.
4. **Reconciliation.** The reported total equals the sum of the underlying `ReplaySaving` records.
