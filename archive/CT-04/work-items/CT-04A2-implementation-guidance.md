# CT-04A2 implementation guidance

## 1. Purpose

This document recommends a source-specific implementation shape. It does not authorize code and does not replace the A2a Phase A proposal or independent design review.

## 2. Dependency direction

```text
@craftingtable/domain
      ↑          ↑
contracts      storage
      ↑          ↑
      └── server ──→ @craftingtable/git
             ↑
            web (contracts/domain only)
```

Rules:

- domain, contracts, and storage do not import Git;
- A2a does not import server or browser;
- only server A2b imports the accepted Git package;
- routes never import Git directly; services use a narrow adapter;
- browser receives strict contracts, never A1 observation objects or host paths as authority;
- no package introduces another process runner.

## 3. Recommended A2a file shape

```text
packages/domain/src/
├── repository.ts
├── repository.test.ts
├── ids.ts
├── ids.test.ts
├── audit.ts
└── index.ts

packages/contracts/src/
├── repository.ts
├── repository.test.ts
├── ids.ts
└── index.ts

packages/storage/migrations/
└── 0003-ct04a2a-repository-model.sql

packages/storage/src/
├── repository-types.ts
├── repository-test-support.ts
├── repository-schema.test.ts
├── repository-repositories.test.ts
├── repository-transitions.test.ts
├── migration-0003.test.ts
└── repositories/repository-registry/
    ├── index.ts
    └── rows.ts
```

The accepted plan must provide the exact file tree and stay below the process threshold or propose another split.

## 4. Recommended domain model

```ts
type RepositoryStatus =
  | 'active'
  | 'unavailable'
  | 'identity-evidence-changed'
  | 'identity-mismatch'
  | 'evidence-blocked'
  | 'retired';

type RepositoryObservationAssessment =
  | { kind: 'same' }
  | { kind: 'risk-evidence-changed'; differences: readonly string[] }
  | { kind: 'environment-evidence-changed'; differences: readonly string[] }
  | { kind: 'core-identity-changed'; differences: readonly string[] }
  | { kind: 'unavailable'; reason: 'path-unavailable' | 'metadata-unreadable' }
  | { kind: 'evidence-invalid'; reason: string }
  | { kind: 'no-state-change-failure'; reason: string };
```

The pure reducer accepts current state, assessment, and command class and returns an allowed transition or rejection. It knows nothing about A1 error codes, HTTP, or SQL.

## 5. Recommended schema 3

### 5.1 `registered_repositories`

Suggested fields:

```text
id
workspace_id
display_name
canonical_top_level
canonical_git_directory
canonical_common_git_directory
object_format
top_level_inode
common_directory_inode
core_fingerprint_sha256
observation_version
inspection_policy_version
registration_inspection_id
accepted_environment_inspection_id
status
status_reason
registered_by_user_id
registered_at
status_changed_by_user_id
status_changed_at
version
```

Structural requirements:

- `UNIQUE(workspace_id, id)`;
- global active/non-retired uniqueness for canonical top level, common Git directory, and core fingerprint;
- core identity and registration fields immutable;
- non-null status/reason coupling;
- exact version increments for transitions;
- no delete;
- `registration_inspection_id` and `accepted_environment_inspection_id` must point to successful inspection records for the same repository/workspace;
- deferred foreign keys may be used to make the registration cycle atomic, but the accepted plan must prove commit-time enforcement.

### 5.2 `repository_inspections`

Suggested fields:

```text
id
workspace_id
repository_id
actor_user_id
kind
outcome
created_at

observation_json
observation_sha256
observation_version
inspection_policy_version
observed_at
core_fingerprint_sha256
top_level_device
common_directory_device
risk_signals_json

error_code
error_subject
error_category
error_retryability
error_evidence_json

core_differences_json
environmental_differences_json
risk_differences_json
```

Checks must enforce:

- success fields all present only for success;
- failure fields all present only for failure;
- sorted/unique difference and risk arrays;
- bounded JSON and text lengths;
- same-workspace repository and actor relationships;
- append-only history;
- candidate key `(workspace_id, repository_id, id)` for parent links.

SQLite cannot verify SHA-256. Storage preserves bytes/digest; A2b verifies before parse/use.

### 5.3 `project_repository_bindings`

Suggested fields:

```text
id
workspace_id
project_id
repository_id
status
bound_by_user_id
bound_at
retired_by_user_id
retired_at
version
```

Constraints:

- same-workspace project/repository;
- one active binding per project;
- multiple projects may bind one repository;
- active/retired null coupling;
- exact version increment;
- no ownership changes and no delete.

