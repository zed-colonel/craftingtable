# ADR-011 — Plan bundle import, versioning, and artifact preservation

- **Status:** accepted
- **Date:** 2026-07-24
- **Amended:** 2026-07-24 after independent review (CT03-R4, CT03-R5)

## Context

CT-03 must ingest a structured planning bundle from an authenticated operator,
preserve its exact source material, and give it a stable identity so a repeated
import is recognisably the same bundle. Planning files are untrusted input. The
first acceptance workload is the real AQ-CONT-1 bundle: six discrete files
totalling roughly 250 KB.

## Decision

### Transport

Import is one authenticated multipart HTTP request. ZIP archives, host
filesystem paths, and external URLs are not accepted.

**The artifact role is the multipart field name** — `implementation-plan`,
`work-breakdown`, `assumption-ledger`, `validation-manifest`, `decision-log`,
`supporting`. Roles are never inferred from a filename or from prose inside a
file. `implementation-plan` and `work-breakdown` are required exactly once;
`supporting` repeats up to ten times; every other role appears at most once.

An optional `projectId` field targets an existing project so a changed bundle
becomes a new version of that project's plan rather than a new project. Its
absence creates a new project from the required `projectName` field.

### Limits

```text
files ≤ 12 · bytes per file ≤ 2 MiB · total ≤ 8 MiB
fields ≤ 8 · parts ≤ 24 · field value ≤ 512 B · header pairs ≤ 200
```

`PLAN_BUNDLE_LIMITS` in `@craftingtable/planning` is the single declaration; the
server imports it to configure the multipart plugin, so stream enforcement and
validation policy cannot drift. Oversized files are never fully buffered.

### Filenames and media types

Logical filenames are NFC-normalised and must match
`^[A-Za-z0-9][A-Za-z0-9._-]*$`, carry an accepted extension, contain no path
separator or control character, and not collide case-insensitively with another
filename in the same request. A filename is a label: it is never joined to a
path, opened, or written.

The canonical media type is derived from the validated extension, not from the
client-declared content type. A browser that labels `.yaml` as
`application/octet-stream` therefore produces the same bundle digest as one that
labels it `application/yaml`, which is what makes duplicate detection
trustworthy across clients.

### Canonical bundle digest, format version 1

```text
SHA-256 over:
  "craftingtable-plan-bundle-digest-v1" || 0x00 || u32be(artifactCount)
  for each artifact, ascending by (role, filename) compared bytewise:
    u32be(len(role))      || role
    u32be(len(filename))  || filename
    u32be(len(mediaType)) || mediaType
    u64be(len(bytes))     || bytes
```

Every field is length-prefixed, so the encoding is injective and no two distinct
bundles can collide by concatenation. Multipart part order, upload timestamps,
temporary filenames, and generated identifiers are absent from the encoding by
construction and therefore cannot affect it. `digest_algorithm`,
`digest_format_version`, and the hex digest are all stored.

The digest is withheld when the accepted artifact set is not exactly what the
client sent, because a digest over a partially rejected set would identify a
bundle nobody submitted.

### Versioning

`Project` is the operator-visible container. `PlanBundle` is the stable logical
family. `PlanVersion` is one immutable, content-addressed import result.
`PlanImportAttempt` records every import request and its outcome.

- The first successful import creates project, bundle, and version atomically
  and sets the project's active plan version.
- Byte-identical logical artifacts are idempotent: the existing version is
  returned, a `duplicate` attempt and audit row are recorded, and no artifact,
  work item, dependency, or workspace event is duplicated.
- Changed content creates a new immutable version. **It does not replace the
  active version.** Activation and version comparison are Planning Studio work.
- `UNIQUE (workspace_id, content_digest)` on `plan_versions` is the
  database-level backstop for idempotency.

### Artifact preservation

Accepted artifacts are stored as bounded immutable SQLite BLOBs with logical
filename, role, media type, byte length, SHA-256, exact bytes, and creation
time. Artifacts from a failed validation attempt are retained with a null plan
version so the failure remains diagnosable.

This is deliberately narrow: it exists so a successful import is one atomic
database transaction for small planning inputs. It does **not** establish SQLite
as CraftingTable's general artifact store. Execution logs, patches, transcripts,
and build artifacts remain later filesystem or content-addressed scope.

Artifacts are served as `text/plain; charset=utf-8` with
`content-disposition: attachment`, `x-content-type-options: nosniff`, and
`content-security-policy: default-src 'none'; sandbox`, regardless of the stored
media type.

### Required roles are pinned to their source class

`implementation-plan` must be Markdown and `work-breakdown` must be YAML.
Dispatching on file extension alone let a JSON work breakdown be accepted as
generic JSON and never parsed as a plan, producing a failed import with no
diagnostic. A mismatch is now the stable `artifact-role-format-mismatch` code.

Analysis additionally guarantees at least one error diagnostic whenever it
cannot produce a usable plan, and the import attempt records the real error
count. A failed import that cannot explain itself is not an acceptable outcome.

### A requested project is resolved before analysis

An unknown or foreign `projectId` returns the same non-disclosing 404 whether
the bundle is valid or not. Previously an unresolved identifier was written
straight into the attempt row, violating its foreign key and producing a 500
with no durable evidence — so the answer to "does this project exist?" depended
on unrelated bundle validity.

## Consequences

Bundle identity is deterministic and client-independent. A repeated import is
cheap and provably non-duplicating. Exact source bytes stay retrievable and
immutable, so unknown fields need not survive parse-and-reserialize.

Failed-import artifacts persist until a future retention feature exists; this is
recorded in `docs/security.md` rather than solved now.

Storing artifacts in SQLite bounds their size at 2 MiB each. A future bundle
larger than that will force the general artifact store decision rather than a
quiet limit increase.

## Alternatives considered

- **ZIP archives** — would add path traversal, decompression bombs, duplicate
  entries, symlink entries, and archive-normalisation ambiguity for bundles that
  already exist as at most twelve small discrete files, and that Planning Studio
  will later write directly through the same artifact model.
- **Host paths or external URLs** — would give the browser filesystem or network
  authority over the daemon, which AGENTS.md forbids.
- **A manifest part mapping filename to role** — a second source of truth and a
  filename-matching failure mode; the field name already carries the role
  unambiguously.
- **JSON stringification as the digest input** — key ordering and binary
  representation are implicit, so identity would depend on serialiser details.
- **Filesystem artifact storage** — would make one import span two failure
  domains and prevent a single atomic transaction.
