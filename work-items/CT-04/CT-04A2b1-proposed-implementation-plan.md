# CT-04A2b1 proposed implementation plan

**Status:** Phase A source-specific proposal; not accepted and not implementation authority  
**Slice:** CT-04A2b1 — Repository journal correlation and browser projection  
**Parent:** CT-04A2b — Repository lifecycle and event integration  
**Planning checkout:** `6aed9bda58fac0824f707691106aff0abbf35cdb`  
**Accepted source head:** `e3b69c612a51b0b2a8d436ae3ea5355abd40745e`

## 1. Authorization boundary and stop condition

This document records the Phase A implementation proposal for independent third-party
review. It proposes source changes but authorizes none.

The required next sequence is:

```text
independent design review of this proposal
    → operator disposition of every material finding
    → CT-04A2b1 design-review disposition
    → CT-04A2b1 accepted implementation plan with reconciliation appendix
    → stop for separate explicit implementation permission
    → implementation of B1 only
```

No accepted plan, product-source implementation, migration, implementation report, or
commit is created by recording this proposal. Protected specifications remain read-only.
B2 repository lifecycle behavior remains forbidden.

## 2. Checkout and source reconciliation

### 2.1 Verified checkout

At proposal time:

```text
branch: ct=04a2b1-repository-journal
HEAD:   6aed9bda58fac0824f707691106aff0abbf35cdb
source: e3b69c612a51b0b2a8d436ae3ea5355abd40745e
```

`e3b69c612a51b0b2a8d436ae3ea5355abd40745e` is an ancestor of the planning
checkout. The only descendant commit is:

```text
6aed9bd operator choie: ct-04a2b, slice 1 planning package
```

The accepted-source-to-planning-checkout diff contains only ten A2b planning-package
files, with 5,057 insertions and 42 deletions. It contains no product-source change.
The worktree was clean before this proposal file was created.

### 2.2 Immutable pins

| Artifact | SHA-256 |
|---|---|
| `0001-ct02-foundation.sql` | `42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273` |
| `0002-ct03-planning.sql` | `6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247` |
| `0003-ct04a2a-repository-model.sql` | `526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4` |
| Original CT-04 protected specification | `ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64` |
| A2 protected supplement | `1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c` |
| A2b protected supplement | `255fe8b61ede97aa3366ab5e81214031ef2053e89c0246b0b9c4c7b14278ebad` |

### 2.3 Every source divergence from the B1 package

1. The event domain has four kinds, no repository correlations, and no
   introduced-schema map.
2. The Zod envelope has four variants and no repository payload or
   kind-specific correlation validation.
3. `AppendWorkspaceEventInput` has no repository, inspection, or binding
   correlations.
4. The storage row mapper and INSERT cover only the four existing kinds.
5. Schema 3 has no repository correlation columns or repository event-kind rows.
6. Migration tests hard-code schema 3. The schema-2 catalog test compares against
   the entire domain kind list and will become incorrect when schema-4 kinds exist.
7. Schema 3 already supplies every required candidate key. Migration 0003 requires
   no change.
8. Snapshot and SSE implementations are kind-neutral and cursor-correct. They need
   mixed legacy/repository regression tests, not production changes.
9. Browser stale scopes contain only `workspaceSummary`, `projectIds`, and
   `workItemIds`.
10. Same-workspace snapshot load currently clears all stale scopes. Repository
    staleness must survive because B1 adds no repository fetch.
11. `stale-consumed` currently clears every stale scope. It must preserve repository
    scopes that B1 cannot consume.
12. `ActivityPanel` has a private four-kind exhaustive description switch and no
    focused render-safety suite.
13. The scope checker has A2a-specific restrictions but no B1 source classification.
14. The protected-package checker has A2a evidence but no B1 IDs, hashes, or report
    lineage.
15. ADR-013 describes catalog insertion as the ordinary future-kind operation. B1
    is a deliberate exception because structural correlation columns are required.
16. No repository route, service, feature configuration, lifecycle command, or
    repository-specific notifier producer exists. B1 must preserve that absence.
17. The A2a observation-assessment gap remains B2-owned and is not touched.

