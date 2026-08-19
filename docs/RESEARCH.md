# Rewind standalone: research

This is the grounded research the plan rests on, gathered August 2026 from the current state of
MCP, the coding-agent clients, the web-chat surfaces, the sandbox providers, and a read of the
existing implementation. Each section ends with the decision it drives.

---

## 1. How coding agents consume a stateful capability

**MCP is the integration layer, and it now fits a stateful checkpoint tool cleanly.** The
MCP specification revision of 2026-07-28 deliberately moved the protocol core to stateless: it
removed the connection handshake and the transport-level session id. The specification's own
guidance for a server that needs to carry state across calls is to mint an explicit handle from a
tool and have the model pass it back as an argument. That is exactly Rewind's natural shape:
`checkpoint()` returns a checkpoint id, and `rewind(id)`, `replay(id)`, `diff(id)` take it back. A
stateful checkpoint tool is now a first-class, blessed pattern, not something fighting the protocol.

**One stdio server reaches every target client.** Claude Code, Cursor, Cline, Windsurf and Codex CLI
all consume MCP servers today through a per-client config file, and the same server binary works
across all of them. The stdio transport is a local subprocess over standard input and output, with
no auth and the lowest latency, and it runs co-located with the workspace it has to snapshot anyway.
That is the correct transport for a local reversible substrate, and it reaches all five clients for
the cost of one binary plus a documented config line each.

**Rewind complements the built-in rewind, it does not duplicate it.** Claude Code ships its own
checkpoint feature that auto-snapshots before every edit and restores on demand. Its documented,
load-bearing limitation is that it tracks only the agent's own file-editing tools. Files changed by
a shell command, and any non-file side effect, are neither tracked nor undone. That gap is precisely
Rewind's territory: whole-workspace snapshots that include shell-driven state, plus the effect barrier
for external effects, plus deterministic replay, and it works across agents that have no built-in
rewind at all. State this complementarity explicitly in the docs to pre-empt the "why not just
`/rewind`" objection.

**Automation is a later layer.** MCP tools are cooperative: the model has to choose to call
checkpoint or rewind. That is fine for an MVP, and it is why Claude Code hooks exist as a follow-on.
A `PostToolUse` hook matching shell tools can auto-checkpoint after every shell call with near-zero
added latency, and a `PreToolUse` hook can call the effect guard before a risky command and deny or
ask. A Claude Code plugin can bundle the MCP server and those hooks and install in one command, but
it reaches only Claude Code, so it is phase 2, not the MVP.

**Decision:** the first surface is a single stdio MCP server exposing checkpoint, list, rewind,
replay and guard-effect as tools, built on a thin internal CLI engine. Hooks and a public bracketing
CLI come later.

---

## 2. Web surfaces (Claude.ai and ChatGPT): phase 2

**Both web surfaces converged on the same primitive: a remote MCP server the vendor calls.** Claude.ai
calls these custom connectors (remote MCP); ChatGPT calls them apps (the Apps SDK, built on MCP).
One MCP server can in principle serve both. That is good, and it means the MVP's tool contract is the
thing that matters most for the web future.

**The execution model kills the literal pitch on web.** Web chat agents do not run code on the user's
machine. A connector is a remote server you host, and the agent drives it purely by tool calls; any
UI renders in a sandboxed frame with no filesystem or process access. There is no local working tree
to snapshot, no local process to jail, no host to protect. So the jail, the local world snapshot and
the local deterministic replay are all inapplicable to web as-is. The only piece that travels is the
effect barrier, applied to state that a workspace Rewind itself hosts. On web, Rewind is not rollback
of what the agent did on your laptop; it is a hosted sandboxed workspace exposed as a connector, with
checkpoint, rewind and an effect barrier over the state that workspace owns. Do not pitch local
rollback on web; it is false there, and overclaiming contradicts the honesty positioning.

**Why it is phase 2.** The one web-portable piece requires standing up a hosted, multi-tenant, OAuth
sandbox-workspace service, which is a large, security-critical infra build and the exact
over-engineering trap to avoid at MVP. Separately, fully write-capable custom connectors on ChatGPT
are gated to Business, Enterprise and Education workspaces today, so the addressable audience for a
mutating web Rewind is thin right now.

**Decision:** ship nothing web-facing in the MVP, but design the MCP tool contract to be
transport-agnostic so the identical server later re-hosts as a Claude.ai connector and a ChatGPT app
behind an auth-and-host shim. When web lands, lead with the effect barrier, because it is the one
claim that is both true and unique there.

---

## 3. Extracting the moat, and keeping it in the larger product

**Rewind is a two-layer system split across a process boundary that already exists.** The upper layer
is the control and policy moat, in TypeScript: the git-snapshot sandbox decorator, the effect barrier,
the tamper-evident hash chain, the correlation identity, the canonical JSON, the replay and cost
accounting, and the jail-enforcement gate. The lower layer is the substrate adapters, in Python, which
run in-process with the substrate: the copy-on-write snapshot carrier and the replay provider. These
two layers already talk over a subprocess and JSON boundary, because the TypeScript gate shells out to
the substrate's command-line interface with strict fail-closed parsing. That command-line and JSON
contract is the cross-language seam, and it does not need inventing.

**The highest-value pieces do not depend on the substrate at all.** The git-snapshot sandbox decorator
is pure git, and the effect barrier is pure cryptography over an append-only log. Neither touches the
Python substrate. That is what makes a zero-Python, zero-substrate MVP possible.

