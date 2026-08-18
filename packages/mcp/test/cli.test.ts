import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { verifyChain, type AuditEntry } from "@rewind/core";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface Run {
  status: number;
  stdout: string;
  stderr: string;
  json: unknown;
}

/** Drive the CLI as a real, separate process (the acceptance bar: state must survive across procs). */
function runCli(dir: string, args: readonly string[]): Run {
  const res = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" });
  const stdout = res.stdout ?? "";
  let json: unknown = undefined;
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      json = JSON.parse(trimmed);
    } catch {
      json = undefined;
    }
  }
  return { status: res.status ?? -1, stdout, stderr: res.stderr ?? "", json };
}

test("rewind CLI: checkpoint → guard admitted → bash edit → rewind → guard REFUSED across the rewind → chain verifies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-cli-"));
  try {
    await writeFile(join(dir, "a.txt"), "original");

    // 1) Checkpoint the workspace through the built binary; capture the handle it mints.
    const cp = runCli(dir, ["checkpoint", "before"]);
    assert.equal(cp.status, 0, `checkpoint should exit 0; stderr=${cp.stderr}`);
    const snap = cp.json as { id: string; label?: string; ts: number };
    assert.match(snap.id, /^[0-9a-f]{7,64}$/i, "checkpoint must print a snapshot id");

    // 2) Fire an external effect — admitted the first time.
    const effect = JSON.stringify({ effectKey: "charge:42", scopeLabel: "s", kind: "http" });
    const first = runCli(dir, ["guard", effect]);
    assert.equal(first.status, 0, `first guard should be admitted (exit 0); stderr=${first.stderr}`);
    assert.equal((first.json as { refused: boolean }).refused, false);

    // 3) Mutate the workspace via a real shell command, then rewind the whole tree to the checkpoint.
    execFileSync("bash", ["-c", "echo mutated > a.txt"], { cwd: dir });
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "mutated\n");

    const rw = runCli(dir, ["rewind", snap.id]);
    assert.equal(rw.status, 0, `rewind should exit 0; stderr=${rw.stderr}`);
    assert.equal(await readFile(join(dir, "a.txt"), "utf8"), "original", "rewind must restore the tree");
    // The spent effect is surfaced from the CHAIN as now-refusable (not read from the filesystem).
    const rwOut = rw.json as { restoredTo: string; refusableEffects: { effectKey: string }[] };
    assert.equal(rwOut.restoredTo, snap.id);
    assert.ok(
      rwOut.refusableEffects.some((e) => e.effectKey === "charge:42"),
      "the emitted effect must be reported as refusable-on-replay after a rewind",
    );

    // 4) Re-firing the same effect ACROSS the rewind is refused and recorded; exit code 2 lets a hook block.
    const second = runCli(dir, ["guard", effect]);
    assert.equal(second.status, 2, `a refused effect must exit 2; stderr=${second.stderr}`);
    const secondOut = second.json as { refused: boolean; firstEmittedSeq: number };
    assert.equal(secondOut.refused, true);
    assert.equal(secondOut.firstEmittedSeq, 0);

    // 5) The tamper-evident chain the barrier wrote to disk still verifies.
    const persisted = JSON.parse(await readFile(join(dir, ".rewind", "evidence.json"), "utf8")) as {
      scopes: Record<string, AuditEntry[]>;
    };
    assert.equal(verifyChain(persisted.scopes["s"] ?? []).ok, true, "the persisted chain must verify");

    // 6) The checkpoint is listed by the CLI.
    const listed = runCli(dir, ["list"]);
    assert.equal(listed.status, 0);
    assert.ok((listed.json as { id: string }[]).some((r) => r.id === snap.id), "list must include the checkpoint");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rewind CLI: an unknown subcommand is refused non-zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-cli-"));
  try {
    const res = runCli(dir, ["frobnicate"]);
    assert.notEqual(res.status, 0, "an unknown subcommand must not exit 0");
    assert.match(res.stderr, /unknown subcommand/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rewind CLI: prune previews duplicate-tool-output savings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-cli-"));
  try {
    const big = "LINE ".repeat(100);
    const tr = (id: string) => ({ type: "tool_result", tool_use_id: id, content: big });
    const body = JSON.stringify({
      model: "m",
      messages: [
        { role: "user", content: [tr("a")] },
        { role: "user", content: [tr("b")] },
      ],
    });
    const r = runCli(dir, ["prune", body]);
    assert.equal(r.status, 0);
    assert.equal((r.json as { elided: number }).elided, 1);
    assert.ok((r.json as { charsSaved: number }).charsSaved > 300);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rewind CLI: analyze prints a verifiable, redacted savings report and exits 0", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-cli-"));
  try {
    const call = (prompt: string) => ({
      scope: "s",
      body: { model: "claude-haiku-4-5", api_key: "sk-ant-secret01xyz", messages: [{ role: "user", content: prompt }] },
      usage: { input_tokens: 100, output_tokens: 100 },
      model: "claude-haiku-4-5",
    });
    const input = JSON.stringify([call("hello"), call("hello"), call("unique")]);
    const r = runCli(dir, ["analyze", input]);
    assert.equal(r.status, 0, `analyze should exit 0; stderr=${r.stderr}`);
    const j = r.json as { analysis: { total: { calls: number; replayableCalls: number } }; rootHash: string; verified: boolean };
    assert.equal(j.analysis.total.calls, 3);
    assert.equal(j.analysis.total.replayableCalls, 1, "the 2nd identical call is byte-replayable");
    assert.equal(j.verified, true, "the attested report verifies");
    assert.match(j.rootHash, /^[0-9a-f]{64}$/);
    // The secret must not survive into the shareable report.
    assert.equal(r.stdout.includes("sk-ant-secret01xyz"), false, "the api key must be redacted from the report");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rewind CLI: analyze rejects non-array input non-zero", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-cli-"));
  try {
    const r = runCli(dir, ["analyze", JSON.stringify({ not: "an array" })]);
    assert.notEqual(r.status, 0, "a non-array must be refused");
    assert.match(r.stderr, /array/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rewind CLI: cache-report prints the hygiene report and exits 1 on a poisoned prefix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rewind-cli-"));
  try {
    const clean = JSON.stringify({ model: "m", system: "static", messages: [{ role: "user", content: "hi" }] });
    const rClean = runCli(dir, ["cache-report", clean]);
    assert.equal(rClean.status, 0, "a clean prefix exits 0");
    assert.equal((rClean.json as { cacheable: boolean }).cacheable, true);

    const poisoned = JSON.stringify({
      model: "m",
      system: "time is 2026-08-18T14:30:00Z",
      messages: [{ role: "user", content: "hi" }],
    });
    const rBad = runCli(dir, ["cache-report", poisoned]);
    assert.equal(rBad.status, 1, "a poisoned prefix exits 1 so a script can gate on it");
    assert.equal((rBad.json as { cacheable: boolean }).cacheable, false);
    assert.equal((rBad.json as { prefixPoisoners: unknown[] }).prefixPoisoners.length >= 1, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
