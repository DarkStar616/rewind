# Request identity generation 2

The v1.1 development gateway now uses domain-separated generation-2 request keys.
This repairs prototype-named JSON field loss, retains unknown provider headers and
content type, and restricts cache-hint removal to request/message/block boundaries.
Tool inputs, schemas and unknown request data remain significant. Unknown cache
hint extensions also remain significant. These rules may reduce hit rate; false
reuse would be worse than an additional live request.

Existing generation-1 keys are never tried as a fallback. Old recordings did not
retain enough request evidence to prove whether their key was produced by a
colliding body. Merely hashing their existing keys again cannot repair that gap.

New encrypted tape epochs use `rewind.epoch/v2` with `identityGeneration: 2`.
The new reader identifies old epoch/v1 metadata as generation 1. Old binaries
reject the new epoch schema, preventing a cooperating old writer from appending
old-generation keys into the new tape. Upgrade every process sharing a store.

Legacy epochs remain on disk. Epoch metadata and existing read-only lookup can
be inspected through the storage API, but append, cursor creation, consumption
and cursor rewind refuse them. The gateway responds with HTTP 409 and
`rewind_legacy_identity`: keep the history for inspection and start a new epoch.
A friendly history export command remains part of the subsequent interoperability
work; it is not delivered by this migration.

For a fresh recording, retain the same tenant, storage directory and wrapping key,
and choose a new explicit `--epoch` value. Omit `--replay-cursor` while recording.
Do not delete historical tapes to resolve this refusal. Existing memory records
are process-local; restart the gateway on upgrade.

Custom RecordStoreV2 implementations may return optional `identityGeneration` on
`epoch()`. Absence is treated as legacy for strict gateway replay; explicitly
return 2 only for a store enforcing the current generation. Custom stores remain
responsible for write-generation admission and durable storage guarantees.

Header names are case-insensitive; ambiguous duplicate spellings or malformed
values are rejected. Unclassified SDK tracing/retry headers can cause additional
misses until evidence justifies treating them as neutral. Local Rewind headers
and the configured scope header are removed before keying/forwarding.

## Requests that require live execution

Replay eligibility rejects declared hosted tools, search-model names, hosted prompt
and conversation references, and remote image/file references in provider content
slots. Client function schemas and arguments are not scanned as provider envelopes.
Inline content remains eligible. These checks are conservative protocol checks,
not proof that an arbitrary provider or future model has no external dependencies.

Ineligible requests run live without recording in normal mode. Strict ordered
replay returns HTTP 409 before opening or advancing a cursor. Custom `Replayer`
implementations must declare `allowLiveFallback: true` to permit this live bypass;
false or absent refuses it. `createReplayer` sets this policy from its strict option.
Bypasses do not invoke custom replay hooks or book avoided tokens.
