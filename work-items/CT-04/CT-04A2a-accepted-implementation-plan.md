# CT-04A2a accepted implementation plan

**Status:** Accepted-plan candidate; source implementation remains unauthorized pending
operator approval and commit
**Slice:** CT-04A2a — Repository domain, evidence model, and persistence
**Parent:** CT-04A2 — Repository registry and project binding
**Planning checkout:** `599f3dedf406542cfda26bfecc25ffdc86e0c6d4`
**Accepted A1 runtime head:** `7313e81a56c0188574c436322d7fedc16e08bb70`

## 1. Authority, lineage, and stop condition

This plan reconciles:

1. `work-items/CT-04/CT-04A2a-proposed-implementation-plan.md`,
   SHA-256 `67c6444ca23ba8d19902ad01a05ef4d31a5c990e4d8d02b1049cde458fcd2c81`;
2. `review-findings/CT-04/CT-04A2a-design-review.md`,
   SHA-256 `5b6e9f620eaec112386f19578b2111d52d12745b43b3de26bb0e67aad8dcfc94`;
3. `work-items/CT-04/CT-04A2a-review-disposition.md`,
   SHA-256 `156b35ef25e920e56cd1a783e8342ac089710abc7ba5b4a3ad4f57fb73bd2206`;
4. the CT-04A2/A2a contracts, accepted A1 records, original protected specification, and
   read-only A2 protected supplement.

It supersedes the proposed plan only after the operator approves and commits it. It does
not itself authorize implementation. After this file is reviewed, the required sequence
is:

```text
operator approves this accepted plan
    → operator commits the planning/review package
    → operator gives separate explicit implementation permission
    → implement exactly this A2a slice
    → run deterministic and focused gates
    → operator creates/requests an implementation commit
    → only then create the completion report with that real exact head
```

Do not edit the A2 protected supplement. Do not implement A2b. Do not create a completion
report before an implementation commit exists.

## 2. Exact source and protected pins

| Artifact/fact | Exact pin | Verified disposition |
|---|---|---|
| Planning-package commit | `599f3dedf406542cfda26bfecc25ffdc86e0c6d4` | local HEAD when proposed/reviewed |
| Accepted A1 runtime | `7313e81a56c0188574c436322d7fedc16e08bb70` | ancestor; runtime paths unchanged through planning head |
| A2 source bundle | `ee0090898b7cedb1ecd0438f607b1e8ed60f0ec28a99f58b688400f025a2aeea` | accepted handoff pin; archive absent locally, not rehashed |
| A1 accepted plan | `da26d6c8870ea52c1aea031f6537d0eb4ba219aec0405db4e4bb3d8b429186cf` | local SHA-256 matches |
| A1 final review | `f27ac10ba6f075e8392abdec471c2413c271cf88329398cf8e9d125ed05cfca7` | local SHA-256 matches |
| Protected-package commit | `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4` | exists |
| Original protected acceptance | `ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64` | local SHA-256 matches |
| A2 protected supplement | `1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c` | local SHA-256 matches; read-only |
| Migration 0001 | `42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273` | must remain byte-identical |
| Migration 0002 | `6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247` | must remain byte-identical |

The A2 planning package is separately recorded from the A1 runtime head. All A2
contracts, handoff/source maps, matrices, guidance, and protected supplement are tracked
at the planning commit. The review independently reproduced the pins and verified that
the intervening changes contain no runtime modification.

## 3. Actual A1 API reconciliation

A2a copies durable vocabulary but imports no Git package. A2b alone will adapt the
package-root API.

The package root exports the following relevant runtime values and functions:

```text
createRepositoryInspector
parseRecordedObservation
compareRepositoryObservations
ALL_REPOSITORY_INSPECTION_ERROR_CODES
REPOSITORY_INSPECTION_ERROR_SUBJECTS
REPOSITORY_OBSERVATION_VERSION
REPOSITORY_INSPECTION_POLICY_VERSION
REPOSITORY_RISK_SCAN_SCOPE_VERSION
REPOSITORY_RISK_SCAN_PATTERN
REPOSITORY_RISK_SIGNALS
```

The relevant exported types are:

```text
CoreEvidenceDifference
EnvironmentalEvidenceDifference
ParsedRepositoryObservation
RecordedObservationResult
RepositoryInspectionError
RepositoryInspectionErrorCategory
RepositoryInspectionErrorCode
RepositoryInspectionErrorSubject
RepositoryInspectionOperation
RepositoryInspectionRequest
RepositoryInspectionResult
RepositoryInspectionRetryability
RepositoryInspector
RepositoryInspectorCreationResult
RepositoryInspectorOptions
RepositoryObservationComparison
RepositoryObservationComparisonResult
RepositoryObservationShape
RepositoryRiskScanObservation
RepositoryRiskSignal
RiskScanDifference
```

`RepositoryInspectorOptions` is exactly:

```ts
{
  allowedSourceRoots: readonly string[];
  reservedRoots?: readonly string[];
  gitExecutable?: string;
  executableSearchPath?: string;
  commandTimeoutMs?: number;
  creationTimeoutMs?: number;
  inspectionTimeoutMs?: number;
  stdoutLimitBytes?: number;
  stderrLimitBytes?: number;
  terminationGraceMs?: number;
}
```

Creation and inspection are result unions, not exceptions. Inspection takes
`{requestedPath, signal?}`. The observation contains observation/policy versions,
`observedAt`, semantic Git version, all three canonical paths, object format, core
inodes/fingerprint, two environmental device values, and risk scope/pattern/class/signals.

Comparison returns the 7/2/3 exact difference sets plus `sameCoreIdentity`,
`sameEnvironmentalEvidence`, and `sameRiskScanEvidence`. The core fingerprint covers only:

```text
observationVersion
inspectionPolicyVersion
canonicalTopLevel
canonicalCommonGitDirectory
objectFormat
topLevelInode
commonDirectoryInode
```

It does not authenticate canonical Git directory, devices, risk evidence, or observed
time. A2a therefore stores exact full-record bytes plus a separate digest.

The exact domain-to-SQL vocabulary parity is proved in A2a. Domain-to-A1 package parity is
an explicit A2b adapter proof. SQL does not duplicate the exact 190-character risk scan
pattern; it enforces only non-empty/bounded shape, while domain owns the accepted exact
constant and A2b compares it to A1.

## 4. Dependency and authority boundary

```text
@craftingtable/domain
  pure records, closed vocabulary, reducer, evidence normalizer
       ▲                           ▲
       │                           │
@craftingtable/contracts     @craftingtable/storage
strict Zod API shapes        SQLite model + exact-byte digest helper
       ▲                           ▲
       └────────── A2b server ─────┘──→ @craftingtable/git
                         ▲
                    A2b web projection
```

A2a production and tests under domain/contracts/storage must not import:

```text
@craftingtable/git
node:child_process or child_process
Fastify or @fastify/*
@craftingtable/server production composition
routes
workspace event vocabulary or repository event payloads
notifier code
React, @craftingtable/web, or browser code
```

The only server file change is a regression-test migration-version repair. There is no
server production change. `repository-test-support.ts` is deliberately classified by the
general scope checker as production-capability surface even though tests consume it; it
contains no privileged import or capability. The A2a-specific rule additionally scans
test files, closing the general checker's test exemption.

## 5. Exact target tree and predicted scope

`+` is new; `~` is modified:

```text
~ README.md
~ CLAUDE.md
~ scripts/check-forbidden-scope.mjs
~ scripts/check-forbidden-scope.test.mjs
~ apps/server/src/restart.test.ts

~ docs/architecture.md
~ docs/security.md
~ docs/operations.md
~ docs/decisions/README.md
~ docs/decisions/ADR-002-sqlite-and-migrations.md
+ docs/decisions/ADR-017-repository-evidence-and-persistence.md

packages/domain/src/
~ ids.ts
~ ids.test.ts
~ audit.ts
~ index.ts
+ repository.ts
+ repository.test.ts

packages/contracts/src/
~ ids.ts
~ index.ts
+ repository.ts
+ repository.test.ts

packages/storage/migrations/
+ 0003-ct04a2a-repository-model.sql

packages/storage/src/
~ types.ts
~ storage.ts
~ migrations.test.ts
~ migration-0002.test.ts
~ snapshot.test.ts
+ repository-types.ts
+ repository-test-support.ts
+ repository-schema.test.ts
+ repository-repositories.test.ts
+ repository-transitions.test.ts
+ migration-0003.test.ts
+ repositories/repository-registry/index.ts
+ repositories/repository-registry/rows.ts
```

Prediction:

```text
35 changed/new implementation files
approximately 7,000–9,500 lines including SQL, tests, and documentation
one migration
no new dependency or manifest
no server production, Git, child-process, route, journal-event, notifier, or browser code
```

Stop and return to planning if implementation reaches roughly 45 files, needs a second
migration, needs production server/browser/Git composition, introduces a second
persistence model, or cannot implement the reviewed SQLite invariants.

## 6. Domain model

### 6.1 IDs, status, and lifecycle vocabulary

Add branded `RepositoryId`, `RepositoryInspectionId`, and
`ProjectRepositoryBindingId` plus strict converters/schemas.

Repository statuses:

```text
active
unavailable
identity-evidence-changed
identity-mismatch
evidence-blocked
retired
```

Repository reasons:

```text
registration-accepted
evidence-matches
environment-evidence-changed
core-identity-changed
repository-class-changed
path-unavailable
metadata-unreadable
stored-evidence-digest-mismatch
stored-evidence-invalid
unsupported-observation-version
inspection-policy-version-mismatch
environment-evidence-reaffirmed
operator-retired
```

Exact status/reason coupling:

| Status | Reasons |
|---|---|
| active | registration-accepted, evidence-matches, environment-evidence-reaffirmed |
| unavailable | path-unavailable, metadata-unreadable |
| identity-evidence-changed | environment-evidence-changed |
| identity-mismatch | core-identity-changed, repository-class-changed |
| evidence-blocked | stored-evidence-digest-mismatch, stored-evidence-invalid, unsupported-observation-version, inspection-policy-version-mismatch |
| retired | operator-retired |

Inspection kind is registration, verification, or reaffirmation. Outcome is succeeded or
failed. Binding status is active or retired.

### 6.2 A1-mirrored and A2a-owned failure vocabulary

The mirrored A1 table is exact:

| Subject | Category / retryability | Codes |
|---|---|---|
| caller-input | path-policy / not-retryable | invalid-path |
| policy-configuration | configuration / configuration-required | invalid-options, invalid-root-policy, outside-allowed-root, reserved-root-overlap |
| host-environment | configuration / retryable | unsupported-platform, root-daemon-refused, git-not-found, git-not-executable, git-executable-changed, unsupported-git-version, aborted |
| repository-unavailable | path-policy / retryable | path-unavailable, repository-metadata-unreadable, observation-raced |
| repository-class-changed | path-policy / not-retryable | symlink-rejected, ownership-refused, not-primary-repository, not-git-repository, unsupported-object-format, unsupported-repository-extension |
| git-boundary-fault | git-process / retryable | spawn-failed, timed-out, stdout-overflow, stderr-overflow, signal-terminated, git-command-failed, invalid-output-encoding, malformed-version-output, malformed-identity-output, malformed-feature-output, feature-count-exceeded |
| recorded-evidence-invalid | observation / not-retryable | recorded-observation-invalid, unsupported-observation-version |
| evidence-not-comparable | observation / not-retryable | inspection-policy-version-mismatch |

A1 operations are create-inspector, inspect-path, parse-recorded-observation, and
compare-observations.

The disjoint A2a-owned tuple is:

```text
origin        storage-integrity
code          stored-evidence-digest-mismatch
subject       stored-evidence-integrity
category      observation
operation     verify-stored-record
retryability  not-retryable
```

No A1 parity test treats that tuple as an A1 export. SQL rejects using an A1 origin with
the A2a tuple or a storage-integrity origin with any A1 tuple.

The exact risk signals are:

```text
core-hooks-path
core-fsmonitor
core-worktree-redirection
diff-external
diff-driver-command
diff-driver-textconv
filter-clean
filter-smudge
filter-process
config-include
conditional-config-include
worktree-config-enabled
hooks-directory-symlink
hook-entry
```

Exact differences:

```text
core:
  canonical-top-level
  canonical-git-directory
  canonical-common-git-directory
  object-format
  top-level-inode
  common-directory-inode
  fingerprint
environment:
  top-level-device
  common-directory-device
risk:
  scan-scope-version
  scanned-key-pattern
  signals
```

Risk classifications are `no-signals-in-scanned-set` and `signals-observed`.
Observation version and risk-scope version are 1. The domain scan-pattern constant is
exactly:

```text
^(extensions\.worktreeconfig|core\.(hookspath|fsmonitor|worktree)|diff\.external|diff\..*\.(command|textconv)|filter\..*\.(clean|smudge|process)|include\.path|includeif\..*\.path)$
```

### 6.3 Complete records

`RegisteredRepository` retains the proposed plan's 21 fields:

```text
id, workspaceId, displayName
canonicalTopLevel, canonicalGitDirectory, canonicalCommonGitDirectory
objectFormat, topLevelInode, commonDirectoryInode, coreFingerprintSha256
observationVersion, inspectionPolicyVersion
registrationInspectionId, acceptedEnvironmentInspectionId
status, statusReason
registeredByUserId, registeredAt
statusChangedByUserId, statusChangedAt
version
```

Every stored `RepositoryInspection` now includes:

```text
sequence
id, workspaceId, repositoryId, actorUserId
kind, outcome, createdAt
```

A successful inspection additionally carries exact observation JSON/digest, observation
and policy versions, observed time, all identity/environment/risk projections, and the
three comparison arrays. Registration comparison arrays are omitted; verification and
reaffirmation arrays are present even when empty.

A failed inspection additionally carries:

```ts
errorOrigin: 'a1' | 'storage-integrity';
errorCode: StoredRepositoryInspectionErrorCode;
errorSubject: StoredRepositoryInspectionErrorSubject;
errorCategory: StoredRepositoryInspectionErrorCategory;
errorOperation: StoredRepositoryInspectionOperation;
errorRetryability: StoredRepositoryInspectionRetryability;
errorEvidence: NormalizedRepositoryErrorEvidence;
```

Failed registration is not stored because no repository parent exists. A storage-integrity
digest mismatch is a failed verification. Non-advancing outcomes discovered during a
reaffirm command are also verification records. A successful reaffirmation kind is
reserved by the storage API for the observation adopted as baseline in that transaction.

`ProjectRepositoryBinding` remains:

```text
id, workspaceId, projectId, repositoryId, status
boundByUserId, boundAt
retiredByUserId?, retiredAt?
version
```

Optional domain properties are omitted, never returned as explicit `undefined`.

### 6.4 Pure reducer

Assessment variants:

```text
same
risk-evidence-changed(differences)
environment-evidence-changed(differences)
core-identity-changed(differences)
unavailable(path-unavailable | metadata-unreadable)
evidence-invalid(one of the four evidence-blocked reasons)
no-state-change-failure
```

Commands are:

```ts
{ kind: 'apply-assessment'; assessment }
{ kind: 'reaffirm-environment'; assessment }
{ kind: 'retire' }
```

Ordinary assessment policy:

| Current | Assessment | Result |
|---|---|---|
| active | same/risk-only/no-state failure | unchanged; retain active |
| active | environment | identity-evidence-changed |
| active | core | identity-mismatch |
| active | unavailable | unavailable |
| active | evidence-invalid | evidence-blocked |
| unavailable | same/risk-only | active/evidence-matches |
| unavailable | environment | identity-evidence-changed |
| unavailable | core | identity-mismatch |
| unavailable | unavailable/no-state failure | unchanged |
| unavailable | evidence-invalid | evidence-blocked |
| identity-evidence-changed | same/risk-only | active/evidence-matches |
| identity-evidence-changed | environment | unchanged/still changed |
| identity-evidence-changed | core | identity-mismatch |
| identity-evidence-changed | unavailable | unavailable |
| identity-evidence-changed | evidence-invalid | evidence-blocked |
| identity-evidence-changed | no-state failure | unchanged |
| identity-mismatch/evidence-blocked | any assessment | rejected terminal |
| retired | any assessment | rejected retired |

Reaffirmation from `identity-evidence-changed` is exhaustive:

| Assessment carried by reaffirm command | Result |
|---|---|
| environment-evidence-changed | active/environment-evidence-reaffirmed; baseline advance required |
| core-identity-changed | identity-mismatch |
| same | rejected/reaffirmation-not-required |
| risk-evidence-changed | rejected/reaffirmation-not-required |
| unavailable | unavailable |
| evidence-invalid | evidence-blocked |
| no-state-change-failure | unchanged/failure-recorded |

Reaffirmation from any other state is rejected as not required, terminal, or retired.
Retirement moves every non-retired status to retired/operator-retired. Repeat retirement
is unchanged. Exhaustive switches call `assertNever`; there is no default transition.

## 7. Strict contract surface and disclosure boundary

