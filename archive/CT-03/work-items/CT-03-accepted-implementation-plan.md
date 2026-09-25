# CT-03 Accepted Implementation Plan

**Status:** accepted by the operator on 2026-07-24
**Binding contract:** `work-items/CT-03/CT-03.md`
**Acceptance matrix:** `work-items/CT-03/CT-03-acceptance-matrix.yaml`
**Fixture expectations:** `work-items/CT-03/CT-03-aq-import-expectations.yaml`
**Accepted source baseline:** `c8e2396a65466bdde95bf740771af63b4fc2272e`
**Phase A inspection head:** `2173d6c9ebc0edf28ab4adfb1775e8a098341e01`

This is the accepted Phase A plan of record for CT-03. The work contract, the
acceptance matrix, and the AQ expectation fixture remain authoritative. Nothing
in this plan weakens or redefines them.

## 1. Baseline

The accepted baseline commit exists. The inspected head descends from it. The
two intervening commits (`b33d616` CT-03 work contract, `2173d6c` AQ fixture)
are additive planning material and rewrite no accepted CT-01 or CT-02 history.
The working tree was clean at Phase A completion, and the existing suite was
green (35 files, 103 tests).

Independent verification of the AQ-CONT-1 fixture, performed before any code
was written, reproduced the expectation file exactly:

```text
work items                14
required dependency edges 24
roots                     [AQ-01]
risk counts               medium 1, high 7, critical 6
acyclic                   true
unresolved references     none
maximum fan-in            8 (AQ-12)
```

`aq-cont-1-implementation-plan.sha256` verifies against the on-disk bytes of
both files it names.

## 2. Operator-approved resolutions

Four Phase A questions were resolved by the operator on 2026-07-24. All four
recommendations were approved.

### 2.1 Q1 — Component-test environment (approved)

`apps/web` gains `jsdom` and `@testing-library/react` as **development-only**
dependencies, with a Vitest project split so server, storage, planning, and
script tests continue to run under the `node` environment. `pnpm test` remains
one command. This satisfies the acceptance matrix's named "component tests"
evidence for CT03-A60, A62, A64, A65, and A67 directly.

### 2.2 Q2 — CT03-A50 daemon-restart evidence (approved)

`e2e-entry.ts` creates a fresh temporary data directory on every start and
Playwright's `webServer` cannot restart the daemon mid-test. A50 is therefore
proved in two explicitly recorded halves:

- **daemon restart** by `apps/server/src/restart.test.ts`, a genuine real-file
  `createRuntime` close/reopen carrying full planning state;
- **browser refresh** by `e2e/planning.spec.ts`.

The completion report must state this split explicitly. A50 is not redefined
and no E2E persistence machinery is added.

### 2.3 Q3 — Snapshot status-summary rename (approved)

`workspaceSnapshotResponseSchema.statusSummary` keys change:

```text
ready   → planningReady
blocked → dependencyBlocked
```

This removes the exact ambiguity that CT-03 §5.11 and the source assessment
§13.4 warn against, and is required for CT03-A60's unambiguous labels. The
CT-02 reducer, components, and tests are updated with it.

### 2.4 Q4 — Explicit `projectId` import field (approved)

Contract §5.13's route list offers no way to direct a *changed* bundle at an
existing project, which CT03-A30 and A31 require without inference. The import
request gains an optional `projectId` multipart field:

```text
absent  → create a new project
present → new immutable plan version in that project; active version untouched
```

§5.13 permits Phase A to adjust resource shape when authorization and identity
remain unambiguous, which this satisfies. Nothing is inferred from prose.

### 2.5 Recorded assumption

This plan is stored at `work-items/CT-03/CT-03-accepted-implementation-plan.md`,
matching the repository's existing `work-items/CT-0N/` convention.

## 3. Package direction

```text
domain    → none
planning  → domain + yaml + zod          (new, pure)
contracts → domain + zod
storage   → domain + better-sqlite3
server    → domain + planning + contracts + storage + fastify + @fastify/multipart
web       → domain + contracts + react
```

Binding boundary rules:

- Domain gains no dependency and stays pure records, branded IDs, and frozen
  vocabularies.
- `contracts` may import pure domain planning records. It must not import
  `@craftingtable/planning`. Its tsconfig references only `../domain`.
- `@craftingtable/planning` must not import Fastify, React, SQLite,
  `better-sqlite3`, `node:fs`, `node:path`, `node:child_process`, agent SDKs,
  Git, or CraftingTable server/browser internals. It accepts bytes plus logical
  metadata and never opens a file.
- Only `@craftingtable/storage` imports the SQLite driver or owns SQL.
- Routes never parse YAML, issue SQL, decide dependency semantics, or read a
  role from a request body.
- The browser imports neither storage nor server internals.
- No production dependency on `@craftingtable/agents`, `@craftingtable/git`, or
  `@craftingtable/testing`.

New runtime dependencies are exactly two, both compelled by the contract's own
fixed decisions:

```text
yaml               2.9.0    zero transitive dependencies; maxAliasCount bound
@fastify/multipart 10.1.0   declarative limits; Fastify 5 compatible
```

## 4. Import contract and security

### 4.1 Multipart model

`POST /api/workspaces/:workspaceId/plan-imports`, `multipart/form-data`.

| Part | Kind | Cardinality | Rule |
|---|---|---|---|
| `projectName` | field | required when `projectId` absent | 1–120 chars, NFC, trimmed |
| `projectId` | field | 0–1 | must resolve inside this workspace |
| `bundleName` | field | 0–1 | defaults to the project slug |
| `implementation-plan` | file | exactly 1 | required role |
| `work-breakdown` | file | exactly 1 | required role |
| `assumption-ledger` | file | 0–1 | optional role |
| `validation-manifest` | file | 0–1 | optional role |
| `decision-log` | file | 0–1 | optional role |
| `supporting` | file | 0–10 | repeatable |

