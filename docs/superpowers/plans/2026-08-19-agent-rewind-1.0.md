# Agent Rewind 1.0 Implementation Plan

> **For agentic workers:** This plan is executed by the overnight workflow
> `.claude/workflows/agent-rewind-1.0.mjs` (one implementer agent per milestone, a
> parallel adversarial-verify + `npm run check` gate after each, bounded fix loop).
> It is also human-executable task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Take Agent Rewind from `0.1.x` to a credible `1.0.0` — a stable, verified,
provider-neutral release we stand behind — without pulling any deferred phase forward.

**Architecture:** Introduce a small `ProviderAdapter` seam in `@agent-rewind/gateway` so
the record/replay proxy's three body-coupled decisions (path match, recordable-success
terminal detection, usage extraction) are per-provider, with three concrete adapters
(Anthropic, OpenAI-compatible, Gemini). Everything else — the byte-exact replay core, the
effect barrier, the hash chain — is already provider-agnostic and does **not** change.

**Tech Stack:** TypeScript (Node ≥ 20 runtime, ≥ 24.15 build), ESM, `.ts` import
specifiers, `node:test`, npm workspaces, tsup. No new runtime dependencies.

**Spec:** This plan is the spec. It argues from the 5-gate 1.0 definition agreed in
conversation and from `docs/PLAN.md` (Slice 1/1.5/2 acceptance) and `docs/POSITIONING.md`
§5 (distribution). `docs/RIP-LIST.md` #6/#7 informs M4.

## Global Constraints

- **The effect barrier and hash chain never read the filesystem.** They read the effect
  log and trace only. No task may change that. (`@agent-rewind/core`.)
- **Exact-replay determinism is sacred.** The replay key is a generic hash over the
  canonicalised request body; no provider adapter may make the key provider-specific or
  introduce a false cache hit. Adapters touch *recording/metering/terminal-detection only*,
  never the key.
- **Meter only the provider's own reported tokens; floor, never round up.** (`meter.ts`.)
- **One real implementation** of the barrier/chain (the TypeScript one). No second impl.
- **Do not market Tier 0 as isolation.** Reversibility only.
- **Licence FSL-1.1-ALv2**, three source-available packages `@agent-rewind/{core,gateway,mcp}`.
- **Node runtime floor ≥ 20**, build ≥ 24.15. Keep `engines` consistent.
- **No new npm runtime dependencies** without an explicit note in the PR body.
- Small commits on one branch; **one PR at the end** (CI-cost discipline, per operator
  directive). Per-milestone gating happens *inside the workflow*, not via CI.
- **Human-gated steps are parked, never faked**: real-client GUI smoke, `npm publish` (2FA
  OTP), and registry submissions are surfaced as residuals for the operator, not done by an
  agent.

---

## Milestone map & autonomy

| # | Milestone | Autonomous (workflow ships it) | Human-gated residual (parked) |
|---|-----------|-------------------------------|-------------------------------|
| M1 | Provider neutrality | Adapter seam + 3 adapters + fixtures + tests | — |
| M2 | E2E verification | Stdio JSON-RPC protocol e2e + plugin hook test | Real Claude Code/Cursor GUI smoke |
| M3 | Distribution surface | Docs page, snippets, deeplinks, registry manifests | Actual registry submissions (accounts) |
| M4 | Savings receipt hardened | Zero-guard confirmed + OpenAI reconcile adapter + tests | — |
| M5 | API freeze & release-prep | STABILITY.md, 10× soak, codex review, 1.0.0 bump, build+pack+install-verify, draft PR | PR merge + `npm publish` + OTP |

---

## Task M1: Provider neutrality (the `ProviderAdapter` seam)

