import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("REWIND_")));
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

for (const variant of [
  { name: "activation", flags: ["--preserve-cache", "--prune-context"], active: true },
  { name: "compatibility", flags: [], active: false },
  { name: "kill switches", flags: ["--profile", "lean", "--no-preserve-cache", "--no-prune-context"], active: false },
]) test(`gateway CLI ${variant.name}: upstream bytes and active manifest`, { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-gateway-cli-"));
  let received: any;
  let receivedRaw = "";
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    receivedRaw = Buffer.concat(chunks).toString();
    received = JSON.parse(receivedRaw);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ type: "message", model: "claude-sonnet-4-20250514", content: [], usage: { input_tokens: 10, output_tokens: 1 } }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address() as { port: number };
  const child = spawn(process.execPath, [CLI, "gateway", "--port", "0", "--upstream", `http://127.0.0.1:${address.port}`, ...variant.flags], { cwd: dir, env: { ...cleanEnv, REWIND_PROFILE: "compat" }, stdio: ["ignore", "ignore", "pipe"] });
  const exited = once(child, "exit");
  let stderr = "";
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`gateway did not start: ${stderr}`)), 5000);
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        const match = stderr.match(/listening on (http:\/\/[^ ]+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(stderr)); });
    });
    const content = "repeatable observation ".repeat(40);
    const requestBody = { model: "claude-sonnet-4-20250514", system: "Stable instructions", messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content }, { type: "tool_result", tool_use_id: "b", content }] }] };
    const response = await fetch(`${url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(requestBody, null, 2) });
    await response.text();
    assert.equal(response.status, 200);
    if (variant.active) {
    assert.deepEqual(received.system[0].cache_control, { type: "ephemeral" });
    assert.equal(received.messages[0].content[0].content, content);
    assert.ok(received.messages[0].content[1].content.length < content.length);
    assert.match(stderr, /"preserveCache":true/);
    assert.match(stderr, /"pruneContext":true/);
    } else {
      assert.deepEqual(received, requestBody);
      assert.equal(receivedRaw, JSON.stringify(requestBody, null, 2));
      assert.match(stderr, /"preserveCache":false/);
      assert.match(stderr, /"pruneContext":false/);
    }
  } finally {
    child.kill("SIGTERM");
    await exited;
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});


test("gateway CLI invalid flags exit before opening a listener", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-gateway-invalid-"));
  try {
    const help = spawnSync(process.execPath, [CLI, "gateway", "--help"], { cwd: dir, env: cleanEnv, encoding: "utf8", timeout: 5000 });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stderr, /--preserve-cache/);
    for (const flags of [["--port"], ["--unknown"], ["--profile", "max"]]) {
      const result = spawnSync(process.execPath, [CLI, "gateway", ...flags], {
        cwd: dir, env: cleanEnv, encoding: "utf8", timeout: 5000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stderr, /listening on/);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