**The artifact role is the multipart field name.** No prose inspection, no
filename heuristics, no separate manifest. An unrecognised field name is a
fatal `unknown-artifact-role` diagnostic.

### 4.2 Limits

Contract §5.1 values, unchanged:

```text
files            ≤ 12
bytes per file   ≤ 2 MiB
total bytes      ≤ 8 MiB
fields ≤ 8 · parts ≤ 24 · fieldSize ≤ 512 B · headerPairs ≤ 200
```

Declared once as `PLAN_BUNDLE_LIMITS` in `packages/planning/src/limits.ts` and
imported by the server for the multipart plugin, so policy and stream
enforcement cannot drift. Oversized files are never fully buffered: the reader
uses per-file truncation detection and aborts past the total budget. Over-limit
bytes are discarded, not persisted, which also caps failed-import retention.
The remaining stream is drained before responding.

### 4.3 Filenames and media types

Logical filenames are NFC-normalised and must match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`, contain no path separator, NUL, or
control character, not be `.` or `..`, not start or end with `.` or `-`, and
end in an accepted extension. Duplicates are rejected case-insensitively. The
value is a label; it is never joined to a path, opened, or written.

Canonical media type is derived from the validated extension, so the digest is
independent of browser labelling:

```text
.md .markdown → text/markdown       .yaml .yml   → application/yaml
.json         → application/json    .txt .sha256 → text/plain
```

The client-declared content type must be in that set or
`application/octet-stream`; anything else is `unsupported-media-type`.

### 4.4 YAML safety

```text
version 1.2 · schema core · customTags [] · strict · uniqueKeys
maxAliasCount 100 · prettyErrors false · keepSourceTokens false
```

More than one document is `multiple-yaml-documents`. Any parser error or
warning (unknown and unresolved tags surface as warnings) is `invalid-yaml`.
The result then passes a sanitiser that bounds depth to 32 and node count to
20 000, rejects `__proto__`/`constructor`/`prototype` keys, and rejects
non-finite numbers, `Date`, `BigInt`, `undefined`, functions, and symbol keys.
The output is provably JSON-serialisable.

### 4.5 Artifact classes

Markdown bytes are preserved and digested but never parsed for meaning;
dependencies are never inferred from prose. The work-breakdown YAML is parsed,
validated, normalised, and graph-analysed. Other YAML and JSON are parsed only
far enough to prove well-formedness and safety. Plain text is preserved
unparsed. A `.sha256` manifest is parsed as `<64 hex>  <filename>` lines; every
entry naming a co-submitted artifact is verified, a mismatch is fatal
`checksum-mismatch`, and an entry naming an absent file is a
`checksum-unmatched-entry` warning.

### 4.6 Request authorization

Both mutations reuse the CT-02 chain through an extracted shared helper:
authenticate the cookie session, require `x-craftingtable-csrf` and compare it
timing-safely, apply the existing origin/fetch-metadata policy, then require
`Owner` or `Editor` in the service layer. Non-members receive 404 and the
existing `workspace.access.denied` audit row. A member with `viewer` receives
403. Roles are never read from a request body.

### 4.7 Artifact response headers

```text
content-type: text/plain; charset=utf-8      (always, regardless of stored type)
content-disposition: attachment; filename="<validated logical filename>"
x-content-type-options: nosniff
content-security-policy: default-src 'none'; sandbox
cache-control: no-store
content-length: <byte_length>
```

The browser renders artifact text as React text children inside `<pre>`. No
`dangerouslySetInnerHTML`, no Markdown renderer, no remote content loading.

### 4.8 Why ZIP, host paths, and external URLs stay unsupported

ZIP would add path traversal, decompression bombs, duplicate entries, symlink
entries, and archive-normalisation ambiguity for bundles that already exist as
at most twelve small discrete files and that Planning Studio will later write
directly through the same artifact model. Host paths and external URLs would
grant the browser filesystem or network authority over the daemon, which
AGENTS.md and contract §5.16 both forbid. Arbitrary uploads are excluded
because §5.7's SQLite BLOB decision is deliberately narrow and does not
establish a general artifact store.

## 5. Pure planning model

### 5.1 Identifiers and records

New branded IDs: `PlanBundleId`, `PlanVersionId`, `PlanImportAttemptId`,
`PlanArtifactId`, `PlanImportDiagnosticId`, `WorkContractDraftId`,
`WorkItemDependencyId`. `ProjectId` and `WorkItemId` are retained; their
construction rule remains correct.

Vocabularies:

```text
WorkItemStatus     proposed | admitted
WorkItemRisk       low | medium | high | critical | unspecified
PlanArtifactRole   implementation-plan | work-breakdown | assumption-ledger
                   | validation-manifest | decision-log | supporting