**Files:**
- Create: `packages/gateway/src/providers/provider-adapter.ts` (interface + registry + selection)
- Create: `packages/gateway/src/providers/anthropic.ts`
- Create: `packages/gateway/src/providers/openai.ts`
- Create: `packages/gateway/src/providers/gemini.ts`
- Modify: `packages/gateway/src/usage.ts` (extract shared field-picker; keep Anthropic SSE fold in the anthropic adapter)
- Modify: `packages/gateway/src/proxy.ts:120,136,302,359` (select adapter; `matchPath` replaces the single-path check; `isRecordableSuccess`/`extractUsage` go through the adapter)
- Modify: `packages/gateway/src/meter.ts:57-71` (add OpenAI + Gemini list-price rows; keep the conservative `default`)
- Modify: `packages/gateway/src/index.ts` (export the adapter surface)
- Create: `packages/gateway/test/providers.test.ts`
- Create: `packages/gateway/test/fixtures/streams.ts` (three recorded streaming fixtures)

**Interfaces:**
- Produces:
  ```ts
  export interface ProviderAdapter {
    readonly id: "anthropic" | "openai" | "gemini";
    /** Is this a recordable model call for this provider?
     *  anthropic: POST /v1/messages
     *  openai:    POST /v1/chat/completions (also /v1/responses)
     *  gemini:    POST /v1beta/models/<model>:generateContent|:streamGenerateContent */
    matchPath(method: string | undefined, url: string | undefined): boolean;
    /** COMPLETE, non-error 2xx worth freezing? Per-provider terminal:
     *  anthropic: SSE has message_stop & no error / JSON type!=="error"
     *  openai:    SSE ends with `data: [DONE]`, ≥1 chunk, no error object / JSON has choices, no top-level error
     *  gemini:    a candidate with finishReason and no `error` field */
    isRecordableSuccess(body: Buffer, contentType: string): boolean;
    /** Provider-reported usage + model, JSON or streamed. Reuses meter/usage semantics. */
    extractUsage(raw: Buffer | string, contentType: string | undefined): ExtractedUsage;
  }
  export function selectAdapter(
    opts: { provider?: ProviderAdapter["id"] },
    method: string | undefined,
    url: string | undefined,
  ): ProviderAdapter | undefined; // explicit opts.provider wins; else first adapter whose matchPath() is true
  export const ADAPTERS: readonly ProviderAdapter[];
  ```
- Consumes: `ExtractedUsage`, `ProviderUsage` (`usage.ts`/`record-store.ts`), `pickUsage` (refactored into a shared `pickUsageFields` that additionally reads Gemini `usageMetadata.promptTokenCount`/`candidatesTokenCount`/`cachedContentTokenCount`).
- `ProxyOptions` gains optional `provider?: "anthropic" | "openai" | "gemini"` (default: auto-detect by path; falls back to `anthropic` for the legacy `messagesPath`).

- [ ] **Step 1: Write the failing acceptance test** (`packages/gateway/test/providers.test.ts`). For EACH of the three fixtures, assert the full record→replay→meter chain:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRecordableSuccessFor, extractUsageFor, selectAdapter } from "../src/providers/provider-adapter.ts";
import { meterAvoidance } from "../src/meter.ts";
import { ANTHROPIC_SSE, OPENAI_SSE, GEMINI_SSE } from "./fixtures/streams.ts";

for (const f of [ANTHROPIC_SSE, OPENAI_SSE, GEMINI_SSE]) {
  test(`${f.id}: streamed 2xx is recordable, meters non-zero`, () => {
    const a = selectAdapter({ provider: f.id }, "POST", f.url);
    assert.ok(a, "adapter resolves by path");
    assert.equal(a!.matchPath("POST", f.url), true);
    assert.equal(a!.isRecordableSuccess(Buffer.from(f.body), f.contentType), true);
    const { usage, model } = a!.extractUsage(f.body, f.contentType);
    const metered = meterAvoidance(usage, model ?? f.model);
    assert.ok(metered.tokensAvoided > 0, "tokens avoided must be > 0");
    assert.ok(metered.costMicros > 0, "avoided cost must be > 0");
  });
  test(`${f.id}: a truncated stream (no terminal) is NOT recordable`, () => {
    const a = selectAdapter({ provider: f.id }, "POST", f.url)!;
    assert.equal(a.isRecordableSuccess(Buffer.from(f.truncatedBody), f.contentType), false);
  });
}