Every object is `z.strictObject`; nested records are strict. IDs are branded. Versions are
positive safe integers. Requested paths are absolute-shape, NUL-free, and at most 4096
UTF-8 bytes but are not claimed canonical or admitted. Display names are trimmed 1–120
characters with no C0/DEL; reasons are trimmed 1–500 characters.

### 7.1 Requests

```ts
registerRepositoryRequest = {
  requestedPath: RequestedPath;
  displayName?: RepositoryDisplayName;
}

inspectRepositoryRequest = {
  expectedVersion: PositiveSafeInteger;
}

reaffirmRepositoryEnvironmentRequest = {
  expectedVersion: PositiveSafeInteger;
  expectedLatestSuccessfulInspectionId: RepositoryInspectionId;
  reason: BoundedReason;
}

retireRepositoryRequest = {
  expectedVersion: PositiveSafeInteger;
  reason: BoundedReason;
}

bindProjectRepositoryRequest = {
  repositoryId: RepositoryId;
  expectedRepositoryVersion: PositiveSafeInteger;
}

retireProjectRepositoryBindingRequest = {
  expectedVersion: PositiveSafeInteger;
  reason: BoundedReason;
}
```

Unknown `command`, `argv`, `environment`, `cwd`, `worktree`, `branch`, `ref`, `remote`,
executable/Git option, readiness, review, merge, or raw A1 fields are rejected.

`expectedVersion` remains mandatory for inspect. A2b must authenticate and authorize, load
the repository, and reject a stale version before creating/calling A1. It rechecks the
version inside the write transaction to catch the later race.

### 7.2 Reader and Owner-only repository identities

Every authenticated reader may receive:

```ts
repositoryIdentitySummary = {
  canonicalTopLevel: BoundedCanonicalPath;
  objectFormat: 'sha1' | 'sha256';
  coreFingerprintSha256: LowerHexSha256;
}
```

Only an Owner-authorized administrative endpoint/projection may receive:

```ts
repositoryAdministrativeIdentity = {
  canonicalTopLevel: BoundedCanonicalPath;
  canonicalGitDirectory: BoundedCanonicalPath;
  canonicalCommonGitDirectory: BoundedCanonicalPath;
  objectFormat: 'sha1' | 'sha256';
  coreFingerprintSha256: LowerHexSha256;
}
```

Common list/detail/mutation schemas reject both Git-directory fields. The administrative
schema is distinct; it is not an optional widening of the reader object. Storage retains
all paths, but role policy and selection remain A2b.

### 7.3 Repository, inspection, and binding summaries

```ts
repositoryEvidenceSummary = {
  registrationInspectionId: RepositoryInspectionId;
  acceptedEnvironmentInspectionId: RepositoryInspectionId;
  latestInspectionId: RepositoryInspectionId;
  latestInspectionAt: ISODateTime;
  latestSuccessfulInspectionId: RepositoryInspectionId;
  latestSuccessfulInspectionAt: ISODateTime;
  risk: {
    classification: RiskClassification;
    signals: SortedUniqueRiskSignals; // max 14
    observedAt: ISODateTime;
  };
}

registeredRepositorySummary = {
  id: RepositoryId;
  displayName: RepositoryDisplayName;
  status: RepositoryStatus;
  statusReason: RepositoryStatusReason;
  version: PositiveSafeInteger;
  registeredAt: ISODateTime;
  statusChangedAt: ISODateTime;
  identity: repositoryIdentitySummary;
  evidence: repositoryEvidenceSummary;
}
```

The four latest fields are required because registration always creates the first
successful inspection.

Successful inspection summary:

```ts
{
  sequence: PositiveSafeInteger;
  id: RepositoryInspectionId;
  kind: RepositoryInspectionKind;
  outcome: 'succeeded';
  createdAt: ISODateTime;
  observedAt: ISODateTime;
  observationSha256: LowerHexSha256;
  observationVersion: 1;
  inspectionPolicyVersion: PositiveSafeInteger;
  coreDifferences?: SortedUniqueCoreDifferences;       // max 7
  environmentalDifferences?: SortedUniqueEnvironmentDifferences; // max 2
  riskDifferences?: SortedUniqueRiskDifferences;       // max 3
  acceptedAsEnvironmentBaseline: boolean;
  risk: {
    classification: RiskClassification;
    signals: SortedUniqueRiskSignals;
  };
}
```

Registration omits all three comparison properties. Verification/reaffirmation requires
all three, including empty arrays. `acceptedAsEnvironmentBaseline` is derived by joining
the repository's current baseline ID; `kind='reaffirmation'` alone never claims adoption.

Failed inspection summary exposes no stored evidence:

```ts
{
  sequence: PositiveSafeInteger;
  id: RepositoryInspectionId;
  kind: 'verification' | 'reaffirmation';
  outcome: 'failed';
  createdAt: ISODateTime;
  error: {
    origin: 'a1' | 'storage-integrity';
    code: StoredErrorCode;
    subject: StoredErrorSubject;
    category: StoredErrorCategory;
    operation: StoredErrorOperation;
    retryability: StoredErrorRetryability;
  };
}
```

Every project-scoped binding projection is:

```ts
{
  id: ProjectRepositoryBindingId;
  projectId: ProjectId;
  repositoryId: RepositoryId;
  status: 'active' | 'retired';
  repositoryStatus: RepositoryStatus;
  repositoryStatusReason: RepositoryStatusReason;
  boundAt: ISODateTime;
  retiredAt?: ISODateTime;
  version: PositiveSafeInteger;
}
```

The repository fields are query projections, not duplicated binding columns.

### 7.4 Exact response envelopes

```text
repositoryListResponse
  { repositories: RegisteredRepositorySummary[0..100] }

repositoryDetailResponse
  { repository: RegisteredRepositorySummary,
    activeBindings: ProjectRepositoryBindingSummary[0..100] }

repositoryAdministrativeDetailResponse
  { repository: the common summary with administrative identity,
    activeBindings: ProjectRepositoryBindingSummary[0..100] }

repositoryInspectionListResponse
  { inspections: RepositoryInspectionSummary[0..100] }

registerRepositoryResponse
  { repository: RegisteredRepositorySummary, created: boolean }

inspectRepositoryResponse
  { repository: RegisteredRepositorySummary,
    inspection: RepositoryInspectionSummary, changed: boolean }

reaffirmRepositoryEnvironmentResponse
  { repository: RegisteredRepositorySummary,
    inspection: successful inspection summary, changed: boolean }

retireRepositoryResponse
  { repository: RegisteredRepositorySummary,
    retiredBindingIds: ProjectRepositoryBindingId[0..100], changed: boolean }

bindProjectRepositoryResponse
  { binding: ProjectRepositoryBindingSummary, created: boolean }

retireProjectRepositoryBindingResponse
  { binding: ProjectRepositoryBindingSummary, changed: boolean }
```

The full observation JSON and normalized error evidence are trusted storage records, never
public wire fields.

### 7.5 Unresolved/readiness terminology

CT-03 drafts remain exactly draft/incomplete with repository and base-revision status
`unresolved`. A binding does not rewrite an immutable draft. An active binding to a
non-active repository is valid history and expected state; it does not mean the repository
is usable. Neither repository `active` nor binding `active` means ready, executable,
approved, verified, reviewed, mergeable, or deliverable.

## 8. Schema 3

Migration `0003-ct04a2a-repository-model.sql` creates exactly three `STRICT` domain tables
and six audit catalog rows. It does not rebuild or add a kind to `workspace_events`.

### 8.1 `registered_repositories`

Exact columns:

| Column | SQL declaration/rule |
|---|---|
| id | `TEXT PRIMARY KEY`, non-empty |
| workspace_id | `TEXT NOT NULL`, workspace FK |
| display_name | `TEXT NOT NULL`, trimmed/control/length checks |
| canonical_top_level | `TEXT NOT NULL`, absolute-shape, max 4096 UTF-8 bytes |
| canonical_git_directory | same |
| canonical_common_git_directory | same |
| object_format | `TEXT NOT NULL`, sha1 or sha256 |
| top_level_inode | `TEXT NOT NULL`, canonical unsigned decimal |
| common_directory_inode | same |
| core_fingerprint_sha256 | `TEXT NOT NULL`, 64 lowercase hex |
| observation_version | `INTEGER NOT NULL`, exactly 1 |
| inspection_policy_version | `INTEGER NOT NULL`, positive safe integer |
| registration_inspection_id | `TEXT NOT NULL` |
| accepted_environment_inspection_id | `TEXT NOT NULL` |
| status | `TEXT NOT NULL`, closed enum |
| status_reason | `TEXT NOT NULL`, exact status coupling |
| registered_by_user_id | `TEXT NOT NULL`, user + membership FKs |
| registered_at | `TEXT NOT NULL`, immutable |
| status_changed_by_user_id | `TEXT NOT NULL`, user + membership FKs |
| status_changed_at | `TEXT NOT NULL`, monotonic non-decreasing on transition |
| version | `INTEGER NOT NULL`, starts 1, exact +1 |

