import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyChain } from "@agent-rewind/core";
import { Readable } from "node:stream";
import { analyzeInput } from "../src/analyze-input.ts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const call = { scope: "test", headers: {}, url: "https://provider.test/v1/responses", model: "test",
  body: { input: "hello", api_key: "sk-ant-private-test-secret" }, usage: { input_tokens: 10, output_tokens: 2 } };

test("shipped CLI input path reads NDJSON stdin and emits a compact verified report", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "rewind-analysis-cli-"));
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "analyze", "--stdin", "--ndjson"],
      { cwd, input: JSON.stringify(call) + "\n" + JSON.stringify(call), encoding: "utf8", maxBuffer: 8192 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(verifyChain(report.chain).ok, true);
    assert.equal(report.chain[0].detail.total.calls, 2);
    assert.equal(report.chain[0].detail.total.replayableCalls, 1);
    assert.equal(result.stdout.includes("private-test-secret"), false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("NDJSON chunks and batch input produce the same bounded summary totals", async () => {
  const text = JSON.stringify(call) + "\r\n" + JSON.stringify(call);
  const stream = await analyzeInput(["--stdin", "--ndjson"], Readable.from([Buffer.from(text.slice(0, 5)), Buffer.from(text.slice(5))]));
  const batch = await analyzeInput([JSON.stringify([call, call])]);
  const a = stream.chain[0].detail as { total: object; sample?: unknown; source: { bytes: number } };
  const b = batch.chain[0].detail as { total: object };
  assert.deepEqual(a.total, b.total);
  assert.equal(a.sample, undefined);
  assert.equal(a.source.bytes, Buffer.byteLength(text));
  assert.equal(verifyChain(stream.chain).ok, true);
});

test("megabyte prompts and malformed input never expand default output or echo secrets", async () => {
  const huge = JSON.stringify([{ ...call, body: { input: "private-source ".repeat(80_000) } }]);
  const result = JSON.stringify(await analyzeInput(["--stdin"], Readable.from([Buffer.from(huge)])));
  assert.ok(result.length < 4096);
  assert.equal(result.includes("private-source"), false);
  await assert.rejects(analyzeInput(["--stdin"], Readable.from([Buffer.from(huge.slice(0, -2) + "sk-ant-private-test-secret")])), (error: unknown) => {
    const message = String(error);
    assert.ok(message.length < 300);
    assert.equal(message.includes("private-source"), false);
    assert.equal(message.includes("sk-ant-private-test-secret"), false);
    assert.match(message, /bytes=\d+; sha256=[a-f0-9]{64}/);
    return true;
  });
});

test("file/options errors are bounded and legacy samples require explicit selection", async () => {
  await assert.rejects(analyzeInput(["--file", "/missing-rewind-input", "--bad"]), /usage/);
  await assert.rejects(analyzeInput(["--file", "/missing-rewind-input"]), /input unavailable/);
  const legacy = await analyzeInput(["--stdin", "--legacy-json"], Readable.from([Buffer.from(JSON.stringify([call]))]));
  assert.ok((legacy.chain[0].detail as { sample?: unknown }).sample);
  assert.equal(JSON.stringify(legacy).includes("sk-ant-private-test-secret"), false);
});

test("positional JSON accepts flags and filesystem errors cannot impersonate safe errors", async () => {
  const legacy = await analyzeInput([JSON.stringify([call]), "--legacy-json"]);
  assert.ok((legacy.chain[0].detail as { sample?: unknown }).sample);
  await assert.rejects(analyzeInput(["--file", "/tmp/secret-private-path-size limit exceeded"]), (error: unknown) => {
    assert.equal(String(error).includes("secret-private-path"), false);
    return true;
  });
});
