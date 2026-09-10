# Rewind: OSS integration and measured efficiency roadmap

Date: 2026-09-09. Addendum to the accepted
[full v1.1 plan](2026-09-09-001-perf-maximize-token-savings-plan.md), which remains
unchanged. This document incorporates the user's explicit direction to reuse
Bifrost, Headroom and agenticstash. It is a delivery design and review packet,
not a statement that these capabilities have shipped.

## Objective and scope

Build an engineering showcase that is useful independently: reliable recovery,
less unnecessary context, lower cost per successful task, and straightforward
local operation. Existing OSS is the preferred starting point. Competitive
feature overlap is a source of reusable engineering, not a reason to avoid a
feature. Rewind must own the integration quality and demonstrate the result.

The research baseline is [the competitiveness report](../research/2026-09-09-rewind-competitiveness.md).
Do not replace measured performance with competitors' advertised percentages.
The desired outcome is an efficient complete workflow, including failures,
retrieval, cache rebuilds and retries.

Implementation authority already exists for the feature work. The standing
human-authored core-oracle requirement remains a separate prerequisite for
correctness-critical changes; the earlier automatic-review rejection has not
been retried. Work proceeds on source inspection, provenance, interfaces and
other unaffected tasks while that prerequisite is unresolved.

## OSS reuse decisions

| Source and pinned revision | Take into Rewind | Adaptation and boundary |
| --- | --- | --- |
| Bifrost `1d89501c733e94feeadce1b1ec9f0b76ec0a670f` | Direct-cache lifecycle, scoped keys, TTL/bypass/no-store controls, upstream protocol test cases | Its Go plugin depends on Bifrost core/framework. Use an optional service integration or a reviewed TypeScript port of bounded policies; copying `main.go` alone is not a working feature. Retain Rewind's conservative request identity and strict tape mode; upstream lowercasing/trimming must not enter that identity. |
| Headroom `7bd4dbaf8f40d00f579f1cfca4bc56716f508d85` | Prefix/history classification, cache-alignment detectors, retrieval ownership contracts, BM25 relevance and recoverable-context design | Begin with advisory diagnostics. Later use Rewind's encrypted storage for exact originals. Upstream comparison projections and provider price constants are not replay or accounting authority. |
| agenticstash `b73efb4378df37de893901b9016abf6498f2474f` | Recording exchange, ordered-event comparison, forks/diffs, supplementary integrity seals | Zero required runtime dependencies makes selective TypeScript reuse practical. Validate the exchange format and preserve raw HTTP bytes separately. Its own seal is not Rewind evidence-chain equivalence or a digital signature. |

All three inspected roots carry Apache-2.0 licenses. Source snapshots, licenses,
notices and file hashes are staged under `third_party/`. Publish-time packaging
must include the relevant licenses/notices. Ports need modification notices and
upstream provenance. Rewind currently declares FSL-1.1-ALv2; changing Rewind's
license is an explicit owner decision and is not part of importing these files.

Prefer selective source reuse where it produces a small, maintainable module.
Prefer an optional process where importing the upstream runtime would otherwise
bring a large dependency tree into the default installation. Do not maintain two
independent authorities for replay, encryption or accounting. Extra components
must earn their installation, latency and maintenance costs.

## Delivery order and acceptance criteria

### 1. Make replay identity and eligibility dependable

Existing units: U17, U18, U4, U28. Areas:
`packages/gateway/src/canonical-request.ts`, `proxy.ts`, provider adapters and
`record-store-v2.ts`.

Repair the confirmed `__proto__` projection collision. Cover the same class in
nested object copies and distinguish unknown behavior-changing headers. Introduce
a versioned identity generation so old keys cannot silently enter the new replay
namespace. Keep historical records available for explicit inspection; do not
rewrite them into supposedly verified new records.

Separate historical reproduction from normal fresh execution. Provider-hosted
web search, connectors and effectful tools need an explicit eligibility policy.
An identical body alone cannot establish that the outside world is unchanged.
Unknown tool behavior should bypass automatic reuse. Explicit historical replay
must identify the captured epoch and disclose its historical contract.

Acceptance: distinct meaningful JSON/header changes cannot false-hit; approved
output-neutral differences still behave as specified; incomplete streams never
become recordings; replay refusals do not move the cursor or book savings. Old
generations are excluded from normal new-generation lookup. Human-owned oracle
review is required before implementation on these paths.

Savings potential: enables trustworthy whole-call avoidance on actual eligible
repeats. It does not increase the repeat rate and has no universal percentage.
Risk: migration and compatibility. This precedes importing another cache engine.

### 2. Make all savings claims inspectable

Existing units: U1, U3, U21. Areas: `meter.ts`, mechanism ledger, CLI durable tape
wiring and the prepared transactional evidence adapter.

