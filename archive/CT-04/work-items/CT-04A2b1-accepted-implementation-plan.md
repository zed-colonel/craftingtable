# CT-04A2b1 accepted implementation plan

**Status:** Accepted and implemented; amended after independent implementation review
under the operator's 2026-07-29 remediation disposition
**Slice:** CT-04A2b1 — Repository journal correlation and browser projection
**Parent:** CT-04A2b — Repository lifecycle and event integration
**Planning checkout:** `6aed9bda58fac0824f707691106aff0abbf35cdb`
**Accepted source head:** `e3b69c612a51b0b2a8d436ae3ea5355abd40745e`
**Implementation review:** `review-findings/CT-04/CT-04A2b1-initial-review.md`,
SHA-256 `b8a70cb1793775d93b72b8923d01242e55751eb25d1621b1213a3eb07e1d2f66`

## 1. Authority, lineage, and stop condition

This plan reconciles:

1. `work-items/CT-04/CT-04A2b1-proposed-implementation-plan.md`,
   SHA-256 `79aa4580ebd5f5bd1fa3efe16ba1047f54a5d8b4aa4cf6366f93b9cc31cbb3a1`;
2. `review-findings/CT-04/CT-04A2b1-design-review.md`, revision 2,
   SHA-256 `9dc99acd43499305420d8233269195ae7e2c4073fd879c7f293099e873774d8a`;
3. `work-items/CT-04/CT-04A2b1-design-review-disposition.md`,
   SHA-256 `c68b04749f4459d161448a260d304755e9ab3a99e1f5f93c118a6cfd6886dbc8`;
4. the B1 contract, A2b handoff/source assessment/guidance/maps/matrices, accepted A2a
   records and source, original CT-04 protected specification, and read-only A2/A2b
   protected supplements.

It supersedes the proposed plan only after the operator approves and commits the complete
planning/review package. It does not authorize source implementation.

The required sequence is:

```text
operator reviews and approves this accepted-plan candidate
    → operator commits the planning/review package
    → operator gives separate explicit implementation permission
    → implement slices 0–2
    → stop for the schema-4 operator checkpoint
    → implement slices 3–5 only after that checkpoint
    → run the complete deterministic gate
    → create no implementation commit unless explicitly authorized
    → record an exact implementation head only after it exists
```

Do not edit protected specifications. Do not implement B2. Do not create a completion
report containing an invented or anticipated commit.

## 2. Exact source and immutable pins

The accepted source head is an ancestor of the planning checkout. The single intervening
commit contains only the A2b planning package; no production source differs.

| Artifact | Exact pin or SHA-256 | Disposition |
|---|---|---|
| Accepted source head | `e3b69c612a51b0b2a8d436ae3ea5355abd40745e` | immutable source baseline |
| Planning-package commit | `6aed9bda58fac0824f707691106aff0abbf35cdb` | proposal/review checkout |
| Migration 0001 | `42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273` | byte-identical |
| Migration 0002 | `6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247` | byte-identical |
| Migration 0003 | `526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4` | byte-identical |
| Original CT-04 protected specification | `ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64` | read-only |
| A2 protected supplement | `1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c` | read-only |
| A2b protected supplement | `255fe8b61ede97aa3366ab5e81214031ef2053e89c0246b0b9c4c7b14278ebad` | read-only |

The A2a repository model, repository migrations, transition primitives, source semantics,
and A1 adapter boundary remain unchanged.

## 3. Exact implementation tree and size

```text
.gitignore
README.md
CLAUDE.md
docs/architecture.md
docs/security.md
docs/operations.md
docs/decisions/README.md
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

apps/server/src/cli.test.ts
apps/server/src/services/workspace-event-stream-service.test.ts

apps/web/src/App.tsx
apps/web/src/lib/workspace-projection.ts
apps/web/src/lib/workspace-projection.test.ts
apps/web/src/components/ActivityPanel.tsx
apps/web/src/components/ActivityPanel.test.tsx

scripts/check-forbidden-scope.mjs
scripts/check-forbidden-scope.test.mjs
scripts/check-ct04-protected-package.mjs
scripts/check-ct04-protected-package.test.mjs
```

Amended exact tree: 32 implementation/documentation files. The implementation review
confirmed that `apps/server/src/cli.test.ts` is a necessary schema-4 regression repair:
the unsupported-version fixture must derive `supportedVersion + 1`. The original
2,700–3,700-line prediction is retained as historical planning evidence. The remediation
review added `.gitignore` so Git itself excludes the complete root `.ct04a-*` test-scratch
class from the B1 changed-path inventory.