Candidate keys:

```text
PRIMARY KEY(id)
UNIQUE(workspace_id, id)
```

Repository-side inspection links are immediate:

```sql
FOREIGN KEY (workspace_id, id, registration_inspection_id)
  REFERENCES repository_inspections(workspace_id, repository_id, id)
  ON DELETE RESTRICT

FOREIGN KEY (workspace_id, id, accepted_environment_inspection_id)
  REFERENCES repository_inspections(workspace_id, repository_id, id)
  ON DELETE RESTRICT
```

Global identity reservations remain held by every non-retired row:

```text
uq_registered_repositories_live_top(canonical_top_level)
uq_registered_repositories_live_common_git(canonical_common_git_directory)
uq_registered_repositories_live_fingerprint(core_fingerprint_sha256)
WHERE status <> 'retired'
```

Query index:
`idx_registered_repositories_workspace_status(workspace_id, status, registered_at, id)`.

### 8.2 `repository_inspections`

Exact 36 columns:

```text
sequence INTEGER PRIMARY KEY AUTOINCREMENT
id TEXT NOT NULL UNIQUE
workspace_id TEXT NOT NULL
repository_id TEXT NOT NULL
actor_user_id TEXT NOT NULL
kind TEXT NOT NULL
outcome TEXT NOT NULL
created_at TEXT NOT NULL

observation_json TEXT
observation_sha256 TEXT
observation_version INTEGER
inspection_policy_version INTEGER
observed_at TEXT
canonical_top_level TEXT
canonical_git_directory TEXT
canonical_common_git_directory TEXT
object_format TEXT
top_level_inode TEXT
common_directory_inode TEXT
core_fingerprint_sha256 TEXT
top_level_device TEXT
common_directory_device TEXT
risk_scan_scope_version INTEGER
risk_scanned_key_pattern TEXT
risk_classification TEXT
risk_signals_json TEXT
core_differences_json TEXT
environmental_differences_json TEXT
risk_differences_json TEXT

error_origin TEXT
error_code TEXT
error_subject TEXT
error_category TEXT
error_operation TEXT
error_retryability TEXT
error_evidence_json TEXT
```

Candidate keys:

```text
UNIQUE(workspace_id, id)
UNIQUE(workspace_id, repository_id, id)
```

The only circular-link deferral is:

```sql
FOREIGN KEY (workspace_id, repository_id)
  REFERENCES registered_repositories(workspace_id, id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED
```

Actor attribution uses both `users(id)` and
`workspace_memberships(workspace_id,user_id)` with `ON DELETE RESTRICT`.

Success coupling requires all 18 observation/projection fields, null seven-field failure
group, exact observation version 1, positive policy version, risk scope 1, non-empty risk
pattern of at most 2048 UTF-8 bytes, bounded exact observation JSON of at most 131072
UTF-8 bytes, valid lowercase digests, canonical paths/decimal values, and risk
classification consistent with signals. SQL deliberately does not require the exact risk
pattern text.

Failure coupling requires all 18 observation/projection fields and all three comparison
fields null, and all seven failure fields non-null. Failure JSON is an object with at most
16 scalar entries, at most 8192 UTF-8 bytes; keys are 1–64 alphanumeric characters
starting with a letter. Failed registration is rejected. A2a-owned integrity and
A1-mirrored taxonomy tuples are disjoint and exact.

Registration success has all three comparison columns null.
Verification/reaffirmation success has all three valid sorted unique allowlisted arrays.
Bounds are 14 risk signals, 7 core differences, 2 environmental differences, and 3 risk
differences.

Indexes:

```text
UNIQUE uq_repository_registration_inspection(repository_id)
  WHERE kind='registration' AND outcome='succeeded'

idx_repository_inspections_history
  (workspace_id, repository_id, sequence DESC)

idx_repository_inspections_success_history
  (workspace_id, repository_id, sequence DESC)
  WHERE outcome='succeeded'
```

Latest means maximum `sequence`; latest-successful means maximum successful `sequence`.
`created_at` and UUID never decide order.

### 8.3 `project_repository_bindings`

Exact columns:

```text
id TEXT PRIMARY KEY
workspace_id TEXT NOT NULL
project_id TEXT NOT NULL
repository_id TEXT NOT NULL
status TEXT NOT NULL
bound_by_user_id TEXT NOT NULL
bound_at TEXT NOT NULL
retired_by_user_id TEXT
retired_at TEXT
version INTEGER NOT NULL
```

Candidate keys:

```text
UNIQUE(workspace_id, id)
UNIQUE(workspace_id, project_id, repository_id, id)
```

Composite FKs prove same-workspace project and repository ownership. Both actors have user
and membership FKs. `MATCH SIMPLE` skipping of the nullable retirement actor is closed by
the exact active/retired actor-time check.

Indexes:

```text
UNIQUE uq_project_repository_bindings_active_project(workspace_id, project_id)
  WHERE status='active'
idx_project_repository_bindings_repository
  (workspace_id, repository_id, status, bound_at, id)
idx_project_repository_bindings_project_history
  (workspace_id, project_id, bound_at, id)
```

### 8.4 Checks and exact trigger inventory

Declarative checks cover enum membership, IDs/bounds, digest/decimal spelling,
status/reason coupling, success/failure null coupling, comparison coupling,
risk-classification coupling, binding retirement coupling, and positive versions.

Exact triggers:

| Trigger | Responsibility |
|---|---|
| registered_repositories_initial_state | registration graph, version/status/link/projection coherence |
| registered_repositories_transition_only | immutable fields, exact +1, exact transition/baseline table, non-decreasing status time |
| registered_repositories_retirement_requires_closed_bindings | no repository retirement with active binding |
| registered_repositories_no_delete | reject delete |
| repository_inspections_record_shape | success/failure/kind/projection/bounds coupling |
| repository_inspections_parent_state | registration pre-parent exception; verification/reaffirmation admissible states |
| repository_inspections_arrays_valid | JSON arrays, allowlists, sort, uniqueness, counts |
| repository_inspections_failure_taxonomy | disjoint exact A1 and storage-integrity tuples plus evidence backstop |
| repository_inspections_no_update | reject update |
| repository_inspections_no_delete | reject delete |
| project_repository_bindings_initial_state | active repository, version 1, null retirement fields |
| project_repository_bindings_retirement_only | exact active→retired +1, immutable ownership |
| project_repository_bindings_no_delete | reject delete |

Every trigger receives behavior tests; catalog-name inspection alone is insufficient.

### 8.5 Catalog additions and parity markers

Insert exactly these actions with `introduced_in_schema=3` and add them to
`AUDIT_ACTIONS`:

```text
repository.register
repository.inspect
repository.reaffirm
repository.retire
repository.bind-project
repository.unbind-project
```

`audit.ts` also exports
`AUDIT_ACTION_INTRODUCED_IN_SCHEMA: Readonly<Record<AuditAction, 1 | 2 | 3>>`.
Existing actions retain their actual schema-1/schema-2 values; the six new actions map to
3. This makes historical catalog assertions version-aware rather than slicing by name.

Migration comments delimit machine-readable literal sets for error code/subject/category/
operation/retryability, signals, and 7/2/3 differences. The A2a parity test extracts these
sets and proves set equality with domain constants. The A2a-owned origin/tuple is checked
separately. No workspace event kind is added.

## 9. Registration graph and typed insert outcomes

### 9.1 Circular registration proof

Registration runs in one immediate transaction:

```text
1. classify live identity collisions without exposing foreign row data
2. insert one successful registration inspection
3. insert repository with version 1, active/registration-accepted,
   registration_inspection_id = accepted_environment_inspection_id,
   matching actor/time and projections
4. repository INSERT checks both immediate inspection FKs and guard
5. outermost COMMIT checks the inspection's deferred repository parent
```

The valid inspection-first graph commits. Repository-first fails its guard. A repository
naming a sibling registration/baseline inspection fails at the repository statement. A
lone orphan inspection can exist inside a transaction but fails only at the outermost
commit. Releasing a nested savepoint does not surface a deferred violation; A2b must not
rely on the nested primitive to report one.

### 9.2 Registration collision classifier

