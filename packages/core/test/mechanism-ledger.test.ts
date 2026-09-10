import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryMechanismLedger, type MechanismEvent } from "../src/replay/mechanism-ledger.ts";

function replay(id = "one", ts = 10): MechanismEvent {
  return { schema: "rewind.mechanism/v1", eventId: `event-${id}`, requestId: `request-${id}`, idempotencyKey: `retry-${id}`, recordId: "same-record", ts, tenant: "tenant", scope: "scope", provider: "anthropic", model: "model", configurationFingerprint: "config-v1", evidenceDigest: "a".repeat(64), pricing: { version: "rates-v1", currency: "USD", costBasis: "simulated" }, eligibleUnits: 20, mechanism: "replay", tokensAvoided: 20, avoidedCostMicros: 12 };
}
function cache(id = "cache"): MechanismEvent {
  const { recordId, tokensAvoided, avoidedCostMicros, ...common } = replay(id) as Extract<MechanismEvent, { mechanism: "replay" }>;
  return { ...common, pricing: { ...common.pricing, costBasis: "provider-reported" }, mechanism: "cache", eligibleUnits: 30, readTokens: 10, write5mTokens: 5, write1hTokens: 5, policyOwner: "gateway", usageSource: "provider-reported", rates: { input: 1_000_000, read: 100_000, write5m: 1_250_000, write1h: 2_000_000 } };
}
const query = { tenant: "tenant", scope: "scope" };

test("evidence digest must be a string, never a coercible array", () => {
  const ledger = createMemoryMechanismLedger();
  assert.throws(() => ledger.append({ ...replay(), evidenceDigest: ["a".repeat(64)] } as unknown as MechanismEvent), /digest/);
  assert.equal(ledger.list(query).length, 0);
});

test("three independent requests sharing a record count three, transport retry counts once", () => {
  const ledger = createMemoryMechanismLedger();
  for (const id of ["one", "two", "three"]) assert.equal(ledger.append(replay(id)), true);
  assert.equal(ledger.append(replay("one")), false);
  assert.equal(ledger.project(query).replay.tokensAvoided, 60);
  assert.equal(ledger.project(query).events, 3);
  assert.throws(() => ledger.append({ ...replay("one"), tokensAvoided: 19 } as MechanismEvent), /conflict/);
  assert.throws(() => ledger.append({ ...replay("one"), eventId: "another", idempotencyKey: "another" }), /request/);
});

test("timestamp boundaries, tenant isolation and immutable storage", () => {
  const ledger = createMemoryMechanismLedger();
  const event = replay();
  ledger.append(event);
  event.model = "mutated";
  ledger.append({ ...replay("two", 20), tenant: "other" });
  assert.equal(ledger.list(query)[0].model, "model");
  assert.throws(() => { ledger.list(query)[0].pricing.version = "mutated"; }, TypeError);
  assert.equal(ledger.project({ ...query, since: 10, until: 11 }).events, 1);
  assert.equal(ledger.project({ ...query, until: 10 }).events, 0);
  assert.equal(ledger.project({ tenant: "other" }).events, 1);
});

test("cache discount requires gateway-owned provider evidence; TTL write costs stay separate", () => {
  const ledger = createMemoryMechanismLedger();
  ledger.append(cache());
  const result = ledger.project(query);
  assert.equal(result.replay.tokensAvoided, 0);
  assert.equal(result.cache.gatewayReadDiscountMicros, 9);
  assert.equal(result.cache.write5mCostMicros, 6);
  assert.equal(result.cache.write1hCostMicros, 10);
  assert.equal(result.cache.gatewayWritePremiumMicros, 7);
  assert.equal(result.cache.gatewayNetBenefitMicros, 2);
  const client = createMemoryMechanismLedger();
  client.append({ ...cache(), policyOwner: "client" } as MechanismEvent);
  assert.equal(client.project(query).cache.gatewayReadDiscountMicros, 0);
  const simulation = createMemoryMechanismLedger();
  simulation.append({ ...cache(), usageSource: "simulated" } as MechanismEvent);
  assert.equal(simulation.project(query).cache.gatewayReadDiscountMicros, 0);
});

