/** Pure, append-only measurement foundation. No clock, persistence, provider calls or legacy sink changes. */
import { canonicalize } from "../audit/canonical-json.ts";

interface Envelope {
  schema: "rewind.mechanism/v1";
  eventId: string;
  requestId: string;
  idempotencyKey: string;
  recordId?: string;
  ts: number;
  tenant: string;
  scope: string;
  provider: string;
  model: string;
  eligibleUnits: number;
  configurationFingerprint: string;
  evidenceDigest: string;
  pricing: { version: string; currency: "USD"; costBasis: "simulated" | "estimated" | "provider-reported" | "paired-provider-billed" };
}
export type MechanismEvent = Envelope & (
  | { mechanism: "replay"; tokensAvoided: number; avoidedCostMicros: number }
  | { mechanism: "cache"; readTokens: number; write5mTokens: number; write1hTokens: number;
      policyOwner: "gateway" | "client" | "provider"; usageSource: "provider-reported" | "simulated";
      /** Integer micro-USD per million tokens; no implicit provider/rate defaults. */
      rates: { input: number; read: number; write5m: number; write1h: number } }
  | { mechanism: "shaping"; measurement: "provider-count" | "tokenizer" | "characters"; removedUnits: number }
  | { mechanism: "control"; tokens: number }
);
export interface MechanismQuery { tenant: string; scope?: string; since?: number; until?: number }
export interface MechanismProjection {
  events: number;
  costBasis: Envelope["pricing"]["costBasis"] | "mixed" | "none";
  replay: { events: number; eligibleTokens: number; tokensAvoided: number; costMicros: number };
  cache: { events: number; eligibleTokens: number; readTokens: number; write5mTokens: number; write1hTokens: number; readCostMicros: number; write5mCostMicros: number; write1hCostMicros: number; gatewayReadDiscountMicros: number; gatewayWritePremiumMicros: number; gatewayReadPremiumMicros: number; gatewayNetBenefitMicros: number };
  shaping: { events: number; eligibleTokens: number; eligibleCharacters: number; tokensRemoved: number; advisoryCharactersRemoved: number };
  control: { events: number; eligibleTokens: number; tokens: number };
  provenance: Array<{ pricing: Envelope["pricing"]; configurationFingerprint: string; evidenceDigest: string }>;
}
export interface MechanismLedger {
  /** Identical retry returns false; conflicting identities or overlapping credit throw. */
  append(event: MechanismEvent): boolean;
  list(query: MechanismQuery): readonly MechanismEvent[];
  project(query: MechanismQuery): MechanismProjection;
}
const integer = (n: unknown): number => {
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new Error("measurement must be a nonnegative safe integer");
  return n;
};
const text = (s: unknown): void => { if (typeof s !== "string" || !s.length) throw new Error("event identity/provenance missing"); };
const sum = (a: number, b: number): number => {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new Error("measurement total overflow");
  return result;
};
const price = (tokens: number, rate: number, roundUp = false): number => {
  const amount = (BigInt(tokens) * BigInt(rate) + (roundUp ? 999_999n : 0n)) / 1_000_000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("measurement price overflow");
  return Number(amount);
};
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
}
function validate(event: MechanismEvent): void {
  if (event.schema !== "rewind.mechanism/v1") throw new Error("unsupported mechanism schema");
  for (const value of [event.eventId, event.requestId, event.idempotencyKey, event.tenant, event.scope, event.provider, event.model, event.configurationFingerprint, event.pricing?.version]) text(value);
  if (!/^[a-f0-9]{64}$/.test(event.evidenceDigest)) throw new Error("event evidence digest must be SHA-256");
  if (event.pricing.currency !== "USD" || !["simulated", "estimated", "provider-reported", "paired-provider-billed"].includes(event.pricing.costBasis)) throw new Error("unsupported pricing provenance");
  integer(event.ts); integer(event.eligibleUnits);
  let used: number;
  switch (event.mechanism) {
    case "replay": text(event.recordId); used = integer(event.tokensAvoided); integer(event.avoidedCostMicros); break;
    case "cache":
      used = sum(sum(integer(event.readTokens), integer(event.write5mTokens)), integer(event.write1hTokens));
      for (const key of ["input", "read", "write5m", "write1h"] as const) integer(event.rates[key]);
      if (!["gateway", "client", "provider"].includes(event.policyOwner) || !["provider-reported", "simulated"].includes(event.usageSource)) throw new Error("unsupported cache provenance");
      break;
    case "shaping":
      if (!["provider-count", "tokenizer", "characters"].includes(event.measurement)) throw new Error("unsupported shaping measurement");
      used = integer(event.removedUnits); break;
    case "control": used = integer(event.tokens); break;
    default: throw new Error("unknown mechanism");
  }
  if (used > event.eligibleUnits) throw new Error("measurement exceeds eligible units");
}

