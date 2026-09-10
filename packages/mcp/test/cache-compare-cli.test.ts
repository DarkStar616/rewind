import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, access } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("cache-compare explains prefix changes without emitting prompts or creating workspace state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-prefix-cli-"));
  const before = join(dir, "before request.json"), after = join(dir, "after request.json");
  const run = (...args: string[]) => spawnSync(process.execPath, [cli, "cache-compare", ...args], { cwd: dir, encoding: "utf8" });
  try {
    const body = { model: "m", messages: [{ role: "user", content: "private prompt" }] };
    await writeFile(before, JSON.stringify(body));
    await writeFile(after, JSON.stringify({ ...body, messages: [...body.messages, { role: "assistant", content: "private result" }] }));
    const result = run(before, after);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.relation, "message-append");
    assert.equal(report.stableMessages, 1);
    assert.equal(report.providerCacheHit, "unknown");
    assert.equal(typeof report.recommendation, "string");
    assert.ok(result.stdout.length < 1000);
    assert.ok(!result.stdout.includes("private"));
    await assert.rejects(access(join(dir, ".rewind")));
    await writeFile(after, "private invalid JSON");
    const bad = run(before, after);
    assert.equal(bad.status, 1);
    assert.ok(!bad.stderr.includes("private"));
    await writeFile(after, '"' + "x".repeat(2 * 1024 * 1024) + '"');
    assert.equal(run(before, after).status, 1);
    assert.equal(run(before).status, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
