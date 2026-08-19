/**
 * LIVE token-savings bench against a real OpenAI-compatible provider (Nebius AI Studio).
 *
 * This is the real-traffic counterpart to the deterministic bench.ts: it makes REAL API calls, reads
 * the PROVIDER'S OWN token counts, and applies the REAL replay key (canonicalizeRequest) to decide
 * which re-runs are served from record. It measures the exact savings mechanism the gateway ships.
 *
 * Scenario (mirrors Benchmark B): a 10-step task fails at step K, the agent rewinds to the start and
 * re-runs 1..K, then finishes K+1..10. OFF pays for every call; ON replays the byte-identical re-runs
 * at zero upstream cost. We report the curve for an early / mid / late failure (K = 2 / 5 / 8).
 *
 * Cost control: each of the 10 distinct turns is priced ONCE from a real call (temperature 0 →
 * deterministic), then reused — so the whole run is ~10 small calls (pennies).
 *
 * Run (never commit your key):
 *   NEBIUS_API_KEY=... NODE_OPTIONS=--conditions=development \
 *     node packages/gateway/bench/live-nebius.ts
 * Optional: NEBIUS_MODEL (default below), NEBIUS_BASE, NEBIUS_IN / NEBIUS_OUT (micro-USD per MTok).
 */
import { canonicalizeRequest } from "../src/canonical-request.ts";
import { extractUsage } from "../src/usage.ts";
import { avoidedCostMicros, totalUsageTokens, type PriceTable } from "../src/meter.ts";

const KEY = process.env.NEBIUS_API_KEY;
const BASE = (process.env.NEBIUS_BASE ?? "https://api.studio.nebius.com/v1").replace(/\/$/, "");
const MODEL = process.env.NEBIUS_MODEL ?? "meta-llama/Meta-Llama-3.1-8B-Instruct";
const N = 10;

if (!KEY) {
  console.error("Set NEBIUS_API_KEY (do not paste it anywhere it gets committed).");
  process.exit(2);
}

// Representative Nebius pricing (micro-USD per 1e6 tokens). Only affects the input/output weighting of
// the % and the $ figure; override with NEBIUS_IN / NEBIUS_OUT for the exact model's contract rates.
const PRICES: PriceTable = {
  version: "nebius-live",
  currency: "USD",
  rates: {
    default: {
      input: Number(process.env.NEBIUS_IN ?? 20_000),
      output: Number(process.env.NEBIUS_OUT ?? 60_000),
      cacheWrite: 0,
      cacheRead: 0,
    },
  },
};

/** Deterministic, re-runnable request for conversation turn t (prior assistant turns are fixed). */
function turnBody(t: number): Record<string, unknown> {
  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: "You are a terse assistant. Reply in one short sentence." },
  ];
  for (let i = 1; i <= t; i++) {
    messages.push({ role: "user", content: `Step ${i}: give one concise fact about the number ${i}.` });
    if (i < t) messages.push({ role: "assistant", content: `Fact ${i}: noted.` });
  }
  return { model: MODEL, max_tokens: 48, temperature: 0, messages };
}

async function callProvider(body: Record<string, unknown>): Promise<{ costMicros: number; tokens: number }> {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`provider ${res.status}: ${text.slice(0, 300)}`);
  const { usage, model } = extractUsage(text, res.headers.get("content-type") ?? "application/json");
  return { costMicros: avoidedCostMicros(usage, model ?? MODEL, PRICES), tokens: totalUsageTokens(usage) };
}

/** "Interrupt at step K": forward 1..K, rewind to start, re-run 1..K, continue K+1..N. */
function trajectory(K: number): number[] {
  const t: number[] = [];
  for (let i = 1; i <= K; i++) t.push(i); // forward to the failure
  for (let i = 1; i <= K; i++) t.push(i); // rewind → re-run
  for (let i = K + 1; i <= N; i++) t.push(i); // finish
  return t;
}

async function main(): Promise<void> {
  console.log(`LIVE bench — provider=${BASE} model=${MODEL}`);
  console.log("pricing each of the 10 turns once (real calls)…");
  const cost: Record<number, number> = {};
  const key: Record<number, string> = {};
  let priced = 0;
  for (let t = 1; t <= N; t++) {
    const body = turnBody(t);
    key[t] = canonicalizeRequest(body);
    const r = await callProvider(body);
    cost[t] = r.costMicros;
    priced += r.tokens;
  }
  console.log(`priced ${N} turns (${priced} real provider tokens total)\n`);
  console.log("interrupt  LIVE saving   OFF $        ON $         calls replayed");
  for (const K of [2, 5, 8]) {
    const traj = trajectory(K);
    const off = traj.reduce((s, t) => s + cost[t], 0);
    const seen = new Set<string>();
    let on = 0;
    let replays = 0;
    for (const t of traj) {
      if (seen.has(key[t])) { replays += 1; continue; } // byte-identical → replayed, 0 upstream
      seen.add(key[t]);
      on += cost[t];
    }
    const pct = off === 0 ? 0 : Math.round(((off - on) / off) * 10000) / 100;
    const usd = (m: number) => `$${(m / 1_000_000).toFixed(6)}`;
    console.log(
      `step ${String(K).padStart(2)}/10   ${String(pct).padStart(6)}%   ${usd(off).padEnd(11)} ${usd(on).padEnd(11)} ${replays}/${traj.length}`,
    );
  }
  console.log("\n(byte-identical re-runs served from record = 0 upstream cost; measured on the provider's own token counts.)");
}

main().catch((e) => {
  console.error(`bench failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