## 3. Exact target tree and predicted change size

### 3.1 Governance artifacts after review

```text
work-items/CT-04/CT-04A2b1-design-review-disposition.md
work-items/CT-04/CT-04A2b1-accepted-implementation-plan.md
```

Later implementation and remediation turns add new immutable reports rather than
overwriting earlier evidence:

```text
work-items/CT-04/CT-04A2b1-implementation-report.md
work-items/CT-04/CT-04A2b1-remediation-<N>-report.md
```

### 3.2 Proposed implementation tree

```text
README.md
CLAUDE.md
docs/architecture.md
docs/security.md
docs/operations.md
docs/decisions/README.md
docs/decisions/ADR-013-journal-vocabulary-catalogs.md
docs/decisions/ADR-018-repository-journal-correlation.md

packages/domain/src/workspace-events.ts
packages/domain/src/workspace-events.test.ts

packages/contracts/src/workspace-event.ts
packages/contracts/src/workspace-event.test.ts

packages/storage/migrations/0004-ct04a2b-repository-journal.sql
packages/storage/src/types.ts
packages/storage/src/repositories/workspace-events.ts
packages/storage/src/migrations.test.ts
packages/storage/src/migration-0002.test.ts
packages/storage/src/migration-0003.test.ts
packages/storage/src/migration-0004.test.ts
packages/storage/src/repositories.test.ts
packages/storage/src/snapshot.test.ts

apps/server/src/services/workspace-event-stream-service.test.ts

apps/web/src/lib/workspace-projection.ts
apps/web/src/lib/workspace-projection.test.ts
apps/web/src/components/ActivityPanel.tsx
apps/web/src/components/ActivityPanel.test.tsx

scripts/check-forbidden-scope.mjs
scripts/check-forbidden-scope.test.mjs
scripts/check-ct04-protected-package.mjs
scripts/check-ct04-protected-package.test.mjs
```

Prediction: 30 implementation/documentation files and approximately 2,500–3,500
changed lines, dominated by migration guards and adversarial tests. No manifest,
lockfile, production server, route, service, configuration, A1, Git, notifier, or
repository-state implementation file is in the target tree.

## 4. Domain event variants and introduced-schema map

Add exactly these kinds:

```text
repository-registered
repository-status-changed
repository-evidence-changed
project-repository-bound
project-repository-binding-retired
```

Add these optional structural correlations to the common envelope vocabulary:

```text
repositoryId
repositoryInspectionId
repositoryBindingId
```

Each event variant then strengthens its required and forbidden dimensions with
required properties or `?: never`. The optional base must not make illegal
correlations type-correct for a specific variant.

The exact introduced-schema map is:

| Kind | Introduced schema |
|---|---:|
| `workspace-created` | 1 |
| `project-created` | 2 |
| `plan-version-imported` | 2 |
| `work-item-admitted` | 2 |
| `repository-registered` | 4 |
| `repository-status-changed` | 4 |
| `repository-evidence-changed` | 4 |
| `project-repository-bound` | 4 |
| `project-repository-binding-retired` | 4 |

Envelope `schemaVersion` remains 1. Adding variants and optional correlations does not
change the representation of an existing variant.

## 5. Strict payload schemas and version relationships

All five payload schemas are strict objects. Corresponding structural and payload IDs
must be identical.

### 5.1 `repository-registered`

Structural:

```text
required:  repository, inspection
forbidden: project, work item, run, binding
```

Payload:

```ts
{
  repositoryId;
  inspectionId;
  displayName;
  status: 'active';
  statusReason: 'registration-accepted';
  version: 1;
}
```

### 5.2 `repository-status-changed`

Structural:

```text
required:  repository
conditional: inspection absent exactly for operator retirement
forbidden: project, work item, run, binding
```

Payload:

```ts
{
  repositoryId;
  inspectionId?;
  displayName;
  fromStatus;
  toStatus;
  statusReason;
  priorVersion;
  resultingVersion;
}
```

Relationships:

- `fromStatus !== toStatus`;
- `statusReason` belongs to `REPOSITORY_STATUS_REASON_SETS[toStatus]`;
- `resultingVersion === priorVersion + 1`;
- both versions are positive safe integers;
- inspection is absent exactly when `toStatus === 'retired'` and
  `statusReason === 'operator-retired'`.

