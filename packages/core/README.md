# @agent-rewind/core

The portable core of [Agent Rewind](https://github.com/DarkStar616/rewind) — reversible execution for AI
agents, as pure logic over logs and traces (never the filesystem or clock, so it runs unchanged across
backend tiers).

Provides:

- **`WorldBackend`** — the whole-workspace snapshot/restore interface, with a Tier-0 git implementation
  (`createGitBackend`): append-only snapshot chain, atomic restore that rolls back on a mid-flight
  failure, and secret/heavy-dir excludes.
- **The effect barrier** (`createEffectLedger`) — admit-once / refuse-and-record over
  `(scope, effectKey)` identity, so a spent external effect can't be re-fired across a rewind.
- **The tamper-evident hash chain** (`createMemoryEvidenceLedger`, `computeEntryHash`, `verifyChain`) —
  append-only, per-scope, SHA-256-linked, fail-closed verification. The action vocabulary and authority
  resolver are injected, so it carries no product-specific vocabulary.
- **Canonical JSON** (`canonicalize`), the **engine** (`createEngine`), a **replay-savings** sink, and
  an AgentRewind-style **recovery/failure-memory** model.

```bash
npm install @agent-rewind/core
```

Requires Node ≥ 20. Licence: **FSL-1.1-ALv2**. See the [monorepo](https://github.com/DarkStar616/rewind)
for architecture and the full product breakdown.
