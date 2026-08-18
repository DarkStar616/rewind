import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryEvidenceLedger,
  verifyChain,
  computeEntryHash,
  GENESIS_HASH,
  type AuditEntry,
} from "../src/audit/evidence-ledger.ts";

// A real NUL byte, constructed at runtime so no control character lives in this source file.
const NUL = String.fromCharCode(0);

async function chainOf(entries: readonly { action: string; detail: unknown }[]): Promise<AuditEntry[]> {
  const led = createMemoryEvidenceLedger();
  for (const e of entries) await led.append({ scopeLabel: "s", action: e.action, detail: e.detail });
  return [...(await led.list({ scopeLabel: "s" }))];
}

test("verify passes on an untouched chain and fails when an interior field is edited", async () => {
  const led = createMemoryEvidenceLedger();
  await led.append({ scopeLabel: "s", action: "a", detail: { n: 1 } });
  await led.append({ scopeLabel: "s", action: "a", detail: { n: 2 } });
  assert.equal((await led.verify("s")).ok, true);
  const entries = [...(await led.list({ scopeLabel: "s" }))];
  const tampered = entries.map((e, i) => (i === 0 ? { ...e, detail: { n: 999 } } : e));
  const res = verifyChain(tampered);
  assert.equal(res.ok, false);
  assert.equal(res.brokenAtSeq, 0);
});

test("an unknown action is rejected when a vocabulary is injected", async () => {
  const led = createMemoryEvidenceLedger({ vocabulary: ["allowed"] });
  await assert.rejects(led.append({ scopeLabel: "s", action: "nope", detail: null }));
});

test("an empty or whitespace-only action is refused", async () => {
  const led = createMemoryEvidenceLedger();
  await assert.rejects(led.append({ scopeLabel: "s", action: "", detail: null }));
  await assert.rejects(led.append({ scopeLabel: "s", action: "   ", detail: null }));
});

test("an empty chain and an unknown scope both verify as ok with length 0", async () => {
  assert.deepEqual(verifyChain([]), { ok: true, length: 0 });
  const led = createMemoryEvidenceLedger();
  assert.deepEqual(await led.verify("never-written"), { ok: true, length: 0 });
});

test("tampering ANY hashed field (not only detail) breaks verification", async () => {
  const base = await chainOf([
    { action: "a", detail: { n: 1 } },
    { action: "a", detail: { n: 2 } },
  ]);
  const mutate = (patch: Partial<AuditEntry>) => {
    const t = base.map((e, i) => (i === 1 ? { ...e, ...patch } : e));
    const r = verifyChain(t);
    assert.equal(r.ok, false, `expected break for patch ${JSON.stringify(Object.keys(patch))}`);
    assert.equal(r.brokenAtSeq, 1);
  };
  mutate({ at: base[1].at + 1 });
  mutate({ actorId: "someone-else" });
  mutate({ objectId: "swapped" });
  mutate({ onBehalfOf: "smuggled" });
  mutate({ correlationId: "rewritten" });
  mutate({ action: "different" });
});

test("out-of-order seq is detected", async () => {
  const base = await chainOf([
    { action: "a", detail: 1 },
    { action: "a", detail: 2 },
    { action: "a", detail: 3 },
  ]);
  const reordered = [base[0], base[2], base[1]];
  const r = verifyChain(reordered);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAtSeq, 2);
});

test("a gap in seq is detected", async () => {
  const base = await chainOf([
    { action: "a", detail: 1 },
    { action: "a", detail: 2 },
    { action: "a", detail: 3 },
  ]);
  const gapped = [base[0], base[2]]; // seq 0 then seq 2
  const r = verifyChain(gapped);
  assert.equal(r.ok, false);
  assert.equal(r.brokenAtSeq, 2);
});

test("prevHash tampering is detected at the genesis, interior and final positions", async () => {
  const base = await chainOf([
    { action: "a", detail: 1 },
    { action: "a", detail: 2 },
    { action: "a", detail: 3 },
  ]);
  for (const pos of [0, 1, 2]) {
    const t = base.map((e, i) => (i === pos ? { ...e, prevHash: "f".repeat(64) } : e));
    const r = verifyChain(t);
    assert.equal(r.ok, false, `prevHash break at position ${pos} should be detected`);
    assert.equal(r.brokenAtSeq, pos);
  }
});

test("a chain that mixes two scopes is refused", async () => {
  const led = createMemoryEvidenceLedger();
  const a = await led.append({ scopeLabel: "tenant-a", action: "x", detail: 1 });
  const b = await led.append({ scopeLabel: "tenant-b", action: "x", detail: 1 });
  const r = verifyChain([a, b]);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /mixes scopes/);
});