### 5.3 `repository-evidence-changed`

Structural:

```text
required:  repository, inspection
forbidden: project, work item, run, binding
```

Payload:

```ts
{
  repositoryId;
  inspectionId;
  displayName;
  evidenceClass: 'risk-scan';
  repositoryVersion;
}
```

`repositoryVersion` is a positive safe integer and describes unchanged repository
state version.

### 5.4 Binding kinds

Structural:

```text
required:  project, repository, binding
forbidden: work item, run, inspection
```

Payloads:

```ts
project-repository-bound {
  projectId;
  repositoryId;
  bindingId;
  repositoryDisplayName;
  bindingVersion: 1;
}

project-repository-binding-retired {
  projectId;
  repositoryId;
  bindingId;
  repositoryDisplayName;
  priorVersion;
  resultingVersion;
}
```

Retirement requires `resultingVersion === priorVersion + 1`, with positive safe
integers.

### 5.5 Explicitly rejected fields

The strict schemas reject unknown readiness, authority, environment, command, and raw
Git evidence, including:

```text
ready, readiness, executable, approved, verified, reviewed, mergeable,
command, argv, cwd, environment,
requestedPath, canonicalTopLevel, canonicalGitDirectory, canonicalCommonGitDirectory,
observation, observationJson, errorEvidence, stdout, stderr, gitExecutable,
ref, branch, worktree, remote
```

Display names reuse `repositoryDisplayNameSchema`.

## 6. Schema-4 table and structural ownership

### 6.1 Column order

The rebuilt `workspace_events` table preserves existing definitions and uses:

```text
sequence
id
schema_version
occurred_at
workspace_id
actor_user_id
project_id
work_item_id
run_id
repository_id
repository_inspection_id
repository_binding_id
kind
payload_json
```

### 6.2 Composite foreign keys

```sql
FOREIGN KEY (workspace_id, repository_id)
  REFERENCES registered_repositories(workspace_id, id)

FOREIGN KEY (workspace_id, repository_id, repository_inspection_id)
  REFERENCES repository_inspections(workspace_id, repository_id, id)

FOREIGN KEY (workspace_id, project_id, repository_id, repository_binding_id)
  REFERENCES project_repository_bindings(workspace_id, project_id, repository_id, id)
```

The required candidate keys already exist in immutable migration 0003.

### 6.3 Kind-specific presence rules

```text
legacy kinds
    all three repository correlations NULL

repository-registered
    repository + inspection required
    project, work item, run, binding absent

repository-status-changed
    repository required
    inspection required except operator retirement
    project, work item, run, binding absent

repository-evidence-changed
    repository + inspection required
    project, work item, run, binding absent

project-repository-bound / project-repository-binding-retired
    project + repository + binding required
    inspection, work item, run absent
```

SQL also enforces correlation/payload ID equality and the retirement/inspection
relationship. It does not duplicate the full Zod payload schema.

### 6.4 Catalog, index, and triggers

- Insert exactly five event-kind rows with `introduced_in_schema = 4`.
- Preserve the four old rows and introduction values.
- Preserve event-kind catalog update/delete immutability.
- Restore `idx_workspace_events_workspace_sequence(workspace_id, sequence)`.
- Restore the existing workspace-event update/delete rejection triggers.
- Add no speculative repository-event query index; B1 adds no such query.

### 6.5 Migration guards

Before the renamed old table is dropped, assert:

- equal row count;
- equal maximum sequence;
- bilateral row equality over every legacy column;
- exact payload bytes using BLOB/hex comparison, not JSON equivalence;
- all migrated repository correlations are null;
- exact nine-row event-kind catalog and introduction map;
- exact required index and trigger catalog bound to the new table;
- no `pragma_foreign_key_check` rows;
- `pragma_integrity_check` returns exactly `ok`;
- exact captured `sqlite_sequence` row presence and value.

Repeat sequence, catalog, trigger, FK, and integrity checks after the old table is
dropped. Any guard failure occurs inside the migration transaction and restores a
readable schema 3.

