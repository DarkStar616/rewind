import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRewindMcpServer } from "../src/server.ts";

/**
 * The acceptance bar for the accuracy engine: the failure memory must survive across SEPARATE agent
 * sessions/processes over the same workspace, or a re-attempt in a new session would repeat the same
 * mistake. This drives two independent server lifecycles against one `.rewind/` on disk.
 */

async function session<T>(cwd: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const server = createRewindMcpServer({ cwd, log: () => {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function structured(res: unknown): Record<string, unknown> {
  return (res as { structuredContent: Record<string, unknown> }).structuredContent;
}

test("failure memory survives across separate sessions: a new session sees the prior failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-loop-"));
  try {
    await writeFile(join(dir, "a.txt"), "v1");

    // --- Session 1: checkpoint, a failed attempt, backtrack with a lesson. Then the session ends. ---
    const checkpointId = await session(dir, async (client) => {
      const cp = structured(await client.callTool({ name: "checkpoint", arguments: { label: "start" } }));
      const id = cp.id as string;
      execFileSync("bash", ["-c", "echo broken > a.txt"], { cwd: dir });
      await client.callTool({
        name: "backtrack_commit",
        arguments: { checkpointId: id, note: "session-1: tried the naive fix, tests failed" },
      });
      return id;
    });

    // The workspace was rewound at the end of session 1.
    assert.equal(execFileSync("bash", ["-c", "cat a.txt"], { cwd: dir }).toString().trim(), "v1");

    // --- Session 2: a FRESH server/process over the same workspace must see session 1's failure. ---
    await session(dir, async (client) => {
      const cand = structured(await client.callTool({ name: "backtrack_candidates", arguments: {} }));
      const candidates = cand.candidates as { checkpointId: string; priorFailures: { note: string }[] }[];
      const forCheckpoint = candidates.find((c) => c.checkpointId === checkpointId);
      assert.ok(forCheckpoint, "the checkpoint from session 1 is still a candidate");
      assert.deepEqual(
        forCheckpoint.priorFailures.map((f) => f.note),
        ["session-1: tried the naive fix, tests failed"],
        "session 2 inherits session 1's failure memory — the accuracy mechanism persists across processes",
      );
      // And a second backtrack in session 2 accumulates on top of session 1's memory.
      execFileSync("bash", ["-c", "echo broken-again > a.txt"], { cwd: dir });
      const commit = structured(
        await client.callTool({
          name: "backtrack_commit",
          arguments: { checkpointId, note: "session-2: tried the other fix, also failed" },
        }),
      );
      assert.deepEqual(
        (commit.carriedMemory as { note: string }[]).map((m) => m.note),
        ["session-1: tried the naive fix, tests failed", "session-2: tried the other fix, also failed"],
        "carried memory accumulates across sessions",
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
