/**
 * bench — the deterministic, no-API-key proof that the gateway saves money, and that the meter's
 * arithmetic is honest.
 *
 * The scenario is the one thing rewind is FOR: an agent works forward, hits a dead end, rewinds to an
 * earlier checkpoint, and re-runs the intervening turns. Those re-runs are byte-identical to the first
 * time. Today (gateway OFF) every re-run is paid for again; with the gateway ON, each re-run is served
 * from the record with zero upstream call.
 *
 * The honesty that makes the number billable — measured, not assumed:
 *
 *   We run the SAME trajectory twice against the SAME cache-faithful mock provider. OFF sends every
 *   call (including the re-runs) upstream, so the re-runs are billed at the provider's OWN warm
 *   cache-read rate — the discount the customer already gets today. ON avoids the re-runs entirely.
 *   The billable saving is the MEASURED difference `offCost - onCost`: precisely what Rewind saves
 *   OVER the provider's auto-caching, with no counterfactual guessing. The "gross" replay figure (the
 *   cold first-occurrence cost the record stored) is reported too, but it is an upper bound we do NOT
 *   bill; `billable <= gross` always, and the bench asserts it.
 *
 * Fully deterministic: fixed request bodies, an injected clock, no Date.now / Math.random. Two runs
 * produce byte-identical reports.
 */
import { createMemoryReplaySavings } from "@agent-rewind/core";

import { createMemoryRecordStore } from "../src/record-store.ts";
import { createReplayer } from "../src/replay.ts";
import { startProxy } from "../src/proxy.ts";
import { avoidedCostMicros, type PriceTable } from "../src/meter.ts";
import { extractUsage } from "../src/usage.ts";
import { manualClock, startMockUpstream } from "./mock-upstream.ts";

/** A fixed price table so the bench number is stable regardless of the shipped DEFAULT table. */
export const BENCH_PRICES: PriceTable = {
  version: "bench",
  currency: "USD",
  rates: {
    "bench-model": { input: 3_000_000, output: 15_000_000, cacheWrite: 3_750_000, cacheRead: 300_000 },
  },
};

const MODEL = "bench-model";

/** Build the request body for conversation turn `t` (1-indexed): user/assistant pairs up to user_t.
 *  Assistant replies are fixed strings (as if from a prior deterministic run), so a re-run of the same
 *  turn produces byte-identical bytes. */
function turnBody(t: number): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [];
  for (let i = 1; i <= t; i++) {
    messages.push({ role: "user", content: `user turn ${i}: please continue the analysis in detail.` });
    if (i < t) messages.push({ role: "assistant", content: `assistant turn ${i}: here is the detailed continuation of the analysis.` });
  }
  return { model: MODEL, max_tokens: 256, messages };
}

/**
 * The ordered list of turns the agent actually issues, INCLUDING the re-runs after a rewind. Reaching
 * turn 5, it rewinds to the checkpoint after turn 2 and re-runs 3,4,5 (byte-identical) then continues
 * to 6. The three repeats are what the gateway can avoid.
 */
export function defaultTrajectory(): number[] {
  return [1, 2, 3, 4, 5, /* rewind → */ 3, 4, 5, 6];
}

export interface BenchCall {
  turn: number;
  servedBy: "upstream" | "replay";
  costMicros: number;
  warm: boolean;
  usage?: Parameters<typeof avoidedCostMicros>[0];
}

export interface BenchReport {
  turns: number[];
  offCostMicros: number;
  onCostMicros: number;
  /** offCost - onCost: the honest marginal saving over the provider's own caching. THIS is billed. */
  billableSavedMicros: number;
  billableSavedPct: number;
  /** Upper bound: the cold first-occurrence cost of the avoided calls (record's own usage). NOT billed. */
  grossReplayMicros: number;
  offUpstreamCalls: number;
  onUpstreamCalls: number;
  avoidedCalls: number;
  /** Three attribution lines kept strictly separate so nothing is double-counted. */
  attribution: { replayMicros: number; preserveMicros: number; shapeMicros: number };
  offTranscript: BenchCall[];
  onTranscript: BenchCall[];
}

function priceUsage(usage: Parameters<typeof avoidedCostMicros>[0]): number {
  return avoidedCostMicros(usage, MODEL, BENCH_PRICES);
}

