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

```bash
npm install @agent-rewind/gateway
```

Requires Node ≥ 20. Licence: **FSL-1.1-ALv2**. See the [monorepo](https://github.com/DarkStar616/rewind)
for architecture and the full product breakdown.