test("verify RETURNS a broken verdict (never throws) when a tampered entry has non-finite detail", async () => {
  const base = await chainOf([{ action: "a", detail: { n: 1 } }]);
  const tampered = base.map((e) => ({ ...e, detail: { n: Infinity } }));
  let r: ReturnType<typeof verifyChain> | undefined;
  assert.doesNotThrow(() => {
    r = verifyChain(tampered);
  });
  assert.equal(r!.ok, false);
  assert.equal(r!.brokenAtSeq, 0);
  assert.match(r!.reason ?? "", /structurally invalid/);
});

test("verify RETURNS a broken verdict (never throws) when authorityChain is stripped", async () => {
  const base = await chainOf([{ action: "a", detail: { n: 1 } }]);
  const tampered = base.map((e) => {
    const clone: Record<string, unknown> = { ...e };
    delete clone.authorityChain;
    return clone as unknown as AuditEntry;
  });
  let r: ReturnType<typeof verifyChain> | undefined;
  assert.doesNotThrow(() => {
    r = verifyChain(tampered);
  });
  assert.equal(r!.ok, false);
  assert.equal(r!.brokenAtSeq, 0);
});

test("golden: computeEntryHash is byte-stable (locks the chain's hashing semantics)", () => {
  const entry: Omit<AuditEntry, "hash"> = {
    scopeLabel: "s",
    seq: 0,
    prevHash: GENESIS_HASH,
    action: "a",
    actorId: null,
    objectId: null,
    detail: { n: 1, nested: { deep: [true, false, null] } },
    onBehalfOf: null,
    authorityChain: [],
    at: 1700000000000,
    correlationId: "fixed-correlation",
  };
  assert.equal(computeEntryHash(entry), "124a49cd5349d52e1fe2fca0881e9247721e9d8e4bbe15b1ee7cd1995f1f62d7");
});

test("an idempotency retry (same scope, action, key) returns the first entry and does not grow the chain", async () => {
  const led = createMemoryEvidenceLedger();
  const first = await led.append({ scopeLabel: "s", action: "a", detail: 1, idempotencyKey: "k1" });
  const retry = await led.append({ scopeLabel: "s", action: "a", detail: 2, idempotencyKey: "k1" });
  assert.equal(retry.hash, first.hash);
  assert.equal(retry.seq, 0);
  assert.equal((await led.list({ scopeLabel: "s" })).length, 1);
});

test("idempotency keys do not collide across the action/key boundary (separator injection)", async () => {
  // ("s", "x\0y", "k") and ("s", "x", "y\0k") join to the same NUL-delimited string; a delimited
  // composite key would dedupe the second append against the first. It must not.
  const led = createMemoryEvidenceLedger();
  const e1 = await led.append({ scopeLabel: "s", action: `x${NUL}y`, detail: 1, idempotencyKey: "k" });
  const e2 = await led.append({ scopeLabel: "s", action: "x", detail: 2, idempotencyKey: `y${NUL}k` });
  assert.equal(e1.seq, 0);
  assert.equal(e2.seq, 1, "second append must be a NEW entry, not a dedup of the first");
  assert.equal(e2.action, "x");
  assert.equal((await led.list({ scopeLabel: "s" })).length, 2);
  assert.equal((await led.verify("s")).ok, true);
});

test("concurrent appends to one scope produce a contiguous, verifiable chain", async () => {
  const led = createMemoryEvidenceLedger();
  const N = 30;
  await Promise.all(
    Array.from({ length: N }, (_, i) => led.append({ scopeLabel: "s", action: "a", detail: { i } })),
  );
  const entries = await led.list({ scopeLabel: "s" });
  assert.equal(entries.length, N);
  const seqs = new Set(entries.map((e) => e.seq));
  assert.equal(seqs.size, N);
  for (let i = 0; i < N; i++) assert.ok(seqs.has(i), `missing seq ${i}`);
  assert.equal((await led.verify("s")).ok, true);
});

test("concurrent appends with the SAME idempotency key collapse to a single entry", async () => {
  const led = createMemoryEvidenceLedger();
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      led.append({ scopeLabel: "s", action: "a", detail: { i }, idempotencyKey: "same" }),
    ),
  );
  const hashes = new Set(results.map((r) => r.hash));
  assert.equal(hashes.size, 1, "all concurrent retries must resolve to one entry");
  assert.equal((await led.list({ scopeLabel: "s" })).length, 1);
});

test("a non-approval action that smuggles provenance is refused (misattribution guard)", async () => {
  const led = createMemoryEvidenceLedger();
  await assert.rejects(
    led.append({ scopeLabel: "s", action: "a", detail: null, authorityChain: ["root"] }),
  );
});