## 6. Schema 3 migration policy

Migration 0003 should add the repository model and audit action catalog entries but not yet add workspace event kinds or rebuild `workspace_events`. This keeps A2a independently buildable without forcing browser event changes.

It must migrate from the accepted schema 2 with:

- all rows and global sequences unchanged;
- old migrations byte-identical;
- old triggers/catalog entries retained;
- migration checksum enforcement;
- fresh-database and forward-migration proof;
- direct-SQL negative matrix.

## 7. Full-record integrity

Recommended A2b write/read protocol, anticipated by A2a schema:

```text
write
    receive branded A1 observation
    JSON.stringify one exact immutable object
    hash those exact UTF-8 bytes
    persist bytes + digest + projected fields

read
    fetch exact stored string + digest
    recompute digest
    JSON.parse
    parseRecordedObservation
    compare projected fields with parsed observation
    only then use as evidence
```

Do not reserialize an object and expect a canonical digest unless a canonicalization format is explicitly defined and tested. The stored byte string is the integrity object.

## 8. Recommended A2b server adapter

A2b should define a server-owned interface such as:

```ts
interface RepositoryObservationPort {
  inspect(path: string, signal?: AbortSignal): Promise<ObservationPortResult>;
  parseStored(value: unknown): StoredObservationPortResult;
  compare(recorded: StoredObservation, current: StoredObservation): ObservationComparisonResult;
}
```

The adapter wraps A1. Routes and storage never import A1 directly.

## 9. Registration transaction

Recommended sequence:

```text
authenticate
    → authorize active Owner
    → strict request/display-name validation
    → ensure feature available
    → first A1 inspection
    → second A1 inspection immediately before transaction
    → require core/environment/risk equality
    → serialize/hash second observation
    → transaction:
         recheck same/foreign duplicate
         insert repository
         insert successful registration inspection
         link registration and environmental baseline
         insert audit success/duplicate/failure as applicable
         insert repository-registered event (A2b only)
      commit
    → notifier
```

A2b must decide atomic circular linkage using deferred FKs or an equivalent structurally proven pattern.

## 10. Inspection and state mapping

Recommended command transaction:

```text
authorize
load repository and stored baseline evidence
verify full stored record integrity and A1 parse
perform A1 inspection
map exact result
transaction:
    append attempt
    apply pure state transition if any
    append audit
    append status/evidence event only when required
commit
notify only if event exists
```

`observation-raced` remains retryable and does not make the stored repository unavailable.

## 11. Reaffirmation

Request should carry:

```text
expected repository version
expected latest successful inspection ID
bounded reason
```

A2b performs a fresh A1 inspection. Core identity must match, environmental evidence must still differ from the accepted baseline, and the current state must still be `identity-evidence-changed`. The transaction appends evidence, advances the environmental baseline, transitions active, increments version, audits, emits status change, commits, then notifies.

## 12. Retirement and unbind

Repository retirement:

- Owner only;
- no A1 dependency;
- one transaction retires all active bindings and repository;
- one binding-retired event per binding plus repository status event;
- one notifier after commit;
- idempotent repeat emits nothing;
- active uniqueness reservation releases only after durable retirement.

Binding retirement:

- Owner/Editor;
- affects one active binding;
- repository and other bindings remain unchanged;
- idempotent repeat emits nothing.

## 13. Journal rebuild in A2b

Migration 0004 should rebuild `workspace_events` with:

```text
repository_id
repository_inspection_id
repository_binding_id
```

Add candidate keys in schema 3 so composite FKs can prove:

```text
inspection belongs to repository and workspace
binding belongs to project, repository, and workspace
```

The migration must use sequence-preserving guard logic equivalent to migration 0002.

## 14. Browser compatibility

A2b changes no repository pages. It must extend exhaustive event handling:

```text
repository-registered
repository-status-changed
repository-evidence-changed
project-repository-bound
project-repository-binding-retired
```

Recommended `StaleScopes` addition:

```ts
repositoryIds: readonly string[];
```

Binding events invalidate the affected project and repository. Repository events invalidate workspace summary only if the accepted snapshot/query design actually includes repository counts; otherwise they invalidate repository IDs for future views without inventing a summary.

## 15. Scope triggers

A2a must propose further decomposition if its source-specific plan predicts:

- more than roughly 45 files;
- more than one migration;
- server or browser changes;
- Git import;
- authoritative command transactions;
- a second persistence model beyond repository/evidence/binding.

A2b must independently recalculate its scope after A2a acceptance.