PlanImportOutcome  succeeded | failed-validation | duplicate
DependencyKind     required | recommended
DiagnosticSeverity error | warning | info
```

Durable records: `Project`, `PlanBundle`, `PlanVersion`, `PlanImportAttempt`,
`PlanArtifact`, `PlanImportDiagnostic`, `WorkItem`, `WorkItemDependency`,
`WorkContractDraft`. `sourceId` is never a primary key; it is unique only
within a plan version.

### 5.2 Source profile `exo-work-breakdown-v1`

Top level requires `document` and `pull_requests`. Each item requires `id`,
`title`, `depends_on`, `risk`, `primary_areas`, `exit_gate`. Schemas use
passthrough so unknown fields validate and survive.

Recognised at top level: `document`, `repository`, `baseline_commit`,
`contract`, `stack_revision`, `status`, `phase`, `clean_break`,
`integration_branch`, `tag`, `release_order`, `forbidden_release_symbols`.
Recognised per item: `id`, `title`, `depends_on`, `recommends`, `risk`,
`primary_areas`, `exit_gate`, `phase`, `status`, `repository`,
`baseline_commit`, `contract`, `stack_revision`, `clean_break`,
`integration_branch`, `tag`, `release_order`, `forbidden_release_symbols`.

Every top-level key is preserved verbatim in `NormalizedPlan.metadata` and
every item key in `NormalizedWorkItem.sourceFields`, including recognised ones,
so re-projection never needs the parser. An unknown field is never fatal.
Exact original bytes remain authoritative.

### 5.3 Normalization

Strings are NFC-normalised and trimmed. `sourceId` must match
`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`. Absent or null `depends_on` / `recommends`
become `[]` and must otherwise be arrays of strings. Absent `primary_areas`
becomes `[]`. `risk` is lower-cased; `low|medium|high|critical` are accepted and
any other non-empty string becomes `unspecified` with an `unrecognized-risk`
warning, the raw value preserved in `sourceFields`. `title` and `exit_gate`
must be non-empty. `ordinal` is the source array position. Item count is capped
at 2 000. Dependency order and item order never change semantic identity.

### 5.4 Diagnostics

```text
error   required-artifact-missing · duplicate-artifact-role · unknown-artifact-role
        duplicate-logical-filename · invalid-logical-filename · unsupported-media-type
        artifact-too-large · too-many-artifacts · total-size-exceeded · empty-artifact
        invalid-yaml · multiple-yaml-documents · unsafe-yaml-key
        unsupported-yaml-scalar · yaml-too-complex · checksum-mismatch
        invalid-work-breakdown · missing-work-items · too-many-work-items
        duplicate-work-item-id · invalid-work-item-id · invalid-work-item-field
        missing-required-dependency · self-dependency · required-dependency-cycle
warning duplicate-required-dependency · unknown-recommended-dependency
        unrecognized-risk · checksum-unmatched-entry
```

An import is fatal if and only if at least one `error` is present. Warnings
persist with the successful version and drive the "Needs attention" count.
Diagnostics are ordered deterministically by
`(severity, code, artifactName, workItemSourceId, path, message)` before
persistence, so stored ordinals are reproducible.

### 5.5 Dependency semantics

`depends_on` produces required edges: they must resolve within the same
version, must be acyclic, and block readiness. `recommends` produces
recommended edges: never blocking; an unresolved target is a warning and the
edge is dropped; a resolved one is persisted with `kind='recommended'` and
excluded from `requiredDependencyCount` and from all blocker derivation.

Duplicate item IDs, missing required targets, and self-dependencies are fatal
and all occurrences are reported. **Repeated required edges are deterministically
deduplicated with a `duplicate-required-dependency` warning** — the behaviour
contract §5.4 requires Phase A to choose. It is chosen because a repeated edge
is unambiguous authoring redundancy, because deduplication keeps
`requiredDependencyCount` equal to the distinct-edge count that the database
unique constraint and CT03-A10 require, and because failing an entire import
over it would be disproportionate.

### 5.6 Cycle algorithm

1. Nodes in source `ordinal` order; successors in ordinal order.
2. Missing and self edges are removed first, so cycle detection runs on the
   resolvable subgraph and the operator sees every problem in one pass.
3. Iterative depth-first search with an explicit stack and white/grey/black
   colouring; no recursion, so deep graphs cannot overflow.
4. On reaching a grey target, slice the current path from that target.
5. Canonicalise by rotating so the member with the smallest ordinal is first;
   deduplicate by the resulting key.
6. Emit diagnostics sorted by key, capped at 20 with a summary beyond that.

Message form is exactly `Required dependency cycle: AQ-02 → AQ-03 → AQ-02`,
with `workItemSourceId` set to the rotation head and `artifactName` set to the
work-breakdown filename. Deterministic for any input permutation with the same
source order.

### 5.7 Canonical bundle digest, format version 1

```text
SHA-256 over:
  "craftingtable-plan-bundle-digest-v1"                     (ASCII, 35 bytes)
  0x00
  u32be(artifactCount)
  for each artifact, ascending by (roleUtf8, filenameNfcUtf8) compared bytewise:
      u32be(len(roleUtf8))        || roleUtf8
      u32be(len(filenameNfcUtf8)) || filenameNfcUtf8
      u32be(len(mediaTypeUtf8))   || mediaTypeUtf8
      u64be(len(bytes))           || bytes
```

Stored as `digest_algorithm='sha-256'`, `digest_format_version=1`, and a 64-hex
`content_digest`. Multipart part order, upload timestamps, temporary filenames,
and parser-generated IDs do not appear in the encoding and therefore cannot
affect it. Length prefixing makes the encoding injective. Per-artifact SHA-256
is computed and stored separately.

### 5.8 AQ fixture proof

`packages/planning/src/aq-fixture.test.ts` asserts against the expectation file
loaded at runtime, never against inline literals, so the fixture remains
authoritative and cannot silently drift. It proves 14 work items, 24 required
dependency edges, one root `AQ-01`, risk counts medium 1 / high 7 / critical 6,
full recognised-field preservation, unknown-field retention, and unchanged
per-artifact SHA-256 values.

## 6. Persistence and migration 0002

Every statement in this section was executed against a real schema-1 database
seeded through the actual `0001-ct02-foundation.sql` during Phase A, under
SQLite 3.53.3 with `foreign_keys=ON`, inside one transaction.

### 6.1 Two source constraints that shape the design

- `PRAGMA foreign_keys` cannot be toggled inside a transaction and the runner
  wraps every migration in one, so migration 0002 must be foreign-key clean at
  every statement.
- `workspace_events.payload_json` carries a CHECK hard-coded to the
  `workspace-created` payload shape, not only the `kind IN (...)` list the
  contract mentions. No new event kind is possible without rebuilding that
  table. This makes the rebuild mandatory rather than merely preferred.

### 6.2 Journal vocabulary catalogs

```sql
CREATE TABLE audit_action_kinds (
  action TEXT PRIMARY KEY CHECK (length(action) BETWEEN 1 AND 64),
  introduced_in_schema INTEGER NOT NULL CHECK (introduced_in_schema >= 1)
) STRICT;
CREATE TABLE workspace_event_kinds (
  kind TEXT PRIMARY KEY CHECK (length(kind) BETWEEN 1 AND 64),
  introduced_in_schema INTEGER NOT NULL CHECK (introduced_in_schema >= 1)
) STRICT;
```

Seeded with the eight CT-02 audit actions at schema 1 and five CT-03 actions at
schema 2 (`plan.import.succeeded`, `plan.import.failed`, `plan.import.duplicate`,
`work-item.admitted`, `work-contract-draft.created`), and one CT-02 event kind
at schema 1 and three CT-03 kinds at schema 2 (`project-created`,
`plan-version-imported`, `work-item-admitted`).

Both catalogs receive no-update and no-delete triggers. `INSERT` remains
permitted so a future migration can register a kind with one statement and no
further table rebuild.

### 6.3 One-time journal rebuild

Per journal, in exactly this order:

```text
1  DROP the two append-only triggers
2  ALTER TABLE <t> RENAME TO <t>_schema1        (also renames its sqlite_sequence row)
3  CREATE TABLE <t> with identical columns; kind/action now REFERENCES the catalog
4  INSERT ... SELECT all columns including sequence, ORDER BY sequence
5  guard row: CHECK(ok = 1) aborts the whole migration unless row counts and
   maximum sequences match the pre-rebuild table
