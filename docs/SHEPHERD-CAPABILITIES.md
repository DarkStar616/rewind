# Shepherd capabilities vs. Agent Rewind MVP — grounded inventory (2026-08-18)

From two grounded sweeps of `/home/reuben/projects/shepherd` (docs + code). Purpose: answer "what did we
skip, and what's worth harvesting for a later tier." **Correction to earlier framing:** shepherd's *code*
is far larger than its 0.3.0 docs suggest — `vcs-core` ("provenance-native version control for executable
worlds") is a real, substantial reversibility+isolation engine, not just git snapshots. So "use full
shepherd" has genuine substance — with the caveats at the bottom.

## What Agent Rewind's MVP has (TypeScript, shipped + verified)
Git checkpoint/rewind (`WorldBackend` + Tier-0 git backend, reflink-CoW with copy fallback); the
refuse-and-record **effect barrier with cross-rewind idempotency** (spent effect refused across a
rewind — see the "our edge" note below); the tamper-evident SHA-256 hash chain; the replay-savings sink;
the engine + CLI + stdio MCP server. Injected action vocabulary + no-op authority resolver.

## Capability map

| Capability | In shepherd (package) | In Agent Rewind MVP? | Verdict |
|---|---|---|---|
| **OS syscall jail** (Linux Landlock, macOS Seatbelt; podman container device) | `vcs-core/_landlock_containment`, `_seatbelt_containment`, `_containment`; `shepherd-runtime/device/container` | **No** (reversibility only, no isolation) | **Tier-1 harvest target — the big one.** Real enforced containment. |
| **Multi-carrier CoW** (clonefile/FUSE-overlay/copy + runtime detection + fallback) | `vcs-core/_clonefile_carrier`, `_fuse_overlay`, `_copy_carrier`, `substrates.detect_*` | Partial (git + reflink probe + copy fallback) | Tier-1 enhancement (richer carriers than git). |
| **Per-grant writable-roots + egress broker** (grants → confinement spec; host-filtered network) | `shepherd-dialect/confinement`, `permission_plan`; `vcs-core/_egress_broker` | Partial (authority resolver injected, no-op default; no enforcement) | Tier-1 (needed to *enforce* grants, not just record). |
| **Materialization changesets w/ `reversibility: auto\|compensable\|none`** | `vcs-core/materialization`; `shepherd-dialect/changesets` | `diff()` only | Enhancement (richer than diff). |
| **World-transition provenance DAG** (content-addressed world snapshots, transitions, candidates) | `vcs-core/_world_types`, `store.py` | Flat checkpoint list | Enhancement. |
| **Content-addressed hash chain w/ CAS head** | `commons-vcs/canonical`,`kernel`; `shepherd-core/effects/commons_vcs` | Simple SHA-256 linked chain | Shepherd's is more robust; note *its own* validator is "structural, not global-head-admission" (same limit class we have). |
| **Managed-exec shell-capture daemon** (lease a subprocess, reduce into trace, command admission) | `vcs-core/_managed_exec*`, `session_capture` | Effects captured via explicit `guard` calls | Enhancement for auto-capture. |
| **Substrate SQLite replay** (re-fold recorded commit trace) | `vcs-core/_sqlite_replay`; `shepherd-core/foundation/fold` | None | Substrate replay (NOT LLM replay — see gap). |
| **Remote sandbox backends** (E2B micro-VM, Modal, Daytona, K8s, Prime) with checkpoint/revert | `shepherd-sandboxes` | No | **Tier-2 (hosted sandbox) harvest target.** |
| **Meta-agent model** (task-as-value, `transform`/`optimize`/`critique`, combinators) | `shepherd-runtime/nucleus`, `combinators`; `shepherd-transform` | No | **Skip** — Python, agent-*programming* model; not what an agent-agnostic SDK needs. Mostly roadmap in docs. |
| **Trajectory export incl. `from_claude_code_session`** | `shepherd-export` | No | Interesting for a record/import story; optional. |
| **Cost/usage accounting** (CostsView, per-model, cache ratios) | `shepherd-core/effects/views` | Replay-savings sink (savings-focused) | Different focus; ours serves billing. |

## Two decisive honest points

1. **Shepherd does NOT have the token-saving engine either.** There is **no recorded/replay LLM provider
   (cassette) anywhere** in shepherd — only a `DeterministicFakeProvider` and deterministic re-fold. The
   mechanism that turns replay into *avoided API calls* (and thus a billable savings number) is a **gap in
   BOTH** shepherd and our MVP — it's net-new regardless of which base you pick. So "full shepherd" does
   **not** advance the save-tokens / bill-on-savings thesis. Shepherd's value is **isolation + provenance +
   governance**, not token savings (its own docs make zero savings claims).
2. **Our cross-rewind idempotency barrier is the one thing shepherd-core lacks.** Shepherd has tool-call
   validation that refuses+records (`Provider._build_composite_validator` → `ToolCallRejected`) and a
   content-addressed event chain — but not the specific "refuse re-firing a **spent effect across a
   restore/rewind**" semantic (the ACRFence/authority-resurrection case). That remains Agent Rewind's edge, and
   it sits *above* whatever backend you choose.

## The decision this informs

- **Product A — viral token-saving reversibility tool for every agent** (what's built + the locked
  strategy): keep the lean TS core; shepherd is an **optional Tier-1** ("enforced isolation") backend under
  the same barrier, harvested when a customer needs it. Build the **replay-savings engine** (the real
  differentiator + billing basis) next — nobody has it.
- **Product B — the reversibility+isolation substrate** (shepherd-based, rewind moat on top): harvest
  `vcs-core` for a big head start on jail/CoW/changesets/provenance — but you inherit Python + privileged
  jail + macOS/Linux-only + alpha, and you largely trade away the viral/web reach and the token-savings
  wedge.

The `WorldBackend` seam already makes Product A → Product B an *additive* path (swap the backend, keep the
moat), so choosing A now does not foreclose B.