## 7. Exact AUTOINCREMENT preservation

The migration must not derive the next value from `MAX(sequence)`.

1. Capture whether `sqlite_sequence` contains a `workspace_events` row.
2. Capture its exact `seq`, including a high-water value above the current maximum
   after deletions.
3. Rename the schema-3 table.
4. Create the new AUTOINCREMENT table.
5. Copy rows with explicit sequence values.
6. If the old sequence row existed, insert or update the new table's sequence row to
   that exact value.
7. If no old row existed, do not invent a high-water value.
8. Assert sequence-row presence and value before and after dropping the old table.
9. Append after migration and require the next sequence to be old `sqlite_sequence + 1`.

A read-only local SQLite probe confirmed that explicit restoration survives the
rename/copy/drop sequence and controls the next insert.

## 8. Foreign-key invariant matrix

Every new composite FK receives these cases:

| Case | Expected |
|---|---|
| Correct same-workspace parent | accepted |
| Parent exists only in another workspace | rejected |
| Same workspace, wrong repository inspection | rejected |
| Same workspace, wrong project/repository binding | rejected |
| Missing parent | rejected |
| Nullable dimension on a kind that permits it | accepted |
| Nullable dimension on a kind requiring it | rejected by kind check |

The nullable status-inspection exception is limited to operator retirement. SQLite's
nullable composite-FK behavior is therefore closed by kind-specific presence checks.

## 9. Storage append input and row mapping

`AppendWorkspaceEventInput` becomes a kind-discriminated input whose payload and
structural correlations are selected together. Storage does not infer structural IDs
from payload JSON.

The INSERT adds:

```text
repository_id
repository_inspection_id
repository_binding_id
```

The row type and base mapper add the corresponding branded IDs. The event mapper keeps
an exhaustive, no-default branch for all nine kinds. Each branch constructs the exact
domain variant.

Unknown catalog kinds, invalid JSON, and invalid structural correlations fail closed.
`listAfter` and `listRecentAtOrBefore` remain workspace-filtered and sequence-ordered.

No repository, inspection, or binding state mutation is introduced. B1 only appends
and reconstructs journal rows supplied by future authorized B2 callers.

## 10. Browser stale-scope projection

Add:

```ts
readonly repositoryList: boolean;
readonly repositoryIds: readonly RepositoryId[];
```

### 10.1 Event-by-event invalidation

| Event | Workspace summary | Project IDs | Work-item IDs | Repository list | Repository IDs |
|---|---:|---|---|---:|---|
| `workspace-created` | yes | — | — | no | — |
| `project-created` | yes | payload project | — | no | — |
| `plan-version-imported` | yes | payload project | — | no | — |
| `work-item-admitted` | yes | payload project | payload item | no | — |
| `repository-registered` | no | — | — | yes | repository |
| `repository-status-changed` | no | — | — | yes | repository |
| `repository-evidence-changed` | no | — | — | yes | repository |
| `project-repository-bound` | no | project | — | no | repository |
| `project-repository-binding-retired` | no | project | — | no | repository |

### 10.2 Reducer behavior

- IDs remain stable-order deduplicated.
- Duplicate or lower sequences remain ignored.
- Foreign-workspace events increment the rejection counter and mutate no projection.
- Same-workspace snapshots retain live tail, cursor, diagnostic counters, and
  repository stale scopes.
- `stale-consumed` clears only scopes current B1 UI queries can consume; repository
  scopes remain available for CT-04E.
- Workspace change clears events, repository IDs, stale scopes, and counters before
  the next workspace can render.
- No repository fetch, page, or model projection is added.

## 11. Activity descriptions and render safety

`ActivityPanel` gains a small exported description helper with an exhaustive switch and
no default.

Descriptions:

- are nonempty and deterministically bounded;
- use validated display names only as React text data;
- never use `dangerouslySetInnerHTML`;
- describe observations, not readiness or authority conclusions;
- distinguish registration, status change, risk evidence change, binding, and
  binding retirement.

Tests cover:

- all nine event kinds;
- a hostile HTML-like display name rendered as text with no created element or
  event-handler execution;