Separate provider-reported usage, historical record price, estimated avoided
cost and measured incremental cost difference. Unknown models have unknown dollar
value unless an explicit rate is supplied; a fallback rate cannot be called
universally conservative. Track cache reads and cache writes separately. An old
cache-write bill is not automatically the cost of a later avoided call.

Connect durable replay claims to transactional receipt events/outbox delivery.
Use distinct recording, request-occurrence and transport-retry identities.
Attribute events to tenant, epoch and checkpoint; a checkpoint-specific query
must not return unfiltered lifetime totals. Preserve conservative retry dedup.

Acceptance: crash/retry paths cannot lose or duplicate a committed accounting
event; another tenant cannot query it; repeated distinct requests and retries
have intentionally different accounting; missing price evidence never becomes
asserted realized savings. Pin Headroom revision and transform configuration into epoch provenance. Account for internal Headroom provider continuations
before crediting any composed proxy workflow.

Savings potential: no direct reduction; prevents over-credit and establishes the
measurement needed to choose real optimizations. Risk: financial correctness and
cross-process transactions. Core-oracle review remains required.

### 3. Preserve native client efficiencies before optimizing

Existing units: U2, U5, U12, U16, U24, U27. Areas: CLI setup, gateway configuration,
MCP profiles and provider protocol integration tests.

Provide an observe-first setup path with explicit client/model/endpoint profiles.
Verify actual client behavior with the proxy installed: deferred tool discovery,
Responses continuation, thinking/signatures, opaque compaction items, streaming,
cache hints and retries. Include managed-policy cases; do not silently override
client policy. Make the compact MCP profile easy to select in the real installed
plugin and preserve the existing public tool contract through versioned profiles.

Acceptance: native client and transparent-proxy arms expose equivalent supported
capabilities; installing Rewind does not accidentally load a previously deferred
large tool catalog; client-visible tool/result tokens are measured with the
actual client rather than inferred solely from character counts.

Savings potential: avoids proxy-induced regressions and reduces Rewind's own
control overhead. Risk: protocol drift. Run conformance against pinned versions.

### 4. Import Headroom prefix diagnostics and make cache decisions explicit

Existing units: U6, U7, U8, U22. Source candidates:
`headroom/cache/prefix_tracker.py`, `headroom/transforms/cache_aligner.py`.
Rewind targets: cache hygiene, capability registry and gateway policy provenance.

Port bounded detectors and history-relation diagnostics first. Report the first
changed segment, stable message/block prefix, relevant caller cache policy and
whether a proposed intervention would change sent history. Keep this comparison
identity separate from the replay identity. Add a typed context manifest that
stays outside normal model context and can be inspected through a short handle.

Version provider/model/endpoint capabilities. Preserve caller-owned cache policy;
choose supported breakpoints and TTL only with enough usage evidence. Carry the
applied policy ID into response usage events. Use native provider diagnostics
where available, and label local explanations as hypotheses when provider cache
state is unknown.

Acceptance: ordinary appends preserve the prior sent prefix; parallel
conversation lineages do not contaminate one another; policy moves never mutate
tool arguments or opaque thinking; incompatible schemas are skipped explicitly.
Paired measurements must include write premiums and cache rebuilds.

Savings potential: workload-dependent reuse improvement; can be near zero for an
already optimized native client. Risk: accidental invalidation or misattribution.

### 5. Add Bifrost-derived exact-cache controls

Existing units: U4, U14, U17, U26, U28. Source candidates:
`plugins/semanticcache/main.go`, `utils.go`, `search.go` and their upstream tests.

Add explicit TTL, bypass, no-store and namespace lifecycle controls to a clearly
separate response-cache mode. Define read bypass and write bypass independently.
Keep ordered recovery selected by cursor; never silently change it into random
sample lookup or freshness caching. Record why each request was eligible, missed,
hit or bypassed. Single-flight is an explicit policy for eligible requests, not
an assumption that identical stochastic calls must share one sample.

Use upstream tests as comparison material, then verify Rewind's stronger identity,
tenant and commit-before-delivery contracts. An optional Bifrost service connector
can supply broader gateway functionality, with route mapping and streaming
conformance tested. Do not stack independent response caches without explicit
ownership and measurement.

Acceptance: TTL and bypass controls work at boundaries; no-store does not
accidentally change read policy; fresh-request mode cannot serve stale hosted-tool
results; two stochastic samples survive ordered recording; concurrent retries
behave according to the documented policy.

Savings potential: whole-call avoidance proportional to eligible repeat traffic.
Risk: stale results and changed sampling semantics. Semantic automatic serving
remains outside the conservative coding-agent path.

### 6. Import recoverable observation delivery from Headroom

