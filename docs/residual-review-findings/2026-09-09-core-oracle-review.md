# Core oracle review required before v1.1 release

Status: prepared for review, not implemented or released.

Automatic approval review rejected new agent-authored checkpoint correctness tests,
citing the repository rule: “For T3 work the test that defines ‘correct’ is written
by the human, before the implementation, and is off-limits to me.” The rejected
operation was not retried through another path. Core work below remains parked
until a human supplies the oracle or explicitly authorizes agent authorship.

## Confirmed replay identity defect (release blocker)

In `packages/gateway/src/canonical-request.ts`, both `deepStrip` and `project` copy
JSON properties into ordinary `{}` dictionaries. Assignment to an own `__proto__`
property invokes the inherited setter instead of preserving the JSON field.
These two parsed JSON bodies currently produce the same canonical request key:

```json
{"input":"x","__proto__":1}
{"input":"x","__proto__":2}
```

The reviewer reproduced the collision and false analysis credit. The defect also
affects real replay because analysis and the gateway share this canonicalizer.
It predates this branch. A passing existing suite does not disprove this finding.

Proposed implementation: use null-prototype dictionaries for both projection
copies. Review all sibling object-copy paths for the same property-loss class.
The human-owned oracle should require distinct keys for distinct primitive and
object-valued `__proto__` fields at top-level and nested positions, retain ordinary
field-order equivalence, and preserve every existing output-affecting field test.

Migration must also be decided: existing tapes may contain keys produced by the
old projection. Fixing new keys alone cannot prove old records were not created
from a colliding request. Use a fresh trusted replay epoch/generation for rollout;
do not silently rewrite or destroy historical records. Review compatibility and
legacy memory restart behavior explicitly.

## Prepared transactional evidence adapter

Uncommitted worktree: `/home/reuben/worktrees/rewind-v11-evidence`.
Adds a ledger-owned transaction seam and encrypted SQLite evidence/head/index
adapter. Host ran 27 focused tests and typecheck, both exit 0. Review fixed a
legacy emitted-effect index miss and inconsistent empty/read-only snapshots.

Human review must establish: one effect admission across processes, contiguous
hash-chain sequence, no partial writes on callback/OCC failures, compatibility
with emitted evidence lacking an index, and consistent transaction snapshots.
Callbacks may re-execute and must have no external effects. Index misses still
scan history; complete index migration and production wiring remain unfinished.

## Checkpoint coalescing

No implementation landed. Proposed opt-in coalescing requires equal workspace
tree AND effect state, explicit force bypass, and discoverable new labels. A
workspace-only comparison is insufficient. The existing checkpoint contract
must remain the default. Cross-process effect races need an explicit oracle;
process-local serialization alone is not a cross-process guarantee.
