# Changelog

All notable changes to the `@agent-rewind/*` packages are recorded here. The three packages
(`@agent-rewind/core`, `@agent-rewind/gateway`, `@agent-rewind/mcp`) are versioned and released
together. This project follows [Semantic Versioning](https://semver.org/); the public-API contract
each package guarantees under semver is documented in [`docs/STABILITY.md`](docs/STABILITY.md).

## 1.0.0 — 2026-08-19

First stable release: provider-neutral, verified end-to-end, and API-frozen. Everything below shipped
across milestones M1–M5 of the 1.0 plan without pulling any deferred phase forward.

### Added

- **Provider neutrality (`@agent-rewind/gateway`).** A small `ProviderAdapter` seam makes the
  record/replay proxy's three body-coupled decisions — path match, recordable-success terminal
  detection, and usage extraction — per-provider, with three concrete adapters:
  - **Anthropic** (`POST /v1/messages`) — the existing behaviour, moved behind the seam unchanged.
  - **OpenAI-compatible** (`POST /v1/chat/completions`) — SSE `[DONE]` terminal + `usage` fold,
    covering OpenAI, Nebius, Together, Groq, and similar.
  - **Gemini** (`POST /v1beta/models/<model>:generateContent|:streamGenerateContent`) — handles all
    three Gemini wire shapes (SSE, the default JSON-array stream, and single-object JSON), folding
    `usageMetadata` for metering.
  - Auto-detection routes each request to its adapter by path; an explicit `provider` pin overrides it
    and is now strictly honoured (a pinned proxy never falls back to Anthropic semantics).
  - Public list-price rows added for the OpenAI and Gemini model families (conservative dated table),
    and the meter resolves a versioned/snapshot model id (e.g. `gpt-4o-2024-08-06`) to its base family
    rate instead of the cheap default.
- **Savings-receipt hardening (`@agent-rewind/gateway`).** An OpenAI usage-API reconciliation adapter
  (`openAiUsageFetcher` / `reconcileAgainstProviderBillWith`) that parses the real organization-usage
  bucket shape (`data[].results[]`) and reconciles chain-attested billable savings against the
  provider's own aggregate bill; the anti-inflation zero-guard (an empty batch bills exactly zero) is
  confirmed by test.
- **End-to-end verification (`@agent-rewind/mcp`).** A stdio JSON-RPC end-to-end test drives the built
  server through the full refuse-and-record demo (checkpoint → edit → rewind → refused → chain
  verified), and the PreToolUse plugin-hook matcher is asserted. A human real-client GUI smoke
  checklist is provided for Claude Code and Cursor.
- **API stability contract.** [`docs/STABILITY.md`](docs/STABILITY.md) documents the frozen public
  export surface of `@agent-rewind/core` and `@agent-rewind/gateway`, enforced by public-API snapshot
  tests that derive the live export set on every run (a removal or rename fails the build; a star
  re-export that would bypass the snapshot is rejected).

### Changed

- **Replay-key identity now includes the request URL path.** The replay key folds the request pathname
  (query stripped of auth material such as Gemini's `?key=`, non-auth params like `?alt=sse` retained)
  in addition to the canonicalised body and output-affecting headers. This is provider-neutral — the
  same fold runs for every provider — and it closes a false-hit class for providers that name the
  model or the wire format in the URL rather than the body (two Gemini models sent an identical body no
  longer collide onto one record). The free savings-analysis surface keys on the URL the same way, so
  its report never over-credits a URL-addressed repeat.
  - **Upgrade note:** the replay-key scheme changed, so a *persistent* record store written by a
    pre-1.0 build will re-miss and regenerate on first use — a miss only forwards one live call
    (fail-open), never a wrong answer. The shipped proxy uses an in-memory store, so nothing persists
    across the bump. A no-URL fallback was deliberately not added, as it would reintroduce the false-hit.
- All three packages bumped to **1.0.0**; `@agent-rewind/mcp` internal dependencies pinned to `^1.0.0`.

### Notes

- No new runtime dependencies were added in this release.
- Deferred out of 1.0 (unchanged): the hosted service, the OS-jail isolation tier, the web connector,
  semantic caching, context compression, the OpenAI Responses API (`/v1/responses`) adapter, and the
  distribution/website surface. Tier 0 (git snapshots) remains **reversibility, not isolation**.
