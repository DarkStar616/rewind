/**
 * End-to-end verification over the REAL MCP wire (Task M2 — the honesty gate).
 *
 * `server.test.ts` drives the server through an in-process linked transport pair — fast and
 * deterministic, but it never crosses a process boundary, so it cannot prove the SHIPPED artifact
 * (`packages/mcp/dist/cli.js`, the `agent-rewind` bin) actually speaks JSON-RPC over stdio. This
 * suite closes that gap: it BUILDS the distribution bundle, spawns `node dist/cli.js mcp` as a real
 * child process, and speaks the genuine MCP stdio protocol to it (initialize handshake → tools/list
 * → tool calls with framed JSON-RPC over the pipe). The child runs WITHOUT the `development` export
 * condition, so `@agent-rewind/{core,gateway}` resolve to their built `dist/`, exactly as an
 * end-user's `npx @agent-rewind/mcp` would — this is the `docs/PLAN.md` Slice-1 success demo,
 * executed through the real MCP wire rather than an in-process shim.
 *
 * The demo it proves end to end: checkpoint → on-disk edit → guard a fresh effect (admitted) →
 * rewind → re-guard the SAME effect (REFUSED with a structured deny-reason) → the refusal is on the
 * tamper-evident chain and the chain still verifies. The chain check reads the durable
 * `.rewind/evidence.json` the child wrote and re-verifies it with core's own `verifyChain` — the
 * barrier/chain never touch the filesystem to decide; this test only reads what they persisted.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { execPath } from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EFFECT_EMITTED, EFFECT_REPLAY_REFUSED } from "@agent-rewind/core";
import { createFileEvidenceLedger } from "../src/store.ts";

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, "..", "..", "..");
const SERVER_BIN = join(REPO_ROOT, "packages", "mcp", "dist", "cli.js");

// The spawned server is the BUILT bin; `dist/` is git-ignored, so build the workspaces before the
// suite runs. This also guarantees the child reflects the CURRENT source every time (`npm run check`
// does not build), closing the stale-artifact hazard rather than trusting a dist someone left behind.
before(() => {
  execFileSync("npm", ["run", "build"], { cwd: REPO_ROOT, stdio: "ignore" });
}, { timeout: 120_000 });

/** Spawn the built server for `cwd` and connect a real MCP client over stdio. */
async function connectStdio(cwd: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: execPath, // the same node running the test — not a PATH lookup
    args: [SERVER_BIN, "mcp"],
    cwd, // the server snapshots/guards its process cwd; point it at the temp workspace
    stderr: "ignore",
  });
  const client = new Client({ name: "rewind-e2e-client", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
    },
  };
}

let dir: string;
after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("stdio e2e: initialize → tools/list surfaces the eight tools", { timeout: 60_000 }, async () => {
  dir = await mkdtemp(join(tmpdir(), "rewind-e2e-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  await writeFile(join(dir, "a.txt"), "original");
  const { client, close } = await connectStdio(dir);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "backtrack_candidates",
      "backtrack_commit",
      "checkpoint",
      "guard_effect",
      "list",
      "replay",
      "rewind",
      "savings",
    ]);
  } finally {
    await close();
  }
});

test(
  "stdio e2e: checkpoint → edit → guard(admit) → rewind → guard(REFUSED) → chain verifies",
  { timeout: 60_000 },
  async () => {
    const workspace = await mkdtemp(join(tmpdir(), "rewind-e2e-"));
    execFileSync("git", ["init", "-q"], { cwd: workspace });
    await writeFile(join(workspace, "a.txt"), "original");
    const { client, close } = await connectStdio(workspace);
    const scopeLabel = "s";
    const descriptor = { effectKey: "charge:42", scopeLabel, kind: "http" };
    try {
      // 1) checkpoint mints a durable handle over the real wire.
      const cp = await client.callTool({ name: "checkpoint", arguments: { label: "before" } });
      const snap = cp.structuredContent as { id: string; ts: number };
      assert.match(snap.id, /^[0-9a-f]{7,64}$/i, "checkpoint must mint a snapshot id");

      // 2) a fresh external effect is admitted (spent) and recorded on the chain.
      const g1 = await client.callTool({ name: "guard_effect", arguments: { descriptor } });
      const g1out = g1.structuredContent as { decision: string; chainHash: string };
      assert.equal(g1out.decision, "admitted", "the first emit of a fresh key is admitted");
      assert.match(g1out.chainHash, /^[0-9a-f]{64}$/, "guard reports the tamper-evident chain head");

      // 3) mutate the workspace on disk (a real edit), then rewind the whole tree over the wire.
      execFileSync("bash", ["-c", "echo mutated > a.txt"], { cwd: workspace });
      assert.equal(await readFile(join(workspace, "a.txt"), "utf8"), "mutated\n");

      const rw = await client.callTool({ name: "rewind", arguments: { id: snap.id } });
      const rwOut = rw.structuredContent as {
        revertedTo: string;
        refusedEffects: { effectKey: string }[];
      };
      assert.equal(rwOut.revertedTo, snap.id);
      assert.equal(
        await readFile(join(workspace, "a.txt"), "utf8"),
        "original",
        "rewind must restore the tree over the real MCP wire",
      );
      assert.ok(
        rwOut.refusedEffects.some((e) => e.effectKey === "charge:42"),
        "the spent effect must surface as refusable-on-replay (read from the chain, not the FS)",
      );

      // 4) re-firing the SAME effect across the rewind is REFUSED with a structured deny-reason.
      const g2 = await client.callTool({ name: "guard_effect", arguments: { descriptor } });
      const g2out = g2.structuredContent as {
        decision: string;
        reason: string;
        firstEmittedSeq?: number;
        chainHash: string;
      };
      assert.equal(g2out.decision, "refused", "a spent effect re-fired across a rewind is refused");
      assert.equal(g2out.firstEmittedSeq, 0, "the refusal cites the original emit's seq");
      assert.ok(g2out.reason.length > 0, "the refusal carries a structured, agent-actionable reason");
      assert.match(g2out.chainHash, /^[0-9a-f]{64}$/);
    } finally {
      await close();
    }

    // 5) the refusal is on the tamper-evident chain the child persisted, and the chain still verifies.
    //    We re-open the durable ledger the server wrote and re-verify it with core's own verifier —
    //    the barrier/chain decided from the effect log alone; this only reads what they committed.
    const ledger = createFileEvidenceLedger({
      path: join(workspace, ".rewind", "evidence.json"),
      vocabulary: [EFFECT_EMITTED, EFFECT_REPLAY_REFUSED],
    });
    const verdict = await ledger.verify(scopeLabel);
    assert.equal(verdict.ok, true, "the persisted evidence chain must verify");
    assert.ok(verdict.length >= 2, "chain has the emit and the refusal");
    const refusals = await ledger.list({ scopeLabel, action: EFFECT_REPLAY_REFUSED });
    assert.ok(refusals.length >= 1, "the refusal is recorded on the chain");

    await rm(workspace, { recursive: true, force: true });
  },
);
