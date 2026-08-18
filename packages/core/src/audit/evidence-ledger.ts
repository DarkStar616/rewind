import { createHash } from "node:crypto";
import type { ScopeId } from "../types.ts";
import { correlationIdForEvent } from "./correlation.ts";
import { canonicalize } from "./canonical-json.ts";
import { createKeyedQueue } from "../util/async.ts";

export const GENESIS_HASH = "0".repeat(64);

// --- Coupling point 1: the action vocabulary is INJECTED, not hard-coded. ---
// The harvested chain baked in one product's action list (AUDIT_ACTIONS / AuditAction /
// isAuditAction). A general-purpose SDK cannot own another product's vocabulary, so the action
// type is `string` and is validated against an optionally-injected allow-list at append time.

// --- Coupling point 2: the authority resolver is INJECTED, with a no-op default. ---
// The harvested chain imported one product's approval-authority resolver directly. Here the caller
// injects one; the default treats nothing as an approval action, so provenance is always empty.

export interface AuthorityResolver {
  (input: {
    actorId: string;
    onBehalfOf?: string;
    authorityChain?: readonly string[];
    subject: string;
  }): { onBehalfOf: string | null; authorityChain: readonly string[] };
}

export interface LedgerOptions {
  /** When provided, an action not in this set (or an empty action) is refused at append. */
  vocabulary?: readonly string[];
  /** Actions that may carry delegated authority. Default: none. */
  approvalActions?: readonly string[];
  /** Resolves provenance for approval actions. Default: the no-op below. */
  resolveAuthority?: AuthorityResolver;
}

const NOOP_AUTHORITY: AuthorityResolver = () => ({ onBehalfOf: null, authorityChain: [] });

interface ResolvedConfig {
  vocabulary?: readonly string[];
  approvalActions: ReadonlySet<string>;
  resolveAuthority: AuthorityResolver;
}

export interface AuditEntryInput {
  scopeLabel: ScopeId;
  action: string;
  actorId?: string;
  objectId?: string;
  detail: unknown;
  onBehalfOf?: string;
  authorityChain?: readonly string[];
  idempotencyKey?: string;
}

export interface AuditEntry {
  scopeLabel: ScopeId;
  seq: number;
  hash: string;
  prevHash: string;
  action: string;
  actorId: string | null;
  objectId: string | null;
  detail: unknown;
  onBehalfOf: string | null;
  authorityChain: readonly string[];
  at: number;
  correlationId: string;
}

export type UnhashedEntry = Omit<AuditEntry, "hash">;

export interface LedgerQuery {
  scopeLabel?: ScopeId;
  action?: string;
  limit?: number;
}

export interface VerifyResult {
  ok: boolean;
  length: number;
  brokenAtSeq?: number;
  reason?: string;
}

export interface EvidenceLedger {
  readonly durable: boolean;
  append(input: AuditEntryInput): Promise<AuditEntry>;
  verify(scopeLabel: ScopeId): Promise<VerifyResult>;
  list(query?: LedgerQuery): Promise<readonly AuditEntry[]>;
  head(scopeLabel: ScopeId): Promise<AuditEntry | undefined>;
}

export class EvidenceLedgerError extends Error {}