```ts
type RepositoryRegistrationResult =
  | { kind: 'created'; repository: RegisteredRepository }
  | { kind: 'existing'; repository: RegisteredRepository }
  | { kind: 'conflicting-local-state'; status: RepositoryStatus }
  | { kind: 'local-identity-conflict' }
  | { kind: 'identity-reserved-elsewhere' };
```

`existing` requires one same-workspace active row matching all three identity values.
`conflicting-local-state` requires that exact same-workspace identity in a non-active,
non-retired row. Partial or multi-row same-workspace collisions are
`local-identity-conflict`. Any live collision owned by another workspace returns the
payload-free `identity-reserved-elsewhere`; it contains no workspace, repository, path,
Git-directory, or fingerprint field.

The three unique indexes remain fail-closed backstops. On a residual
`SQLITE_CONSTRAINT_UNIQUE`, the nested savepoint rolls back and the classifier reruns.
The result is the same typed variant; if it cannot safely establish a local case, it
returns `identity-reserved-elsewhere`. Code never parses SQLite error text or index names.

## 10. Exact bytes, digest verification, and failure-evidence normalization

Observation write:

```text
receive branded A1 observation in A2b
→ JSON.stringify once
→ hash exact UTF-8 bytes with SHA-256
→ derive projections from that same immutable object
→ store exact string, digest, and projections without reserialization
```

Observation read:

```text
read exact string and digest
→ hash exact stored UTF-8 bytes
→ on mismatch: do not parse or call A1
→ append storage-integrity failed verification
→ transition evidence-blocked in the same outer transaction
→ otherwise JSON.parse once
→ A1 parseRecordedObservation
→ compare every stored projection
→ only then use/compare evidence
```

Whitespace and key order are part of stored byte identity. This is not canonical JSON and
not hostile-database authenticity. A writer able to replace bytes and digest can defeat
the checksum. SQLite validates syntax/bounds but cannot hash or prove semantic projection
equality.

A2a owns:

```ts
normalizeRepositoryErrorEvidence(
  value: Readonly<Record<string, string | number | boolean>>,
): NormalizedRepositoryErrorEvidence
```

The total deterministic algorithm:

1. sort input entries by key;
2. retain keys of 1–64 characters matching `[A-Za-z][A-Za-z0-9]*`;
3. retain booleans, finite numbers, and strings only;
4. truncate strings to at most 2048 UTF-8 bytes on a valid code-point boundary;
5. retain at most 16 entries while the serialized object remains at most 8192 UTF-8 bytes;
6. omit an entry that still cannot fit;
7. on any unexpected normalization/serialization condition, return the already accepted
   prefix or `{}`, never throw.

Failed-inspection write input accepts only the branded normalized result. Direct SQL
retains the same bounds as a backstop. An awkward future A1 key reduces diagnostic detail
but never loses the failure record.

## 11. State machines, ordering, and concurrency

### 11.1 Repository transitions

Insert requires version 1, active/registration-accepted, identical registration/baseline
inspection, identical registered/status actor and time, and exact registration projection
agreement.

Every update keeps workspace, display name, core identity, registration evidence, and
registration attribution immutable; requires `NEW.version=OLD.version+1`; requires a
valid status actor; and requires
`NEW.status_changed_at >= OLD.status_changed_at`. Equal millisecond time is valid. An
earlier timestamp is invalid.

Allowed non-reaffirmation triples:

| Old | New | Reason |
|---|---|---|
| active | identity-evidence-changed | environment-evidence-changed |
| active | identity-mismatch | core-identity-changed or repository-class-changed |
| active | unavailable | path-unavailable or metadata-unreadable |
| active | evidence-blocked | one of four evidence-blocked reasons |
| active | retired | operator-retired |
| unavailable | active | evidence-matches |
| unavailable | identity-evidence-changed | environment-evidence-changed |
| unavailable | identity-mismatch | core-identity-changed or repository-class-changed |
| unavailable | evidence-blocked | one of four evidence-blocked reasons |
| unavailable | retired | operator-retired |
| identity-evidence-changed | active | evidence-matches, baseline unchanged |
| identity-evidence-changed | unavailable | path-unavailable or metadata-unreadable |
| identity-evidence-changed | identity-mismatch | core-identity-changed or repository-class-changed |
| identity-evidence-changed | evidence-blocked | one of four evidence-blocked reasons |
| identity-evidence-changed | retired | operator-retired |
| identity-mismatch | retired | operator-retired |
| evidence-blocked | retired | operator-retired |

Risk-only, same evidence from active, repeated preserving failures, and observation-raced
append history but issue no repository update. A self-update fails because no exact
old/new/reason triple admits it, even if the timestamp is equal and version is bumped.
No-op update, +0/+2, bare bump, reason-only rewrite, baseline rewrite, core/display/
ownership rewrite, reverse transition, and delete fail.

### 11.2 Inspection append state

Inspection rows are immutable and totally ordered by sequence. Registration is inserted
only by `register`. Generic `append` records verification only. A2b uses verification for
every non-advancing result discovered during a reaffirm request, including same,
risk-only, core mismatch, unavailable, invalid evidence, and failure.

The `reaffirmEnvironment` primitive alone inserts a successful reaffirmation and adopts
it as baseline atomically. A direct-SQL successful reaffirmation row that is not adopted
remains possible under the three-table model but is never projected as accepted:
`acceptedAsEnvironmentBaseline` is false. Kind is attempt classification; only the
baseline link proves acceptance.

Verification inserts are allowed from active, unavailable, and
identity-evidence-changed. Reaffirmation insert is allowed only from
identity-evidence-changed. New inspections from identity-mismatch, evidence-blocked, or
retired fail. Historical rows remain readable in every status.

The storage-integrity failure tuple is permitted only on a failed verification. A digest
mismatch appends that row and applies the evidence-blocked transition in one A2b outer
transaction; rollback removes both.

### 11.3 Environmental baseline and reaffirmation

Initial baseline equals the registration inspection. Ordinary successful verification
matching the existing accepted baseline can restore active/evidence-matches without
changing the baseline.

Reaffirmation requires:

```text
current status identity-evidence-changed
exact expected repository version
expectedLatestSuccessfulInspectionId equals MAX(successful sequence) before fresh append
fresh successful observation
core and version projections equal immutable registration identity
environmental differences non-empty
fresh row becomes MAX(successful sequence)
successful kind reaffirmation
new baseline differs from old and names that fresh row
status active/environment-evidence-reaffirmed
status actor equals inspection actor
version exactly +1
timestamp non-decreasing
```

Core difference follows mismatch rather than reaffirmation. Same/risk-only is
reaffirmation-not-required. All non-advancing results are verification records. A direct
baseline rollback, failed/sibling/stale/non-latest/non-reaffirmation target, policy/core
mismatch, wrong actor, wrong status, or missing exact version fails.

The registration row does not prove the two-inspection quiescence check: it stores only
the accepted second observation and NULL comparison arrays. A2b must durably attest the
decision in the `repository.register` audit details with:

```text
firstObservationSha256
acceptedObservationSha256
sameCoreIdentity = true
sameEnvironmentalEvidence = true
sameRiskScanEvidence = true
```

That is a bounded attestation; it does not retain the first full observation.

### 11.4 Binding and retirement

Binding insert requires same-workspace existing project, active repository at the exact
expected repository version, active binding/version 1, valid historical member actor, and
null retirement attribution. One project has at most one active binding; many projects
may bind one repository.

Repository status changes do not rewrite or close bindings. An active binding may point to
an unavailable, evidence-changed, mismatched, or evidence-blocked repository. Every
project-scoped projection joins the current repository status/reason so this cannot read as
usability.

Binding retirement is exactly active/version N/null retirement fields to
retired/version N+1/non-null actor/time. Ownership/bound attribution is immutable.
Retarget, unretire, partial retirement, +0/+2, post-retirement touch, and delete fail.
Repeat retirement is an application no-op with no SQL.

Repository retirement is available from every non-retired state without A1. In one
immediate transaction it retires each active binding once, then moves the repository to
retired/operator-retired at +1. The repository trigger rejects retirement while an active
binding remains. Forced failure rolls back all rows. Repeat retirement is a no-op.
Identity reservations release only after durable repository retirement.

### 11.5 Versions, total order, and concurrent writers

All updates carry `expectedVersion`; bind carries `expectedRepositoryVersion`.
Registration has no prior version. SQL predicates include workspace, ID, current status,
and exact version. Zero-row outcomes are typed conflicts/no-ops, never implicit retries.

All creation/collision classification and state transitions run in the existing
nested-safe immediate transaction model with 5000 ms busy timeout:

```text
two registrations     one writer/classified typed loser; unique indexes backstop
two inspections       both can append if state/version remains admissible; sequence orders
two status updates    first N+1 wins; second expected N conflicts
two project bindings  one active-project winner; loser typed existing/conflict
two binding retires   first N+1 wins; second unchanged/conflict
bind vs repo retire   serialized; binding is included in retirement or sees retired
two reaffirmations    one expected version/latest-success winner
```

Inspection `sequence` is database-generated and never supplied by callers. Multiple
same-millisecond rows remain deterministic. Repository/binding triggers independently
reject exact-version bypass.

Only the inspection-to-repository FK is deferred. Its violation is checked at the
outermost commit, not at a nested savepoint release.

## 12. Relationship matrices

These are implementation proof obligations for every relationship.

### 12.1 Repository → workspace and actor attribution

| Case | Result |
|---|---|
| Same workspace/correct parent | workspace, user, membership FKs accept |
| Cross workspace | membership composite FK rejects |
| Same workspace/wrong actor | any historical member is structurally valid; A2b owns role/current status |
| Missing parent | workspace/user/membership FK rejects |
| Retired/non-active parent | archived workspace and revoked member remain referential history; A2b blocks new action |
| NULL/optional | all repository parents/actors non-null |
| Concurrent insert/update | identity indexes/immediate transaction/version predicate serialize |
| Wrong version increment | transition trigger rejects |
| Delete/reverse | no-delete and terminal table reject |

### 12.2 Inspection → repository/workspace/actor

| Case | Result |
|---|---|
| Same workspace/correct parent | membership FKs accept at statement; deferred composite repository FK accepts at outer commit |
| Cross workspace | composite repository/membership key rejects |
| Same workspace/wrong parent | row belongs to its declared repository; sibling use as registration/baseline fails repository-side key |
| Missing parent | orphan statement may succeed; outermost commit rejects |
| Retired/non-active parent | unavailable/evidence-changed allow recovery; mismatch/blocked/retired reject new rows |
| NULL/optional | base ownership non-null; discriminated groups exactly coupled |
| Concurrent insert/update | unique ID plus global sequence; append-only rows coexist |
| Wrong version increment | no inspection update/version exists; every update rejects |
| Delete/reverse | append-only delete trigger rejects |

### 12.3 Repository ↔ registration inspection

| Case | Result |
|---|---|
| Same workspace/correct parent | inspection-first, immediate repository link, deferred reciprocal parent, outer commit succeeds |
| Cross workspace | immediate three-column repository FK rejects statement |
| Same workspace/wrong parent | immediate repository FK rejects statement |
| Missing parent | repository fails statement; orphan inspection fails outer commit |
| Retired/non-active parent | immutable registration evidence remains linked |
| NULL/optional | IDs non-null; initial baseline equals registration |
| Concurrent insert/update | one identity winner; one registration inspection per repository |
| Wrong version increment | registration link immutable |
| Delete/reverse | both rows reject delete/retarget |

### 12.4 Repository → environmental baseline

| Case | Result |
|---|---|
| Same workspace/correct parent | immediate same-repository FK and success/core/version guard accept |
| Cross workspace | immediate composite FK rejects |
| Same workspace/wrong parent | sibling inspection rejects |
| Missing parent | repository INSERT/UPDATE rejects at statement |
| Retired/non-active parent | baseline remains readable; only evidence-changed can advance |
| NULL/optional | baseline always non-null |
| Concurrent insert/update | expected version/latest sequence admit one advance |
| Wrong version increment | transition trigger rejects |
| Delete/reverse | inspection delete and baseline rollback reject |

### 12.5 Binding → project/repository/workspace

| Case | Result |
|---|---|
| Same workspace/correct parent | composite FKs and active/version guard accept |
| Cross workspace | project/repository composite FK rejects |
| Same workspace/wrong parent | nonexistent/mixed graph rejects; a real sibling project is a separate valid binding |
| Missing parent | project/repository FK or typed precheck rejects |
| Retired/non-active parent | new binding rejects; existing binding survives and projects repository status |
| NULL/optional | ownership non-null; retirement attribution exactly coupled |
| Concurrent insert/update | active-project unique index selects one typed winner |
| Wrong version increment | retirement trigger rejects |
| Delete/reverse | no-delete/no-unretire/no-retarget reject |

### 12.6 Binding actors

| Case | Result |
|---|---|
| Same workspace/correct parent | user and historical membership FKs accept |
| Cross workspace | membership FK rejects |
| Same workspace/wrong actor | any historical member structurally valid; A2b role policy |
| Missing parent | user/membership FK rejects |
| Retired/non-active parent | revoked actor remains valid history, cannot authorize new service action |
| NULL/optional | bound actor non-null; retired actor null iff active |
| Concurrent insert/update | exact version selects retirement attribution |
| Wrong version increment | trigger rejects |
| Delete/reverse | immutable attribution/no-delete rejects |

Archived workspaces remain structurally referenceable, matching CT-03. Active-workspace
policy is A2b. Referenced workspace-membership rows become undeletable historical
attribution because all new FKs use `ON DELETE RESTRICT`.

## 13. Storage repository surface and typed outcomes

`repository-types.ts` owns exact write inputs, normalized evidence, typed result unions,
query rows, and digest helpers.

```ts
type InspectionAppendResult =
  | { kind: 'appended'; inspection: RepositoryInspection }
  | { kind: 'duplicate-id' }
  | { kind: 'version-conflict' }
  | { kind: 'repository-not-inspectable'; status: RepositoryStatus };

type ProjectRepositoryBindingInsertResult =
  | { kind: 'created'; binding: ProjectRepositoryBinding }
  | { kind: 'existing'; binding: ProjectRepositoryBinding }
  | { kind: 'project-already-bound' }
  | { kind: 'repository-not-found' }
  | { kind: 'repository-not-active'; status: RepositoryStatus }
  | { kind: 'repository-version-conflict' };
```

`existing` binding requires the same active project/repository pair.
`project-already-bound` carries no other repository identity. `repository-not-found` also
carries no foreign detail. Constraint backstops are caught, rolled back to the local
savepoint, and reclassified by reads; error strings are not parsed.

```ts
interface RepositoryRegistryRepositories {
  repositories: {
    register(input): RepositoryRegistrationResult;
    find(workspaceId, repositoryId): RegisteredRepository | undefined;
    list(workspaceId, limit): readonly RegisteredRepository[];
    applyTransition(inputWithExpectedVersion): RepositoryMutationResult;
    reaffirmEnvironment(
      inputWithExpectedVersionAndFreshInspection,
    ): RepositoryReaffirmationResult;
    retireWithBindings(inputWithExpectedVersion): RepositoryRetirementResult;
  };
  inspections: {
    appendVerification(inputWithExpectedVersion): InspectionAppendResult;
    find(workspaceId, inspectionId): RepositoryInspection | undefined;
    listForRepository(...): readonly RepositoryInspection[];
    latestForRepository(...): RepositoryInspection; // MAX sequence
    latestSuccessfulForRepository(...): SuccessfulRepositoryInspection;
  };
  bindings: {
    insert(inputWithExpectedRepositoryVersion):
      ProjectRepositoryBindingInsertResult;
    find(workspaceId, bindingId): ProjectRepositoryBinding | undefined;
    findActiveForProject(...): ProjectRepositoryBinding | undefined;
    listForProject(...): readonly ProjectRepositoryBinding[];
    listForRepository(...): readonly ProjectRepositoryBinding[];
    retire(inputWithExpectedVersion): BindingMutationResult;
  };
  queries: {
    repositorySummary(...): RepositorySummaryRow | undefined;
    repositorySummaries(...): readonly RepositorySummaryRow[];
    projectBindingSummaries(...):
      readonly ProjectRepositoryBindingSummaryRow[];
  };
}
```

Latest methods are non-optional for an existing repository; absence is a storage integrity
error because registration guarantees a row. Storage repositories and
`CraftingTableStorage` gain `repositoryRegistry`. The existing outer transaction can later
compose state, audit, and events. A2a writes no audit or event.

## 14. Migration preservation and direct-SQL proof

### 14.1 Fresh and forward migration

`migration-0003.test.ts` exercises fresh schema 3 and a populated accepted schema-2 file
containing users, workspaces/memberships, sessions, projects, plan versions, attempts,
artifacts, diagnostics, work items/dependencies, drafts, audit rows, and workspace events.

Before migration it records every row, journal maxima, catalogs, trigger/index SQL,
schema ledger, and every pre-existing `sqlite_sequence` row. After applying only 0003:

```text
all old rows and sequence-bearing journal behavior are unchanged
every pre-existing sqlite_sequence row/counter is unchanged and no counter reset
a new inspection sequence row may appear only after an inspection insert
old triggers/indexes/catalog values remain active
exactly three domain tables, required indexes/triggers, and six audit actions exist
workspace_event_kinds and snapshot/SSE semantics are unchanged
schema ledger records version 3/name/checksum with actual migration digest
foreign_key_check and integrity_check are clean
```

`migration-0002.test.ts` explicitly applies migrations 1 and 2. Its catalog comparison
uses only `AUDIT_ACTIONS` whose
`AUDIT_ACTION_INTRODUCED_IN_SCHEMA[action] <= 2`, proves no repository action exists, and
preserves the exact existing introduction versions.
`migration-0003.test.ts` proves the full sorted 19-action constant equals the full schema-3
catalog and old introduction versions did not change.

`apps/server/src/restart.test.ts` compares migration status with discovered supported
version rather than literal 2. The scope regression forbids future literal pinning.
`packages/storage/src/snapshot.test.ts` owns named `A2A-MIG-007` proof that prior
snapshot/SSE reconstruction is unchanged.

A synthetic failing 0003 proves rollback leaves schema 2 and its ledger intact. Old
migration files remain byte-identical and checksum drift fails closed.

### 14.2 Direct-SQL and concurrency matrix

| Surface | Positive | Negative/backstop |
|---|---|---|
| Circular graph | inspection-first pair commits | orphan fails outer commit; wrong repository/baseline fails statement |
| Identity | distinct live identities; retired reuse | all three live collisions; typed local/foreign outcomes |
| Repository | every exact transition, equal timestamp | core/owner/display rewrite, self update, +0/+2, backwards time, delete/unretire |
| Inspection success | complete registration/verification/reaffirmation | partial group, bad digest/JSON/array/version/risk bounds |
| Inspection failure | exact A1 and A2a tuples | cross-origin tuple, missing field, unnormalized direct SQL |
| Total order | fixed-clock three-row order | UUID ascending/descending cannot change MAX sequence |
| Digest | byte-identical round trip | one-byte stale digest appends integrity failure and blocks |
| Baseline | initial and fresh latest reaffirm | failed/sibling/stale/nonlatest/core-different/nonreaffirmation |
| Binding | same-workspace active; many projects/repo | mixed parents, non-active repo, second active project binding |
| Retirement | binding + repository atomic | forced rollback, repository-first, reverse/delete |
| Concurrency | separate connections for registration/bind/update/reaffirm | loser returns typed result; no raw unique exception |
| Vocabulary | migration literals equal domain sets | mutated fixture literal fails parity |
| Migration | fresh and populated schema-2 forward | checksum drift, interruption, old-file edit |

## 15. Acceptance and proof mapping

Every original A2a protected ID remains a test-title prefix. The reviewed 91 protected
cases are not renumbered or edited.

### 15.1 Original protected cases

| IDs | Permanent proof |
|---|---|
| `A2A-STATUS-001`, `A2A-STATUS-002`, `A2A-STATUS-003`, `A2A-STATUS-004`, `A2A-STATUS-005`, `A2A-STATUS-006`, `A2A-STATUS-007`, `A2A-STATUS-008`, `A2A-STATUS-009`, `A2A-STATUS-010`, `A2A-STATUS-011`, `A2A-STATUS-012`, `A2A-STATUS-013`, `A2A-STATUS-014` | `packages/domain/src/repository.test.ts`; exact ordinary reducer matrix, terminal/reverse/unsupported behavior |
| `A2A-REP-001`, `A2A-REP-002`, `A2A-REP-003`, `A2A-REP-004`, `A2A-REP-005`, `A2A-REP-006`, `A2A-REP-007`, `A2A-REP-008`, `A2A-REP-009`, `A2A-REP-010`, `A2A-REP-011`, `A2A-REP-012`, `A2A-REP-013`, `A2A-REP-014` | `packages/storage/src/repository-schema.test.ts`; circular timing, ownership, global identity, immutability/version/delete and name bounds |
| `A2A-INSP-001`, `A2A-INSP-002`, `A2A-INSP-003`, `A2A-INSP-004`, `A2A-INSP-005`, `A2A-INSP-006`, `A2A-INSP-007`, `A2A-INSP-008`, `A2A-INSP-009`, `A2A-INSP-010`, `A2A-INSP-011`, `A2A-INSP-012`, `A2A-INSP-013`, `A2A-INSP-014` | schema and repository tests; complete null coupling, ownership, append-only, arrays/bounds, exact bytes, stale digest, digest syntax |
| `A2A-BASE-001`, `A2A-BASE-002`, `A2A-BASE-003`, `A2A-BASE-004`, `A2A-BASE-005`, `A2A-BASE-006`, `A2A-BASE-007`, `A2A-BASE-008` | `packages/storage/src/repository-transitions.test.ts`; initial/failed/sibling/status/version/coherent/core/delete baseline cases |
| `A2A-BIND-001`, `A2A-BIND-002`, `A2A-BIND-003`, `A2A-BIND-004`, `A2A-BIND-005`, `A2A-BIND-006`, `A2A-BIND-007`, `A2A-BIND-008`, `A2A-BIND-009`, `A2A-BIND-010`, `A2A-BIND-011`, `A2A-BIND-012` | schema/repository tests; same workspace, wrong/missing/non-active parent, uniqueness, sibling binding, retirement/null/reverse/delete/revoked actor |
| `A2A-RET-001`, `A2A-RET-002`, `A2A-RET-003`, `A2A-RET-004`, `A2A-RET-005`, `A2A-RET-006`, `A2A-RET-007`, `A2A-RET-008` | transitions tests; atomic/rollback/idempotent/new-binding/history/reuse/unretire/delete |
| `A2A-MIG-001`, `A2A-MIG-002`, `A2A-MIG-003`, `A2A-MIG-004`, `A2A-MIG-005`, `A2A-MIG-006`, `A2A-MIG-007`, `A2A-MIG-008` | `migration-0003.test.ts`, `migration-0002.test.ts`, `migrations.test.ts`, and `snapshot.test.ts` |
| `A2A-CON-001`, `A2A-CON-002`, `A2A-CON-003`, `A2A-CON-004`, `A2A-CON-005`, `A2A-CON-006`, `A2A-CON-007`, `A2A-CON-008` | `packages/contracts/src/repository.test.ts`; strict registration, hostile fields, unsafe derived name, accepted summary, false claims/raw evidence, reaffirm and retire/unbind shape |
| `A2-PROC-001` | independent design review at the pinned hash |
| `A2-PROC-002` | disposition plus this reconciliation appendix; closes only after operator approval |
| `A2-PROC-003` | deferred completion report with real committed implementation head |
| `A2-PROC-004` | supplement hash and protected diff checks in every implementation gate |
| `A2-SCOPE-001` | enhanced scope checker over production and test files, target diff, dependency inspection |

`A2A-REP-002` has three named subcases: orphan inspection fails outer COMMIT; repository
naming sibling inspection fails INSERT; nested orphan returns locally but fails outermost
COMMIT.

### 15.2 Review-added permanent cases

These IDs supplement proof without editing the protected file:

| ID | Proof |
|---|---|
| `A2A-STATUS-015` | `packages/domain/src/repository.test.ts`: all seven reaffirm assessments have exact reductions |
| `A2A-REP-015` | `repository-repositories.test.ts`: all identity/active-binding typed collision variants; foreign serialization contains no protected identifiers/paths |
| `A2A-REP-016` | `repository-transitions.test.ts`: two valid same-time transitions reach version 3; backwards time fails |
| `A2A-INSP-015` | `repository-transitions.test.ts` and `repository-schema.test.ts`: stale digest creates durable storage-integrity failure + evidence-blocked; cross-origin SQL tuples fail |
| `A2A-INSP-016` | `repository-repositories.test.ts`: three fixed-time appends return insertion order under ascending and descending IDs |
| `A2A-INSP-017` | domain/repository tests: dotted/17th/oversize evidence normalizes and records; direct bypass fails |
| `A2A-INSP-018` | `repository-schema.test.ts`: registration comparisons null; accepted plan names the deferred A2b audit attestation |
| `A2A-BASE-009` | `repository-transitions.test.ts`: only adopted fresh observation is written by API as reaffirmation; stray direct row projects `acceptedAsEnvironmentBaseline=false` |
| `A2A-BIND-013` | `repository-repositories.test.ts` and contracts test: binding survives mismatch and projection requires mismatch status/reason |
| `A2A-CON-009` | `packages/contracts/src/repository.test.ts`: reader identity exposes top level only; admin identity owns Git-directory paths |
| `A2A-CON-010` | `packages/contracts/src/repository.test.ts`: omission of any latest/latest-successful ID/time fails |
| `A2-SCOPE-003` | `scripts/check-forbidden-scope.test.mjs`: no repository test pins supported migration version to a literal |
| `A2-SCOPE-004` | `packages/storage/src/repository-schema.test.ts`: migration allowlist markers are set-equal to domain constants |