6  DROP TABLE <t>_schema1                       (frees old index names and its sequence row)
7  CREATE INDEX with the original names and definitions
8  CREATE the two append-only triggers with identical bodies
```

Then the planning tables, then the guard table is dropped. The runner records
version 2, name `ct03-planning`, and its SHA-256 in the same transaction.

Four details make this correct rather than merely plausible, all verified in
Phase A:

- Triggers are dropped before the rename, so `ALTER TABLE RENAME` cannot
  rewrite stale trigger bodies.
- Indexes are freed by the `DROP TABLE` in step 6, so recreating them under
  their original names in step 7 does not collide.
- `AUTOINCREMENT` continuity holds: the rename carries `sqlite_sequence`, the
  explicit-sequence copy establishes a row for the new table name, and step 6
  removes only the old row. The next event therefore receives a sequence
  strictly greater than the preserved CT-02 maximum.
- No foreign-key pragma toggle is needed: catalogs are seeded before the copy,
  every copied action and kind is registered, and `users`, `sessions`, and
  `workspaces` are untouched.

The only semantic journal change is that the workspace-created-specific payload
CHECK becomes `json_valid(payload_json) AND json_type(payload_json) = 'object'`.
Strict per-kind payload validation stays in Zod, exactly as contract §5.9
requires.

`0001-ct02-foundation.sql` is not modified. Its checksum, and therefore every
existing database, remains valid.

### 6.4 Planning schema

Tables: `projects`, `plan_bundles`, `plan_versions`, `plan_import_attempts`,
`plan_artifacts`, `plan_import_diagnostics`, `work_items`,
`work_item_dependencies`, `work_contract_drafts`. All `STRICT`.

Key constraints:

```text
projects                 UNIQUE(workspace_id, slug), UNIQUE(workspace_id, id)
                         active_plan_version_id → plan_versions(id) RESTRICT
plan_bundles             UNIQUE(project_id, logical_name)
plan_versions            UNIQUE(bundle_id, version_number)
                         UNIQUE(workspace_id, content_digest)
                         UNIQUE(workspace_id, id); immutable triggers
plan_import_attempts     outcome CHECK; cross-field CHECKs tying plan_version_id,
                         project_id, and bundle_digest to the outcome
plan_artifacts           UNIQUE(import_attempt_id, logical_filename)
                         CHECK(length(content) = byte_length); byte_length ≤ 2 MiB
                         immutable triggers
plan_import_diagnostics  UNIQUE(import_attempt_id, ordinal)
work_items               UNIQUE(plan_version_id, source_id)
                         UNIQUE(plan_version_id, ordinal)
                         UNIQUE(plan_version_id, id)
                         CHECK((status='admitted') = (admitted_at IS NOT NULL
                                AND admitted_by_user_id IS NOT NULL))
work_item_dependencies   UNIQUE(plan_version_id, predecessor, successor, kind)
                         CHECK(predecessor <> successor)
                         composite FKs (plan_version_id, predecessor|successor)
                           → work_items(plan_version_id, id)
work_contract_drafts     work_item_id UNIQUE; schema_version=1; status='draft';
                         completeness='incomplete'; immutable triggers
```

**Workspace ownership is structural.** Every planning table carries
`workspace_id NOT NULL REFERENCES workspaces(id) RESTRICT`, and each child uses
a composite foreign key to its parent's `(workspace_id, id)`, so a row can never
be attached to a parent in another workspace.

**Immutability.** `plan_versions`, `plan_artifacts`, and `work_contract_drafts`
carry no-update and no-delete triggers. `projects` (active-version pointer) and
`work_items` (status transition) are deliberately mutable current state.

**No deletion path exists.** Every foreign key is `RESTRICT` and no route,
service, or repository issues `DELETE`.

**Version numbering** is `COALESCE(MAX(version_number), 0) + 1` per bundle,
computed inside the write transaction. **Active version** is set only when
`active_plan_version_id IS NULL`, so a changed import never replaces it.

### 6.5 Phase A verification results

```text
BEFORE  audit{count 3, max 3}  events{count 1, max 1}  sqlite_sequence[3, 1]
AFTER   audit{count 3, max 3}  events{count 1, max 1}  sqlite_sequence[3, 1]
        foreign_keys=1 · foreign_key_check=[] · integrity_check=ok

