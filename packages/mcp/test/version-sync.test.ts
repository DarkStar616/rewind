import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRewindMcpServer } from "../src/server.ts";

/**
 * Version-sync guard (codex round 11). Bumping the published package to a new version silently left the
 * MCP server identity AND the bundled Claude plugin manifest behind at the old version, so after
 * installing 1.0.0 the server still introduced itself as 0.1.3. `server.ts` now DERIVES its version from
 * package.json (can't drift), so the only hand-maintained copy left is the plugin manifest — this test
 * pins BOTH: the manifest against package.json, and the running server's advertised version against it.
 */
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const plugin = JSON.parse(
  readFileSync(new URL("../dist-plugin/.claude-plugin/plugin.json", import.meta.url), "utf8"),
) as { version: string };

test("the bundled Claude plugin manifest version matches the package version", () => {
  assert.equal(plugin.version, pkg.version, "dist-plugin/.claude-plugin/plugin.json must track the package version");
});

test("the running MCP server advertises the package version (derived, never hard-coded)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-ver-"));
  try {
    const server = createRewindMcpServer({ cwd: dir, log: () => {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "ver-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      assert.equal(
        client.getServerVersion()?.version,
        pkg.version,
        "the server identity must report exactly the published package version",
      );
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
