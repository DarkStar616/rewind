# Upstream source import staging

These are pinned, unmodified Apache-2.0 source snapshots for the requested Rewind
integrations. **They are review material, not enabled runtime features.** Their
presence does not mean Bifrost, Headroom or agenticstash is running inside Rewind.

`manifest.json` records repository URLs, full commit IDs, every selected source
file's SHA-256 and each archive's SHA-256. `sources.tar.gz` contains original
upstream paths and bytes. Archives keep foreign Go/Python/TypeScript projects out
of Rewind's workspace build until a specific integration is reviewed. License
and notice files are also present beside each archive. No installer, lifecycle
script or downloaded model has been run.

| Import | Selected material | Intended integration |
| --- | --- | --- |
| Bifrost | Normalized direct/semantic cache plugin, upstream tests and Go module locks | Lifecycle policy, namespaces and TTL; optional gateway interoperability. Preserve Rewind identity instead of upstream text normalization |
| Headroom | Prefix tracking, cache alignment, BM25 scoring, retrieval ownership/tool contracts, storage interface | Cache diagnostics and stable-prefix policy; bounded, recoverable observations over Rewind's encrypted store |
| agenticstash | Runtime source, upstream tests and package/build metadata | Recording exchange, ordered replay comparison, fork/diff and supplementary seals |

These are selected snapshots, not standalone distributions of Bifrost or
Headroom. Their dependent source and runtimes are not included. Full local clones
are at `/home/reuben/oss-reference/{bifrost,headroom,agenticstash}`; those paths are
machine-local development conveniences, not package dependencies.

Before activating a component, retain attribution in the published package,
record modifications, verify its transitive dependencies, and run its relevant
upstream tests plus Rewind integration checks. Copied upstream tests are reference
material; they do not replace Rewind's human-owned core correctness oracles.

See [integration roadmap](../docs/plans/2026-09-09-002-research-driven-efficiency-roadmap.md).