next event sequence                               => 2, strictly greater
unregistered event kind / audit action            => REJECTED (foreign key)
audit UPDATE/DELETE, event UPDATE/DELETE          => REJECTED (append-only triggers)
non-object event payload                          => REJECTED (check)
future kind registered then used, no rebuild      => ALLOWED
deleting a referenced kind                        => REJECTED (foreign key)
plan_version under another workspace's project    => REJECTED (composite foreign key)
plan_version under its own workspace's project    => ALLOWED
active version pointing at an unknown version     => REJECTED (foreign key)
duplicate content digest in one workspace         => REJECTED (unique)
```

This also settled an open design question: SQLite accepts
`projects.active_plan_version_id REFERENCES plan_versions(id)` declared before
`plan_versions` exists and enforces it correctly at DML time, so no
repository-level workaround is required.

## 7. Transaction design

Computed entirely outside SQLite: multipart streaming and byte accumulation,
filename/media-type/limit validation, YAML parsing and sanitisation, source
profile validation, normalisation, graph analysis, cycle detection, canonical
digest, per-artifact SHA-256, draft projection, and all identifier generation.

`better-sqlite3` transaction callbacks are synchronous. **No `await` appears
inside any transaction, and no write transaction is open while a stream is
being read or YAML is being parsed.**

### 7.1 Failed validation import

One transaction: attempt with `outcome='failed-validation'` and null
`plan_version_id`; artifacts that passed their own bounds, also with null
`plan_version_id`; all diagnostics; one `plan.import.failed` audit row with
bounded metadata. No project, bundle, version, work item, edge, draft, or
workspace event. The notifier is not called.

A failed import creates no workspace event because a workspace event is the
browser's signal that accepted planning state changed. Emitting one would
assert state that does not exist, violating CT03-I05 and CT03-A44.

### 7.2 Success, duplicate, and changed version

All three share one immediate transaction, because `BEGIN IMMEDIATE` takes the
write lock at entry and therefore serialises concurrent importers, making a
pre-transaction duplicate probe unnecessary and race-free:

```text
tx =>
  existing = planVersions.findByDigest(workspaceId, digest)
  if existing:                                     DUPLICATE
      insert attempt(outcome='duplicate', projectId, planVersionId of existing)
      audit 'plan.import.duplicate'
      return existing            (no artifacts, no diagnostics, no event)
                                                   SUCCESS
  project = projectId ? requireInWorkspace(...) : insert(...)
  bundle  = findOrInsert(project)
  version = insert(bundle, versionNumber = max+1, digest, normalizedSource)
  attempt = insert(outcome='succeeded', projectId, planVersionId)
  insert artifacts, warning diagnostics, work items, dependency edges
  if project.activePlanVersionId is null: setActivePlanVersion(version)
  audit 'plan.import.succeeded' with bounded metadata
  append 'project-created' if the project was created
  append 'plan-version-imported'
```

**Ordering note (recorded during generation 2).** The Phase A sketch inserted the
attempt first. Implementation showed that cannot work on the success path: the
attempt row carries `project_id` and `plan_version_id` foreign keys, so its
parents must commit before it. The success path therefore writes
project → bundle → version → attempt → artifacts → diagnostics → items → edges,
while the failed-validation path still writes the attempt first because both
columns are null there. The fault-injection test asserts this exact order.

`notifier.notify()` runs after the transaction returns and only when a
workspace event was appended, so success notifies while duplicate and failure
do not. A duplicate creates no duplicate planning state because the branch
performs exactly two inserts and returns the existing identifiers;
`UNIQUE(workspace_id, content_digest)` is the database-level backstop.

Changed content with `projectId` present creates a new immutable version in the
same bundle with `versionNumber = max + 1` and leaves the active pointer alone.
Without `projectId` it creates a new project, never an implicit reattachment.

### 7.3 Admission

A read-only pre-check runs in `readTransaction`; if the item is already
admitted, the existing draft is returned with zero writes and no notification.
Otherwise one transaction re-reads the status inside the lock as a
concurrent-admission guard, sets `status='admitted'` with actor and time, bumps
`version`, inserts one `work_contract_drafts` row, appends
`work-item.admitted` and `work-contract-draft.created` audit rows, and appends
one `work-item-admitted` workspace event. The notifier fires after commit.

### 7.4 Proving no partial state

`planning-transactions.test.ts` is table-driven over every durable insert stage.
Each row injects a throw after that stage inside the transaction callback, then
asserts that all eleven affected tables are unchanged and that the notifier
generation is unchanged. This extends the accepted CT-02 pattern in
`transactions.test.ts`.

## 8. Services and HTTP

| Service | Responsibility |
|---|---|
| `PlanImportService` | role authorization, pure analysis, durable command, outcome transaction, post-commit notify |
| `PlanningQueryService` | authorized project list, project detail, plan-version detail, work-item detail, artifact bytes, recent import attempts |
| `WorkItemService` | admission transition, draft projection, idempotency, post-commit notify |
| `WorkspaceService` (extended) | `requireRole`; planning summary inside the existing snapshot read transaction |

Routes:

```text
POST /api/workspaces/:workspaceId/plan-imports                                     Owner|Editor
GET  /api/workspaces/:workspaceId/projects                                         member
GET  /api/workspaces/:workspaceId/projects/:projectId                              member
GET  /api/workspaces/:workspaceId/projects/:projectId/plan-versions/:planVersionId member
GET  /api/workspaces/:workspaceId/work-items/:workItemId                           member
POST /api/workspaces/:workspaceId/work-items/:workItemId/admit                     Owner|Editor
GET  /api/workspaces/:workspaceId/plan-artifacts/:artifactId                       member
GET  /api/workspaces/:workspaceId/plan-imports                                     member
```

The final route, bounded recent attempts with diagnostics, is the only addition
to §5.13's list. It is what the "Needs attention" region links to and what makes
a failed import inspectable after its response is gone.

The import response is a strict discriminated union on `outcome`:

```text
succeeded         importAttemptId, projectId, planVersionId, versionNumber,
                  isActiveVersion, itemCount, requiredDependencyCount,
                  warningCount, diagnostics[]
