import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRewindMcpServer } from "../src/server.ts";
import { parseMcpProfile } from "../src/mcp-profile.ts";

test("MCP profiles expose only their advertised tools and lean stays under 1000 approximate tokens", async (t) => {
  const expected = {
    lean: ["checkpoint", "guard_effect", "rewind"],
    analytics: ["savings"],
    recovery: ["backtrack_candidates", "backtrack_commit", "checkpoint", "guard_effect", "list", "replay", "rewind"],
    all: ["backtrack_candidates", "backtrack_commit", "checkpoint", "guard_effect", "list", "replay", "rewind", "savings"],
  };
  for (const profile of Object.keys(expected) as Array<keyof typeof expected>) {
    const cwd = await mkdtemp(join(tmpdir(), "rewind-profile-"));
    const server = createRewindMcpServer({ cwd, profile, log: () => {} });
    const client = new Client({ name: "profile-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(b), client.connect(a)]);
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((tool) => tool.name).sort(), expected[profile]);
      const instructions = client.getInstructions()!;
      assert.match(instructions, /reversibility.*not.*isolation.*security/i);
      const approximateTokens = Math.ceil((JSON.stringify(tools).length + instructions.length) / 4);
      t.diagnostic(`${profile}: ${approximateTokens} approximate initialization tokens (characters / 4)`);
      if (profile === "lean") {
        assert.ok(approximateTokens <= 1000, `lean initialization uses ${approximateTokens} approximate tokens`);
        const hidden = await client.callTool({ name: "savings", arguments: {} });
        assert.equal(hidden.isError, true);
      }
    } finally { await client.close(); await server.close(); await rm(cwd, { recursive: true, force: true }); }
  }
});

test("invalid MCP profile refuses startup", () => {
  assert.throws(() => createRewindMcpServer({ cwd: "/tmp", profile: "max" as never }), /profile/);
});

test("MCP CLI profile overrides environment and rejects typos or duplicates", () => {
  assert.equal(parseMcpProfile([], {}), "all");
  assert.equal(parseMcpProfile([], { REWIND_MCP_PROFILE: "lean" }), "lean");
  assert.equal(parseMcpProfile(["--profile", "analytics"], { REWIND_MCP_PROFILE: "lean" }), "analytics");
  assert.equal(parseMcpProfile(["--profile=recovery"], {}), "recovery");
  for (const args of [["--profile"], ["--profile="], ["--profile", "max"], ["--profle", "lean"], ["--profile", "lean", "--profile", "all"]]) {
    assert.throws(() => parseMcpProfile(args, {}), /profile|usage/);
  }
});
