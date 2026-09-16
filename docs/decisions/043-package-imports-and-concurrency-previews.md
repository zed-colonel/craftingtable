# ADR-043 — ZIP packages and bound concurrency-map drafts

- Status: accepted
- Date: 2026-09-15
- Amends: ADR-011 transport, limits and explicit active-version selection

## Decision

Roadmaps accepts a bounded v0.3 concurrency-map ZIP and preserves an immutable,
inactive definition. Import, exact plan binding, adoption and execution are distinct.
This increment implements the first two; no imported map can launch runs or satisfy
gates. The existing whole-item roadmap scheduler is unchanged.

The planning package validates an application-owned JSON Schema 2020-12 using Ajv,
then validates source hashes, full work-item records, acceptance case coverage,
profile-owned criteria/owners, retained consumer contract/release requirements,
references and the expanded milestone DAG. Repository aliases are data; supported
semantics are closed. Uploaded schemas, Python validators and manifests never run.
An implemented baseline may replace its own historical publication criteria; its new
publication requirements remain unresolved and separate from baseline acceptance.

ZIP parsing is in-memory with no extraction or processes. Only stored/deflated,
single-disk archives are supported: 8 MiB compressed, 32 MiB expanded, 2 MiB per
member, 512 entries. Reject traversal, absolute paths, links, conflicting paths,
encryption, unsupported encodings, overlapping entries and invalid size/CRC data.
Strict map/source YAML rejects aliases, anchors, tags and merge keys. The original
archive is retained separately from both the canonical plan digest and map digest.

Full planning ZIP import explicitly selects the current primary documents. Supported
text files in their directory become agent-facing artifacts; scripts, historical
snapshots and other members remain in the downloadable original ZIP. Package-scoped
checksum manifests are checked; external source-tree manifests grant no runtime
baseline evidence. Discrete-file import remains available. Both paths allow 64
artifacts and 60 supporting files within the existing 8 MiB bundle limit.

Import into an existing project adds a version, preserving old artifacts, work,
completion and finalization history. An explicit Make active choice uses an expected
active-version check and rejects ongoing admitted/delegated work. It never copies
branch settings, admission or completion into the new version. New version branch
configuration remains an explicit existing plan command.

Schema 16 records bounded original archives, import attempts, immutable definitions,
plan archive links and immutable binding revisions. Identical content is idempotent;
a different map digest under the same map ID/revision is a recorded conflict. Failed
validation remains inspectable. The database's existing backup policy includes these
records. Binding revisions use optimistic concurrency and pin plan/project/work-item,
artifact and configured repository/branch identities. Missing configuration is shown
as a draft blocker; rechecking never silently rebinds to latest. Archive provenance
and exact source-document matches are displayed separately.

All commands retain workspace roles, session authentication, origin/CSRF checks and
strict wire validation. Downloads are authenticated inert attachments. Package imports
hold no Git or agent interface. Source snapshots are provenance, not imported duplicate
plans, runtime receipts, approvals or completed checkpoints. Future Studio authoring
must reach the same validated definition/binding seam; adoption and scheduling require
the remaining increments in the cross-project roadmap.