duplicate         importAttemptId, projectId, planVersionId, versionNumber
failed-validation importAttemptId, diagnostics[]
```

**All three return HTTP 200.** Each is a recorded, durable outcome of a valid
request. 4xx is reserved for transport and authorization faults — 401
unauthenticated, 403 bad CSRF/origin/role, 404 unknown workspace, 400
non-multipart or unparseable body — which record no attempt because they are
not import requests in the domain sense.

Role matrix:

| Operation | Viewer | Editor | Owner | Non-member |
|---|---|---|---|---|
| view projects, versions, items, artifacts, diagnostics, drafts | yes | yes | yes | 404 |
| import plan | 403 | yes | yes | 404 |
| admit work item | 403 | yes | yes | 404 |
| workspace audit page | 403 | 403 | yes | 404 |

Non-disclosure: a non-member workspace request returns 404 plus the existing
`workspace.access.denied` audit row; an authorized workspace with an unknown or
foreign project, version, work item, or artifact returns the identical 404 with
no audit noise. Artifact retrieval resolves the workspace through parent joins,
never by trusting the route parameter.

Queries are set-based. Project detail uses six bounded statements, work-item
detail four, artifact bytes one, and the snapshot planning summary three
grouped aggregates inside the existing snapshot read transaction. No N+1.

## 9. Snapshot and events

Audit actions added: `plan.import.succeeded`, `plan.import.failed`,
`plan.import.duplicate`, `work-item.admitted`, `work-contract-draft.created`.

Event kinds and strict payloads:

```text
project-created        { projectId, name }
plan-version-imported  { projectId, planVersionId, versionNumber, document,
                         itemCount, requiredDependencyCount, warningCount }
work-item-admitted     { projectId, planVersionId, workItemId, sourceWorkItemId,
                         workContractDraftId }
```

Each joins the existing `workspaceEventEnvelopeSchema` discriminated union and
is validated by the server before sending and by the browser again. Existing
envelope correlation columns (`project_id`, `work_item_id`) are populated where
semantically correct rather than adding a competing envelope.

**Summary-event strategy.** Importing AQ-CONT-1 appends two events, never
fourteen. The activity journal records the meaningful transition; the
authoritative work-item table carries the detail.

Extended snapshot, all computed inside the existing single read transaction
alongside `asOfSequence`:

```text
statusSummary   { needsAttention, active, planningReady, dependencyBlocked }
planningSummary { projectCount, importAttentionCount, proposedCount,
                  admittedCount, planningReadyCount, dependencyBlockedCount,
                  riskCounts{low, medium, high, critical, unspecified} }
projects        ProjectSummary[]  (≤ 50)
```

No artifact bytes, no diagnostic text, no dependency edges.

Status derivation from the active plan version: `planningReady` is `proposed`
with no un-Completed required predecessor; `dependencyBlocked` has at least one;
`active` is `admitted`; `needsAttention` counts import attempts that failed
validation or carry warnings. The SQL is written in the general
"predecessor not Completed" form rather than hard-coding "no predecessors", so
the language stays honest and CT-04's completion workflow only widens a CHECK.

Browser invalidation marks scopes stale and refetches authoritative queries; it
never patches the planning model from an event payload:

```text
project-created       → workspace summary + project list
plan-version-imported → workspace summary + that project's detail
work-item-admitted    → workspace summary + project detail + that item's detail
```

The cursor still advances through the event. A refetch failure surfaces a
degraded banner without discarding the last good projection.

**Notifier proof.** `server-planning-events.test.ts` listens on a real ephemeral
port with `streamHooks.waitTimeoutMs = 60_000`, far longer than the whole test,
so any observed delivery must come from the same-process notifier rather than
the fallback poll. A separate case injects a no-op notifier and asserts recovery
through the durable timeout and re-query, preserving CT-02's dropped-notification
guarantee. Both snapshot/SSE race orderings are covered.

## 10. Browser

**Navigation uses no router dependency.** `lib/route.ts` exports pure
`parseRoute` and `buildPath` (unit-testable under `node`); `lib/use-route.ts` is
a small `pushState` and `popstate` hook. Four static route shapes need roughly
fifty lines, whereas a router brings the data-loading framework ADR-001
deliberately excluded and contract §5.14 warns against. Vite's default SPA
fallback already serves `index.html` for deep links.

```text
/
/workspaces/:workspaceId
/workspaces/:workspaceId/import
/workspaces/:workspaceId/projects/:projectId
/workspaces/:workspaceId/projects/:projectId/plans/:planVersionId
/workspaces/:workspaceId/work-items/:workItemId
```

The import surface uses role-labelled file inputs, an optional project name or
existing-project selector, local count/size/extension pre-validation, and three
visually and textually distinct outcomes — imported new version, identical to an
existing version, and failed validation — with diagnostics grouped by severity
showing code, artifact, work-item ID, and message.

The dashboard's four regions become **Needs attention**, **Active**, **Ready for
admission**, and **Dependency-blocked** with real server-derived counts and
visible, not tooltip-only, labels, plus project cards and a risk distribution.

Project detail shows project and active plan metadata, version history, source
artifact inventory, diagnostics, risk distribution, proposed/admitted/
planning-ready/blocked counts, and the full work-item table with ID, title,
risk, status, required predecessors, blockers, primary areas, and exit gate
summary, filterable by risk and status.

Plan-version detail shows the immutable header (version number, digest,
algorithm, format version, profile, document, creator, time), counts, artifacts,
diagnostics, and items.

Work-item detail shows source ID and title, plan version, risk, primary areas,
exit gate, required and recommended dependencies with each predecessor's status,
current blockers, admission status, an explicit admission control that stays
enabled when blocked with the blockers shown adjacent, and the draft after
admission.

Artifact text renders as React text children inside `<pre>`. Diagnostics render
as a severity-grouped list.

Accessible labels, each rendered as text with colour never the sole carrier:

```text
Proposed · Admitted · Ready for admission · Dependency-blocked
Draft — not executable
```

Never a bare "Ready".

Design tokens gain no new colours; the existing attention/active/ready/blocked
pairs are reused. `global.css` gains table, badge, filter-bar, definition-list,
and source-text classes on the existing spacing, radius, and type scales, plus a
reading measure and a stacked layout below 900 px.

No graph canvas, IDE, or frontend framework: §5.14 forbids the canvas, a
dependency-summary table conveys the same information for a 14-node graph, and
AGENTS.md and ADR-001 both resist accumulating framework machinery in a
projection surface.

## 11. Admission and draft

Only `Proposed → Admitted` is exposed anywhere in contracts, services, routes,
or UI. Authorization requires an authenticated Owner or Editor with
session-bound CSRF and the origin policy. A second admission returns the
existing draft and writes no audit, event, or draft row.

A dependency-blocked item may be admitted through explicit user action; the UI
shows the blockers next to the control and states that admission means accepted
into the agenda, not run now. Blockers remain visible afterwards.

Draft document, `schemaVersion: 1`, `status: draft`, `completeness: incomplete`:

```text
source        projectId, planVersionId, workItemId, sourceWorkItemId
objective     title, exitGate
classification risk, primaryAreas
dependencies  required[{sourceId,title,status}], recommended[...]
repository    status: unresolved
baseRevision  status: unresolved
scope         status: unresolved, writable: [], forbidden: []
verification  status: unresolved, checkIds: []
review        requiredPerspectives: [specification, correctness]
              maxRemediationGenerations: 3