export function computeEntryHash(entry: UnhashedEntry): string {
  const canonical = canonicalize({
    scopeLabel: entry.scopeLabel,
    seq: entry.seq,
    prevHash: entry.prevHash,
    action: entry.action,
    actorId: entry.actorId,
    objectId: entry.objectId,
    detail: entry.detail,
    onBehalfOf: entry.onBehalfOf,
    authorityChain: [...entry.authorityChain],
    at: entry.at,
    correlationId: entry.correlationId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function verifyChain(entries: readonly AuditEntry[]): VerifyResult {
  let previous: AuditEntry | undefined;
  for (const entry of entries) {
    if (previous && entry.scopeLabel !== previous.scopeLabel) {
      return {
        ok: false,
        length: entries.length,
        brokenAtSeq: entry.seq,
        reason: `the chain mixes scopes (${previous.scopeLabel} then ${entry.scopeLabel}); verify one tenant at a time`,
      };
    }
    const expectedSeq = previous ? previous.seq + 1 : 0;
    if (entry.seq !== expectedSeq) {
      return {
        ok: false,
        length: entries.length,
        brokenAtSeq: entry.seq,
        reason: `seq ${entry.seq} is out of order; the unbroken successor of ${previous ? previous.seq : "genesis"} is ${expectedSeq}`,
      };
    }
    const expectedPrev = previous ? previous.hash : GENESIS_HASH;
    if (entry.prevHash !== expectedPrev) {
      return {
        ok: false,
        length: entries.length,
        brokenAtSeq: entry.seq,
        reason: `prevHash at seq ${entry.seq} does not link to the preceding entry`,
      };
    }
    if (computeEntryHash(entry) !== entry.hash) {
      return {
        ok: false,
        length: entries.length,
        brokenAtSeq: entry.seq,
        reason: `the stored hash at seq ${entry.seq} does not match the entry's own contents`,
      };
    }
    previous = entry;
  }
  return { ok: true, length: entries.length };
}

export function resolveEntryProvenance(
  input: AuditEntryInput,
  config: ResolvedConfig,
): {
  onBehalfOf: string | null;
  authorityChain: readonly string[];
} {
  const declaresProvenance =
    input.onBehalfOf !== undefined || (input.authorityChain !== undefined && input.authorityChain.length > 0);
  if (!config.approvalActions.has(input.action)) {
    if (declaresProvenance) {
      throw new EvidenceLedgerError(
        `${input.action} carries approval provenance but only approval actions delegate authority; ` +
          `a non-approval entry that claims an authority chain is misattributed`,
      );
    }
    return { onBehalfOf: null, authorityChain: [] };
  }
  if (input.actorId === undefined) {
    throw new EvidenceLedgerError(`${input.action} must name the actor whose authority the approval records`);
  }
  return config.resolveAuthority({
    actorId: input.actorId,
    onBehalfOf: input.onBehalfOf,
    authorityChain: input.authorityChain,
    subject: `${input.action}:${input.objectId ?? ""}`,
  });
}

function buildEntry(input: AuditEntryInput, seq: number, prevHash: string, config: ResolvedConfig): AuditEntry {
  const provenance = resolveEntryProvenance(input, config);
  const unhashed: UnhashedEntry = {
    scopeLabel: input.scopeLabel,
    seq,
    prevHash,
    action: input.action,
    actorId: input.actorId ?? null,
    objectId: input.objectId ?? null,
    detail: input.detail,
    onBehalfOf: provenance.onBehalfOf,
    authorityChain: provenance.authorityChain,
    at: Date.now(),
    correlationId: correlationIdForEvent(),
  };
  return { ...unhashed, hash: computeEntryHash(unhashed) };
}

function idempotencyMapKey(scopeLabel: ScopeId, action: string, idempotencyKey: string): string {
  return `${scopeLabel}\0${action}\0${idempotencyKey}`;
}

export function createMemoryEvidenceLedger(opts: LedgerOptions = {}): EvidenceLedger {
  const config: ResolvedConfig = {
    vocabulary: opts.vocabulary,
    approvalActions: new Set(opts.approvalActions ?? []),
    resolveAuthority: opts.resolveAuthority ?? NOOP_AUTHORITY,
  };
  const chains = new Map<ScopeId, AuditEntry[]>();
  const byIdempotencyKey = new Map<string, AuditEntry>();
  const enqueue = createKeyedQueue<ScopeId>();

  async function append(input: AuditEntryInput): Promise<AuditEntry> {
    if (typeof input.action !== "string" || input.action.trim() === "") {
      throw new EvidenceLedgerError("an audit entry requires a non-empty action");
    }
    if (config.vocabulary && !config.vocabulary.includes(input.action)) {
      throw new EvidenceLedgerError(`${input.action} is not in the injected action vocabulary`);
    }
    resolveEntryProvenance(input, config);
    return enqueue(input.scopeLabel, async () => {
      if (input.idempotencyKey) {
        const mapKey = idempotencyMapKey(input.scopeLabel, input.action, input.idempotencyKey);
        const existing = byIdempotencyKey.get(mapKey);
        if (existing) return existing;
      }
      const chain = chains.get(input.scopeLabel) ?? [];
      const head = chain[chain.length - 1];
      const entry = buildEntry(input, head ? head.seq + 1 : 0, head ? head.hash : GENESIS_HASH, config);
      chain.push(entry);
      chains.set(input.scopeLabel, chain);
      if (input.idempotencyKey) {
        byIdempotencyKey.set(idempotencyMapKey(input.scopeLabel, input.action, input.idempotencyKey), entry);
      }
      return entry;
    });
  }

  async function verify(scopeLabel: ScopeId): Promise<VerifyResult> {
    return verifyChain(chains.get(scopeLabel) ?? []);
  }

  async function list(query: LedgerQuery = {}): Promise<readonly AuditEntry[]> {
    const source = query.scopeLabel ? (chains.get(query.scopeLabel) ?? []) : [...chains.values()].flat();
    const filtered = query.action ? source.filter((e) => e.action === query.action) : source;
    return query.limit !== undefined ? filtered.slice(0, query.limit) : filtered;
  }

  async function head(scopeLabel: ScopeId): Promise<AuditEntry | undefined> {
    const chain = chains.get(scopeLabel);
    return chain && chain.length > 0 ? chain[chain.length - 1] : undefined;
  }

  return { durable: false, append, verify, list, head };
}