Existing units: U9, U10, U11, U13, U23, U24. Source candidates:
`headroom/ccr/tool_injection.py`, `tool_calls.py`, `cache/backends/base.py` and
`relevance/bm25.py`.

Normalize observations across supported provider formats while retaining exact
original bytes. Store originals in Rewind's encrypted transactional store; do not
adopt the upstream plaintext SQLite default or memory fallback. Return small
results inline and bound large results using stable artifact handles, exact
ranges, paging and query-driven retrieval. Enforce tenant ownership and expiry
at every retrieval, including indirect markers.

Use BM25 for explicit retrieval ranking rather than embedding every observation
or requiring a new model call. Preserve edit anchors, failing assertions and
caller-pinned content. Keep disclosure of omitted content and recovery options
short. Ensure older handles remain resolvable for as long as active checkpoints
reference them. Retrieval failure must be visible and recoverable.

Acceptance: retrieved bytes match the stored original; handles cannot cross
tenants; restart retains live artifacts; duplicate output does not duplicate
storage unnecessarily; unavailable originals never become fabricated content;
full tasks measure retrieval calls and failures as well as input reduction.

Savings potential: strongest context-volume opportunity on long, tool-heavy
workflows. Short tasks may see overhead. Risk: hiding needed evidence and causing
extra turns. Enable gradually after paired task evidence.

### 7. Integrate agenticstash exchange, fork and diff

Existing units: U4, U21, U25, U28. Source candidates: `src/types.ts`, `wire.ts`,
`replay/`, `fork/`, `diff/`, `seal/` and their dependencies.

Provide explicit recording import/export and compare commands. Preserve ordered
occurrence identity and raw HTTP metadata/body fidelity in Rewind's own format;
map only representable content into the exchange format. Label transformations
and unsupported fields. Bound file sizes, event counts and nesting before parsing
foreign recordings. Treat imported records as untrusted evidence, not automatic
permission to serve a model response.

Supplementary upstream seals can support interoperability. They cannot replace
Rewind's chain, prove signer identity or establish legal compliance. The inspected upstream seal covers selected event fields and referenced
payloads, not all recording metadata or unreferenced blobs. Input-divergence
checks skip comparison when either input is absent; Rewind must specify its
stronger required-input policy. Diff should explain the first changed input/output
and the affected occurrence without dumping full transcripts by default.

Bind workspace checkpoint ID, effect state and tape position atomically or through
a validated durable mapping. Expose explicit resume, strict replay and live-fork
operations. Refuse a cursor paired with the wrong restored world.

Acceptance: round-trip tests preserve declared fields; foreign content cannot
change the live cursor; incorrect world/tape pairings refuse; binary responses
survive native export/import; forks retain parent provenance without reusing
spent effects. Core-oracle review precedes activation.

Savings potential: reduced repeated work during recovery and debugging; frequency
must be measured. Risk: exchanging superficially similar but incompatible formats.

### 8. Prove the combined product continuously

Existing units: U1, U15, U16, U26, U28, alongside every preceding integration.

Run native client, transparent proxy, cache-only, replay-only, recoverable-output
and combined arms on identical declared workloads. Include cold/warm/post-idle
sessions, unique requests, real recovery, deliberate divergence, process failure
and missing artifacts. Pin repositories, clients, model versions, configurations
and graders. Preserve failed/excluded runs and reasons. Avoid warm-cache carryover
bias through randomized arm ordering and deliberate experimental separation.

Use publicly licensed coding-agent traces for transport replay, after verifying
dataset licenses and revisions. Add executable task evaluation and representative
owned workflows. Offline fixture savings remain explicitly simulated. Any paid
provider campaign needs a separately stated spend ceiling before execution.

Measure cost per accepted task, solve rate, eliminated input/output, cache traffic,
retrieval overhead, latency and storage. Report uncertainty and dataset selection.
Native compaction passthrough comes before optional natural-language compaction.
Optional transformation policies need a predeclared quality threshold and an
economic rule that includes reconstruction/retrieval and additional turns.

Acceptance: no critical replay-fidelity failure; native capabilities preserved;
correctness gates pass; paid results reconcile to usage evidence; published claims
state workload and configuration. There is no honest aggregate savings percentage
before this experiment.

## Completion boundaries

The import preparation is complete only when archive/file hashes and attribution
are verified. A component is integrated only when a real user-facing path invokes
it and the relevant integration checks pass. A component is enabled by default
only after its compatibility, failure and quality behavior meet the release
criteria. Downloading source satisfies none of the latter two conditions.

The full original plan remains in scope. Its translation, Gemini lifecycle,
compaction, resource limits and deployment work are not silently dropped. The
research changes ordering: close false-hit/accounting risks, preserve the native
baseline, then add measurable OSS-derived capabilities. Track progress in commits
and `docs/V1.1-EXECUTION.md`, not by editing this plan into a claim of completion.
