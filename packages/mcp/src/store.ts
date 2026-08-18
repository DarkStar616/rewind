/**
 * Durable, file-backed evidence store for the rewind adapters (CLI now; MCP server next).
 *
 * The MCP stateless-core rule (CLAUDE.md) forbids per-connection / per-session state: every stateful
 * surface must persist to the substrate's durable store keyed by an explicit handle. The CLI is the
 * extreme case — each subcommand is a SEPARATE short-lived process — so the evidence chain the effect
 * barrier records on MUST live on disk, or a `guard` in one process could never refuse an effect a
 * `guard` in an earlier process already spent.
 *
 * This is a faithful on-disk EvidenceLedger, NOT a second barrier implementation. The effect barrier
 * (`createEffectLedger`) still sits above it unchanged; this only swaps the ledger's storage from a
 * process-lifetime Map to a JSON file. It reuses core's canonical hash (`computeEntryHash`) and chain
 * verifier (`verifyChain`) verbatim, so a chain written here verifies bit-for-bit the way the
 * in-memory ledger's does — the `correlationId` is generated locally (its exact value is opaque and
 * only has to be present and stable once written, since the hash covers it).
 *
 * Handles: the durable handles are (1) checkpoint ids — already persisted by the git backend's own
 * object store under `.rewind/snapshots.git` — and (2) the per-scope evidence chains persisted here.
 * Nothing is held in connection or session memory; a fresh process reconstructs all state from disk.
 * Every read (list/verify/head/spentAt-via-list) re-reads the file, so disk is the single source of
 * truth and a later process always sees an earlier one's committed effects.
 *
 * Concurrency: appends are serialized per scope WITHIN a process. Cross-process writers are not
 * file-locked (last flush wins) — acceptable for the CLI's one-append-per-invocation model; the
 * barrier's spentAt scan over the persisted chain is what enforces refuse-across-rewind between
 * processes, not the in-process idempotency map.
 *
 * This store NEVER inspects the filesystem to make a barrier decision — it only serializes the
 * effect log / trace to and from a file. The barrier and chain logic stay filesystem-blind.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { computeEntryHash, EvidenceLedgerError, GENESIS_HASH, verifyChain } from "@rewind/core";
import type {
  AuditEntry,
  AuditEntryInput,
  AuthorityResolver,
  EvidenceLedger,
  LedgerOptions,
  LedgerQuery,
  UnhashedEntry,
  VerifyResult,
} from "@rewind/core";

export interface FileEvidenceLedgerOptions extends LedgerOptions {
  /** Absolute path to the JSON file the chain is persisted to (created on first append). */
  path: string;
}

const NOOP_AUTHORITY: AuthorityResolver = () => ({ onBehalfOf: null, authorityChain: [] });

interface ResolvedConfig {
  vocabulary?: readonly string[];
  approvalActions: ReadonlySet<string>;
  resolveAuthority: AuthorityResolver;
}

/** On-disk shape. `version` guards a future migration; `scopes` maps a scope to its ordered chain. */
interface PersistShape {
  version: 1;
  scopes: Record<string, AuditEntry[]>;
}

/**
 * Provenance resolution, kept byte-for-byte equivalent to the core memory ledger's so an entry built
 * here hashes identically to one the in-memory ledger would build for the same input.
 */
function resolveProvenance(
  input: AuditEntryInput,
  config: ResolvedConfig,
): { onBehalfOf: string | null; authorityChain: readonly string[] } {
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
  const provenance = resolveProvenance(input, config);
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
    correlationId: randomUUID(),
  };
  return { ...unhashed, hash: computeEntryHash(unhashed) };
}

function idempotencyMapKey(scopeLabel: string, action: string, idempotencyKey: string): string {
  return `${scopeLabel}\0${action}\0${idempotencyKey}`;
}