Governance and immutable reports remain separate:

```text
work-items/CT-04/CT-04A2b1-implementation-report.md
work-items/CT-04/CT-04A2b1-remediation-<N>-report.md
```

Every implementation or remediation turn creates a new report. No report is rewritten to
hide prior evidence.

## 4. Closed event vocabulary and domain base

Add exactly five kinds:

```text
repository-registered
repository-status-changed
repository-evidence-changed
project-repository-bound
project-repository-binding-retired
```

No sixth inspection-history kind is added.

Export a named `WorkspaceEventBase` from domain. It contains the common immutable envelope
fields and optional structural correlations:

```ts
interface WorkspaceEventBase {
  readonly id: EventId;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly workspaceId: WorkspaceId;
  readonly actorUserId?: UserId;
  readonly projectId?: ProjectId;
  readonly workItemId?: WorkItemId;
  readonly runId?: AgentRunId;
  readonly repositoryId?: RepositoryId;
  readonly repositoryInspectionId?: RepositoryInspectionId;
  readonly repositoryBindingId?: ProjectRepositoryBindingId;
  readonly schemaVersion: 1;
}
```

The exported event variants refine that named base into exact structural shapes. Storage
must not derive a base with `Omit` over the event union.

The introduced-schema map is:

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

Envelope version remains 1.

Inspection rows whose reducer disposition is `verified`,
`environment-evidence-still-changed`, or `failure-recorded` intentionally have no
workspace event. The journal therefore is not a complete change feed for
`repository_inspections`. CT-04E owns inspection-history fetch-on-view/freshness; B2 owns
the zero-event lifecycle proof.

## 5. Contracts prove semantics

### 5.1 Exact nine-variant correlation shapes

The common Zod base does not declare the three repository correlation keys. Each of the
nine strict variant schemas declares them explicitly as required, optional, or
`z.never().optional()`. This prevents base `.extend()` from making illegal legacy
correlations wire-valid.

| Kind | Required | Permitted optional | Forbidden |
|---|---|---|---|
| four legacy kinds | existing legacy correlations | existing legacy optionals | all repository correlations |
| registered | repository, inspection | actor | project, work item, run, binding |
| status changed | repository | actor, inspection | project, work item, run, binding |
| evidence changed | repository, inspection | actor | project, work item, run, binding |
| binding kinds | project, repository, binding | actor | inspection, work item, run |

A table-driven 9 kinds × 3 repository-correlation matrix rejects every illegal pair.

### 5.2 Payloads

All payloads are `z.strictObject`.

```ts
repository-registered {
  repositoryId;
  inspectionId;
  displayName;
  status: 'active';
  statusReason: 'registration-accepted';
  version: 1;
}

repository-status-changed {
  repositoryId;
  inspectionId?;
  displayName;
  fromStatus;
  toStatus;
  statusReason;
  priorVersion;
  resultingVersion;
}

repository-evidence-changed {
  repositoryId;
  inspectionId;
  displayName;
  evidenceClass: 'risk-scan';
  repositoryVersion;
}

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

### 5.3 Zod refinements

Zod proves:

- every structural repository/project/inspection/binding ID equals its payload copy;
- `fromStatus !== toStatus`;
- `statusReason` belongs to `REPOSITORY_STATUS_REASON_SETS[toStatus]`;
- status `resultingVersion === priorVersion + 1`;
- binding retirement `resultingVersion === priorVersion + 1`;
- all nonliteral versions are positive safe integers;
- status inspection is absent exactly when `toStatus === 'retired'` and
  `statusReason === 'operator-retired'`;
- all other status transitions carry the same inspection structurally and in payload;
- display names pass `repositoryDisplayNameSchema`.

The refinements are present on the exported per-kind schemas, not only on the final
discriminated union, so direct consumers cannot bypass them.

### 5.4 Evidence-event version meaning

`repositoryVersion` is:

> the repository version in effect after the transaction that commits the evidence event.

For B2's compound status-plus-risk-evidence transition:

1. emit `repository-status-changed`;
2. emit `repository-evidence-changed`;
3. correlate both to the same inspection;
4. set evidence `repositoryVersion` equal to the status event's `resultingVersion`.

B1 freezes and round-trips this meaning. B2 supplies the lifecycle emission proof.

### 5.5 Rejected fields

Strict payloads reject, at minimum:

```text
ready, readiness, executable, approved, verified, reviewed, mergeable,
command, argv, cwd, environment,
requestedPath, canonicalTopLevel, canonicalGitDirectory, canonicalCommonGitDirectory,
observation, observationJson, errorEvidence, stdout, stderr, gitExecutable,
ref, branch, worktree, remote
```

## 6. Database proves ownership

ADR-018 records this division:

> The database proves ownership. Contracts prove semantics.

For B1, “ownership” means:

- the event belongs to its workspace;
- a correlated repository belongs to that workspace;
- a correlated inspection belongs to that exact workspace and repository;
- a correlated binding belongs to that exact workspace, project, and repository;
- a known kind has only its permitted structural correlation dimensions.

“Semantics” means:

- payload shape;
- payload/structural ID agreement;
- status/reason relationships;
- version arithmetic;
- retirement/inspection coupling;
- display-name and forbidden-field policy.

This is ADR-003's existing payload division, now stated explicitly for duplicated
correlations.

Migration 0004 contains no new per-kind payload-semantic CHECK, no `json_extract`, and no
payload-ID or retirement-cause expression. It retains the existing generic:

```sql
CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object')
```

That inherited CHECK proves only that the durable bytes are a JSON object. It does not
make a registered kind's payload semantically valid.

ADR-013 is not amended.

## 7. Schema-4 DDL

### 7.1 Column order

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

All legacy column definitions remain unchanged.

### 7.2 Composite foreign keys

```sql
FOREIGN KEY (workspace_id, repository_id)
  REFERENCES registered_repositories(workspace_id, id)
  ON DELETE RESTRICT