test("auto-detect: an OpenAI chat path selects the openai adapter, not anthropic", () => {
  const a = selectAdapter({}, "POST", "/v1/chat/completions");
  assert.equal(a?.id, "openai");
});
test("auto-detect: a Gemini generateContent path selects the gemini adapter", () => {
  const a = selectAdapter({}, "POST", "/v1beta/models/gemini-2.5-pro:streamGenerateContent");
  assert.equal(a?.id, "gemini");
});
```

- [ ] **Step 2: Write the three fixtures** (`test/fixtures/streams.ts`) — small but real terminal-bearing streams: Anthropic (`message_start` w/ input+cache usage → `content_block_delta` → `message_delta` w/ `output_tokens` → `message_stop`); OpenAI (two `data:` chunks with `choices[].delta`, a final chunk carrying `usage:{prompt_tokens,completion_tokens,prompt_tokens_details:{cached_tokens}}`, then `data: [DONE]`); Gemini SSE (`data:` GenerateContentResponse chunks, last with `candidates[].finishReason:"STOP"` and `usageMetadata:{promptTokenCount,candidatesTokenCount,cachedContentTokenCount}`). Each fixture also carries a `truncatedBody` with the terminal removed.

- [ ] **Step 3: Run — expect FAIL** (`selectAdapter`/`isRecordableSuccessFor` undefined). `NODE_OPTIONS=--conditions=development node --test packages/gateway/test/providers.test.ts`.

- [ ] **Step 4: Implement** the interface + registry + selection (`provider-adapter.ts`), then the three adapters. The `anthropic` adapter is the current `isRecordableSuccess`/`extractSse` logic moved verbatim (no behaviour change). `openai`/`gemini` implement their terminals and usage folds. Refactor `usage.ts`'s `pickUsage` into a shared `pickUsageFields` that also reads Gemini `usageMetadata`.

- [ ] **Step 5: Wire `proxy.ts`** — resolve `const adapter = selectAdapter(options, req.method, req.url)`; replace the `isMessages` single-path check with `adapter?.matchPath(...)`; route recording through `adapter.isRecordableSuccess` and `adapter.extractUsage`. Keep the legacy `messagesPath` default so existing Anthropic callers are unaffected (regression: the whole existing gateway suite must still pass).

- [ ] **Step 6: Add OpenAI + Gemini price rows** to `DEFAULT_PRICE_TABLE` (public list prices, dated `version`), keeping the conservative cheapest `default`.

- [ ] **Step 7: Run the FULL gateway suite** — `npm run check` green (new + all existing). Expected: PASS.

- [ ] **Step 8: Commit** — `feat(gateway): ProviderAdapter seam + Anthropic/OpenAI/Gemini adapters (streaming record+meter for all three)`.

**Acceptance:** From recorded *streaming* fixtures, all three providers record (terminal detected), replay byte-identical, and meter a strictly-positive token+cost figure; auto-detection routes each path to its adapter; the entire existing gateway suite still passes unchanged. Only now may docs say "any provider."

---

## Task M2: End-to-end verification (the honesty gate)

**Files:**
- Create: `packages/mcp/test/e2e-stdio.test.ts` (spawns the built server, drives real JSON-RPC)
- Create: `docs/verification/2026-08-19-real-client-smoke.md` (the human GUI checklist + a slot to paste the captured transcript)
- Verify (no change unless broken): `packages/mcp/test/dist-plugin.test.ts` (PreToolUse hook wiring)

**Interfaces:**
- Consumes: the built `packages/mcp/dist/cli.js` `mcp` bin; the five/eight MCP tools; `@agent-rewind/core` engine.

- [ ] **Step 1: Write the failing e2e** — spawn `node packages/mcp/dist/cli.js mcp` as a child, speak MCP over stdio: `initialize` → `tools/list` (assert the 8 tools) → `checkpoint` (capture handle) → make a file edit on disk in a temp git repo → `guard_effect` on a fresh key (assert spent) → `rewind` to the handle → `guard_effect` on the SAME key (assert **refused**, structured deny-reason) → assert the refusal is on the chain and `verify` passes. This is the `docs/PLAN.md` Slice-1 success demo, executed through the real MCP wire.

- [ ] **Step 2: Run — expect FAIL** (test not written / server path). Then build (`npm run build -w @agent-rewind/mcp`) and implement the harness until green.

- [ ] **Step 3: Confirm the plugin hook** — `dist-plugin.test.ts` asserts `dist-plugin/hooks/hooks.json` wires a `PreToolUse` `guard_effect` matcher on `Bash|Write|Edit`. Extend it if it only checks presence, not the matcher shape.

- [ ] **Step 4: Write the human GUI checklist** (`docs/verification/…-real-client-smoke.md`): the exact `claude mcp add agent-rewind …` line, the 5 tool calls to run in Claude Code and in Cursor, and what "refused" looks like — with an empty "PASTE TRANSCRIPT HERE" block. **This step's *execution* is the parked human residual**; the workflow writes the checklist, the operator runs it.

- [ ] **Step 5: Commit** — `test(mcp): stdio JSON-RPC end-to-end (checkpoint→edit→rewind→refused, chain-verified) + real-client smoke checklist`.

**Acceptance (autonomous):** the stdio e2e completes the refuse-and-record demo over the real MCP protocol and asserts chain verification; the plugin PreToolUse matcher is asserted. **Parked residual:** operator runs the GUI checklist in Claude Code + Cursor and pastes the transcript into the verification doc — the only thing that closes "verified against a real client."

---

## Task M3: Distribution surface

**Files:**
- Create/replace: `docs/install/README.md` (the copy-paste install page)
- Create: `packages/mcp/server.json` (official MCP registry manifest) + `docs/distribution/pulsemcp.md` (PulseMCP listing copy)
- Modify: `README.md` (link the install page; add the "any provider" line unlocked by M1)

- [ ] **Step 1: Write the two config snippets** in `docs/install/README.md`: a JSON `mcpServers` block (`"type":"stdio"`, `npx -y @agent-rewind/mcp mcp`) for Claude Code/Cursor/Cline/Windsurf, and a TOML `[mcp_servers.agent-rewind]` block for Codex CLI; plus the `claude mcp add agent-rewind …` / `codex mcp add …` one-liners as the primary path.
- [ ] **Step 2: Add the deeplinks** — an "Add to Cursor" `cursor://anysphere.cursor-deeplink/mcp/install?...` (base64 config payload) and the `windsurf://` equivalent, on the install page.
- [ ] **Step 3: Write the registry manifest** `server.json` per the official MCP registry schema (name `io.github.<owner>/agent-rewind` or the reserved namespace, package `@agent-rewind/mcp`, transport stdio) and validate it against the schema. Write the PulseMCP submission copy.
- [ ] **Step 4: Add a test** `packages/mcp/test/server-json.test.ts` asserting `server.json` parses, its package name/version match `package.json`, and the transport is stdio. Run — green.
- [ ] **Step 5: Commit** — `docs(dist): install page (snippets + Cursor/Windsurf deeplinks), MCP registry manifest, PulseMCP copy`.