Every one of the 13 triggers has at least one positive and one direct-SQL negative behavior
test in addition to schema-name inventory.

## 16. ADR and documentation updates

Create ADR-017 recording:

```text
three evidence layers and exact noncanonical full-record checksum
A1-mirrored versus A2a-owned integrity failure axes
global inspection sequence and deterministic latest semantics
inspection-first graph with only reciprocal parent FK deferred
same-parent composite keys and historical membership attribution
non-retired identity reservation
pure reducer and evidence-bearing reaffirmation
baseline/adoption semantics and non-advancing reaffirm kind
typed non-disclosing collision results
error-evidence normalization
binding persistence across repository state changes
terminal retirement and exact optimistic versions
A2a/A2b authority split
historical membership rows restricted from delete
```

ADR-002 documents schema-3 sequence, immediate/deferred cycle placement, composite
membership, and transition triggers. Architecture documents the storage/domain seam and
uncomposed state. Security records:

- canonical top level is visible to authenticated readers;
- canonical Git and common Git directory paths are Owner-only diagnostics;
- common schemas reject those two fields;
- foreign collision variants carry no identity or path;
- stored error evidence and full observations are not public;
- archived-workspace structural references do not authorize A2b action.

Operations documents migration 3, deterministic sequence, reset/preservation behavior,
and that no repository operation is usable until A2b. README/CLAUDE describe A2a as the
active implementation slice only after plan approval; they do not claim registration is
composed.

## 17. Exact verification commands

Only commands actually run may be reported:

```text
pnpm install --frozen-lockfile

pnpm exec biome format --write \
  apps/server/src/restart.test.ts \
  scripts/check-forbidden-scope.mjs \
  scripts/check-forbidden-scope.test.mjs \
  packages/domain/src \
  packages/contracts/src \
  packages/storage/src

pnpm exec tsc -b packages/domain packages/contracts packages/storage

pnpm exec vitest run \
  packages/domain/src/repository.test.ts \
  packages/contracts/src/repository.test.ts \
  packages/storage/src/repository-schema.test.ts \
  packages/storage/src/repository-repositories.test.ts \
  packages/storage/src/repository-transitions.test.ts \
  packages/storage/src/migration-0003.test.ts \
  packages/storage/src/migration-0002.test.ts \
  packages/storage/src/migrations.test.ts \
  packages/storage/src/snapshot.test.ts \
  apps/server/src/restart.test.ts \
  scripts/check-forbidden-scope.test.mjs \
  scripts/check-ct04-protected-package.test.mjs

pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
pnpm check

node scripts/check-forbidden-scope.mjs
node scripts/check-ct04-protected-package.mjs

sha256sum \
  work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml \
  protected/CT-04-protected-acceptance-spec.yaml \
  packages/storage/migrations/0001-ct02-foundation.sql \
  packages/storage/migrations/0002-ct03-planning.sql

git diff --exit-code \
  599f3dedf406542cfda26bfecc25ffdc86e0c6d4 -- \
  protected/ \
  work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml

git diff --exit-code \
  599f3dedf406542cfda26bfecc25ffdc86e0c6d4 -- \
  packages/storage/migrations/0001-ct02-foundation.sql \
  packages/storage/migrations/0002-ct03-planning.sql

git diff --check
git diff --name-only \
  599f3dedf406542cfda26bfecc25ffdc86e0c6d4
git status --short
```

Focused tests use real SQLite files, multiple connections, fixed clocks, opposite ID
orders, forced rollbacks, direct SQL, `foreign_key_check`, and `integrity_check`.

## 18. A2b work intentionally deferred

A2a does not implement:

- repository feature configuration, roots, explicit Git executable/search path;
- A1 inspector creation/memoization or server-owned adapter;
- authentication/Owner/Editor/Viewer/current-workspace policy;
- the pre-A1 expected-version service ordering (it is a binding A2b handoff);
- two-inspection execution/quiescence orchestration;
- the `repository.register` audit attestation carrying both digests/comparison booleans;
- domain-to-A1 package-root parity test (A2a proves domain-to-SQL parity);
- runtime digest→parse→projection→compare orchestration;
- state/audit/event command transactions, denied/failed audit policy;
- schema 4, repository workspace-event kinds, journal rebuild/correlation;
- notifier/SSE/browser projection or activity text;
- routes, CSRF/origin/error mapping;
- startup reconciliation/background inspection;
- remote Git, credentials, Git mutation, automated repair, or scheduled inspection;
- rewriting CT-03 work-contract drafts or claiming repository/base resolution;
- base ref/commit, branch/worktree/diff/artifact, readiness, review, merge, delivery;
- `A2-PROC-005` A2b replanning/fan-out and `A2-SCOPE-002` A2b composition proof.

A2b must be replanned from the accepted, committed A2a implementation source.

## 19. Honest fan-out check

The reviewed revision predicts 35 implementation files, one migration, one persistence
model, and one assurance domain. The only server change is a migration regression test.
The model additions from review—integrity origin, global sequence, typed results, and
evidence-bearing reaffirmation—remain projections of the same repository/evidence/
binding model. Removing two unnecessary deferred FKs simplifies the hardest SQL seam.

This remains below the ~45-file replanning trigger and well below the protocol's 60-file
review threshold. No additional fan-out is warranted. The stop conditions in §5 remain
binding.

## 20. Review reconciliation appendix

| Finding | Operator disposition | Accepted-plan sections | Permanent proof |
|---|---|---|---|
| A2a-F-01 | accept A2a integrity axis | 6.2–6.3, 8.2, 10, 11.2 | A2A-INSP-013/015 |
| A2a-F-02 | accept global sequence | 6.3, 8.2, 11.5, 13–14 | A2A-INSP-016 |
| A2a-F-03 | accept typed insert results | 9.2, 11.5, 13–14 | A2A-REP-015 + concurrency |
| A2a-F-04 | accept evidence-bearing reaffirm | 6.4, 11.3 | A2A-STATUS-015 |
| A2a-F-05 | add server regression test/re-cost | 5, 14.1, 17, 19 | A2-SCOPE-003 + restart test |
| A2a-F-06 | schema-versioned audit comparison | 8.5, 14.1 | extended A2A-MIG-003 |
| A2a-F-07 | non-decreasing timestamps | 11.1, 14.2 | A2A-REP-016 |
| A2a-F-08 | relax risk SQL/pin vocabulary parity | 3, 6.2, 8.2/8.5, 15, 18 | A2-SCOPE-004 + A2b parity |
| A2a-F-09 | total evidence normalizer | 6.3, 10, 13–14 | A2A-INSP-017 |
| A2a-F-10 | immediate repository-side FKs | 8.1–8.2, 9.1, 11.5, 12 | A2A-REP-002/003/004 |
| A2a-F-11 | top level reader; Git paths Owner | 7.2–7.4, 16 | A2A-CON-009 |
| A2a-F-12 | retain bindings/project repository state | 7.3/7.5, 11.4, 13 | A2A-BIND-013 |
| A2a-F-13 | latest fields required | 7.3, 13 | A2A-CON-010 |
| A2a-F-14 | audit quiescence attestation | 11.3, 18 | A2A-INSP-018 + A2b audit |
| A2a-F-15 | non-advancing kind verification | 7.3, 11.2–11.3, 13 | A2A-BASE-009 |
| A2a-F-16 | scan tests for Git import | 4, 5, 15 | scope checker fixture |
| A2a-F-17 | preserve existing sequence rows | 14.1 | A2A-MIG-002 |
| A2a-F-18 | pre-A1 expected-version check | 7.1, 11.5, 18 | deferred A2b zero-call/race |

Informational review items map to §§3, 12, 14.1, and 16: complete A1 exports,
archived-workspace structural policy, named snapshot proof, and membership-delete
restriction.

No review finding disappeared, no protected case was weakened, and no A2b behavior was
pulled into A2a.

## 21. Accepted-plan handoff

The operator should verify the three planning artifacts and commit them together with the
independent review:

```text
work-items/CT-04/CT-04A2a-proposed-implementation-plan.md
review-findings/CT-04/CT-04A2a-design-review.md
work-items/CT-04/CT-04A2a-review-disposition.md
work-items/CT-04/CT-04A2a-accepted-implementation-plan.md
```

Stop here. Do not implement source until the operator approves and commits this accepted
plan and gives explicit permission.
