import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMemoryReplaySavings } from "@rewind/core";
import type { ReplaySavingsSink } from "@rewind/core";
import {
  buildSavingsReceipt,
  estimateCostMicros,
  formatReceiptLine,
  upsellLine,
  DEFAULT_UPSELL_THRESHOLD_TOKENS,
  type SavingsReceipt,
} from "../src/savings.ts";
import { createRewindMcpServer } from "../src/server.ts";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/**
 * A "session" here is a savings sink holding whatever ReplaySaving records the run genuinely
 * produced. The honest-metering bar: the receipt reports ONLY what was recorded as provably-avoided
 * re-spend (deduped by the recorded call identity), never a projection of the whole run.
 */
function sessionWithNoReplay(): ReplaySavingsSink {
  return createMemoryReplaySavings(); // nothing recorded -> nothing was avoided
}
function sessionWithOneReplayOf(hit: { tokens: number; callId: string; costMicros?: number }): ReplaySavingsSink {
  const sink = createMemoryReplaySavings();
  const rec = {
    scope: "s",
    tokensAvoided: hit.tokens,
    costMicros: hit.costMicros ?? hit.tokens * 3,
    model: "m",
    callId: hit.callId,
  };
  sink.record(rec);
  sink.record(rec); // an overlapping rewind re-reports the SAME call -> must not double-count
  return sink;
}
function runSavings(sink: ReplaySavingsSink, opts: { scope?: string; window?: string } = {}): SavingsReceipt {
  return buildSavingsReceipt(sink.total(opts.scope), { window: opts.window });
}

// ── the acceptance bar (docs/SAVINGS-RECEIPT.md) ──────────────────────────────────────────────────

test("savings reports 0 when no re-spend was avoided", () => {
  const out = runSavings(sessionWithNoReplay());
  assert.equal(out.tokensSaved, 0); // MUST fail on any 'credit the whole run' implementation
  assert.equal(out.costSaved, 0);
  assert.equal(out.breakdown.replayHits, 0);
  assert.equal(out.breakdown.rewindAvoided, 0);
});

test("savings equals the summed ReplaySaving records and never double-counts overlapping rewinds", () => {
  const out = runSavings(sessionWithOneReplayOf({ tokens: 1200, callId: "c1" }));
  assert.equal(out.tokensSaved, 1200);
});

test("reconciliation: tokensSaved equals the sink total and equals replayHits + rewindAvoided", () => {
  const sink = createMemoryReplaySavings();
  sink.record({ scope: "s", tokensAvoided: 500, costMicros: 1500, model: "m", callId: "a" });
  sink.record({ scope: "s", tokensAvoided: 700, costMicros: 2100, model: "m", callId: "b" });
  const out = runSavings(sink);
  assert.equal(out.tokensSaved, sink.total().tokens);
  assert.equal(out.breakdown.replayHits + out.breakdown.rewindAvoided, out.tokensSaved);
  assert.equal(out.costSaved, 3600 / 1_000_000); // summed recorded micros -> dollars, no float rounding
  assert.equal(out.currency, "USD");
  assert.equal(out.estimate, true);
});

test("scope filter narrows the receipt to one scope", () => {
  const sink = createMemoryReplaySavings();
  sink.record({ scope: "s", tokensAvoided: 100, costMicros: 300, model: "m", callId: "a" });
  sink.record({ scope: "t", tokensAvoided: 900, costMicros: 2700, model: "m", callId: "b" });
  assert.equal(runSavings(sink, { scope: "s" }).tokensSaved, 100);
  assert.equal(runSavings(sink).tokensSaved, 1000);
});

// ── the shipped rate table is an ESTIMATE, and overridable ────────────────────────────────────────

test("the per-model rate table prices tokens as an overridable estimate", () => {
  assert.equal(estimateCostMicros("claude-x", 1000, { "claude-x": { microsPerToken: 5 } }), 5000);
  // an unknown model falls back to the table's default rate, never throws
  assert.equal(typeof estimateCostMicros("no-such-model", 1000), "number");
});

// ── the shareable human line + the single upsell ask ──────────────────────────────────────────────

test("the human line reads as the shareable receipt", () => {
  const line = formatReceiptLine({
    tokensSaved: 4_200_000,
    costSaved: 63,
    currency: "USD",
    window: "week",
    breakdown: { replayHits: 4_200_000, rewindAvoided: 0 },
    estimate: true,
  });
  assert.match(line, /Rewind recovered 4\.2M tokens this week \(~\$63 saved\)\./);
});

test("the upsell line appears only once cumulative savings cross the threshold", () => {
  assert.equal(upsellLine(DEFAULT_UPSELL_THRESHOLD_TOKENS - 1), null);
  const line = upsellLine(DEFAULT_UPSELL_THRESHOLD_TOKENS);
  assert.ok(line && /See your whole team's savings/.test(line));
  assert.ok(line && /total/.test(line));
});

// ── the two adapters read the SAME receipt (one engine, thin adapters) ────────────────────────────

test("MCP savings tool returns the honest receipt shape and reports 0 in a fresh workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-savings-mcp-"));
  try {
    await writeFile(join(dir, "a.txt"), "original");
    const server = createRewindMcpServer({ cwd: dir, log: () => {} });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "savings-test", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some((t) => t.name === "savings"), "the savings tool must be registered");
      const res = await client.callTool({ name: "savings", arguments: { since: "week" } });
      const r = res.structuredContent as SavingsReceipt;
      assert.equal(r.tokensSaved, 0); // fresh workspace: nothing avoided -> honest 0
      assert.equal(r.costSaved, 0);
      assert.equal(r.currency, "USD");
      assert.equal(r.window, "week");
      assert.deepEqual(r.breakdown, { replayHits: 0, rewindAvoided: 0 });
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI `rewind savings --json` prints the honest receipt; the human line names the window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-savings-cli-"));
  try {
    const asJson = spawnSync(process.execPath, [CLI, "savings", "--json"], { cwd: dir, encoding: "utf8" });
    assert.equal(asJson.status, 0, `savings --json should exit 0; stderr=${asJson.stderr}`);
    const r = JSON.parse(asJson.stdout.trim()) as SavingsReceipt;
    assert.equal(r.tokensSaved, 0);
    assert.deepEqual(r.breakdown, { replayHits: 0, rewindAvoided: 0 });

    const human = spawnSync(process.execPath, [CLI, "savings", "--since", "week"], { cwd: dir, encoding: "utf8" });
    assert.equal(human.status, 0, `savings should exit 0; stderr=${human.stderr}`);
    assert.match(human.stdout, /Rewind recovered 0 tokens this week/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