export function createFileEvidenceLedger(opts: FileEvidenceLedgerOptions): EvidenceLedger {
  const config: ResolvedConfig = {
    vocabulary: opts.vocabulary,
    approvalActions: new Set(opts.approvalActions ?? []),
    resolveAuthority: opts.resolveAuthority ?? NOOP_AUTHORITY,
  };
  const path = opts.path;
  // Per-instance idempotency (matches the memory ledger, whose map is also per-instance). The
  // cross-process guard is the barrier's spentAt scan over the persisted chain, not this map.
  const byIdempotencyKey = new Map<string, AuditEntry>();

  function load(): Map<string, AuditEntry[]> {
    const chains = new Map<string, AuditEntry[]>();
    if (!existsSync(path)) return chains;
    let parsed: PersistShape;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as PersistShape;
    } catch (err) {
      throw new EvidenceLedgerError(
        `rewind: the evidence store at ${path} is corrupt and cannot be parsed (${(err as Error).message}); ` +
          `refusing to append onto an unreadable chain`,
      );
    }
    for (const [scope, entries] of Object.entries(parsed?.scopes ?? {})) {
      chains.set(scope, [...(entries ?? [])]);
    }
    return chains;
  }

  function flush(chains: Map<string, AuditEntry[]>): void {
    const shape: PersistShape = { version: 1, scopes: {} };
    for (const [scope, entries] of chains) shape.scopes[scope] = entries;
    mkdirSync(dirname(path), { recursive: true });
    // Atomic replace: write a sibling temp then rename over the target so a reader never sees a
    // half-written file.
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(shape));
    renameSync(tmp, path);
  }

  // Per-scope serialization so two concurrent appends in the same process cannot both read the same
  // head and fork the chain. Failures do not wedge the queue (both arms settle the tail).
  const tails = new Map<string, Promise<unknown>>();
  function serialize<T>(scope: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(scope) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    tails.set(
      scope,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async function append(input: AuditEntryInput): Promise<AuditEntry> {
    if (typeof input.action !== "string" || input.action.trim() === "") {
      throw new EvidenceLedgerError("an audit entry requires a non-empty action");
    }
    if (config.vocabulary && !config.vocabulary.includes(input.action)) {
      throw new EvidenceLedgerError(`${input.action} is not in the injected action vocabulary`);
    }
    // Validate provenance before entering the queue (mirrors the core ledger's ordering).
    resolveProvenance(input, config);
    return serialize(String(input.scopeLabel), async () => {
      if (input.idempotencyKey) {
        const mapKey = idempotencyMapKey(String(input.scopeLabel), input.action, input.idempotencyKey);
        const existing = byIdempotencyKey.get(mapKey);
        if (existing) return existing;
      }
      // Re-read from disk so a fresh process (or a sibling append) chains onto the latest committed head.
      const chains = load();
      const chain = chains.get(input.scopeLabel) ?? [];
      const head = chain[chain.length - 1];
      const entry = buildEntry(input, head ? head.seq + 1 : 0, head ? head.hash : GENESIS_HASH, config);
      chain.push(entry);
      chains.set(input.scopeLabel, chain);
      flush(chains);
      if (input.idempotencyKey) {
        byIdempotencyKey.set(idempotencyMapKey(String(input.scopeLabel), input.action, input.idempotencyKey), entry);
      }
      return entry;
    });
  }

  async function verify(scopeLabel: string): Promise<VerifyResult> {
    return verifyChain(load().get(scopeLabel) ?? []);
  }

  async function list(query: LedgerQuery = {}): Promise<readonly AuditEntry[]> {
    const chains = load();
    const source = query.scopeLabel ? (chains.get(query.scopeLabel) ?? []) : [...chains.values()].flat();
    const filtered = query.action ? source.filter((e) => e.action === query.action) : source;
    return query.limit !== undefined ? filtered.slice(0, query.limit) : filtered;
  }

  async function head(scopeLabel: string): Promise<AuditEntry | undefined> {
    const chain = load().get(scopeLabel);
    return chain && chain.length > 0 ? chain[chain.length - 1] : undefined;
  }

  return { durable: true, append, verify, list, head };
}