- a proposed 256-character upper bound;
- absence of `ready`, `verified`, `reviewed`, `mergeable`, or equivalent claims;
- exact all-kind tables and exhaustive switches.

## 12. Acceptance and protected-ID mapping

### 12.1 B1 migration cases

| ID | Proof |
|---|---|
| `B1-MIG-001` | Schema-4 preservation fixture; bilateral row and payload-byte comparison |
| `B1-MIG-002` | Deleted high-water `sqlite_sequence` and next append |
| `B1-MIG-003` | Exact index/trigger catalog plus behavioral update/delete rejection |
| `B1-MIG-004` | Old catalog versions and all four legacy behaviors |
| `B1-MIG-005` | SHA-256 pins for migrations 0001–0003 |
| `B1-MIG-006` | Test copy of 0004 with a uniquely identified forced-failing guard; schema-3 rollback |
| `B1-MIG-007` | Fresh migrations 1→4 with catalog, FK, and integrity checks |
| `B1-MIG-008` | Applied 0004 then mutated migration bytes; checksum rejection |

### 12.2 B1 correlation cases

| ID | Proof |
|---|---|
| `B1-COR-001` | Positive same-workspace cases for every repository kind |
| `B1-COR-002` | Foreign-workspace repository rejected |
| `B1-COR-003` | Missing repository rejected |
| `B1-COR-004` | Sibling-repository inspection rejected |
| `B1-COR-005` | Inspection without repository rejected |
| `B1-COR-006` | Sibling-project binding rejected by four-column FK |
| `B1-COR-007` | Binding without project or repository rejected |
| `B1-COR-008` | Legacy kind carrying repository correlation rejected |
| `B1-COR-009` | Registration without inspection rejected |
| `B1-COR-010` | Evidence change without inspection rejected |
| `B1-COR-011` | Operator retirement without inspection accepted; inverse cases rejected |
| `B1-COR-012` | Binding with work-item, inspection, or run rejected |

### 12.3 B1 contract cases

| ID | Proof |
|---|---|
| `B1-CON-001`–`005` | Every valid new variant, including both status forms and binding kinds |
| `B1-CON-006` | Table-driven readiness, authority, environment, raw-Git, and unknown-field rejection |
| `B1-CON-007` | Status version relationship |
| `B1-CON-008` | Binding-retirement version relationship |
| `B1-CON-009` | Control-character and overlength display names |
| `B1-CON-010` | Status/reason, ID parity, and retirement/inspection coupling |

### 12.4 B1 storage cases

| ID | Proof |
|---|---|
| `B1-STO-001` | Append/read round trip for all five new kinds |
| `B1-STO-002` | Mixed legacy/new global sequence ordering |
| `B1-STO-003` | Cursor-bounded mixed recent activity |
| `B1-STO-004` | Unknown-kind direct insert |
| `B1-STO-005` | Exhaustive mapper and domain/catalog parity |
| `B1-STO-006` | Foreign-workspace `listAfter` |
| `B1-STO-007` | Append-only update/delete rejection |
| `B1-STO-008` | Invalid JSON rejection |

### 12.5 B1 browser cases

| ID | Proof |
|---|---|
| `B1-UI-001` | Registration list/ID invalidation and retained event |
| `B1-UI-002` | Status/evidence invalidation |
| `B1-UI-003` | Binding project/repository invalidation |
| `B1-UI-004` | Duplicate/lower sequence |
| `B1-UI-005` | Foreign workspace |
| `B1-UI-006` | Same-workspace snapshot/live-tail/repository-stale preservation |
| `B1-UI-007` | Workspace-switch clearing |
| `B1-UI-008` | Hostile display rendering |
| `B1-UI-009` | Bounded descriptions for every kind |
| `B1-UI-010` | Exhaustive description and invalidation switches |

### 12.6 B1 scope, process, and regression

