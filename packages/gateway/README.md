# @agent-rewind/gateway

The token-saving LLM proxy of [Agent Rewind](https://github.com/DarkStar616/rewind) — local, **byte-exact**
record/replay for AI coding agents, plus prompt-cache preservation, deterministic pruning, and
verifiable savings accounting.

Provides:

- **Byte-exact record/replay** (`canonicalizeRequest`, `createReplayer`, `createMemoryRecordStore`) —
  a request's replay key is a SHA-256 over a **deny-list** projection, so a byte-equivalent request
  after a rewind is served from record at zero upstream cost, while a semantically different request
  is **never** served a stale answer (false-miss over false-hit, by design).
- **Prompt-cache preservation** (`planCacheBreakpoints`) — inject one cache breakpoint on the static
  prefix when the agent set none; credit only what it actually caused.
- **Deterministic, lossless pruning** (`pruneToolOutputs`) — collapse duplicate `tool_result` blocks,
  replay-safe by construction.
- **Honest metering & gainshare surface** (`avoidedCostMicros`, `billableSavedTokens`, `analyzeTraffic`
  + `attestAnalysis`, `reconcileAgainstProviderBill`) — priced from the provider's own usage, floored,
  never over-crediting; reports fold into a verifiable hash chain.

**Provider-neutral.** Three built-in adapters cover **Anthropic** (`/v1/messages`), **OpenAI**
(`/v1/chat/completions`), and **Google Gemini** (`:generateContent`), auto-selected per request or pinned
explicitly. Any **OpenAI-compatible** endpoint (Kimi / Moonshot, DeepSeek, Together, Fireworks, Groq,
OpenRouter, Nebius, xAI, vLLM, Ollama, …) is handled by the OpenAI adapter. The byte-exact replay key is
provider-agnostic; unlisted models meter against a conservative default rate (under-bills, never over).

```bash
npm install @agent-rewind/gateway
```

Requires Node ≥ 20. Licence: **FSL-1.1-ALv2**. See the [monorepo](https://github.com/DarkStar616/rewind)
for architecture and the full product breakdown.

## Optional encrypted storage foundation

`openSqliteStorage({ directory, tenant, wrappingKey })` opens an asynchronous SQLite worker. Use an
absolute, dedicated owner-only directory and a 32-byte key supplied by your application; do not put
keys in request headers, command-line arguments or source control. Values are binary and encrypted;
namespace names remain public. The optional `better-sqlite3@12.11.1` driver may need a compiler and
Node headers (Node 20 prebuilt coverage is incomplete). A requested durable open fails if the driver
cannot load; compatibility installations do not require it.

Use `commit(transactionId, mutations)` for atomic writes, `expectedRevision: null` for absence, or a
returned revision for compare-and-swap. Reuse the same transaction ID and exact mutations after an
ambiguous completion; conflicting retries fail. `get` and paginated `scan` exclude expired values.
`createEncryptedStaging(storage)` adds bounded, ordered encrypted chunks and an explicit seal before
reading. Schedule `collectExpired()` to remove abandoned/expired stages. Always await `close()`.

This is a storage API foundation, not yet the CLI replay backend. Physical erasure, key rotation,
transaction-receipt retention and the full packaging/crash-test matrix remain future work. WAL size
under stalled external readers is not an absolute disk quota. See `docs/STABILITY.md` for the contract.