**Acceptance (autonomous):** a new user can copy one block and get a working server on Claude Code, Cursor, and Codex; the deeplinks and `server.json` exist and validate. **Parked residual:** actual submission to PulseMCP + the official registry (needs the operator's accounts) — surface the ready-to-submit manifest and copy.

---

## Task M4: Savings receipt hardened

**Files:**
- Verify (already green): `packages/gateway/test/billable.test.ts:6-16` (empty list ⇒ `{0,0,0}` — the anti-inflation guard already exists)
- Modify: `packages/gateway/src/reconcile.ts` (+ its test) — add an OpenAI usage-API `ProviderUsageFetcher` shape alongside the existing Anthropic one
- Modify: `packages/mcp/src/{server.ts,cli.ts}` only if the `savings` tool/command does not already report the honest zero — confirm first, change only if needed

- [ ] **Step 1: Confirm the zero-guard** — run `billable.test.ts`; it must assert `billableSavedTokens([]) === {billableTokens:0,billableCostMicros:0,realizedReplays:0}`. (It does today — this step is a verification, not a rewrite.)
- [ ] **Step 2: Write a failing reconcile test** — feed a stub OpenAI-shaped usage response (`{ total_usage: { input_tokens, output_tokens } }` from the OpenAI Usage API) through `reconcileAgainstProviderBill` with an injected fetcher; assert the chain-attested per-call figure reconciles against the aggregate bill and the report flags any delta.
- [ ] **Step 3: Implement** the OpenAI fetcher adapter in `reconcile.ts` (inject the fetcher; no live network in tests). Anthropic path unchanged.
- [ ] **Step 4: Run `npm run check`** — green.
- [ ] **Step 5: Commit** — `feat(gateway): OpenAI usage-API reconciliation adapter; confirm savings zero-guard`.

**Acceptance:** `savings` reports exactly the sum of realised `ReplaySaving` records and **0** for a no-replay run; reconciliation works against both an Anthropic- and an OpenAI-shaped provider bill via an injected fetcher. The hash-attested public "analysis mode" report (RIP #7) stays **post-1.0**.

---

## Task M5: API freeze, hardening, cut 1.0

**Files:**
- Create: `docs/STABILITY.md` (the 1.0 public-API stability guarantee + the frozen export surface of core & gateway)
- Create: `packages/core/test/public-api.test.ts` + `packages/gateway/test/public-api.test.ts` (snapshot the exported names; a removal fails the test)
- Modify: `packages/{core,gateway,mcp}/package.json` → `1.0.0`; `packages/mcp` deps on core/gateway → `^1.0.0`
- Create/modify: `CHANGELOG.md`

- [ ] **Step 1: Snapshot the public API** — a test that imports each package's `index.ts` and asserts the exact set of exported names (from `packages/core/src/index.ts` and `packages/gateway/src/index.ts`). This *is* the freeze: any later removal/rename breaks the test. Run — green on the current surface.
- [ ] **Step 2: Write `STABILITY.md`** — "1.0 means these exports are stable under semver; additions are minor, removals are major." List the frozen surfaces.
- [ ] **Step 3: 10× soak** — run `npm run check` ten times; all green (guards against a flaky effect-barrier/git-backend race). Capture pass/fail counts.
- [ ] **Step 4: Cross-vendor review** — `codex exec review` (unsteered) over the full 1.0 diff; fix findings; re-review until clean. **Mandatory build step.** If `codex` is unavailable in the run, park this as a residual and say so — do not skip silently.
- [ ] **Step 5: Version bump** all three to `1.0.0`, sync `mcp` internal deps to `^1.0.0`, write `CHANGELOG.md`, `npm install` to sync the lockfile.
- [ ] **Step 6: Build + pack + install-verify** — `npm run build`; `npm pack` all three; install the tarballs into a clean temp consumer and run the smoke (`npx agent-rewind --version`, a checkpoint round-trip). Green.
- [ ] **Step 7: Commit + open ONE draft PR** — `release: 1.0.0 — provider-neutral, verified, API-frozen`. Do **not** merge; do **not** publish.

**Acceptance (autonomous):** all suites green ×10, public-API snapshot in place, codex review addressed (or parked with reason), all three at `1.0.0`, tarballs install-verified, a single draft PR open. **Parked residual:** operator merges the PR and runs `npm publish -w @agent-rewind/{core,gateway,mcp}` with the 2FA OTP.

---

## Self-review (done at authoring)

- **Spec coverage:** M1↔Q1 provider neutrality; M2↔PLAN Slice-1 acceptance; M3↔POSITIONING §5 four artifacts; M4↔Slice-1.5 zero-guard + RIP #6; M5↔the semver meaning of 1.0. Deferred items (hosted, jail, web, semantic cache, compression, human-gate, billing) explicitly out of scope.
- **Placeholder scan:** interfaces and the load-bearing acceptance tests are concrete; fixtures specified by exact terminal/usage shape.
- **Type consistency:** `ProviderAdapter.id` is the same union in the interface, `selectAdapter`, and the fixtures; `ExtractedUsage`/`ProviderUsage` reused from existing modules, not redefined.
- **Autonomy honesty:** every human-gated step is named as a parked residual, never folded into an "autonomous" acceptance.
