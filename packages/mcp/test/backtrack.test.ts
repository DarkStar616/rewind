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
 * The recovery tools: backtrack_candidates lists where you can selectively rewind to (with the failure
 * memory tied to each), and backtrack_commit rewinds the world AND carries the failure forward — but
 * only with a non-empty note (the discipline that makes the re-attempt smarter).
 */

async function connect(cwd: string): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createRewindMcpServer({ cwd, log: () => {} });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
}

test("backtrack_commit REQUIRES a note — an empty note is refused and does NOT rewind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-bt-"));
  try {
    await writeFile(join(dir, "a.txt"), "v1");
    const { client, close } = await connect(dir);
    try {
      const cp = await call(client, "checkpoint", { label: "start" });
      const id = (cp.structuredContent as { id: string }).id;
      execFileSync("bash", ["-c", "echo v2 > a.txt"], { cwd: dir });

      // Empty note must be rejected by the schema (min length 1).
      const res = await call(client, "backtrack_commit", { checkpointId: id, note: "" });
      assert.equal(res.isError, true, "an empty note must be refused");
      // The world must NOT have been rewound.
      const content = execFileSync("bash", ["-c", "cat a.txt"], { cwd: dir }).toString().trim();
      assert.equal(content, "v2", "a refused backtrack must not touch the workspace");
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backtrack_commit with a note rewinds the world and carries the failure memory forward", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-bt-"));
  try {
    await writeFile(join(dir, "a.txt"), "v1");
    const { client, close } = await connect(dir);
    try {
      const cp = await call(client, "checkpoint", { label: "start" });
      const id = (cp.structuredContent as { id: string }).id;

      // Attempt 1 fails → backtrack to start with a lesson.
      execFileSync("bash", ["-c", "echo bad-attempt-1 > a.txt"], { cwd: dir });
      const c1 = await call(client, "backtrack_commit", { checkpointId: id, note: "tried X, broke the build", goal: "fix bug" });
      const s1 = c1.structuredContent as { rewoundTo: string; carriedMemory: { note: string }[] };
      assert.equal(s1.rewoundTo, id);
      assert.equal(execFileSync("bash", ["-c", "cat a.txt"], { cwd: dir }).toString().trim(), "v1", "world rewound");
      assert.equal(s1.carriedMemory.length, 1);
      assert.equal(s1.carriedMemory[0].note, "tried X, broke the build");

      // Attempt 2 also fails → backtrack again; memory now ACCUMULATES both lessons.
      execFileSync("bash", ["-c", "echo bad-attempt-2 > a.txt"], { cwd: dir });
      const c2 = await call(client, "backtrack_commit", { checkpointId: id, note: "tried Y, also failed" });
      const s2 = c2.structuredContent as { carriedMemory: { note: string }[] };
      assert.deepEqual(
        s2.carriedMemory.map((m) => m.note),
        ["tried X, broke the build", "tried Y, also failed"],
        "the re-attempt sees ALL prior failures from this checkpoint",
      );
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a whitespace-only note is refused and does NOT rewind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-bt-"));
  try {
    await writeFile(join(dir, "a.txt"), "v1");
    const { client, close } = await connect(dir);
    try {
      const id = (((await call(client, "checkpoint", { label: "s" })).structuredContent) as { id: string }).id;
      execFileSync("bash", ["-c", "echo v2 > a.txt"], { cwd: dir });
      const res = await call(client, "backtrack_commit", { checkpointId: id, note: "   " });
      assert.equal(res.isError, true, "a whitespace-only note is not a lesson");
      assert.equal(execFileSync("bash", ["-c", "cat a.txt"], { cwd: dir }).toString().trim(), "v2", "no rewind");
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an unknown checkpoint id is refused and records NO note (no memory pollution)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-bt-"));
  try {
    await writeFile(join(dir, "a.txt"), "v1");
    const { client, close } = await connect(dir);
    try {
      await call(client, "checkpoint", { label: "s" });
      const bad = await call(client, "backtrack_commit", { checkpointId: "deadbeef", note: "lesson" });
      assert.equal(bad.isError, true, "unknown checkpoint is refused");
      // No candidate should carry a failure note tied to the bogus id.
      const cand = await call(client, "backtrack_candidates", {});
      const cands = (cand.structuredContent as { candidates: { priorFailures: unknown[] }[] }).candidates;
      assert.equal(cands.every((c) => c.priorFailures.length === 0), true, "no note recorded for a bad id");
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("retrying an IDENTICAL backtrack_commit does not duplicate the failure memory (idempotent)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-bt-"));
  try {
    await writeFile(join(dir, "a.txt"), "v1");
    const { client, close } = await connect(dir);
    try {
      const id = (((await call(client, "checkpoint", { label: "s" })).structuredContent) as { id: string }).id;
      execFileSync("bash", ["-c", "echo v2 > a.txt"], { cwd: dir });
      const first = await call(client, "backtrack_commit", { checkpointId: id, note: "same lesson" });
      execFileSync("bash", ["-c", "echo v3 > a.txt"], { cwd: dir });
      const retry = await call(client, "backtrack_commit", { checkpointId: id, note: "same lesson" });
      const mem = (retry.structuredContent as { carriedMemory: { note: string }[] }).carriedMemory;
      assert.deepEqual(mem.map((m) => m.note), ["same lesson"], "an identical retry is not double-counted");
      void first;
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("backtrack_candidates lists checkpoints newest-first and recommends the failing one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-bt-"));
  try {
    await writeFile(join(dir, "a.txt"), "v1");
    const { client, close } = await connect(dir);
    try {
      const a = (((await call(client, "checkpoint", { label: "A" })).structuredContent) as { id: string }).id;
      execFileSync("bash", ["-c", "echo v2 > a.txt"], { cwd: dir });
      const b = (((await call(client, "checkpoint", { label: "B" })).structuredContent) as { id: string }).id;

      // Record a failure against B by backtracking to it.
      execFileSync("bash", ["-c", "echo v3 > a.txt"], { cwd: dir });
      await call(client, "backtrack_commit", { checkpointId: b, note: "B branch failed" });

      const cand = await call(client, "backtrack_candidates", {});
      const s = cand.structuredContent as {
        candidates: { checkpointId: string; priorFailures: unknown[] }[];
        recommended?: string;
      };
      // Newest first: B (newer) before A.
      assert.equal(s.candidates[0].checkpointId, b);
      assert.equal(s.candidates[1].checkpointId, a);
      // Recommendation is the newest checkpoint (B) — minimal loss — and it carries B's failure memory.
      assert.equal(s.recommended, b);
      assert.equal(s.candidates[0].priorFailures.length, 1);
      assert.equal(s.candidates[1].priorFailures.length, 0);
    } finally {
      await close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