export function createMemoryMechanismLedger(): MechanismLedger {
  const events: MechanismEvent[] = [];
  const byEvent = new Map<string, MechanismEvent>();
  const byRetry = new Map<string, MechanismEvent>();
  const byRequest = new Map<string, MechanismEvent[]>();
  const key = (event: MechanismEvent, id: string): string => JSON.stringify([event.tenant, event.scope, id]);
  const list = (query: MechanismQuery): readonly MechanismEvent[] => {
    text(query.tenant);
    if (query.scope !== undefined) text(query.scope);
    if (query.since !== undefined) integer(query.since);
    if (query.until !== undefined) integer(query.until);
    if (query.since !== undefined && query.until !== undefined && query.since > query.until) throw new Error("invalid time window");
    return Object.freeze(events.filter((event) => event.tenant === query.tenant && (query.scope === undefined || event.scope === query.scope) && (query.since === undefined || event.ts >= query.since) && (query.until === undefined || event.ts < query.until)));
  };
  return {
    append(input) {
      // Canonical JSON makes duplicate comparison independent of object insertion order and owns a copy.
      const encoded = canonicalize(input);
      const event = JSON.parse(encoded) as MechanismEvent;
      validate(event);
      freeze(event);
      for (const previous of [byEvent.get(key(event, event.eventId)), byRetry.get(key(event, JSON.stringify([event.idempotencyKey, event.mechanism])))]) {
        if (previous && canonicalize(previous) !== encoded) throw new Error("conflicting event/idempotency payload");
      }
      if (byEvent.has(key(event, event.eventId)) || byRetry.has(key(event, JSON.stringify([event.idempotencyKey, event.mechanism])))) return false;
      const requestKey = key(event, event.requestId);
      const siblings = byRequest.get(requestKey) ?? [];
      if (siblings.some((other) => other.mechanism === event.mechanism)) throw new Error("request mechanism already recorded");
      if (siblings.some((other) => (event.mechanism === "replay" && ["cache", "shaping"].includes(other.mechanism)) || (other.mechanism === "replay" && ["cache", "shaping"].includes(event.mechanism)))) throw new Error("overlapping replay/cache/shaping credit");
      events.push(event); byEvent.set(key(event, event.eventId), event); byRetry.set(key(event, JSON.stringify([event.idempotencyKey, event.mechanism])), event); byRequest.set(requestKey, [...siblings, event]);
      return true;
    },
    list,
    project(query) {
      const result: MechanismProjection = {
        events: 0, costBasis: "none",
        replay: { events: 0, eligibleTokens: 0, tokensAvoided: 0, costMicros: 0 },
        cache: { events: 0, eligibleTokens: 0, readTokens: 0, write5mTokens: 0, write1hTokens: 0, readCostMicros: 0, write5mCostMicros: 0, write1hCostMicros: 0, gatewayReadDiscountMicros: 0, gatewayWritePremiumMicros: 0, gatewayReadPremiumMicros: 0, gatewayNetBenefitMicros: 0 },
        shaping: { events: 0, eligibleTokens: 0, eligibleCharacters: 0, tokensRemoved: 0, advisoryCharactersRemoved: 0 },
        control: { events: 0, eligibleTokens: 0, tokens: 0 }, provenance: [],
      };
      const add = (target: Record<string, number>, field: string, value: number): void => { target[field] = sum(target[field], value); };
      for (const event of list(query)) {
        result.events = sum(result.events, 1);
        result.costBasis = result.costBasis === "none" ? event.pricing.costBasis : result.costBasis === event.pricing.costBasis ? result.costBasis : "mixed";
        result.provenance.push({ pricing: event.pricing, configurationFingerprint: event.configurationFingerprint, evidenceDigest: event.evidenceDigest });
        const target = result[event.mechanism];
        add(target, "events", 1);
        if (event.mechanism === "shaping" && event.measurement === "characters") add(result.shaping, "eligibleCharacters", event.eligibleUnits);
        else add(target, "eligibleTokens", event.eligibleUnits);
        switch (event.mechanism) {
          case "replay": add(result.replay, "tokensAvoided", event.tokensAvoided); add(result.replay, "costMicros", event.avoidedCostMicros); break;
          case "control": add(result.control, "tokens", event.tokens); break;
          case "shaping": add(result.shaping, event.measurement === "characters" ? "advisoryCharactersRemoved" : "tokensRemoved", event.removedUnits); break;
          case "cache": {
            const c = result.cache;
            for (const field of ["readTokens", "write5mTokens", "write1hTokens"] as const) add(c, field, event[field]);
            add(c, "readCostMicros", price(event.readTokens, event.rates.read));
            add(c, "write5mCostMicros", price(event.write5mTokens, event.rates.write5m));
            add(c, "write1hCostMicros", price(event.write1hTokens, event.rates.write1h));
            if (event.policyOwner === "gateway" && event.usageSource === "provider-reported" && event.pricing.costBasis !== "simulated") {
              add(c, "gatewayReadPremiumMicros", price(event.readTokens, Math.max(0, event.rates.read - event.rates.input), true));
              add(c, "gatewayReadDiscountMicros", price(event.readTokens, Math.max(0, event.rates.input - event.rates.read)));
              add(c, "gatewayWritePremiumMicros", sum(price(event.write5mTokens, Math.max(0, event.rates.write5m - event.rates.input), true), price(event.write1hTokens, Math.max(0, event.rates.write1h - event.rates.input), true)));
            }
            break;
          }
        }
      }
      result.cache.gatewayNetBenefitMicros = sum(result.cache.gatewayReadDiscountMicros, -sum(result.cache.gatewayWritePremiumMicros, result.cache.gatewayReadPremiumMicros));
      return result;
    },
  };
}