test("replay cannot overlap cache or shaping for the same request in either insertion order", () => {
  for (const reverse of [false, true]) {
    const ledger = createMemoryMechanismLedger();
    const a = replay();
    const b = { ...cache(), requestId: a.requestId };
    ledger.append(reverse ? b : a);
    assert.throws(() => ledger.append(reverse ? a : b), /overlap/);
  }
});

test("advisory characters never become eliminated tokens; control plane remains overhead", () => {
  const ledger = createMemoryMechanismLedger();
  const base = replay("shape");
  ledger.append({ ...base, mechanism: "shaping", measurement: "characters", removedUnits: 15 } as MechanismEvent);
  ledger.append({ ...replay("control"), mechanism: "control", tokens: 8 } as MechanismEvent);
  assert.equal(ledger.project(query).shaping.tokensRemoved, 0);
  assert.equal(ledger.project(query).shaping.advisoryCharactersRemoved, 15);
  assert.equal(ledger.project(query).control.tokens, 8);
});

test("invalid, overflow and unsafe totals fail closed", () => {
  for (const tokens of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createMemoryMechanismLedger().append({ ...replay(), tokensAvoided: tokens } as MechanismEvent));
  }
  const ledger = createMemoryMechanismLedger();
  ledger.append({ ...replay(), eligibleUnits: Number.MAX_SAFE_INTEGER, tokensAvoided: Number.MAX_SAFE_INTEGER } as MechanismEvent);
  ledger.append(replay("two"));
  assert.throws(() => ledger.project(query), /overflow/);
  assert.throws(() => ledger.project({ ...query, since: 11, until: 10 }), /window/);
});


test("write-only or more expensive cache traffic cannot manufacture positive savings", () => {
  const ledger = createMemoryMechanismLedger();
  ledger.append({ ...cache(), readTokens: 0 } as MechanismEvent);
  assert.equal(ledger.project(query).cache.gatewayNetBenefitMicros, -7);
  const expensive = createMemoryMechanismLedger();
  const event = cache() as Extract<MechanismEvent, { mechanism: "cache" }>;
  expensive.append({ ...event, rates: { ...event.rates, read: 2_000_000 } });
  assert.equal(expensive.project(query).cache.gatewayReadPremiumMicros, 10);
  assert.equal(expensive.project(query).cache.gatewayNetBenefitMicros, -17);
});

test("schema, eligibility, provenance, retry collisions and mixed cost bases remain explicit", () => {
  const ledger = createMemoryMechanismLedger();
  for (const override of [{ schema: "unknown" }, { eligibleUnits: 0 }, { evidenceDigest: "unknown" }, { ts: -1 }]) {
    assert.throws(() => ledger.append({ ...replay(), ...override } as MechanismEvent));
  }
  ledger.append(replay());
  assert.throws(() => ledger.append({ ...replay("two"), idempotencyKey: "retry-one" }), /conflict/);
  ledger.append({ ...replay("two"), pricing: { version: "other", currency: "USD", costBasis: "estimated" } });
  assert.equal(ledger.project(query).costBasis, "mixed");
  assert.equal(ledger.project(query).provenance.length, 2);
});


test("one transport request can emit cache and shaping events with the same retry key", () => {
  const ledger = createMemoryMechanismLedger();
  const cached = cache();
  const shaped = { ...cached, eventId: "shaping-event", mechanism: "shaping", measurement: "provider-count", removedUnits: 2 } as MechanismEvent;
  assert.equal(ledger.append(cached), true);
  assert.equal(ledger.append(shaped), true);
  assert.equal(ledger.append(shaped), false);
  assert.equal(ledger.project(query).events, 2);
  assert.equal(ledger.project(query).shaping.tokensRemoved, 2);
});

test("simulated pricing evidence never masquerades as realized gateway cache savings", () => {
  const ledger = createMemoryMechanismLedger();
  const event = cache();
  ledger.append({ ...event, pricing: { ...event.pricing, costBasis: "simulated" } });
  assert.equal(ledger.project(query).cache.gatewayReadDiscountMicros, 0);
});