| ID | Proof |
|---|---|
| `B1-SCOPE-001` | B1 path allowlists and negative Git/process/Fastify/service/notifier/lifecycle fixtures |
| `B1-SCOPE-002` | Original and A2 supplement hashes |
| `B1-SCOPE-003` | Migration-0003 hash and A2a semantic-source diff |
| `B1-SCOPE-004` | Real implementation head and immutable report lineage |
| `B1-SCOPE-005` | Unchanged exact route inventory |
| `B1-SCOPE-006` | Documentation claims foundation only |
| `B1-PROC-001` | Proposal → independent review → disposition → accepted plan before source |
| `B1-PROC-002` | Real head only after commit exists; a new report for every remediation turn |
| `B1-PROC-003` | Original, A2, and A2b protected hashes remain fixed |
| `B1-REGRESS-001` | Full `pnpm check`, including Playwright |
| `B1-REGRESS-002` | Mixed snapshot/SSE cursor and durable re-query tests |

### 12.7 Inherited A2B-JRN cases

| ID | B1 mapping |
|---|---|
| `A2B-JRN-001` | `B1-MIG-001/002` |
| `A2B-JRN-002` | Repository workspace/missing-parent cases |
| `A2B-JRN-003` | Inspection ownership cases |
| `A2B-JRN-004` | Four-column binding ownership cases |
| `A2B-JRN-007` | Binding project/repository invalidation |
| `A2B-JRN-011` | Strict readiness/raw-Git rejection |
| `A2B-JRN-012` | Legacy contract/storage/projection regression |

`A2B-JRN-005`, `006`, `008`, `009`, and `010` remain B2-owned. B1 supplies
generic durable read/replay primitives but does not claim lifecycle producer, notifier,
or authorization completion.

### 12.8 Original protected specification

B1 contributes to, but does not prematurely close:

- `A-MIG-001`: journal-preserving schema migration;
- `JRN-REP-004`: durable re-query foundation;
- `JRN-REP-005`: workspace-isolated event-access foundation;
- `UI-RENDER-001`, `002`, and `005`: escaped, bounded, non-readiness text;
- `REGRESS-001`–`005`: accepted CT-02/CT-03 behavior, isolation, and route absence;
- `E-SCOPE-001`: no agent, verification, review, readiness, merge, or remote-Git
  behavior;
- `P-PROCESS-001`–`004`: plan, review/disposition, real head, and protected hash.

`REG-*`, `OWN-*`, `JRN-REP-001`–`003`, and all lifecycle/audit/notifier
completion remain outside B1.

## 13. Scope checker and negative authority proof

The scope checker classifies exact B1 production paths with closed allowlists:

- domain event files: domain/local imports only;
- contract event files: domain, Zod, and local imports;
- storage event files: domain, `better-sqlite3`, and local imports;
- browser projection/activity: contracts/domain, React, and local imports.

It rejects:

```text
@craftingtable/git
node:child_process
Fastify or route registration
server services
repository configuration
notifier calls
repository registry mutation
repository lifecycle commands
```

Negative fixtures prove every forbidden category. The checker does not acquire Git or
process authority merely to inspect diffs. Protected hashes and changed-path inventory
remain deterministic checks outside production authority.

## 14. ADR and documentation changes

Add ADR-018 to record:

- additive envelope-version-1 repository correlations;
- the schema-4 structural rebuild;
- why JSON-only correlation is insufficient;
- composite workspace ownership;
- exact AUTOINCREMENT high-water preservation;
- B1's authority-free boundary;
- deferred B2 producers and CT-04E consumers.

Amend ADR-013 to state that catalog-only additions remain normal unless a new event kind
requires new structural correlation columns.

Update architecture, security, operations, README, CLAUDE, and the decision index with
this exact product claim:

> Repository journal correlation and browser invalidation vocabulary exist; no usable
> repository lifecycle command, service, route, or UI exists.

## 15. Deterministic implementation slices

### Slice 0 — governance and baseline

```bash
git status --short --branch
git merge-base --is-ancestor e3b69c612a51b0b2a8d436ae3ea5355abd40745e HEAD
sha256sum packages/storage/migrations/0001-ct02-foundation.sql \
  packages/storage/migrations/0002-ct03-planning.sql \
  packages/storage/migrations/0003-ct04a2a-repository-model.sql
pnpm check
```

### Slice 1 — domain and contracts

