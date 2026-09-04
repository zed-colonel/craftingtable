# CT-04A2b source assessment

## 1. Assessment basis

This assessment is pinned to the attached source bundle and the public branch state:

```text
Branch head:
    e3b69c612a51b0b2a8d436ae3ea5355abd40745e

A2a merge:
    957874b96eb236c0042d6b7828d9b8ea26577bd9

Source-bundle SHA-256:
    aaccbdbfc60eecb63fd22980c96af119d19ae270e6ed87a981b5e53b49fd652d
```

The source tree contains 362 files. It includes accepted A1, accepted A2a, the A2a review/remediation records, the merge, and a follow-up cleanup that closed the three non-blocking review advisories concerning tooling authority, Node builtin allowlisting, and per-turn report immutability.

This is a static source assessment. The implementation agent must reconcile it against the local Git checkout during Phase A.

## 2. Accepted A2a implementation surface

A2a established a substantial but intentionally authority-free foundation:

```text
packages/domain/src/repository.ts                            627 lines
packages/contracts/src/repository.ts                         338 lines
packages/storage/migrations/0003-ct04a2a-repository-model.sql 644 lines
packages/storage/src/repository-types.ts                     259 lines
packages/storage/src/repositories/repository-registry/index.ts 763 lines
```

The accepted model includes:

- six repository statuses;
- exact status-reason coupling;
- immutable globally sequenced inspection evidence;
- exact observation JSON bytes and SHA-256;
- risk/core/environment difference vocabularies;
- complete A1 error taxonomy mirrored into domain;
- pure ordinary/reaffirm/retire reducer;
- strict HTTP request/response schemas;
- globally unique live repository identity reservations;
- structural workspace/project/repository ownership;
- evidence-bearing reaffirmation;
- atomic retirement with active-binding retirement;
- typed registration, transition, verification, binding, unbind, and query primitives.

A2a intentionally wrote no audit or workspace event and imported no A1 package.

## 3. Current source seams

### 3.1 A1 boundary

`@craftingtable/git` exports:

```text
createRepositoryInspector
parseRecordedObservation
compareRepositoryObservations
observation/error/risk constants and types
```

Production composition still does not import it. The scope checker currently treats `@craftingtable/git` as a non-production seam and will need one exact adapter exemption in B2, not a broad server exemption.

### 3.2 Repository domain gap

The domain supports status reason `repository-class-changed` and classifies A1 errors under that subject, but `RepositoryObservationAssessment` has no matching variant. B2 must add an explicit assessment/reducer branch. Mapping class failures to `core-identity-changed` would lose provenance and contradict the accepted status vocabulary.

### 3.3 Audit vocabulary

Schema 3 already registers:

```text
repository.register
repository.inspect
repository.reaffirm
repository.retire
repository.bind-project
repository.unbind-project
```

B2 needs no new audit action merely to implement the planned commands.

### 3.4 Workspace journal

The current workspace-event union and schema-2 table know only:

```text
workspace-created
project-created
plan-version-imported
work-item-admitted
```

The table has project/work-item correlation but no repository/inspection/binding columns. The storage mapper, Zod union, browser projection, and activity renderer are exhaustive switches. This makes the B1 seam mechanically clear.

### 3.5 Server composition

`createServices` currently composes authentication, workspaces, planning, and the event stream. No repository feature configuration, inspector provider, repository service, or repository routes exist.

The daemon is loopback-only. `ServerConfig` has no repository roots, Git executable, reserved roots, or inspection bounds.

### 3.6 Browser

The browser has no repository views. The only immediate browser requirement is to keep the workspace-event union exhaustive and prepare stale scopes for repository-aware views in CT-04E.

### 3.7 Storage transactions

`CraftingTableStorage.transaction` opens a single `BEGIN IMMEDIATE` transaction. A2a repository methods use nested better-sqlite3 transactions/savepoints, so B2 may compose them with audit and workspace-event writes in one outer transaction.

One reciprocal inspection-parent FK is deferred and is checked only at the outermost commit. B2 must not treat a nested primitive return as final transaction success.

## 4. Why B2 is split

The preliminary B2 scope crosses:

```text
domain event types
strict wire contracts
schema-4 journal migration
storage event mapping
browser projection and activity
server configuration
A1 adapter and host boundary activation
authorization
six lifecycle commands
routes and error mapping
notifier and parent fan-in
```

The journal/projection half has no new host authority and can be verified with direct SQLite and pure browser tests. The lifecycle half is the first production composition of the trusted Git observer and deserves a separate design and code review.

This is the recursive-decomposition principle recorded in `init/craftingtable-planning-implementation-feedback-loop-addendum.md`.

## 5. A2a review lessons carried forward

- Protected acceptance IDs require truthful, per-case proof rather than title-only claims.
- Authority-free source uses a closed Node builtin allowlist.
- Development scripts are a separately governed tooling tier.
- Every remediation turn gets a new immutable report.
- Legal same-millisecond transitions remain allowed; B2 must not reintroduce stricter unstated attribution semantics.
- Exact Git lineage controls require non-squash/non-rebase preservation where used.

## 6. Accepted source integrity pins

```text
A2a accepted plan:
    e3490f16333c9e80b9eab667cea10d57312bbbdbab9434ddb05bc7794e1da747

A2a final review record:
    e6cb2207d20dfa5e621b84073eff36a0c9e9f94f3cc601985e16830973c45899

Migration 0003:
    526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4

Original protected spec:
    ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64

A2 protected supplement:
    1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c

Planning feedback-loop addendum:
    e2b6283401f3e44b57264bd9de41848b3e5dd1270735c875ddbd459082323776
```

## 7. Expected B1 target surface

Likely source areas:

```text
packages/domain/src/workspace-events.ts
packages/domain/src/workspace-events.test.ts
packages/contracts/src/workspace-event.ts
packages/contracts/src/workspace-event.test.ts
packages/storage/migrations/0004-ct04a2b-repository-journal.sql
packages/storage/src/migrations.ts
packages/storage/src/types.ts
packages/storage/src/repositories/workspace-events.ts
packages/storage/src/*migration/schema/event tests
apps/web/src/lib/workspace-projection.ts
apps/web/src/lib/workspace-projection.test.ts
apps/web/src/components/ActivityPanel.tsx
apps/web activity tests if introduced
scripts/check-forbidden-scope.*
docs/architecture.md
docs/security.md
docs/operations.md
docs/decisions/*
README.md / CLAUDE.md phase records
```

B1 should remain roughly a 20–30 file schema/projection slice. If source-specific planning reveals service, route, A1, or unrelated browser work, it must stop and return to planning.

## 8. Expected B2 target surface

Likely source areas after B1:

```text
packages/domain/src/repository.ts         repository-class assessment only
apps/server/package.json / tsconfig       exact Git dependency
apps/server/src/config.ts                 optional strict repository config
apps/server/src/services/repository-inspection-port.ts
apps/server/src/services/a1-repository-inspection-adapter.ts
apps/server/src/services/repository-service.ts
apps/server/src/routes/repositories.ts
apps/server/src/composition.ts
apps/server/src/server.ts
apps/server/src/services/errors.ts
apps/server/src/route-inventory.test.ts
apps/server tests and fixtures
scripts/check-forbidden-scope.*
docs/ADRs/operations/security/architecture
```

B2 should not need new browser projections or a second migration after B1.