**Language decision:** TypeScript is the source of truth for the moat semantics and the public SDK and
MCP surface. Python is confined to the external substrate dependency and the two in-process adapters,
which cannot be anything but Python because they load inside the substrate's runtime. TypeScript wraps
Python through the existing command-line contract. The two layers implement different things, not the
same thing twice, which keeps this out of the two-implementation drift trap.

**Two coupling points must be genericized before extraction.** The hash-chain module hard-codes the
larger product's domain action vocabulary, and it imports that product's approval-authority resolver.
Both must become injected dependencies, with sensible defaults, or the SDK drags an entire product's
approval and domain model with it. This is the single most important extraction task, and it is small.

**Keeping it in the larger product:** the larger product depends on the extracted `@agent-rewind/core` as a
published package, and injects its own store, action vocabulary and authority resolver. You develop
Rewind once, and the product consumes it. Do not maintain a fork; a fork recreates the drift the whole
method exists to avoid.

**Decision:** extract `@agent-rewind/core` (TypeScript) as git-snapshot decorator, effect barrier, hash
chain, correlation, canonical JSON, replay accounting and jail-enforcement gate, with the two coupling
points injected. The MVP subset is only the git decorator, the barrier and the chain. The Python
adapters extract later, as-is, when the enforcement tier is needed.

---

## 4. Runtime tiers and zero-config distribution

**The snapshot mechanism is a swappable backend, and the moat is pure logic above it.** The value,
reversible execution plus the effect barrier plus a deterministic trace, does not depend on where the
world snapshot lives. So the runtime is a thin `WorldBackend` interface with tiered implementations,
and the barrier and hash chain sit entirely above it, reading only the effect log and trace. That
single discipline is what lets the same moat run on a git worktree and later on a hosted sandbox with
no rewrite.

The three tiers, mapped to what exists in 2026:

- **Tier 0, the zero-config default: git plus copy-on-write filesystem snapshots.** Works on any
  laptop with git, needs no privileges, no daemon, no container and no account. A world is a
  commit or worktree, a revert is a checkout, a fork is a reflinked worktree, near-instant and
  near-zero-disk on copy-on-write filesystems with a graceful fall back to a plain checkout
  elsewhere. The MIT substrate already implements this, so Tier 0 is a harvest. This is the
  fastest-adoption path, and it is the MVP.
- **Tier 1, opt-in enforcement: an OS-level jail on a privileged host or container.** This turns
  reversible into reversible and actually contained. Add it the first time a user needs enforced,
  not merely recorded, containment.
- **Tier 2, hosted sandboxes for web and CI.** When execution has to move off the laptop, target the
  Apache-2.0, self-hostable provider with pause-and-resume semantics first, because it maps onto
  fork and revert with the least lock-in; add a memory-snapshot provider second for byte-identical
  running state. Treat any recently closed-source provider as hosted-only and optional.

**Distribution:** runnable as `npx rewind` for the TypeScript control layer, with the Python substrate
available through `uvx` when a later tier needs it. `npx rewind init` in any git repo yields a
reversible session immediately, with no account and no privilege.

**Honest limits to bake in:** Tier 0 gives reversibility but not containment, and a git worktree
cannot stop an agent from touching files outside the tree or making a network call, so it must not be
marketed as isolation. Git snapshots capture tracked and working-tree file state, not process memory
or external effects, which is exactly why the effect barrier is not optional polish on Tier 0; it is
the thing that covers what git cannot.

**Decision:** build one `WorldBackend` interface and ship exactly one backend at launch, the Tier 0
git and copy-on-write worktree, wired as the zero-config default. Design Tiers 1 and 2 as drop-in
adapters and add them only when a concrete use-case pays for them.

---

## 5. Positioning, prior art and the wedge

Note: the dedicated positioning agent hit a tooling error on this run, so this section is synthesized
from the other four findings and known prior art, and it is the section most worth pressure-testing
with a fresh web search early in the build.

**The landscape, and the gap.** Hosted sandbox providers give you an isolated place to run agent code
and, in some cases, pause and resume it, but they are infrastructure, not a reversibility SDK for
agents, and they do not ship an effect barrier. Framework-level checkpointers give you state snapshots
inside one orchestration framework, but they are framework-locked and, again, have no concept of
refusing to replay a spent external effect. The coding agents that ship a rewind track only their own
file edits, single-agent and local, with no external-effect safety. Across all of them, the
refuse-and-record effect barrier, packaged as a portable primitive that works across agents and tiers,
appears to be unshipped by anyone. That is the differentiator to lead with, and the first thing to
confirm with a current search.

**The wedge, one line:** reversible execution for AI agents that also refuses to double-charge.

**Three differentiators, each against a real comparator:**

1. Whole-workspace rewind that includes shell-driven state and works on every agent, where the
   built-in agent rewinds see only their own file edits on one agent.
2. The refuse-and-record effect barrier, where sandbox providers and framework checkpointers have no
   external-effect safety at all.
3. Portability across tiers behind one interface and one tool contract, from a zero-config git
   default to a hosted sandbox, where the alternatives lock you to one runtime or one framework.

**Launch ICP and use case:** developers running AI coding agents who have been burned by an agent
botching a long multi-step task, or by an agent re-firing a side effect on a retry. The first
demo is a ten-step task interrupted at step eight that resumes instead of restarting, and an agent
that is refused when it tries to re-send a spent effect after a rewind.

**Licence and shape:** open-core. The core SDK and MCP server are MIT or Apache-2.0, matching the MIT
substrate, and the hosted and enterprise features are the commercial layer. Keep that boundary clean
from the first commit.