```bash
pnpm exec biome format --write \
  packages/domain/src/workspace-events.ts \
  packages/domain/src/workspace-events.test.ts \
  packages/contracts/src/workspace-event.ts \
  packages/contracts/src/workspace-event.test.ts
pnpm exec tsc -b packages/domain packages/contracts
pnpm exec vitest run \
  packages/domain/src/workspace-events.test.ts \
  packages/contracts/src/workspace-event.test.ts
```

### Slice 2 — migration

```bash
pnpm exec biome format --write \
  packages/storage/src/migrations.test.ts \
  packages/storage/src/migration-0002.test.ts \
  packages/storage/src/migration-0003.test.ts \
  packages/storage/src/migration-0004.test.ts
pnpm exec tsc -b packages/storage
pnpm exec vitest run \
  packages/storage/src/migrations.test.ts \
  packages/storage/src/migration-0002.test.ts \
  packages/storage/src/migration-0003.test.ts \
  packages/storage/src/migration-0004.test.ts
```

### Slice 3 — storage and replay

```bash
pnpm exec biome format --write \
  packages/storage/src/types.ts \
  packages/storage/src/repositories/workspace-events.ts \
  packages/storage/src/repositories.test.ts \
  packages/storage/src/snapshot.test.ts \
  apps/server/src/services/workspace-event-stream-service.test.ts
pnpm exec tsc -b packages/domain packages/contracts packages/storage apps/server
pnpm exec vitest run \
  packages/storage/src/repositories.test.ts \
  packages/storage/src/snapshot.test.ts \
  apps/server/src/services/workspace-event-stream-service.test.ts
```

### Slice 4 — browser projection and activity

```bash
pnpm exec biome format --write \
  apps/web/src/lib/workspace-projection.ts \
  apps/web/src/lib/workspace-projection.test.ts \
  apps/web/src/components/ActivityPanel.tsx \
  apps/web/src/components/ActivityPanel.test.tsx
pnpm typecheck
pnpm exec vitest run \
  apps/web/src/lib/workspace-projection.test.ts \
  apps/web/src/components/ActivityPanel.test.tsx
```

### Slice 5 — scope, protected evidence, ADRs, and documentation

```bash
pnpm exec biome format --write \
  scripts/check-forbidden-scope.mjs \
  scripts/check-forbidden-scope.test.mjs \
  scripts/check-ct04-protected-package.mjs \
  scripts/check-ct04-protected-package.test.mjs
pnpm exec vitest run \
  scripts/check-forbidden-scope.test.mjs \
  scripts/check-ct04-protected-package.test.mjs \
  apps/server/src/route-inventory.test.ts
pnpm check:scope
pnpm check:protected
git diff --name-only e3b69c612a51b0b2a8d436ae3ea5355abd40745e
git status --short
```

### Final gate

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
pnpm check:scope
pnpm check:protected
pnpm check
```

No commit occurs unless explicitly authorized. If implementation permission does not
include commit authority, implementation stops after validation. An immutable report
may record an exact implementation head only after that head exists.

## 16. Proof that B1 adds no lifecycle authority

Completion evidence must establish:

- no package manifest or lockfile changed;
- no production file under `apps/server` changed;
- exact route inventory remains unchanged;
- no repository route exists;
- no repository feature configuration exists;
- no service or lifecycle command exists;
- no A1 or `@craftingtable/git` import exists in B1;
- no `node:child_process` import exists in B1;
- no repository-specific notifier call exists;
- migration 0003 and A2a semantic source remain unchanged;
- repository tables are referenced only as correlation parents;
- B1 does not mutate repository, inspection, or binding state;
- completion documentation states directly that B2 lifecycle commands remain absent.

## 17. Fan-out decision

The actual B1 plan does not require further fan-out.

The target is at the upper edge of the package's predicted file count, but it remains
one cohesive authority-free change: one journal migration, one event vocabulary, one
storage projection, one browser invalidation vocabulary, and their proofs.

Further fan-out is required if review demands any production service, route,
configuration, notifier producer, repository-state mutation, second persistence model,
A1/Git integration, or repository UI. Those changes are B2 or later and must stop this
plan rather than be absorbed into B1.