FOREIGN KEY (workspace_id, repository_id, repository_inspection_id)
  REFERENCES repository_inspections(workspace_id, repository_id, id)
  ON DELETE RESTRICT

FOREIGN KEY (workspace_id, project_id, repository_id, repository_binding_id)
  REFERENCES project_repository_bindings(workspace_id, project_id, repository_id, id)
  ON DELETE RESTRICT
```

Migration 0003 already contains the three required candidate keys and remains
byte-identical.

### 7.3 Exact structural correlation CHECK

Migration 0004 uses the following logical expression, with these exact kind arms:

```sql
CHECK (
  CASE
    WHEN kind IN (
      'workspace-created',
      'project-created',
      'plan-version-imported',
      'work-item-admitted'
    ) THEN
      repository_id IS NULL
      AND repository_inspection_id IS NULL
      AND repository_binding_id IS NULL

    WHEN kind = 'repository-registered' THEN
      repository_id IS NOT NULL
      AND repository_inspection_id IS NOT NULL
      AND repository_binding_id IS NULL
      AND project_id IS NULL
      AND work_item_id IS NULL
      AND run_id IS NULL

    WHEN kind = 'repository-status-changed' THEN
      repository_id IS NOT NULL
      AND repository_binding_id IS NULL
      AND project_id IS NULL
      AND work_item_id IS NULL
      AND run_id IS NULL

    WHEN kind = 'repository-evidence-changed' THEN
      repository_id IS NOT NULL
      AND repository_inspection_id IS NOT NULL
      AND repository_binding_id IS NULL
      AND project_id IS NULL
      AND work_item_id IS NULL
      AND run_id IS NULL

    WHEN kind IN (
      'project-repository-bound',
      'project-repository-binding-retired'
    ) THEN
      repository_id IS NOT NULL
      AND repository_inspection_id IS NULL
      AND repository_binding_id IS NOT NULL
      AND project_id IS NOT NULL
      AND work_item_id IS NULL
      AND run_id IS NULL

    ELSE
      repository_id IS NULL
      AND repository_inspection_id IS NULL
      AND repository_binding_id IS NULL
  END
)
```

The `repository-status-changed` arm deliberately permits either NULL or non-NULL
inspection. SQL permits this; Zod proves when each form is semantically legal.

The ELSE arm is B1-F-08's fail-closed rule: a future kind not listed here cannot carry a
repository, inspection, or binding correlation.

### 7.4 Catalog, indexes, and triggers

- Insert exactly five rows with `introduced_in_schema = 4`.
- Preserve the four old rows and introduction values.
- Preserve event-kind catalog update/delete immutability.
- Restore `idx_workspace_events_workspace_sequence(workspace_id, sequence)`.
- Restore workspace-event update/delete rejection triggers with the current bodies.
- Add no repository-event query index because B1 adds no repository-event query.

Tests assert exact `pragma_foreign_key_list(workspace_events)` rows, including composite
column order and `on_delete = RESTRICT`.

## 8. Migration protocol and AUTOINCREMENT

Migration 0004 runs in the existing migration transaction:

1. Insert the five catalog rows.
2. Create migration state/guard tables.
3. Capture old row count, maximum sequence, and exact `sqlite_sequence` presence/value.
4. Drop the old append-only workspace-event triggers.
5. Rename the schema-3 table.
6. Create the schema-4 table.
7. Copy exact old rows in sequence order with all three new correlations NULL.
8. Restore the AUTOINCREMENT high-water.
9. Restore the named index and append-only triggers on the new table.
10. Run pre-drop preservation, catalog, sequence, FK, trigger, and integrity guards.
11. Drop the renamed old table.
12. Repeat the post-drop guards.
13. Drop guard/state tables.

### 8.1 Exact sequence policy

The migration never substitutes `MAX(sequence)` for the captured AUTOINCREMENT high-water.

- If an old `sqlite_sequence` row exists, restore its exact value on the new table.
- If an empty old journal has no captured sequence row, normalize the newly rebuilt
  table's row to `seq = 0`; assert that row is present with zero.
- Assert the captured high-water is never lower than the copied maximum when it exists.
- Append after migration and require the next value to be captured high-water + 1, or 1
  for the normalized empty case.

This covers deletion gaps and prevents reuse of a sequence that was previously issued.

### 8.2 Exact preservation guards

Before old-table drop, and again where applicable after it:

- row count;
- maximum sequence;
- bilateral equality over every legacy structural column;
- `hex(CAST(payload_json AS BLOB))` equality for exact payload bytes;
- all migrated repository correlations NULL;
- exact nine-row kind/introduction catalog;
- exact named index and trigger catalog bound to the new table;
- exact composite FK catalog;
- empty `pragma_foreign_key_check`;
- `pragma_integrity_check = 'ok'`;
- exact normalized/restored `sqlite_sequence`.

### 8.3 Forced guard failure

The real migration contains one unique token:

```sql
1 /* B1_GUARD_TEST_SENTINEL */
```

inside a load-bearing preservation guard. `B1-MIG-006` reads the real 0004 bytes and
replaces that token with:

```sql
0 /* B1_GUARD_TEST_SENTINEL */
```

The test asserts the original marker matched exactly once and the bytes changed. It then
proves rollback restored:

- schema version 3;
- readable legacy rows and exact payload bytes;
- the four-row catalog;
- the old named index;
- functioning update/delete rejection triggers;
- successful legacy query behavior.

No hand-maintained migration copy exists.

### 8.4 Amendment policy and checkpoint

Before B1 implementation acceptance, migration 0004 may be amended in place during a
reviewed remediation turn because there is no accepted production database at schema 4.
Every remediation records new bytes and checksum in a new immutable report.

After B1 is accepted, further schema evolution uses a later migration rather than
rewriting 0004.

Implementation stops after slice 2 for operator review of the isolated DDL and migration
tests before storage/browser slices proceed.

## 9. No payload-aware DDL

The schema-4 test reads `sqlite_master.sql` and proves:

- no `json_extract(` occurs in the `workspace_events` table DDL;
- no kind-specific `json_type` occurs;
- the only payload JSON expressions are the inherited exact valid-object CHECK;
- no payload field name such as `repositoryId`, `inspectionId`, `bindingId`, `toStatus`,
  or `statusReason` appears in the table DDL.

Direct SQL with valid structural ownership can insert a payload/structural disagreement.
That is an intentional option-(b) consequence. Application reads must reject that row.

## 10. Storage append and mapper

### 10.1 Append input

`AppendWorkspaceEventInput` becomes a kind-discriminated union. Each kind selects both:

- its strict TypeScript payload; and
- its required, optional, and forbidden structural correlations.

The API does not infer correlations from JSON.

Before INSERT, `appendEvent` calls a runtime agreement assertion for the five repository
kinds:

- payload repository ID equals structural repository ID;
- payload inspection ID equals structural inspection ID where present;
- payload project ID equals structural project ID for binding kinds;
- payload binding ID equals structural binding ID.

Absent, null-like, misspelled, or disagreeing values throw a typed append error before
the SQL statement runs. A test asserts row count and `sqlite_sequence` are unchanged after
rejection.

### 10.2 Raw row and explicit base mapping

The raw row type uses:

```ts
kind: string
```

not an asserted `WorkspaceEventKind`. The base mapper returns the explicit exported
`WorkspaceEventBase` rather than `Omit<WorkspaceEvent, ...>`.

### 10.3 Read-time failure

Introduce a closed typed error such as:

```text
WorkspaceEventMappingError
  unknown-kind
  invalid-json
  invalid-structural-correlations
  payload-correlation-mismatch
  invalid-retirement-correlation
```

The mapper:

1. parses JSON to an unknown record;
2. checks the runtime kind before narrowing;
3. validates the kind's exact structural correlations;
4. requires every applicable payload correlation key to exist as the expected string;
5. compares every payload correlation with its structural copy;
6. enforces status retirement/inspection coupling from structural inspection,
   `toStatus`, and `statusReason`;
7. constructs the exact variant;
8. throws explicitly on the runtime default.

Full per-kind payload shape remains a contract responsibility. The mapper enforces the
correlation semantics needed to make direct-SQL poison fail closed.

`listAfter` and `listRecentAtOrBefore` map their entire selected row array before returning.
They never return a hole, `undefined`, a short success, or a partially advanced result.

### 10.4 Snapshot and SSE propagation

- A poisoned `listRecentAtOrBefore` rejects the snapshot transaction/request; it never
  returns a partial activity list.
- A poisoned `listAfter` rejects the stream query before that batch is yielded.
- The existing SSE route catch logs the typed error name and closes the stream.
- The cursor does not advance past the failed batch.
- No production server service or route change is needed.

Tests cover `listAfter`, `listRecentAtOrBefore`, and the stream iterator.

## 11. Browser projection and bounded consumption

Add:

```ts
readonly repositoryList: boolean;
readonly repositoryIds: readonly RepositoryId[];
```

`repositoryIds` retains stable order among the newest 100 unique pending IDs. Repeating
an ID does not move or duplicate it. Once the cap is exceeded, the oldest retained unique
ID is dropped.

### 11.1 Invalidation table

| Event | Workspace summary | Project IDs | Work-item IDs | Repository list | Repository IDs | ID source |
|---|---:|---|---|---:|---|---|
| `workspace-created` | yes | — | — | no | — | legacy payload convention |
| `project-created` | yes | payload project | — | no | — | legacy payload convention |
| `plan-version-imported` | yes | payload project | — | no | — | legacy payload convention |
| `work-item-admitted` | yes | payload project | payload item | no | — | legacy payload convention |
| `repository-registered` | no | — | — | yes | structural repository | structural |
| `repository-status-changed` | no | — | — | yes | structural repository | structural |
| `repository-evidence-changed` | no | — | — | yes | structural repository | structural |
| `project-repository-bound` | no | structural project | — | no | structural repository | structural |
| `project-repository-binding-retired` | no | structural project | — | no | structural repository | structural |

The legacy asymmetry is deliberate B1 scope control. Zod agreement means valid new wire
events have identical structural and payload copies, but invalidation still uses the
ownership-bearing structural value.

### 11.2 Parameterized consumption

Replace unparameterized `stale-consumed` with an action carrying the exact consumed
scope classes and ID sets:

```ts
{
  type: 'stale-consumed';
  consumed: {
    workspaceSummary?: true;
    projectIds?: readonly ProjectId[];
    workItemIds?: readonly WorkItemId[];
    repositoryList?: true;
    repositoryIds?: readonly RepositoryId[];
  };
}
```

The reducer clears only named booleans and subtracts only named IDs.

`App.tsx` changes only to dispatch the planning scopes its current refresh token schedules.
It does not name or consume `repositoryList` or `repositoryIds`. This adds no repository
fetch. CT-04E can later consume repository scopes without changing the action's semantics.

### 11.3 Snapshot and workspace behavior

- Duplicate/lower events remain ignored.
- Foreign-workspace events increment the rejection counter and alter no stale scope.
- Same-workspace snapshot preserves live tail, cursor, counters, and pending repository
  scopes.
- Planning scopes covered by the successful current snapshot can be consumed explicitly.
- Workspace change clears all events, stale scopes, IDs, and counters before render.

No repository page, repository model projection, or repository fetch is added.

## 12. Activity rendering

`ActivityPanel` exposes a small description helper with an exhaustive switch and explicit
unreachable failure.

All nine descriptions:

- are nonempty;
- use validated display names as React text children;
- use no raw HTML;
- disclose no administrative path or Git evidence;
- make no ready, verified, reviewed, approved, executable, or mergeable claim;
- distinguish registration, status transition, risk evidence change, binding, and
  binding retirement.

The five B1 repository-event descriptions, whose display names are bounded to 120
characters, are no longer than 256 characters. This bound is not asserted for the
pre-existing `plan-version-imported` description because its document field may contain
300 characters.

The hostile-display test asserts literal text, absence of injected elements, and absence
of handler execution. A single nine-kind fixture is shared by exhaustive description and
coverage tests.

## 13. Inspection-history limitation

B1 adds exactly the five contracted kinds. It does not emit an event for:

```text
verified
environment-evidence-still-changed
failure-recorded
```

Those outcomes may append a durable inspection without invalidating repository browser
scopes. ADR-018 and operations documentation record this limitation.

B1 contributes to `JRN-REP-004` only for emitted repository lifecycle events that exist
in the workspace journal. It does not claim the journal is a complete inspection history.
B2 retains no-event/no-notifier proofs, and CT-04E must fetch inspection history when a
view needs it.

## 14. ADR and documentation

Add ADR-018, “Repository journal correlation,” recording:

1. five-kind vocabulary and envelope version 1;
2. structural correlation columns;
3. composite workspace ownership;
4. schema-4 preservation and AUTOINCREMENT strategy;
5. database proves **ownership**;
6. contracts prove **semantics**;
7. append and mapper agreement defenses;
8. all-NULL future-kind default;
9. structural-ID browser invalidation;
10. bounded pending repository scopes;
11. incomplete inspection-history freshness;
12. B2 lifecycle producers and CT-04E consumers remain absent.

ADR-018 links ADR-003 and ADR-013 but does not amend ADR-013.

Update README, CLAUDE, architecture, security, operations, and decision index with the
accurate statement:

> Repository journal correlation and bounded browser invalidation vocabulary exist; no
> usable repository lifecycle command, service, route, notifier producer, repository
> fetch, or repository UI exists.

## 15. Scope and authority proof

### 15.1 Import checker

The scope checker uses exact-path allowed-specifier sets. It does not claim to detect
behavior from names.

- Domain event source: domain/local edges only.
- Contract event source: domain, Zod, and local edges.
- Storage event source: domain, `better-sqlite3`, and local edges.
- Browser projection/activity/App: existing browser dependencies only.

Negative fixtures cover `@craftingtable/git`, `node:child_process`, Fastify, server
services, and forbidden package directions.

Positive fixtures prove:

- accepted `packages/storage/src/types.ts → ./repository-types.js`;
- permitted `workspace-event.ts → repository.js`;
- forbidden reverse A2a repository source → workspace-event module.

### 15.2 Behavioral and inventory proof

Separate deterministic checks establish:

- no package manifest or lockfile changed;
- no production server file changed;
- exact route inventory unchanged;
- no repository route or service exists;
- no feature configuration exists;
- no repository-specific notifier producer exists;
- no repository lifecycle command exists;
- no A1 or Git import exists;
- migration 0003 and A2a state-semantic source remain unchanged;
- protected specifications remain byte-identical;
- documentation claims foundation only.

## 16. Acceptance map

### 16.1 Migration

| ID | Exact proof |
|---|---|
| `B1-MIG-001` | All legacy rows, IDs, exact payload bytes, order, count, and maximum preserved |
| `B1-MIG-002` | Deleted high-water restored; empty journal normalized to sequence row 0; next append exact |
| `B1-MIG-003` | Exact index/trigger behavior and catalog |
| `B1-MIG-004` | Old kind introduction values/behavior; no new payload-semantic DDL |
| `B1-MIG-005` | Migrations 0001–0003 hash pins |
| `B1-MIG-006` | One-marker mutation of real 0004; complete schema-3 rollback |
| `B1-MIG-007` | Fresh migrations 1→4 and full catalogs |
| `B1-MIG-008` | Applied-0004 checksum drift rejected |
| `B1-MIG-009` | No `json_extract`; only inherited generic valid-object JSON CHECK |
| `B1-MIG-010` | Exact composite FK order and `ON DELETE RESTRICT` |

### 16.2 Correlation and contracts

| ID | Exact proof |
|---|---|
| `B1-COR-001` | Every legal same-workspace structural combination |
| `B1-COR-002/003` | Foreign-workspace and missing repository |
| `B1-COR-004/005` | Sibling inspection and inspection-without-repository |
| `B1-COR-006/007` | Wrong-project binding and incomplete binding correlation |
| `B1-COR-008` | Legacy kind with repository correlation rejected by SQL and Zod |
| `B1-COR-009/010` | Registration/evidence inspection required structurally |
| `B1-COR-011` | Named positive retirement-without-inspection and negative inverse subcases |
| `B1-COR-012` | Binding work-item/inspection/run rejection |
| `B1-COR-013` | Missing, misspelled, null, and contradictory payload IDs rejected by Zod/append/read |
| `B1-COR-014` | Synthetic future kind with repository correlation rejected by ELSE arm |
| `B1-CON-001`–`005` | Every valid new envelope |
| `B1-CON-006` | Readiness, authority, environment, and raw-Git rejection |
| `B1-CON-007/008` | Exact version arithmetic |
| `B1-CON-009` | Display-name control/length bounds |
| `B1-CON-010` | Status/reason and retirement relationships |
| `B1-CON-011` | Table-driven all-nine illegal-correlation matrix |
| `B1-CON-012` | Per-kind/per-dimension structural/payload ID agreement |

Every FK suite covers correct parent, cross-workspace parent, same-workspace wrong
repository/project/binding, missing parent, and each legal/illegal nullable dimension.

### 16.3 Storage, snapshot, and SSE

| ID | Exact proof |
|---|---|
| `B1-STO-001` | Payload and structural IDs asserted separately for every new kind |
| `B1-STO-002` | Mixed old/new strict global sequence |
| `B1-STO-003` | Mixed cursor-bound recent activity |
| `B1-STO-004` | Unknown runtime kind fails with typed error |
| `B1-STO-005` | Explicit base and compile/runtime exhaustive mapping |
| `B1-STO-006` | Foreign workspace cannot read event |
| `B1-STO-007/008` | Append-only and invalid-JSON rejection |
| `B1-STO-009` | Unknown kind, contradictory structural shape, ID mismatch, and retirement mismatch fail every read surface |
| `B1-STO-010` | One nine-kind parity fixture spans catalog/map/mapper/invalidation/description |
| `B1-STO-011` | Append mismatch rejected before row or sequence change |
| `B1-REGRESS-002` | Mixed legacy/repository snapshot and SSE cursors; poisoned batch never partially advances |

### 16.4 Browser and rendering

| ID | Exact proof |
|---|---|
| `B1-UI-001/002` | Repository list/structural-ID invalidation |
| `B1-UI-003` | Binding invalidates structural project/repository |
| `B1-UI-004/005` | Duplicate/lower and foreign-workspace behavior |
| `B1-UI-006/007` | Same-workspace retention and workspace-switch clearing |
| `B1-UI-008/009/010` | Hostile render, five bounded repository descriptions, exhaustive switches |
| `B1-UI-011` | 100-ID bound, stable dedup, and exact parameterized consumption |
| `B1-UI-012` | Documentary five-kind/no-inspection-feed limit; executable lifecycle proof remains B2 |
| `B1-UI-013` | Reducer helper selects structural project/repository on mismatch; Zod rejects mismatch at wire |

### 16.5 Scope, process, and inherited cases

- `B1-SCOPE-001`: exact import allowlists and positive/negative fixtures.
- `B1-SCOPE-002/003`: protected and migration/A2a hashes.
- `B1-SCOPE-004`: real head and immutable reports only after implementation.
- `B1-SCOPE-005`: unchanged exact route inventory.
- `B1-SCOPE-006`: foundation-only documentation.
- `B1-PROC-001`: proposal, independent review, disposition, accepted plan before code.
- `B1-PROC-002/003`: real report lineage and protected hashes.
- `B1-REGRESS-001`: full `pnpm check`, including Playwright.

Inherited B1-owned journal cases:

```text
A2B-JRN-001 → B1-MIG-001/002
A2B-JRN-002 → repository FK ownership
A2B-JRN-003 → inspection FK ownership
A2B-JRN-004 → binding FK ownership
A2B-JRN-007 → structural binding invalidation
A2B-JRN-011 → strict forbidden-field rejection
A2B-JRN-012 → legacy journal behavior
```

`A2B-JRN-005`, `006`, `008`, `009`, and `010` remain B2-owned.

B1 contributes only a foundation to original `A-MIG-001`, `JRN-REP-004/005`,
`UI-RENDER-001/002/005`, `REGRESS-001`–`005`, `E-SCOPE-001`, and
`P-PROCESS-001`–`004`. It does not close later lifecycle or UI milestones.

## 17. Deterministic implementation sequence

### Slice 0 — lineage and baseline

```bash
git status --short --branch
git merge-base --is-ancestor e3b69c612a51b0b2a8d436ae3ea5355abd40745e HEAD
sha256sum \
  packages/storage/migrations/0001-ct02-foundation.sql \
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

### Slice 2 — schema 4

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
pnpm check:scope
git diff --check
```

**Mandatory stop:** operator reviews migration 0004, its schema text, guards, sequence
proof, exact FKs, and the absence of payload-semantic DDL before slice 3.

### Slice 3 — storage, snapshot, and SSE

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
  apps/web/src/App.tsx \
  apps/web/src/lib/workspace-projection.ts \
  apps/web/src/lib/workspace-projection.test.ts \
  apps/web/src/components/ActivityPanel.tsx \
  apps/web/src/components/ActivityPanel.test.tsx
pnpm typecheck
pnpm exec vitest run \
  apps/web/src/lib/workspace-projection.test.ts \
  apps/web/src/components/ActivityPanel.test.tsx \
  apps/web/src/App.test.tsx
```

### Slice 5 — scope, protected evidence, ADR, and docs

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
git diff --check
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

If implementation permission does not include commit authority, stop after validation.
After a separately authorized implementation commit exists, create a new immutable report
that records that exact head. Each remediation repeats this rule.

## 18. Fan-out and explicit completion boundary

No further B1 fan-out is required. The accepted design remains one authority-free schema
and projection boundary, with the amended 32-file tree, one migration, and no new service
or process authority.

Stop and replan if implementation requires:

- a production server service or route;
- feature configuration;
- a notifier-producing repository command;
- repository state mutation;
- A1 or `@craftingtable/git`;
- a repository page, fetch, or view;
- a sixth event kind;
- another migration;
- CT-04B+ behavior.

B1 completion must state directly:

> B2 lifecycle commands remain absent.

## Appendix A — review reconciliation

| Finding | Accepted-plan reconciliation |
|---|---|
| `B1-F-01` | Option (b): Zod agreement, append assertion, mapper enforcement; no equality CHECK |
| `B1-F-02` | No new payload-aware DDL; ADR-018 applies ADR-003 division; ADR-013 unchanged |
| `B1-F-03` | Nine exact variant schemas and 9 × 3 illegal-correlation matrix |
| `B1-F-04` | Explicit exported base; no union-derived `Omit` |
| `B1-F-05` | Raw string kind, typed runtime failure, complete-batch mapping, snapshot/SSE propagation |
| `B1-F-06` | Evidence version means post-transaction version; compound ordering frozen |
| `B1-F-07` | `App.tsx`, 100-ID cap, exact parameterized consumption |
| `B1-F-08` | Verbatim CASE rule with all-NULL ELSE arm and future-kind test |
| `B1-F-09` | Exactly five kinds; incomplete inspection feed documented and assigned |
| `B1-F-10` | Forced failure derived from real bytes; amendment policy and migration checkpoint |
| `B1-F-14` | New invalidation uses structural IDs; legacy asymmetry documented |
| `B1-F-11` | Explicit `ON DELETE RESTRICT` and exact pragma proof |
| `B1-F-12` | Import checker limited to specifiers; behavior proven by inventory/diff |
| `B1-F-13` | Target tree, empty sequence, structural round-trip, claim scope, and fan-out corrected |

## Appendix B — post-implementation review amendment

The independent implementation review at
`7c8bcd34c0c4822e1b37cf2f2ea05acc7d9c4056` found two blockers and six advisories.
The operator directed one remediation turn with this disposition:

| Finding | Disposition |
|---|---|
| `B1-R-01` | required: repair multi-line import detection and add multi-line negative fixtures |
| `B1-R-02` | required, superseded by remediation-review evidence: use `.gitignore` to exclude the complete root `.ct04a-*` test-scratch class from Git's untracked inventory; remove the checker carve-out and prove both known namespaces plus a near-miss |
| `B1-A-01` | close now: amend §3 to include `apps/server/src/cli.test.ts` |
| `B1-A-02` | close now: add exact pre-drop and post-drop composite-FK catalog guards |
| `B1-A-03` | close now: scope the 256-character bound to the five B1 repository descriptions |
| `B1-A-04` | no change |
| `B1-A-05` | no change; retain the original line-count prediction as historical evidence |
| `B1-A-06` | close now: admit the required initial and remediation review artifact paths |
| `B1-A-07` | close now by operator disposition: strip comments lexically before import scanning so comment punctuation cannot hide an import |

The remediation-1 independent review is
`review-findings/CT-04/CT-04A2b1-remediation-1-review.md`, SHA-256
`4d35f08915b279918e3809cddeff6ebfac6cb45f213abca113513a0a0a83a8f8`.
The operator directed the sequenced `B1-R-02` replacement and elected to close
`B1-A-07` structurally in the same remediation turn.

This amendment changes no protected specification and authorizes no B2 behavior.

## Appendix C — proof that B2 remains absent

The planned production changes are limited to domain event vocabulary, contracts,
workspace-event storage, browser reducer/App consumption, and safe activity descriptions.

There is:

- no production server file in the target tree;
- no route or service;
- no repository configuration;
- no A1 import;
- no Git or child-process authority;
- no repository state write;
- no repository notifier producer;
- no registration, inspection, reaffirmation, retirement, bind, or unbind command;
- no repository fetch or view.

Therefore B2 lifecycle behavior remains absent by construction and by deterministic
changed-path, import, route-inventory, and protected-package proofs.