merge         humanAuthorizationRequired: true
missing       registered-repository · exact-base-revision · path-scope
              verification-policy · protected-acceptance-criteria
              agent-backend · execution-environment
```

There is deliberately no `approved`, `executable`, `ready`, or active status
field. Nothing in the document can be misread as authorization.

The draft cannot be approved or executed in CT-03 because no approval, change
request, worktree, agent, command, verification, or merge route exists;
`route-inventory.test.ts` enumerates every registered route against an allowlist
and fails on any addition; the extended scope script fails on any Git, process,
or agent import; and `work_contract_drafts` carries no-update triggers, so the
draft cannot transition even in the database.

## 12. Acceptance mapping

| IDs | Evidence |
|---|---|
| A01–A07 | `packages/storage/src/migration-0002.test.ts`; A02 also `migrations.test.ts` |
| A08, A33, A34 | `packages/storage/src/planning-schema.test.ts` |
| A09–A12 | `packages/planning/src/aq-fixture.test.ts` against the expectation file |
| A13, A23 | `packages/planning/src/bundle.test.ts` + `server-plan-import.test.ts` |
| A14, A24 | `packages/planning/src/parse.test.ts` |
| A15, A16 | `packages/planning/src/normalize.test.ts` |
| A17–A20 | `packages/planning/src/graph.test.ts` |
| A21, A22 | `packages/planning/src/digest.test.ts` |
| A25, A27 | `packages/storage/src/planning-transactions.test.ts` |
| A26, A31, A43, A44 | `apps/server/src/services/plan-import-service.test.ts` |
| A28–A30, A38, A41, A42 | `apps/server/src/server-plan-import.test.ts` |
| A32, A35, A36, A39, A40, A51, A52 | `apps/server/src/server-planning-queries.test.ts` |
| A37 | `server-plan-import.test.ts` + `server-admission.test.ts` |
| A45–A47, A49 | `apps/server/src/server-planning-events.test.ts` |
| A48 | `packages/storage/src/snapshot.test.ts` + `server-planning-queries.test.ts` |
| A50 | `apps/server/src/restart.test.ts` (daemon restart) + `e2e/planning.spec.ts` (refresh), per §2.2 |
| A53–A56 | `server-admission.test.ts` + `services/work-item-service.test.ts` |
| A57, A58 | `packages/planning/src/work-contract-draft.test.ts` + `server-admission.test.ts` |
| A59 | `apps/server/src/route-inventory.test.ts` + `check:scope` |
| A60, A62, A64, A65, A67 | `apps/web/src/features/planning/*.test.tsx`, `lib/planning-labels.test.ts`, `lib/workspace-projection.test.ts`, `e2e/planning.spec.ts` |
| A61, A63 | `e2e/planning.spec.ts` with the real AQ fixture |
| A66 | `apps/web/src/lib/workspace-projection.test.ts` |
| A68 | full existing suite kept green |
| A69 | literal root `pnpm check` under pnpm-managed Node 24.18.0 |
| A70 | extended `scripts/check-forbidden-scope.mjs` and its test |
| A71 | documentation inspection |

Invalid fixtures live in `fixtures/plan-bundles/invalid/` as real files, so
parser tests are real-file tests like the AQ case.

Final gate, literal and unchanged:

```text
pnpm check
  → pnpm format:check → pnpm lint → pnpm typecheck → pnpm build
  → pnpm test → pnpm test:e2e → pnpm check:scope
```

## 13. Source mismatches to correct

| # | Mismatch | Disposition |
|---|---|---|
| M1 | Package cites `work-items/CT-03.md`, `work-items/CT-03-aq-import-expectations.yaml`, `work-items/CT-02-accepted-implementation-plan.md`; actual paths are under `work-items/CT-0N/` | Fix the matrix `expectations:` path; note the rest. Contract text and expectation values are not altered |
| M2 | `CLAUDE.md` and `README.md` name a non-existent `work-items/CT-02.md` | Update both to CT-03 |
| M3 | `migrations.test.ts` asserts schema version 1 in four places and name `ct02-foundation` | Update to version 2 |
| M4 | `restart.test.ts:60` asserts `currentVersion === 1` | Update to 2 |
| M5 | `cli.test.ts` fabricates schema row `(2,'future')` for the unsupported-version case, which becomes a name mismatch once 0002 exists | Move the fabricated row to version 3 |
| M6 | `workspace_events.payload_json` CHECK is workspace-created specific | Replaced by the rebuild; strict shape stays in Zod |
| M7 | `WorkspaceEventRepository` has no kind-generic append; `mapEvent` is single-kind typed | Add `appendEvent` and a discriminated mapper |
| M8 | `check-forbidden-scope.mjs` checks only Exo Stack patterns; A70 also requires Git, worktree, agent, process runner, review, merge, and Planning Studio proof | Extend the script and its test |
| M9 | `vitest.config.ts` lacks the planning alias, `*.test.tsx`, and a DOM environment; root `tsconfig.json` lacks the planning reference | Add all |
| M10 | `statusSummary` keys `ready`/`blocked` are the ambiguity §13.4 warns about | Renamed per §2.3 |
| M11 | Neither `yaml` nor a multipart parser is installed | Add `yaml@2.9.0` and `@fastify/multipart@10.1.0` |
| M12 | `apps/web` has no DOM test environment | Added per §2.1 |
| M13 | §5.13's routes cannot target an existing project for a changed import | `projectId` field per §2.4 |
| M14 | `authorizeMutation` is private to `routes/auth.ts`; no reusable role gate exists | Extract to `routes/request-security.ts`; add `WorkspaceService.requireRole` |
| M15 | `createTestContext` cannot inject `streamHooks`, so A45–A47 cannot be written | Extend the harness |
| M16 | `StatusRegions` hints say "No executable work in CT-02"; `SERVER_VERSION` is `0.2.0` | Update; bump to `0.3.0` |
| M17 | `docs/architecture.md` deferred section states CT-02 has no imported plans | Rewrite for CT-03 |

No mismatch requires a contract amendment.

## 14. Generations

| # | Content | Verification | Reviewer focus | Stop condition |
|---|---|---|---|---|
| 1 | Accepted plan, five ADRs, planning IDs and domain records, `@craftingtable/planning`, invalid fixtures, tsconfig and vitest wiring | Planning package tests; AQ counts from the expectation file; all invalid diagnostics; digest property tests | dependency purity, YAML safety, digest determinism, cycle determinism | AQ counts disagree with the expectation file, or the parser needs filesystem or HTTP access |
| 2 | Migration 0002, catalogs, planning schema, nine repositories, storage types and transactions | Storage tests; A01–A08, A25, A27, A33, A34 | journal preservation, sequences, triggers, ownership, rollback completeness | any CT-02 row, sequence, or trigger fails to survive, or the in-migration guard trips |
| 3 | Multipart plugin and bounded reader, `PlanImportService`, import route, extracted request security, post-commit notifier | First vertical: real HTTP multipart to SQLite to audit to events; imports the exact AQ fixture; A28–A30, A38, A41–A45 | atomicity, duplicate idempotency, CSRF/origin/role, notifier fast path, audit bounding | an import cannot be made atomic, or the notifier is used as storage |
| 4 | Planning contracts, extended snapshot, `PlanningQueryService`, query and artifact routes | A32, A35, A36, A39, A40, A48, A49, A51, A52 | workspace isolation, non-disclosure, snapshot consistency, N+1 avoidance | cross-workspace disclosure, or a snapshot that is not transactionally consistent |
| 5 | Route module and hook, import page, dashboard regions, project/plan/work-item pages, viewers, CSS, DOM test environment | A60–A62, A64–A67; existing auth, SSE, and outage E2E still green | honest labels, escaped rendering, preserved projection on failure | rendering would need CT-04+ data, or a framework rewrite begins |
| 6 | `WorkItemService`, admit route, draft persistence, draft panel | A46, A53–A58 | idempotency, atomicity, non-executability, notifier fast path | the draft could be read as approved or executable |
| 7 | Planning E2E, extended scope script, route inventory, regression sweep, all documentation, completion report, literal `pnpm check` | A50, A59, A63, A68–A71 | scope absence, documentation truth, evidence completeness | any acceptance case fails, in which case CT-03 is reported blocked and not weakened |

Generation 3 is the first end-to-end working point. Nothing is committed or
merged at any generation without explicit operator authorization.

## 15. Scope

This plan implements none of the following: repository registration; canonical
host repository paths; Git, branches, commits, diffs, merges, or worktrees;
change requests or generation commits; real coding-agent integration; command or
process execution; verification runners; review, remediation, readiness, or
merge workflows; work-contract approval or execution; Planning Studio, plan
version activation, or model-generated planning; interactive dependency graph
editing; ZIP, host-path, or external-URL import; a general artifact system; LAN
exposure, TLS, systemd, or backup tooling; activated multi-user collaboration
beyond CT-02's existing identity, membership, and role authorization; or any
ActionQueue, WorldInterface, or Exoskeleton dependency.

`packages/agents`, `packages/git`, and `packages/testing` remain non-production
seams. `route-inventory.test.ts` and the extended scope script make each
exclusion mechanically checkable rather than merely asserted.

## 16. Deliberately deferred

Documented, not implemented: plan version activation and comparison; Planning
Studio editing and model-assisted planning; a general content-addressed artifact
store; dependency graph visualisation; cross-project and cross-repository
dependencies; repository binding and base revisions; work-contract approval and
execution; diagnostic and artifact retention policy; external dependency
references in `depends_on`; import-attempt cleanup; a browser YAML preview of
the draft contract, which would require shipping a YAML serialiser for cosmetic
benefit where contract §5.12 says "may", not "must".
