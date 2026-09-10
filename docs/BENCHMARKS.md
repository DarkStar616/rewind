# Agent Rewind benchmark evidence

Agent Rewind reports different measurements for different questions. Do not merge them into one
unqualified “savings” percentage.

## Benchmark B: recovered tokens after a rewind

Benchmark B ran 120 deterministic trials of a 10-step task. It measures how many tokens a rewind can
recover as the failure moves later in the run:

| Failure point | Tokens recovered |
|---|---:|
| step 2 of 10 | **9.1%** |
| step 5 of 10 | **25.6%** |
| step 8 of 10 | **41.2%** |

The public claim is therefore: **“recover up to 41.2% of the tokens a late-failing run burned.”**
The late-failure condition must stay attached. This controlled benchmark is deterministic, has a 50%
ceiling for one interruption, and does not represent every workload or a production dollar-saving rate.

The result was recorded in repository history by commit `64f3ec6` after verification against the
Benchmark B output. The original qm-athena/SHEPHERD-INTEGRATION corpus and runner are not vendored in
this repository, so this historical result is measured but not independently rerunnable from this
checkout alone.

## Nebius provider-calibrated scenario

[`packages/gateway/bench/live-nebius.ts`](../packages/gateway/bench/live-nebius.ts) makes ten real calls
to Nebius, reads the provider's own token counts, and uses Rewind's production request identity to price
early, middle, and late rewind trajectories. Repeated requests are then treated as zero-upstream-cost
replays.

This proves the calculation against real provider usage. It is a provider-calibrated scenario rather
than an end-to-end OFF/ON gateway experiment over production traffic. Run it with a Nebius key that is
supplied only through the process environment:

```bash
NEBIUS_API_KEY=... NODE_OPTIONS=--conditions=development \
  node packages/gateway/bench/live-nebius.ts
```

## Reproducible in-repo mock scenario

`npm run --silent bench:json` executes a nine-call trajectory with three replayed calls. It reports
**28.08% avoided simulated cost**; its unique-call negative control reports zero. The artifact includes
source hashes, denominators, a price-table version, and explicit limitations.

This benchmark is fully rerunnable from the repository and guards the accounting mechanism. It is not
real provider billing, a recovered-token percentage, or a general product-savings estimate.

## Claim rules

- Always pair **41.2%** with “late failure” or “step 8 of 10.”
- Call Benchmark B a deterministic controlled measurement, not production traffic.
- Call the Nebius runner provider-calibrated, not a production A/B.
- Call **28.08%** simulated avoided cost, not recovered tokens.
- Keep token recovery, billed cost, latency, and task success as separate metrics.
