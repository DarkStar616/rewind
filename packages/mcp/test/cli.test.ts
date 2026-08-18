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
