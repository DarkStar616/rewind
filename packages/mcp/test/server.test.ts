import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRewindMcpServer } from "../src/server.ts";

/**
 * Stand up the real @agent-rewind/mcp server for `cwd` and connect a real MCP client to it over an
 * in-process linked transport pair. This exercises the genuine JSON-RPC client<->server protocol
 * (initialize handshake, tool list, tool calls, structured output validation) without spawning a
 * process, so the test is deterministic and fast while still driving the actual SDK surface.
 */
async function connect(cwd: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createRewindMcpServer({ cwd, log: () => {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "rewind-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("MCP server hands the agent a workflow via server instructions (self-explaining)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-mcp-"));
  try {
    const { client, close } = await connect(dir);
    try {
      const instr = client.getInstructions() ?? "";
      // The connecting agent must be told the workflow up front, not left to reverse-engineer it.
      assert.ok(instr.length > 0, "the server must provide instructions to the client");
      assert.match(instr, /checkpoint/i, "instructions name the checkpoint step");
      assert.match(instr, /rewind/i, "instructions name the rewind step");
      assert.match(instr, /guard_effect/i, "instructions name the effect guard");
      assert.match(instr, /reversibility.*not.*(isolation|security)/is, "instructions carry the Tier-0 honesty line");
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP server exposes the five MVP tools plus the Slice 1.5 savings receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-mcp-"));
  try {
    await writeFile(join(dir, "a.txt"), "original");
    const { client, close } = await connect(dir);
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
      // The honesty line (Tier-0 = reversibility, not isolation) must ride on the tool descriptions.
      const rewindTool = tools.find((t) => t.name === "rewind");
      assert.ok(rewindTool?.description && /reversibility/i.test(rewindTool.description));
      assert.ok(rewindTool?.description && /not.*(isolation|security)/i.test(rewindTool.description));
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("MCP server: checkpoint → guard admitted → bash edit → rewind → guard REFUSED across the rewind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-mcp-"));
  try {
    await writeFile(join(dir, "a.txt"), "original");
    const { client, close } = await connect(dir);
    try {
      // 1) checkpoint mints a durable handle (the snapshot id) and hands it back.
      const cp = await client.callTool({ name: "checkpoint", arguments: { label: "before" } });
      const snap = cp.structuredContent as { id: string; ts: number };
      assert.match(snap.id, /^[0-9a-f]{7,64}$/i, "checkpoint must mint a snapshot id");

      // 2) an external effect — admitted the first time, recorded on the chain.
      const descriptor = { effectKey: "charge:42", scopeLabel: "s", kind: "http" };
      const g1 = await client.callTool({ name: "guard_effect", arguments: { descriptor } });
      const g1out = g1.structuredContent as { decision: string; chainHash: string };
      assert.equal(g1out.decision, "admitted");
      assert.match(g1out.chainHash, /^[0-9a-f]{64}$/, "guard reports the tamper-evident chain head");

      // 3) mutate the workspace via a real shell command, then rewind the whole tree to the checkpoint.
      execFileSync("bash", ["-c", "echo mutated > a.txt"], { cwd: dir });
      assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "mutated\n");

      const rw = await client.callTool({ name: "rewind", arguments: { id: snap.id } });
      const rwOut = rw.structuredContent as { revertedTo: string; refusedEffects: { effectKey: string }[] };
      assert.equal(rwOut.revertedTo, snap.id);
      assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "original", "rewind must restore the tree");
      assert.ok(
        rwOut.refusedEffects.some((e) => e.effectKey === "charge:42"),
        "the spent effect must be surfaced as refusable-on-replay (read from the chain, not the FS)",
      );

      // 4) re-firing the same effect ACROSS the rewind is refused and recorded, citing the first emit.
      const g2 = await client.callTool({ name: "guard_effect", arguments: { descriptor } });
      const g2out = g2.structuredContent as { decision: string; firstEmittedSeq?: number; chainHash: string };
      assert.equal(g2out.decision, "refused");
      assert.equal(g2out.firstEmittedSeq, 0, "the refusal must cite the original emit's seq");
      assert.match(g2out.chainHash, /^[0-9a-f]{64}$/);

      // 5) the checkpoint is listed by the server, keyed by the handle it minted.
      const listed = await client.callTool({ name: "list", arguments: {} });
      const checkpoints = (listed.structuredContent as { checkpoints: { id: string; effects: number }[] }).checkpoints;
      assert.ok(checkpoints.some((c) => c.id === snap.id), "list must include the checkpoint");
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