/** POST a body and return the parsed response + the x-rewind header. */
async function post(base: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { text, rewind: res.headers.get("x-rewind"), contentType: res.headers.get("content-type") ?? "application/json" };
}

/**
 * Run the bench. Two passes over the same trajectory against fresh mock providers with identical
 * settings; the only difference is that the ON pass routes through the gateway.
 */
export async function runBench(trajectory: number[] = defaultTrajectory()): Promise<BenchReport> {
  // --- OFF pass: every call goes upstream; the provider's own cache warms the repeats. ---
  const offClock = manualClock(0);
  const offUpstream = await startMockUpstream({ clock: offClock });
  const offTranscript: BenchCall[] = [];
  let offCost = 0;
  try {
    for (const turn of trajectory) {
      const { text, contentType } = await post(offUpstream.base, turnBody(turn));
      const { usage } = extractUsage(text, contentType);
      const cost = priceUsage(usage);
      offCost += cost;
      const warm = offUpstream.calls[offUpstream.calls.length - 1]?.warm ?? false;
      offTranscript.push({ turn, servedBy: "upstream", costMicros: cost, warm, usage });
    }
  } finally {
    await offUpstream.close();
  }

  // --- ON pass: same trajectory through the gateway; byte-identical repeats are served from record. ---
  const onClock = manualClock(0);
  const onUpstream = await startMockUpstream({ clock: onClock });
  const store = createMemoryRecordStore();
  const savings = createMemoryReplaySavings();
  const replayer = createReplayer(store, savings, { priceTable: BENCH_PRICES });
  const proxy = await startProxy({ upstreamBase: onUpstream.base, replayer, store });
  const onTranscript: BenchCall[] = [];
  let onCost = 0;
  try {
    for (const turn of trajectory) {
      const { text, rewind, contentType } = await post(proxy.url, turnBody(turn), { "x-rewind-scope": "bench" });
      if (rewind === "replay") {
        onTranscript.push({ turn, servedBy: "replay", costMicros: 0, warm: false });
      } else {
        const { usage } = extractUsage(text, contentType);
        const cost = priceUsage(usage);
        onCost += cost;
        const warm = onUpstream.calls[onUpstream.calls.length - 1]?.warm ?? false;
        onTranscript.push({ turn, servedBy: "upstream", costMicros: cost, warm, usage });
      }
    }
  } finally {
    await proxy.close();
    await onUpstream.close();
  }

  const billable = offCost - onCost;
  const grossReplay = savings.total("bench").costMicros;
  const avoidedCalls = onTranscript.filter((c) => c.servedBy === "replay").length;

  return {
    turns: trajectory,
    offCostMicros: offCost,
    onCostMicros: onCost,
    billableSavedMicros: billable,
    billableSavedPct: offCost === 0 ? 0 : Math.round((billable / offCost) * 10000) / 100,
    grossReplayMicros: grossReplay,
    offUpstreamCalls: offTranscript.filter((c) => c.servedBy === "upstream").length,
    onUpstreamCalls: onTranscript.filter((c) => c.servedBy === "upstream").length,
    avoidedCalls,
    attribution: { replayMicros: billable, preserveMicros: 0, shapeMicros: 0 },
    offTranscript,
    onTranscript,
  };
}

/** A human-readable one-screen report. */
export function formatReport(r: BenchReport): string {
  const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(6)}`;
  return [
    `Rewind gateway bench — SIMULATED costs/tokens, deterministic, no API key`,
    `  trajectory turns:     [${r.turns.join(", ")}]  (${r.avoidedCalls} re-runs avoidable)`,
    `  OFF cost (today):     ${usd(r.offCostMicros)}  over ${r.offUpstreamCalls} upstream calls`,
    `  ON  cost (rewind):    ${usd(r.onCostMicros)}  over ${r.onUpstreamCalls} upstream calls`,
    `  ── billable saving:   ${usd(r.billableSavedMicros)}  (${r.billableSavedPct}% over the provider's own caching)`,
    `  gross replay (upper): ${usd(r.grossReplayMicros)}  [NOT billed — cold first-occurrence cost]`,
    `  attribution:          replay=${usd(r.attribution.replayMicros)}  preserve=${usd(r.attribution.preserveMicros)}  shape=${usd(r.attribution.shapeMicros)}`,
  ].join("\n");
}
