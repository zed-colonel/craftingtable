# CT-04A2a proposed implementation plan

**Status:** Phase A source-specific proposal; not accepted and not implementation authority
**Slice:** CT-04A2a — Repository domain, evidence model, and persistence
**Parent:** CT-04A2 — Repository registry and project binding
**Planning checkout:** `599f3dedf406542cfda26bfecc25ffdc86e0c6d4`
**Accepted A1 runtime head:** `7313e81a56c0188574c436322d7fedc16e08bb70`

## 1. Authorization boundary and stop condition

This document is the only Phase A output. It proposes source changes but authorizes none.

The required next sequence is:

```text
independent design review of this proposal
    → operator disposition of every material finding
    → design-review disposition using the repository template
    → CT-04A2a accepted implementation plan with reconciliation appendix
    → operator approval and commit of that accepted plan
    → implementation only after a separate explicit permission
```

No accepted plan, source implementation, migration, completion report, or implementation
commit is created in this phase. The protected A2 supplement is read-only. A2b remains
unplanned and unimplemented.

## 2. Checkout, planning-package, source, and protected pins

### 2.1 Exact local checkout

The local branch is `ct-04a2a-repository-model` at:

```text
599f3dedf406542cfda26bfecc25ffdc86e0c6d4
pre-ct04a2a chore: stage design package
```

The newly committed A2 planning-package commit is therefore:

```text
599f3dedf406542cfda26bfecc25ffdc86e0c6d4
```

This is deliberately recorded separately from the accepted A1 runtime head:

```text
7313e81a56c0188574c436322d7fedc16e08bb70
ct-04a1: remediation generation 2 - bounded creation and structural ceiling boundary
```

`7313e81…` is an ancestor of `599f3de…`. A diff from the A1 head through the
planning checkout is empty for `apps/`, all production packages, scripts, root manifests,
runtime documentation, and the A1 Git source. The intervening commits add or finalize
review, report, template, and A2 planning artifacts; they do not alter the accepted A1
runtime.

The worktree was clean before this proposal was created.

`git ls-tree` at `599f3de…` confirms the A2 parent/child contracts, source assessment,
implementation guidance, A1 handoff, source map, adversarial matrices, acceptance matrix,
and protected supplement are all tracked in the checkout. This is the newly committed A2
planning package; it is not being confused with the older accepted runtime commit.

### 2.2 Exact source and protected facts

| Fact | Exact pin or digest | Local result |
|---|---|---|
| A1 runtime source | `7313e81a56c0188574c436322d7fedc16e08bb70` | commit exists; ancestor; runtime diff clean |
| A2 source bundle | `ee0090898b7cedb1ecd0438f607b1e8ed60f0ec28a99f58b688400f025a2aeea` | accepted handoff/source-package pin |
| `work-items/CT-04/CT-04A1-accepted-implementation-plan.md` | `da26d6c8870ea52c1aea031f6537d0eb4ba219aec0405db4e4bb3d8b429186cf` | local SHA-256 matches |
| `review-findings/CT-04/CT-04A1-remediation-2-review.md` (A1 final review) | `f27ac10ba6f075e8392abdec471c2413c271cf88329398cf8e9d125ed05cfca7` | local SHA-256 matches |
| Original protected-package commit | `06abcffe1fdcd32c72b2e4d2a3dcb849ac1d58d4` | commit exists |
| `protected/CT-04-protected-acceptance-spec.yaml` | `ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64` | local SHA-256 matches |
| `work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml` | `1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c` | local SHA-256 matches |
| Schema-1 migration | `42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273` | local SHA-256 recorded for preservation |
| Schema-2 migration | `6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247` | local SHA-256 recorded for preservation |

The source-bundle ZIP itself is not present in or immediately above this checkout, so this
session did not pretend to recompute `ee009089…` from an absent archive. The accepted
handoff, source map, source assessment, adversarial matrix, and local runtime ancestry all
carry that same bundle digest. The source actually used by this proposal is the local A1
tree proven unchanged from `7313e81…`.

## 3. Actual A1 API reconciliation

A2a does not import A1. The following reconciliation exists to make the durable model fit
the real accepted API that A2b will later adapt through the package root.

The package root currently exports:

```ts
createRepositoryInspector(options)
parseRecordedObservation(value)
compareRepositoryObservations(recorded, current)
```

and these relevant public types/constants:

```text
RepositoryInspector
RepositoryInspectorOptions
RepositoryInspectionResult
RepositoryInspectionError
ParsedRepositoryObservation
RecordedObservationResult
RepositoryObservationComparisonResult
ALL_REPOSITORY_INSPECTION_ERROR_CODES
REPOSITORY_INSPECTION_ERROR_SUBJECTS
REPOSITORY_OBSERVATION_VERSION
REPOSITORY_INSPECTION_POLICY_VERSION
REPOSITORY_RISK_SCAN_SCOPE_VERSION
REPOSITORY_RISK_SCAN_PATTERN
REPOSITORY_RISK_SIGNALS
```

The actual options, including remediation-2, are exactly:

```ts
interface RepositoryInspectorOptions {
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

Creation returns `{ok:true, inspector}` or `{ok:false, error}`; inspection takes
`{requestedPath, signal?}` and returns `{ok:true, observation}` or `{ok:false, error}`.
A2b must pass explicit executable policy and must not rely on ambient daemon `PATH`.

The actual observation has:

```text
observationVersion
inspectionPolicyVersion
observedAt
gitVersion { major, minor, patch }
canonicalTopLevel
canonicalGitDirectory
canonicalCommonGitDirectory
objectFormat
coreIdentity {
  topLevelInode
  commonDirectoryInode
  fingerprintSha256
}
environmentalEvidence {
  topLevelDevice
  commonDirectoryDevice
}
riskScan {
  scanScopeVersion
  scannedKeyPattern
  classification
  signals[]
}
```

The comparison result names exactly:

```text
coreDifferences:
  canonical-top-level
  canonical-git-directory
  canonical-common-git-directory
  object-format
  top-level-inode
  common-directory-inode
  fingerprint

environmentalDifferences:
  top-level-device
  common-directory-device

riskScanDifferences:
  scan-scope-version
  scanned-key-pattern
  signals
```

The successful comparison also carries
`sameCoreIdentity`, `sameEnvironmentalEvidence`, and `sameRiskScanEvidence`;
the difference arrays and booleans must agree. Failure uses the same closed A1 error
record as creation/inspection.

The real length-prefixed fingerprint input is exactly observation version, inspection
policy version, canonical top level, canonical common Git directory, object format,
top-level inode, and common-directory inode. It does **not** include
`canonicalGitDirectory`, devices, `riskScan`, or `observedAt`. A successful A1 stored
parse validates their shape but is not full-record authentication. A2a therefore stores
and checks a digest over the exact serialized full-record UTF-8 bytes without calling that
representation canonical.

The complete A1 error code, subject, category, operation, and retryability vocabularies
are mirrored as durable A2a vocabulary without importing `@craftingtable/git`. A2b must
provide an exhaustive adapter test against the then-current package-root unions.
`reserved-root-overlap` remains in the durable closed vocabulary for forward-compatible
record reading, but coherent current A1 configuration makes it unreachable during normal
inspection. `observation-raced` is a no-state-change failure; it is not identity loss.

## 4. Dependency and authority boundary

### 4.1 Package dependency diagram

```text
                         A2a production

                 @craftingtable/domain
                 pure records + reducer
                    ▲             ▲
                    │             │
       @craftingtable/contracts   @craftingtable/storage
       strict Zod wire shapes     SQLite + SHA-256 byte helper
                    ▲             ▲
                    └──────┬──────┘
                           │
                    server in A2b only
                           │
                           └────────────→ @craftingtable/git in A2b only

       browser in A2b only → domain + contracts
```

The A2a graph has no edge to Git, process control, Fastify, server composition, routes,
workspace-event production, notifier code, React, or browser projection.

### 4.2 Explicit prohibited-import confirmation

A2a will not import, deep-import, or otherwise depend on:

```text
@craftingtable/git
node:child_process
child_process
Fastify or @fastify/*
@craftingtable/server
server composition or routes
workspace event records, event kinds, or event repository changes
workspace-event notifier code
React, @craftingtable/web, or browser code
```

Migration 0003 will not mention, rebuild, rename, copy, or add kinds to
`workspace_events`; it adds audit catalog rows only. The production scope checker gains
an A2a-specific assertion over the new repository modules and migration.

## 5. Exact target tree and predicted scope

`+` means new and `~` means modified.

```text
~ README.md
~ CLAUDE.md

~ scripts/check-forbidden-scope.mjs
~ scripts/check-forbidden-scope.test.mjs

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
33 changed/new files
approximately 6,000–9,000 lines including SQL, tests, and documentation
approximately 2,000–3,000 production/documentation lines
one migration
three production packages already present in the workspace
zero new dependency or manifest entries
zero Git, process, HTTP, journal-event, notifier, or browser authority
```

The upper range is driven by direct-SQL invariant tests, not by extra production
abstraction. If implementation crosses roughly 45 files, needs a second migration, or
needs server/browser/Git composition, implementation stops and returns to planning.

## 6. Domain model

### 6.1 Identifiers

`packages/domain/src/ids.ts` adds:

```ts
type RepositoryId = Brand<'RepositoryId'>;
type RepositoryInspectionId = Brand<'RepositoryInspectionId'>;
type ProjectRepositoryBindingId = Brand<'ProjectRepositoryBindingId'>;

asRepositoryId(value)
asRepositoryInspectionId(value)
asProjectRepositoryBindingId(value)
```

The shared non-empty/no-surrounding-whitespace ID rule remains unchanged.

### 6.2 Closed vocabularies

```ts
type RepositoryStatus =
  | 'active'
  | 'unavailable'
  | 'identity-evidence-changed'
  | 'identity-mismatch'
  | 'evidence-blocked'
  | 'retired';

type RepositoryStatusReason =
  | 'registration-accepted'
  | 'evidence-matches'
  | 'environment-evidence-changed'
  | 'core-identity-changed'
  | 'repository-class-changed'
  | 'path-unavailable'
  | 'metadata-unreadable'
  | 'stored-evidence-digest-mismatch'
  | 'stored-evidence-invalid'
  | 'unsupported-observation-version'
  | 'inspection-policy-version-mismatch'
  | 'environment-evidence-reaffirmed'
  | 'operator-retired';

type RepositoryInspectionKind =
  | 'registration'
  | 'verification'
  | 'reaffirmation';

type RepositoryInspectionOutcome = 'succeeded' | 'failed';
type ProjectRepositoryBindingStatus = 'active' | 'retired';
```

Allowed status/reason pairs are exact:

| Status | Allowed reason |
|---|---|
| `active` | `registration-accepted`, `evidence-matches`, `environment-evidence-reaffirmed` |
| `unavailable` | `path-unavailable`, `metadata-unreadable` |
| `identity-evidence-changed` | `environment-evidence-changed` |
| `identity-mismatch` | `core-identity-changed`, `repository-class-changed` |
| `evidence-blocked` | `stored-evidence-digest-mismatch`, `stored-evidence-invalid`, `unsupported-observation-version`, `inspection-policy-version-mismatch` |
| `retired` | `operator-retired` |

The domain also defines the exact A1-aligned durable enums for error code, subject,
category, operation, retryability, core/environment/risk difference names, risk
classification, and the fourteen current risk-signal names. They are data vocabulary,
not an A1 dependency or an alternate parser.

The complete mirrored error table is:

| Error subject | Category / retryability | Exact codes |
|---|---|---|
| `caller-input` | `path-policy` / `not-retryable` | `invalid-path` |
| `policy-configuration` | `configuration` / `configuration-required` | `invalid-options`, `invalid-root-policy`, `outside-allowed-root`, `reserved-root-overlap` |
| `host-environment` | `configuration` / `retryable` | `unsupported-platform`, `root-daemon-refused`, `git-not-found`, `git-not-executable`, `git-executable-changed`, `unsupported-git-version`, `aborted` |
| `repository-unavailable` | `path-policy` / `retryable` | `path-unavailable`, `repository-metadata-unreadable`, `observation-raced` |
| `repository-class-changed` | `path-policy` / `not-retryable` | `symlink-rejected`, `ownership-refused`, `not-primary-repository`, `not-git-repository`, `unsupported-object-format`, `unsupported-repository-extension` |
| `git-boundary-fault` | `git-process` / `retryable` | `spawn-failed`, `timed-out`, `stdout-overflow`, `stderr-overflow`, `signal-terminated`, `git-command-failed`, `invalid-output-encoding`, `malformed-version-output`, `malformed-identity-output`, `malformed-feature-output`, `feature-count-exceeded` |
| `recorded-evidence-invalid` | `observation` / `not-retryable` | `recorded-observation-invalid`, `unsupported-observation-version` |
| `evidence-not-comparable` | `observation` / `not-retryable` | `inspection-policy-version-mismatch` |

Operations are exactly `create-inspector`, `inspect-path`,
`parse-recorded-observation`, and `compare-observations`. The current A1 type permits any
operation member with an error; A2a therefore validates operation membership but does not
invent a narrower code/operation matrix.

Risk signals are exactly:

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

Core, environmental, and risk difference enums are the 7/2/3 exact names reconciled in
section 3. The implementation copies these literal vocabularies into domain and adds an
A2b-deferred parity test; it never imports them from Git.

### 6.3 Complete records

```ts
interface RegisteredRepository {
  readonly id: RepositoryId;
  readonly workspaceId: WorkspaceId;
  readonly displayName: string;

  readonly canonicalTopLevel: string;
  readonly canonicalGitDirectory: string;
  readonly canonicalCommonGitDirectory: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly topLevelInode: string;
  readonly commonDirectoryInode: string;
  readonly coreFingerprintSha256: string;
  readonly observationVersion: number;
  readonly inspectionPolicyVersion: number;

  readonly registrationInspectionId: RepositoryInspectionId;
  readonly acceptedEnvironmentInspectionId: RepositoryInspectionId;
  readonly status: RepositoryStatus;
  readonly statusReason: RepositoryStatusReason;

  readonly registeredByUserId: UserId;
  readonly registeredAt: string;
  readonly statusChangedByUserId: UserId;
  readonly statusChangedAt: string;
  readonly version: number;
}

interface SuccessfulRepositoryInspection {
  readonly id: RepositoryInspectionId;
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: RepositoryId;
  readonly actorUserId: UserId;
  readonly kind: RepositoryInspectionKind;
  readonly outcome: 'succeeded';
  readonly createdAt: string;

  readonly observationJson: string;
  readonly observationSha256: string;
  readonly observationVersion: number;
  readonly inspectionPolicyVersion: number;
  readonly observedAt: string;

  readonly canonicalTopLevel: string;
  readonly canonicalGitDirectory: string;
  readonly canonicalCommonGitDirectory: string;
  readonly objectFormat: 'sha1' | 'sha256';
  readonly topLevelInode: string;
  readonly commonDirectoryInode: string;
  readonly coreFingerprintSha256: string;
  readonly topLevelDevice: string;
  readonly commonDirectoryDevice: string;

  readonly riskScanScopeVersion: number;
  readonly riskScannedKeyPattern: string;
  readonly riskClassification:
    | 'no-signals-in-scanned-set'
    | 'signals-observed';
  readonly riskSignals: readonly StoredRepositoryRiskSignal[];

  // Omitted for registration, present for verification/reaffirmation.
  readonly coreDifferences?: readonly StoredCoreEvidenceDifference[];
  readonly environmentalDifferences?: readonly StoredEnvironmentalEvidenceDifference[];
  readonly riskDifferences?: readonly StoredRiskEvidenceDifference[];
}

interface FailedRepositoryInspection {
  readonly id: RepositoryInspectionId;
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: RepositoryId;
  readonly actorUserId: UserId;
  readonly kind: 'verification' | 'reaffirmation';
  readonly outcome: 'failed';
  readonly createdAt: string;
  readonly errorCode: StoredRepositoryInspectionErrorCode;
  readonly errorSubject: StoredRepositoryInspectionErrorSubject;
  readonly errorCategory: StoredRepositoryInspectionErrorCategory;
  readonly errorOperation: StoredRepositoryInspectionOperation;
  readonly errorRetryability: StoredRepositoryInspectionRetryability;
  readonly errorEvidence: Readonly<Record<string, string | number | boolean>>;
}

type RepositoryInspection =
  | SuccessfulRepositoryInspection
  | FailedRepositoryInspection;

interface ProjectRepositoryBinding {
  readonly id: ProjectRepositoryBindingId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId;
  readonly repositoryId: RepositoryId;
  readonly status: ProjectRepositoryBindingStatus;
  readonly boundByUserId: UserId;
  readonly boundAt: string;
  readonly retiredByUserId?: UserId;
  readonly retiredAt?: string;
  readonly version: number;
}
```

Optional record properties are omitted by row mappers rather than returned as explicit
`undefined`, preserving the repository's exact-optional convention.

### 6.4 Pure reducer

The reducer accepts domain assessments, not A1 codes:

```ts
type RepositoryObservationAssessment =
  | { readonly kind: 'same' }
  | {
      readonly kind: 'risk-evidence-changed';
      readonly differences: readonly StoredRiskEvidenceDifference[];
    }
  | {
      readonly kind: 'environment-evidence-changed';
      readonly differences: readonly StoredEnvironmentalEvidenceDifference[];
    }
  | {
      readonly kind: 'core-identity-changed';
      readonly differences: readonly StoredCoreEvidenceDifference[];
    }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'path-unavailable' | 'metadata-unreadable';
    }
  | {
      readonly kind: 'evidence-invalid';
      readonly reason:
        | 'stored-evidence-digest-mismatch'
        | 'stored-evidence-invalid'
        | 'unsupported-observation-version'
        | 'inspection-policy-version-mismatch';
    }
  | { readonly kind: 'no-state-change-failure' };

type RepositoryStateCommand =
  | {
      readonly kind: 'apply-assessment';
      readonly assessment: RepositoryObservationAssessment;
    }
  | { readonly kind: 'reaffirm-environment' }
  | { readonly kind: 'retire' };

type RepositoryReduction =
  | {
      readonly kind: 'unchanged';
      readonly status: RepositoryStatus;
      readonly evidenceDisposition:
        | 'verified'
        | 'risk-evidence-changed'
        | 'environment-evidence-still-changed'
        | 'failure-recorded'
        | 'already-retired';
    }
  | {
      readonly kind: 'transition';
      readonly fromStatus: RepositoryStatus;
      readonly toStatus: RepositoryStatus;
      readonly reason: RepositoryStatusReason;
      readonly evidenceDisposition: 'none' | 'risk-evidence-changed';
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'terminal-status'
        | 'retired'
        | 'reaffirmation-not-required'
        | 'unsupported-transition';
    };
```

Complete reducer policy:

| Current state | Assessment/command | Reduction |
|---|---|---|
| `active` | same | unchanged active / verified |
| `active` | risk only | unchanged active / risk evidence changed |
| `active` | environment differs | `identity-evidence-changed` |
| `active` | core differs | `identity-mismatch` |
| `active` | unavailable | `unavailable` |
| `active` | evidence invalid | `evidence-blocked` |
| `active` | no-state-change failure | unchanged |
| `unavailable` | same | active / `evidence-matches` |
| `unavailable` | risk only | active / `evidence-matches`, risk evidence changed |
| `unavailable` | environment differs | `identity-evidence-changed` |
| `unavailable` | core differs | `identity-mismatch` |
| `unavailable` | unavailable or no-state-change failure | unchanged |
| `unavailable` | evidence invalid | `evidence-blocked` |
| `identity-evidence-changed` | same | active / `evidence-matches` |
| `identity-evidence-changed` | risk only | active / `evidence-matches`, risk evidence changed |
| `identity-evidence-changed` | environment differs | unchanged |
| `identity-evidence-changed` | unavailable | `unavailable` |
| `identity-evidence-changed` | core differs | `identity-mismatch` |
| `identity-evidence-changed` | evidence invalid | `evidence-blocked` |
| `identity-evidence-changed` | no-state-change failure | unchanged / failure recorded |
| `identity-evidence-changed` | reaffirm | active / `environment-evidence-reaffirmed` |
| `active` or `unavailable` | reaffirm | rejected / reaffirmation not required |
| `identity-mismatch` or `evidence-blocked` | any assessment or reaffirm | rejected terminal |
| any non-retired | retire | `retired` / `operator-retired` |
| `retired` | retire | unchanged / already retired |
| `retired` | any assessment or reaffirm | rejected retired |

The reducer has no SQL, Git, filesystem, HTTP, role, or event knowledge.

## 7. Strict contract surface

### 7.1 Common validation

`packages/contracts/src/ids.ts` adds schemas for all three IDs. Every object below uses
`z.strictObject`; nested objects are strict too.

Exact common limits:

```text
requested path       1..4096 UTF-8 bytes, starts "/", no NUL
display name         trimmed 1..120 characters, no C0/DEL control
operator reason      trimmed 1..500 characters, no C0/DEL control
observation digest   exactly 64 lowercase hexadecimal characters
versions             positive safe integers
response arrays      bounded as stated below
```

Contract validation does not claim that a path is canonical or admitted. A1 remains the
only path-admission authority in A2b.

### 7.2 Requests

```ts
registerRepositoryRequestSchema = strict {
  requestedPath: requestedPathSchema;
  displayName?: repositoryDisplayNameSchema;
}

inspectRepositoryRequestSchema = strict {
  expectedVersion: positiveSafeInteger;
}

reaffirmRepositoryEnvironmentRequestSchema = strict {
  expectedVersion: positiveSafeInteger;
  expectedLatestSuccessfulInspectionId: repositoryInspectionIdSchema;
  reason: boundedReasonSchema;
}

retireRepositoryRequestSchema = strict {
  expectedVersion: positiveSafeInteger;
  reason: boundedReasonSchema;
}

bindProjectRepositoryRequestSchema = strict {
  repositoryId: repositoryIdSchema;
  expectedRepositoryVersion: positiveSafeInteger;
}

retireProjectRepositoryBindingRequestSchema = strict {
  expectedVersion: positiveSafeInteger;
  reason: boundedReasonSchema;
}
```

No request admits `command`, `argv`, `environment`, `cwd`, `worktree`, `branch`, `ref`,
`remote`, executable selection, Git options, or raw A1 objects. Strict parsing rejects all
such unknown fields.

### 7.3 Responses and stored-document boundary

```ts
repositoryIdentitySummarySchema = strict {
  canonicalTopLevel: boundedPath;
  canonicalGitDirectory: boundedPath;
  canonicalCommonGitDirectory: boundedPath;
  objectFormat: 'sha1' | 'sha256';
  coreFingerprintSha256: lowerHexDigest;
}

repositoryEvidenceSummarySchema = strict {
  registrationInspectionId: repositoryInspectionIdSchema;
  acceptedEnvironmentInspectionId: repositoryInspectionIdSchema;
  latestInspectionId?: repositoryInspectionIdSchema;
  latestInspectionAt?: ISODateTime;
  latestSuccessfulInspectionId?: repositoryInspectionIdSchema;
  latestSuccessfulInspectionAt?: ISODateTime;
  risk: strict {
    classification:
      'no-signals-in-scanned-set' | 'signals-observed';
    signals: sortedUniqueRiskSignals(max 14);
    observedAt: ISODateTime;
  };
}

registeredRepositorySummarySchema = strict {
  id: repositoryIdSchema;
  displayName: repositoryDisplayNameSchema;
  status: RepositoryStatus enum;
  statusReason: RepositoryStatusReason enum;
  version: positiveSafeInteger;
  registeredAt: ISODateTime;
  statusChangedAt: ISODateTime;
  identity: repositoryIdentitySummarySchema;
  evidence: repositoryEvidenceSummarySchema;
}

repositoryInspectionSummarySchema =
  discriminated union on outcome:
    succeeded strict {
      id: repositoryInspectionIdSchema;
      kind: 'registration' | 'verification' | 'reaffirmation';
      outcome: 'succeeded';
      createdAt: ISODateTime;
      observedAt: ISODateTime;
      observationSha256: lowerHexDigest;
      observationVersion: positiveSafeInteger;
      inspectionPolicyVersion: positiveSafeInteger;
      coreDifferences?: sortedUniqueCoreDifferences(max 7);
      environmentalDifferences?: sortedUniqueEnvironmentalDifferences(max 2);
      riskDifferences?: sortedUniqueRiskDifferences(max 3);
      risk: strict {
        classification:
          'no-signals-in-scanned-set' | 'signals-observed';
        signals: sortedUniqueRiskSignals(max 14);
      };
    }
    failed strict {
      id: repositoryInspectionIdSchema;
      kind: 'verification' | 'reaffirmation';
      outcome: 'failed';
      createdAt: ISODateTime;
      error: strict {
        code: storedErrorCodeEnum;
        subject: storedErrorSubjectEnum;
        category: storedErrorCategoryEnum;
        operation: storedErrorOperationEnum;
        retryability: storedErrorRetryabilityEnum;
      };
    }

projectRepositoryBindingSummarySchema = strict {
  id: projectRepositoryBindingIdSchema;
  projectId: projectIdSchema;
  repositoryId: repositoryIdSchema;
  status: 'active' | 'retired';
  boundAt: ISODateTime;
  retiredAt?: ISODateTime;
  version: positiveSafeInteger;
}
```

Registration-success comparison fields must be omitted; successful
verification/reaffirmation comparison fields must all be present, including empty arrays.
Latest inspection ID/time and latest-success ID/time are each all-present or all-absent.
The Zod schemas use discriminated unions plus `superRefine` for these couplings.

The exact strict response envelopes are:

```ts
repositoryListResponseSchema = strict {
  repositories: array(registeredRepositorySummarySchema).max(100);
}

repositoryDetailResponseSchema = strict {
  repository: registeredRepositorySummarySchema;
  activeBindings: array(projectRepositoryBindingSummarySchema).max(100);
}

repositoryInspectionListResponseSchema = strict {
  inspections: array(repositoryInspectionSummarySchema).max(100);
}

registerRepositoryResponseSchema = strict {
  repository: registeredRepositorySummarySchema;
  created: boolean;
}

inspectRepositoryResponseSchema = strict {
  repository: registeredRepositorySummarySchema;
  inspection: repositoryInspectionSummarySchema;
  changed: boolean;
}

reaffirmRepositoryEnvironmentResponseSchema = strict {
  repository: registeredRepositorySummarySchema;
  inspection: successful reaffirmation inspection summary;
  changed: boolean;
}

retireRepositoryResponseSchema = strict {
  repository: registeredRepositorySummarySchema;
  retiredBindingIds: array(projectRepositoryBindingIdSchema).max(100);
  changed: boolean;
}

bindProjectRepositoryResponseSchema = strict {
  binding: projectRepositoryBindingSummarySchema;
  created: boolean;
}

retireProjectRepositoryBindingResponseSchema = strict {
  binding: projectRepositoryBindingSummarySchema;
  changed: boolean;
}
```

The `created` booleans reserve A2b's defined idempotent-registration/binding result;
`changed` is true only for a durable transition. They do not invent readiness.

The exact observation JSON is a storage-integrity object, not a general public response.
Storage write inputs are a discriminated success/failure union matching the domain record.
Storage read types retain `observationJson`, `observationSha256`, and bounded stored error
evidence byte-for-byte for the later trusted A2b adapter. Public inspection summaries do
not expose stored error evidence at all; they expose only its closed classification.
They never expose raw stdout, stderr, inherited environment, config values, arbitrary
system messages, or the full stored observation.

### 7.4 Unresolved and executable terminology

A2a does not edit `packages/domain/src/work-contract.ts`,
`packages/contracts/src/planning.ts`, or an existing draft document. These exact CT-03
literals remain true:

```text
repository.status = unresolved
baseRevision.status = unresolved
status = draft
completeness = incomplete
```

A project binding is a separate repository fact. It does not silently rewrite a historical
draft or make its repository/base fields resolved. `active` means only that the registered
repository's current core and accepted environmental evidence agree; it never means ready,
approved, executable, verified, reviewed, or mergeable. Those fields are absent from the
strict repository schemas, and tests prove that adding any of them is rejected.

## 8. Schema 3: exact relational model

Migration `0003-ct04a2a-repository-model.sql` creates exactly three domain tables and adds
six rows to the existing audit-action catalog. It creates no workspace-event kind and
does not rebuild a journal.

### 8.1 `registered_repositories`

| Column | SQL type/nullability | Rule |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | non-empty |
| `workspace_id` | `TEXT NOT NULL` | FK to workspace |
| `display_name` | `TEXT NOT NULL` | trimmed 1..120; no C0/DEL |
| `canonical_top_level` | `TEXT NOT NULL` | 1..4096 UTF-8 bytes; absolute-shape check |
| `canonical_git_directory` | `TEXT NOT NULL` | same bound |
| `canonical_common_git_directory` | `TEXT NOT NULL` | same bound |
| `object_format` | `TEXT NOT NULL` | `sha1` or `sha256` |
| `top_level_inode` | `TEXT NOT NULL` | canonical unsigned decimal |
| `common_directory_inode` | `TEXT NOT NULL` | canonical unsigned decimal |
| `core_fingerprint_sha256` | `TEXT NOT NULL` | 64 lowercase hex |
| `observation_version` | `INTEGER NOT NULL` | accepted observation version exactly 1 |
| `inspection_policy_version` | `INTEGER NOT NULL` | positive safe bound |
| `registration_inspection_id` | `TEXT NOT NULL` | same-repository inspection link |
| `accepted_environment_inspection_id` | `TEXT NOT NULL` | same-repository successful baseline link |
| `status` | `TEXT NOT NULL` | repository status enum |
| `status_reason` | `TEXT NOT NULL` | exact status/reason coupling |
| `registered_by_user_id` | `TEXT NOT NULL` | user and workspace-membership FKs |
| `registered_at` | `TEXT NOT NULL` | immutable |
| `status_changed_by_user_id` | `TEXT NOT NULL` | user and workspace-membership FKs |
| `status_changed_at` | `TEXT NOT NULL` | changes only with status/baseline transition |
| `version` | `INTEGER NOT NULL` | starts 1, exact `+1` transitions |

Candidate keys:

```text
PRIMARY KEY (id)
UNIQUE (workspace_id, id)
```

Deferred links:

```text
FOREIGN KEY (workspace_id, id, registration_inspection_id)
  REFERENCES repository_inspections(workspace_id, repository_id, id)
  DEFERRABLE INITIALLY DEFERRED

FOREIGN KEY (workspace_id, id, accepted_environment_inspection_id)
  REFERENCES repository_inspections(workspace_id, repository_id, id)
  DEFERRABLE INITIALLY DEFERRED
```

Global non-retired identity reservations:

```text
UNIQUE INDEX uq_registered_repositories_live_top
  ON registered_repositories(canonical_top_level)
  WHERE status <> 'retired'

UNIQUE INDEX uq_registered_repositories_live_common_git
  ON registered_repositories(canonical_common_git_directory)
  WHERE status <> 'retired'

UNIQUE INDEX uq_registered_repositories_live_fingerprint
  ON registered_repositories(core_fingerprint_sha256)
  WHERE status <> 'retired'
```

“Live” deliberately means every non-retired state, not only `active`; unavailable,
evidence-changed, mismatch, and evidence-blocked rows keep their identity reservation.

Query index:

```text
idx_registered_repositories_workspace_status
  (workspace_id, status, registered_at, id)
```

### 8.2 `repository_inspections`

The exact 34 columns are:

| Column | SQL type/nullability | Rule |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | non-empty |
| `workspace_id` | `TEXT NOT NULL` | workspace FK |
| `repository_id` | `TEXT NOT NULL` | deferred same-workspace repository FK |
| `actor_user_id` | `TEXT NOT NULL` | user and workspace-membership FKs |
| `kind` | `TEXT NOT NULL` | registration, verification, or reaffirmation |
| `outcome` | `TEXT NOT NULL` | succeeded or failed |
| `created_at` | `TEXT NOT NULL` | immutable |
| `observation_json` | `TEXT` | success-only exact full-record string |
| `observation_sha256` | `TEXT` | success-only lowercase SHA-256 |
| `observation_version` | `INTEGER` | success-only accepted observation version exactly 1 |
| `inspection_policy_version` | `INTEGER` | success-only positive safe integer |
| `observed_at` | `TEXT` | success-only observation timestamp |
| `canonical_top_level` | `TEXT` | success-only bounded absolute-shape projection |
| `canonical_git_directory` | `TEXT` | success-only bounded absolute-shape projection |
| `canonical_common_git_directory` | `TEXT` | success-only bounded absolute-shape projection |
| `object_format` | `TEXT` | success-only sha1 or sha256 |
| `top_level_inode` | `TEXT` | success-only canonical unsigned decimal |
| `common_directory_inode` | `TEXT` | success-only canonical unsigned decimal |
| `core_fingerprint_sha256` | `TEXT` | success-only lowercase SHA-256 |
| `top_level_device` | `TEXT` | success-only canonical unsigned decimal |
| `common_directory_device` | `TEXT` | success-only canonical unsigned decimal |
| `risk_scan_scope_version` | `INTEGER` | success-only accepted risk-scan scope exactly 1 |
| `risk_scanned_key_pattern` | `TEXT` | success-only exact accepted A1 scan pattern |
| `risk_classification` | `TEXT` | success-only risk enum |
| `risk_signals_json` | `TEXT` | success-only sorted unique allowlisted JSON array |
| `core_differences_json` | `TEXT` | comparison-only sorted unique allowlisted JSON array |
| `environmental_differences_json` | `TEXT` | comparison-only sorted unique allowlisted JSON array |
| `risk_differences_json` | `TEXT` | comparison-only sorted unique allowlisted JSON array |
| `error_code` | `TEXT` | failure-only accepted A1 code |
| `error_subject` | `TEXT` | failure-only accepted A1 subject |
| `error_category` | `TEXT` | failure-only accepted A1 category |
| `error_operation` | `TEXT` | failure-only accepted A1 operation |
| `error_retryability` | `TEXT` | failure-only accepted A1 retryability |
| `error_evidence_json` | `TEXT` | failure-only bounded scalar-object JSON |

Every success/failure-specific column is nullable at the declaration and governed as one
complete discriminated record by checks and triggers.

Candidate keys:

```text
PRIMARY KEY (id)
UNIQUE (workspace_id, id)
UNIQUE (workspace_id, repository_id, id)
```

The parent link is:

```text
FOREIGN KEY (workspace_id, repository_id)
  REFERENCES registered_repositories(workspace_id, id)
  ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED
```

Actor attribution has both `users(id)` and
`workspace_memberships(workspace_id, user_id)` foreign keys. This proves historical
workspace membership, not currently active membership or role; A2b owns that authorization.

Success rules:

```text
all 18 observation/projection fields are non-null
all six failure fields are null
registration has all three comparison fields null
verification/reaffirmation have all three comparison arrays non-null
observation_json is valid JSON text, 1..131072 UTF-8 bytes
observation_sha256 and core fingerprint are 64 lowercase hex
unsigned decimal fields use 0 or a non-zero-leading digit sequence
risk classification is empty-signals iff no-signals-in-scanned-set
risk/difference arrays are JSON arrays, bounded, allowlisted, sorted, unique
```

Failure rules:

```text
all observation, projection, risk, and comparison fields are null
all six failure fields are non-null
kind is verification or reaffirmation; a failed registration is not a durable
  repository attempt because no registered parent exists
error_evidence_json is an object of at most 16 scalar values,
  at most 8192 UTF-8 bytes, with keys 1..64 characters matching
  [A-Za-z][A-Za-z0-9]* and no array/object/null values
code → subject → category/retryability agrees with the complete accepted A1 table
operation is one of create-inspector, inspect-path,
  parse-recorded-observation, compare-observations
```

Bounds:

```text
risk signals                 ≤ 14
core differences             ≤ 7
environmental differences    ≤ 2
risk differences             ≤ 3
risk scanned-key pattern     1..2048 UTF-8 bytes
```

Indexes:

```text
UNIQUE INDEX uq_repository_registration_inspection
  ON repository_inspections(repository_id)
  WHERE kind = 'registration' AND outcome = 'succeeded'

idx_repository_inspections_history
  (workspace_id, repository_id, created_at DESC, id DESC)

idx_repository_inspections_success_history
  (workspace_id, repository_id, created_at DESC, id DESC)
  WHERE outcome = 'succeeded'
```

### 8.3 `project_repository_bindings`

| Column | SQL type/nullability | Rule |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | non-empty |
| `workspace_id` | `TEXT NOT NULL` | workspace FK |
| `project_id` | `TEXT NOT NULL` | same-workspace project FK |
| `repository_id` | `TEXT NOT NULL` | same-workspace repository FK |
| `status` | `TEXT NOT NULL` | active or retired |
| `bound_by_user_id` | `TEXT NOT NULL` | user and membership FKs |
| `bound_at` | `TEXT NOT NULL` | immutable |
| `retired_by_user_id` | `TEXT` | required only when retired |
| `retired_at` | `TEXT` | required only when retired |
| `version` | `INTEGER NOT NULL` | starts 1; retirement is exactly 2 |

Candidate keys:

```text
PRIMARY KEY (id)
UNIQUE (workspace_id, id)
UNIQUE (workspace_id, project_id, repository_id, id)
```

Structural parents:

```text
FOREIGN KEY (workspace_id, project_id)
  REFERENCES projects(workspace_id, id)

FOREIGN KEY (workspace_id, repository_id)
  REFERENCES registered_repositories(workspace_id, id)
```

Both actor columns have user FKs; non-null actors also have
`(workspace_id, user_id)` membership FKs. `MATCH SIMPLE` is safe for the optional retired
actor only because a separate check couples it exactly to `retired_at` and retired status.

Indexes:

```text
UNIQUE INDEX uq_project_repository_bindings_active_project
  ON project_repository_bindings(workspace_id, project_id)
  WHERE status = 'active'

idx_project_repository_bindings_repository
  (workspace_id, repository_id, status, bound_at, id)

idx_project_repository_bindings_project_history
  (workspace_id, project_id, bound_at, id)
```

### 8.4 Exact checks and trigger inventory

All three tables are `STRICT`. Declarative `CHECK` families cover:

```text
all enum membership
non-empty IDs
display-name/path/pattern/JSON byte bounds
canonical unsigned-decimal inode/device spelling
positive safe-integer version fields
accepted observation/risk-scope versions and exact risk-scan pattern
lowercase 64-hex digest spelling
status/reason coupling
success/failure all-or-nothing null coupling
registration versus comparison-array null coupling
risk classification versus empty/non-empty signals
binding active/retired actor-time null coupling
initial positive row versions
```

SQLite JSON validity is a check; array membership/order/uniqueness and error-taxonomy
cross-field rules use triggers because SQLite `CHECK` expressions cannot contain the
needed subqueries. The exact trigger inventory is:

| Trigger | Timing/table | Responsibility |
|---|---|---|
| `registered_repositories_initial_state` | before insert/repository | require version 1, active/registration-accepted, identical registration/baseline link, actor/time coupling, and matching preinserted registration evidence |
| `registered_repositories_transition_only` | before update/repository | immutable ownership/core/registration fields, exact +1, and complete allowed state/baseline transition |
| `registered_repositories_retirement_requires_closed_bindings` | before update/repository | refuse retirement while any active binding remains |
| `registered_repositories_no_delete` | before delete/repository | reject delete |
| `repository_inspections_record_shape` | before insert/inspection | enforce success/failure, kind/outcome, JSON byte bounds, projection format, and comparison null coupling |
| `repository_inspections_parent_state` | before insert/inspection | registration may precede its deferred parent; verification is allowed only from active/unavailable/evidence-changed; reaffirmation only from evidence-changed |
| `repository_inspections_arrays_valid` | before insert/inspection | enforce JSON array shape, allowlists, sorted order, uniqueness, counts, and risk classification coupling |
| `repository_inspections_failure_taxonomy` | before insert/inspection | enforce the mirrored A1 code/subject/category/operation/retryability table and bounded safe-name scalar evidence keys |
| `repository_inspections_no_update` | before update/inspection | reject update |
| `repository_inspections_no_delete` | before delete/inspection | reject delete |
| `project_repository_bindings_initial_state` | before insert/binding | require active repository, active binding, version 1, and null retirement attribution |
| `project_repository_bindings_retirement_only` | before update/binding | immutable ownership/bound fields and exact active→retired +1 transition |
| `project_repository_bindings_no_delete` | before delete/binding | reject delete |

The migration test enumerates these exact names from `sqlite_master` and exercises their
positive and direct-SQL negative paths; merely observing that a trigger exists is not
proof of its behavior.

### 8.5 Catalog additions

Migration 0003 inserts exactly:

```text
repository.register
repository.inspect
repository.reaffirm
repository.retire
repository.bind-project
repository.unbind-project
```

with `introduced_in_schema = 3`. `AUDIT_ACTIONS` mirrors those values. No repository
workspace-event kind appears in domain, catalog, contracts, storage mapping, or browser.

## 9. Circular registration/inspection linkage and commit proof

Registration uses one immediate SQLite transaction and this exact statement order:

```text
1. INSERT one successful kind=registration inspection.
   Its repository FK is deferred, so the not-yet-inserted repository is legal
   only until the outer transaction attempts to commit.

2. INSERT the registered repository with:
   version = 1
   status = active
   status_reason = registration-accepted
   registration_inspection_id = accepted_environment_inspection_id
   registered actor/time = status actor/time

3. The repository INSERT guard requires the named inspection already to exist,
   have the same workspace/repository IDs, kind=registration, outcome=succeeded,
   and have every projected version/core field equal the repository row.

4. COMMIT checks both reciprocal deferred FKs.
```

Consequences:

- inspection alone cannot commit because its repository parent is missing;
- repository alone is rejected by the insertion guard and deferred links;
- an inspection from another workspace or sibling repository cannot satisfy the composite
  link;
- a failed or non-registration inspection cannot initialize the repository;
- registration and initial environmental baseline cannot name different inspections;
- rollback removes both sides;
- the storage `register` primitive wraps the pair in a nested-safe immediate transaction,
  so it is atomic both standalone and inside A2b's later outer audit/event transaction.

The insertion guard intentionally makes inspection-first order part of the storage
contract. Direct SQL that uses repository-first order fails closed rather than receiving
an unsafe grace period.

## 10. Full-record byte and digest contract

Write protocol anticipated for A2b:

```text
receive a branded ParsedRepositoryObservation from the package-root adapter
    → JSON.stringify that exact immutable observation once
    → obtain the exact UTF-8 bytes of that string
    → SHA-256 those bytes
    → derive the SQL projection columns from the same parsed observation
    → persist the exact string, digest, and projections without reserialization
```

Read protocol:

```text
read the exact stored observation_json string and stored digest
    → SHA-256 the exact UTF-8 bytes of that string
    → reject a digest mismatch before JSON parsing
    → JSON.parse once
    → pass the parsed unknown value to A1 parseRecordedObservation
    → compare every stored projection with the parsed observation
    → only then compare or use the evidence
```

A2a provides a small storage-owned SHA-256 helper over exact UTF-8 strings so the stale
digest fixture is executable without importing Git. It does not automatically bless a
row or parse A1 content.

This contract makes no canonical-JSON claim. Whitespace and object-key order are part of
the stored byte identity. It also makes no hostile-database authenticity claim: an
attacker able to rewrite both the SQLite row and the running daemon's trust context can
replace bytes and digest together. The checksum detects accidental or unauthorized
single-field corruption within the application's storage-integrity model.

SQLite checks JSON syntax and bounded storage only. It cannot calculate SHA-256 or prove
that projections equal JSON semantics. Digest verification, A1 parse, and projection
comparison are mandatory A2b trust-boundary steps, not database claims.

## 11. Storage state machines and triggers

### 11.1 Repository insert/update/delete

`registered_repositories_initial_state` rejects an insert unless:

```text
version = 1
status/reason = active/registration-accepted
registration inspection = accepted environmental inspection
registered actor/time = status actor/time
the successful registration inspection exists and its projections match
```

One `registered_repositories_transition_only` update trigger states the complete allowed
rule, following the schema-2 one-trigger convention:

```text
all workspace/display/core/registration/registered fields remain unchanged
version = OLD.version + 1
new status actor is non-null and the new status timestamp differs from the old timestamp
either:
  accepted baseline unchanged and (OLD.status, NEW.status, NEW.reason)
    is one reducer-permitted durable status transition
or:
  OLD.status = identity-evidence-changed
  NEW.status/reason = active/environment-evidence-reaffirmed
  accepted baseline changes to a different successful reaffirmation inspection
  that belongs to the same repository/workspace, uses the same observation and
  policy versions, matches every immutable core projection, and has the same
  actor as status_changed_by_user_id
```

The non-reaffirmation branch admits only these exact old/new/reason triples:

| Old status | New status | Allowed new reason |
|---|---|---|
| `active` | `identity-evidence-changed` | `environment-evidence-changed` |
| `active` | `identity-mismatch` | `core-identity-changed`, `repository-class-changed` |
| `active` | `unavailable` | `path-unavailable`, `metadata-unreadable` |
| `active` | `evidence-blocked` | any of the four evidence-blocked reasons |
| `active` | `retired` | `operator-retired` |
| `unavailable` | `active` | `evidence-matches` |
| `unavailable` | `identity-evidence-changed` | `environment-evidence-changed` |
| `unavailable` | `identity-mismatch` | `core-identity-changed`, `repository-class-changed` |
| `unavailable` | `evidence-blocked` | any of the four evidence-blocked reasons |
| `unavailable` | `retired` | `operator-retired` |
| `identity-evidence-changed` | `active` | `evidence-matches` with baseline unchanged |
| `identity-evidence-changed` | `unavailable` | `path-unavailable`, `metadata-unreadable` |
| `identity-evidence-changed` | `identity-mismatch` | `core-identity-changed`, `repository-class-changed` |
| `identity-evidence-changed` | `evidence-blocked` | any of the four evidence-blocked reasons |
| `identity-evidence-changed` | `retired` | `operator-retired` |
| `identity-mismatch` | `retired` | `operator-retired` |
| `evidence-blocked` | `retired` | `operator-retired` |

Risk-only evidence, exact matching evidence from active, repeated failures that preserve
the current status, and `observation-raced` append inspection history but perform no
repository update. No same-status reason rewrite is a transition.

A no-op update, same-status reason rewrite, bare version bump, version jump, baseline
change outside reaffirmation, terminal recovery, core rewrite, display-name rewrite, or
actor/time-only rewrite aborts.

`registered_repositories_retirement_requires_closed_bindings` rejects transition to
retired while an active binding exists. The repository retirement primitive therefore
retires all active bindings first and the repository second in one immediate transaction.

`registered_repositories_no_delete` rejects every delete.

### 11.2 Inspection immutability and taxonomy

`repository_inspections_record_shape` enforces the complete success/failure and
registration/comparison null coupling. `repository_inspections_arrays_valid` enforces
allowlists, sorted order, uniqueness, and maximum counts through `json_each`.
`repository_inspections_failure_taxonomy` enforces exact code/subject/category/retryability
agreement.

`repository_inspections_no_update` and `repository_inspections_no_delete` make every
attempt append-only.

### 11.3 Environmental baseline

Initial baseline is exactly the registration inspection. It cannot be removed.

Reaffirmation storage requires:

```text
current repository status = identity-evidence-changed
fresh successful kind=reaffirmation inspection already appended
inspection belongs to the same repository/workspace
inspection core and version projections equal immutable registration identity
new baseline ID differs from the old baseline ID
status becomes active/environment-evidence-reaffirmed
repository version increments exactly once
status actor equals inspection actor
repository ID and all bindings stay unchanged
```

An ordinary successful verification whose evidence again matches the old accepted
baseline may transition the repository back to active/evidence-matches without advancing
the baseline. Reaffirmation is therefore an explicit acceptance of a different
environment, not a synonym for reinspection.

### 11.4 Binding and retirement

`project_repository_bindings_initial_state` requires an active repository and an
active/version-1 binding with null retirement fields. It does not treat a binding as
work-contract resolution.

`project_repository_bindings_retirement_only` permits exactly:

```text
active/version N/null retirement fields
    → retired/version N+1/non-null retired actor and time
```

All workspace/project/repository/bound fields are immutable. Unretire, retarget, actor-only
rewrite, version jump, and touch-after-retirement fail. Delete always fails.
The storage retirement primitive returns an unchanged result for an already-retired
binding without issuing SQL; direct SQL still cannot rewrite it.

Repository retirement updates every active binding once, leaves historical bindings and
inspections intact, then moves the repository to terminal retired. Repeating retirement
is an application-level idempotent no-op; direct SQL cannot rewrite the retired row.

### 11.5 Version and concurrency semantics

Every update input carries `expectedVersion`; binding insertion carries
`expectedRepositoryVersion`. Update SQL includes workspace, ID, current status, and exact
version in its `WHERE` clause, and binding insertion first proves the active repository is
still at the expected version inside the same immediate transaction. Registration has no
preexisting row version and instead relies on the three global identity reservations. A
zero-row result is a typed storage conflict/no-op result; it is never retried against stale
facts inside the repository.

SQLite write transactions are immediate and use the existing 5000 ms busy timeout:

```text
concurrent active identity registration:
  one partial unique index winner; the other receives a uniqueness conflict

concurrent repository transitions:
  first commits version N+1; second's expected N update affects zero rows

concurrent binding inserts for one project:
  one active partial-index winner

concurrent binding retirement:
  first retires at N+1; second affects zero rows

bind versus repository retirement:
  serialized; either the new binding is included in retirement, or insertion
  observes retired and is rejected
```

Database triggers independently reject an exact-version bypass such as `+0`, `+2`, a bare
version bump, or a reverse transition.

## 12. Relationship matrices

These matrices were performed before finalizing the proposal. “DB” means a declared
foreign key/check/trigger/index; “A2b” means the intentionally deferred active-role or
host-inspection decision.

### 12.1 Registered repository → workspace and actors

| Case | Expected proof/result |
|---|---|
| Same workspace and correct parent | workspace and both actor membership keys accept |
| Cross workspace | `(workspace_id, actor_user_id)` membership FK rejects |
| Same workspace and wrong parent | wrong actor is allowed only if that user has historical membership in this workspace; role is not inferred |
| Missing parent | workspace/user/membership FK rejects |
| Retired or non-active parent | archived workspace and revoked membership remain structurally referenceable history; A2b denies new commands using active-status policy |
| NULL/optional dimension | repository workspace and actors are non-null; no FK can be skipped |
| Concurrent insert/update | immediate transactions plus global identity indexes/version predicate serialize |
| Update without exact version increment | transition trigger rejects |
| Direct delete or reverse transition | no-delete and terminal-transition rules reject |

### 12.2 Inspection → repository/workspace/actor

| Case | Expected proof/result |
|---|---|
| Same workspace and correct parent | composite repository FK plus membership FK accept |
| Cross workspace | composite repository or membership FK rejects |
| Same workspace and wrong parent | a standalone inspection is valid for the repository it declares; any later attempt to use sibling B's inspection as repository A's registration/baseline fails the three-column reciprocal key |
| Missing parent | deferred repository FK fails commit; missing actor/membership fails statement |
| Retired or non-active parent | unavailable/evidence-changed permit governed recovery inspection; mismatch/evidence-blocked/retired reject new inspection; FK alone preserves old history |
| NULL/optional dimension | repository and actor are non-null; success/failure groups use explicit null-coupling checks |
| Concurrent insert/update | append IDs are unique; history inserts coexist; state update uses expected version |
| Update without exact version increment | inspections have no mutable version and reject every update |
| Direct delete or reverse transition | append-only delete trigger rejects |

### 12.3 Repository ↔ registration inspection

| Case | Expected proof/result |
|---|---|
| Same workspace and correct parent | inspection-first insert, registration guard, reciprocal deferred FKs, commit succeeds |
| Cross workspace | three-column composite link rejects |
| Same workspace and wrong parent | `repository_id` mismatch rejects even if inspection ID exists |
| Missing parent | either lone side fails statement/commit; no partial graph commits |
| Retired or non-active parent | registration inspection remains immutable history; it cannot be replaced during retirement |
| NULL/optional dimension | both IDs are non-null; initial baseline must equal registration ID |
| Concurrent insert/update | one global identity winner; one successful registration inspection per repository |
| Update without exact version increment | registration link is immutable regardless of version |
| Direct delete or reverse transition | both rows reject delete; link cannot be retargeted |

### 12.4 Repository → accepted environmental inspection

| Case | Expected proof/result |
|---|---|
| Same workspace and correct parent | same-repository FK plus successful/core-matching trigger accept |
| Cross workspace | composite FK rejects |
| Same workspace and wrong parent | sibling repository inspection rejects |
| Missing parent | deferred FK/transition trigger rejects |
| Retired or non-active parent | baseline remains queryable after mismatch/block/retirement; no advance except evidence-changed reaffirmation |
| NULL/optional dimension | baseline is always non-null |
| Concurrent insert/update | expected repository version and immediate transaction permit one baseline advance |
| Update without exact version increment | unified transition trigger rejects |
| Direct delete or reverse transition | inspection deletion and repository baseline rollback reject |

### 12.5 Binding → project/repository/workspace

| Case | Expected proof/result |
|---|---|
| Same workspace and correct parent | both composite parent FKs and active-repository insert guard accept |
| Cross workspace | project or repository composite FK rejects |
| Same workspace and wrong parent | a real sibling project is a valid separate binding; a nonexistent/mixed project/repository graph fails the relevant key; one project cannot have two active bindings |
| Missing parent | project/repository FK rejects |
| Retired or non-active parent | insert guard rejects every non-active repository |
| NULL/optional dimension | project/repository IDs are non-null; retirement actor/time are exactly coupled |
| Concurrent insert/update | partial active-project uniqueness and immediate transactions select one winner |
| Update without exact version increment | retirement trigger rejects |
| Direct delete or reverse transition | no-delete, no-unretire, and no-retarget rules reject |

### 12.6 Binding actors and retirement attribution

| Case | Expected proof/result |
|---|---|
| Same workspace and correct parent | user plus historical workspace-membership keys accept |
| Cross workspace | membership composite FK rejects |
| Same workspace and wrong parent | any historically related member is structurally valid; A2b separately checks Owner/Editor and active status |
| Missing parent | user/membership FK rejects |
| Retired or non-active parent | revoked member remains valid historical attribution; cannot authorize a new service command |
| NULL/optional dimension | bound actor never null; retired actor is null iff active and non-null iff retired |
| Concurrent insert/update | exact binding version selects one retirement actor |
| Update without exact version increment | retirement trigger rejects fabricated attribution |
| Direct delete or reverse transition | immutable attribution/no-delete rules reject |

## 13. Storage repository surface

`repository-types.ts` defines:

```text
successful and failed inspection write inputs
registration graph write input
repository transition and reaffirmation inputs
binding create/retire inputs
repository retirement input
typed conflict/no-op results
repository list/detail/evidence query rows
exact-observation digest calculator/verifier
RepositoryRegistryRepositories group
```

The grouped repository surface is:

```ts
interface RepositoryRegistryRepositories {
  readonly repositories: {
    register(input): RegisteredRepository;
    find(workspaceId, repositoryId): RegisteredRepository | undefined;
    list(workspaceId, limit): readonly RegisteredRepository[];
    applyTransition(inputWithExpectedVersion): RepositoryMutationResult;
    reaffirmEnvironment(inputWithExpectedVersion): RepositoryMutationResult;
    retireWithBindings(inputWithExpectedVersion): RepositoryRetirementResult;
  };
  readonly inspections: {
    append(input): RepositoryInspection;
    find(workspaceId, inspectionId): RepositoryInspection | undefined;
    listForRepository(...): readonly RepositoryInspection[];
    latestForRepository(...): RepositoryInspection | undefined;
    latestSuccessfulForRepository(...): SuccessfulRepositoryInspection | undefined;
  };
  readonly bindings: {
    insert(input): ProjectRepositoryBinding;
    find(workspaceId, bindingId): ProjectRepositoryBinding | undefined;
    findActiveForProject(...): ProjectRepositoryBinding | undefined;
    listForProject(...): readonly ProjectRepositoryBinding[];
    listForRepository(...): readonly ProjectRepositoryBinding[];
    retire(inputWithExpectedVersion): BindingMutationResult;
  };
  readonly queries: {
    repositorySummary(...): RepositorySummaryRow | undefined;
    repositorySummaries(...): readonly RepositorySummaryRow[];
  };
}
```

`StorageRepositories` and `CraftingTableStorage` gain `repositoryRegistry`. The existing
transaction callback supplies the group, so A2b can later compose state, audit, and events
in one outer transaction. A2a itself writes no audit row or workspace event.

## 14. Migration and direct-SQL proof matrix

### 14.1 Preservation

`migration-0003.test.ts` builds a real accepted schema-2 file through current
repositories, including users, two workspaces/memberships, sessions, projects, versions,
items, dependencies, drafts, artifacts, diagnostics, audit rows, and workspace events.
It records:

```text
all existing rows ordered by primary key/sequence
schema_migrations rows
sqlite_sequence values
existing indexes and trigger SQL
audit and workspace-event catalogs
foreign_key_check and integrity_check
```

Applying only migration 0003 must:

```text
preserve every recorded row byte-for-value
preserve both journal maxima and next sequence behavior
preserve every prior trigger/index/catalog row
add exactly the three tables, named indexes/triggers, and six audit actions
leave workspace_event_kinds unchanged
record schema version/name/checksum 3/ct04a2a-repository-model/<actual digest>
pass foreign_key_check and integrity_check
```

A synthetic failing copy of migration 0003 proves the entire migration and ledger insert
roll back to schema 2. Existing checksum tests prove drift fails closed. The schema-2
migration test is changed to select migrations 1 and 2 explicitly; it must not
accidentally apply 3 while claiming to test migration 2. The old SQL files remain
byte-identical to the hashes in section 2.

### 14.2 Direct SQL

| Surface | Positive proof | Negative/direct proof |
|---|---|---|
| Repository graph | coherent circular registration commits | missing, foreign-workspace, sibling-parent, failed-registration, split-baseline reject |
| Global identity | three distinct live identities insert | duplicate top/common/fingerprint across any workspace reject; reuse after retirement accepts |
| Repository immutable fields | status transition leaves core intact | display/workspace/core/registration/registered attribution rewrite rejects |
| Repository version | exact `N → N+1` allowed transition | `+0`, `+2`, bare bump, same-status rewrite reject |
| Repository terminal state | any non-retired can retire after bindings close | unretire, inspect/reaffirm terminal, delete reject |
| Success inspection | complete registration and verification records insert | any missing success field, any failure field, malformed digest/JSON/array rejects |
| Failure inspection | complete bounded failure record inserts | mixed success/failure, missing classification, wrong code taxonomy, object/array evidence rejects |
| Inspection arrays | sorted unique allowlisted arrays insert | unsorted, duplicate, unknown, oversized arrays reject |
| Inspection integrity | exact string/digest round trips; digest helper passes | one-byte string change with stale digest returns integrity failure |
| Inspection ownership | same repository/workspace/member inserts | cross-workspace, wrong repository, missing actor/member reject |
| Baseline | registration baseline and one core-matching reaffirmation accept | failed/sibling/core-different/non-reaffirmation baseline, wrong status, no version increment reject |
| Binding | active same-workspace repo/project inserts; many projects per repo | cross-workspace, missing/wrong project, non-active repo, second active binding reject |
| Binding retirement | one active binding retires at `+1` | partial retirement fields, retarget, unretire, delete, version jump reject |
| Repository retirement | two bindings then repository retire atomically | repository-first retire, forced rollback, direct unretire/delete reject |
| Concurrency | separate connections prove one registration/binding/update winner | stale expected version produces conflict and no duplicate transition |
| Migration | fresh and schema-2-forward paths reach 3 | changed checksum, interruption, old-migration edit fail |

## 15. Protected acceptance mapping

Every A2a protected ID appears in a test name. The source matrix and A2 supplement contain
the same 91 A2a cases; the supplement digest remains pinned. Each implementation test
title starts with the exact ID below, so an individual protected result can be reported
without inferring coverage from a range.

Status reducer cases all live in `packages/domain/src/repository.test.ts`:

| ID | Named proof assertion |
|---|---|
| `A2A-STATUS-001` | active + unchanged core/environment/risk remains active with no version transition |
| `A2A-STATUS-002` | risk-only difference remains active, records the evidence-change disposition, and does not change repository version |
| `A2A-STATUS-003` | active + environmental difference becomes `identity-evidence-changed` |
| `A2A-STATUS-004` | active + core difference becomes terminal `identity-mismatch` |
| `A2A-STATUS-005` | active + availability failure becomes `unavailable` |
| `A2A-STATUS-006` | `observation-raced`/other no-state-change failure does not transition |
| `A2A-STATUS-007` | unavailable + successful matching evidence returns active |
| `A2A-STATUS-008` | unavailable + environmental difference becomes `identity-evidence-changed` |
| `A2A-STATUS-009` | ordinary inspection showing the accepted baseline has returned restores active |
| `A2A-STATUS-010` | inspection from `identity-mismatch` is terminally rejected |
| `A2A-STATUS-011` | inspection from `evidence-blocked` is terminally rejected |
| `A2A-STATUS-012` | retirement from each non-retired state produces `retired` |
| `A2A-STATUS-013` | inspection/reaffirmation from retired is rejected |
| `A2A-STATUS-014` | every unknown state, event, difference, failure, or pairing is an explicit error, never a default transition |

Repository cases live in `packages/storage/src/repository-schema.test.ts`, with the
display-name boundary duplicated in `packages/contracts/src/repository.test.ts`:

| ID | Named proof assertion |
|---|---|
| `A2A-REP-001` | inspection-first valid registration graph commits |
| `A2A-REP-002` | missing registration inspection fails the deferred FK at commit |
| `A2A-REP-003` | registration inspection belonging to another repository fails composite ownership |
| `A2A-REP-004` | environmental baseline belonging to another repository fails composite ownership |
| `A2A-REP-005` | a non-retired duplicate canonical top level fails global uniqueness |
| `A2A-REP-006` | a non-retired duplicate canonical common Git directory fails global uniqueness |
| `A2A-REP-007` | a non-retired duplicate core fingerprint fails global uniqueness |
| `A2A-REP-008` | all identity reservations are released only after retirement and a new repository ID can register |
| `A2A-REP-009` | SQL mutation of workspace, core identity, display name, or registration actor is rejected |
| `A2A-REP-010` | direct repository delete is rejected |
| `A2A-REP-011` | status transition without exact version +1 is rejected |
| `A2A-REP-012` | bare version bump without an allowed status/baseline transition is rejected |
| `A2A-REP-013` | invalid status/reason/retirement null coupling is rejected |
| `A2A-REP-014` | invalid or over-bound display names are rejected at contract and database boundaries |

Inspection cases use `packages/storage/src/repository-schema.test.ts` for SQL invariants
and `packages/storage/src/repository-repositories.test.ts` for byte/digest round trips:

| ID | Named proof assertion |
|---|---|
| `A2A-INSP-001` | success requires every success field and null failure fields |
| `A2A-INSP-002` | failure requires bounded taxonomy/evidence fields and null observation/projection/comparison fields |
| `A2A-INSP-003` | partial-success rows are rejected |
| `A2A-INSP-004` | partial-failure rows are rejected |
| `A2A-INSP-005` | failure missing code, subject, category, or retryability is rejected |
| `A2A-INSP-006` | cross-workspace or wrong-parent inspection ownership is rejected |
| `A2A-INSP-007` | actor existence and historical workspace membership are database-enforced; active-role policy remains A2b |
| `A2A-INSP-008` | direct update of inspection evidence is rejected |
| `A2A-INSP-009` | direct delete of inspection evidence is rejected |
| `A2A-INSP-010` | unsorted or duplicate risk/difference arrays are rejected |
| `A2A-INSP-011` | oversize observation JSON or evidence metadata is rejected |
| `A2A-INSP-012` | the exact stored observation string and SHA-256 digest round-trip byte-identically |
| `A2A-INSP-013` | stale digest is detected before parse/projection use and returns an integrity failure |
| `A2A-INSP-014` | invalid observation-digest length or case is rejected |

Baseline cases live in `packages/storage/src/repository-transitions.test.ts`:

| ID | Named proof assertion |
|---|---|
| `A2A-BASE-001` | registration inspection is accepted as the initial environmental baseline |
| `A2A-BASE-002` | a failed inspection cannot be the baseline |
| `A2A-BASE-003` | a baseline inspection belonging to a sibling repository is rejected |
| `A2A-BASE-004` | baseline update while the repository is not `identity-evidence-changed` is rejected |
| `A2A-BASE-005` | baseline update without exact repository version +1 is rejected |
| `A2A-BASE-006` | a coherent baseline update plus active transition is accepted |
| `A2A-BASE-007` | a baseline update that mutates core identity is rejected |
| `A2A-BASE-008` | direct deletion of the baseline relation/evidence is rejected |

Binding cases use `packages/storage/src/repository-schema.test.ts` for structural
negatives and `packages/storage/src/repository-repositories.test.ts` for lifecycle/query
behavior:

| ID | Named proof assertion |
|---|---|
| `A2A-BIND-001` | active project and active repository in the same workspace can bind |
| `A2A-BIND-002` | cross-workspace or wrong-parent project/repository ownership is rejected |
| `A2A-BIND-003` | a same-workspace nonexistent or wrong project ID is rejected |
| `A2A-BIND-004` | a non-active repository cannot receive a new binding |
| `A2A-BIND-005` | a project cannot have two active bindings |
| `A2A-BIND-006` | multiple projects may actively bind one repository |
| `A2A-BIND-007` | one active binding retires with exact actor/time null coupling and version +1 |
| `A2A-BIND-008` | retiring one binding leaves a sibling binding to the same repository active |
| `A2A-BIND-009` | active/retired field null coupling is enforced |
| `A2A-BIND-010` | retarget, reverse transition, +0/+2 update, or ownership mutation is rejected |
| `A2A-BIND-011` | direct binding delete is rejected |
| `A2A-BIND-012` | revoked historical actor remains referentially valid; A2b denies new service action by inactive member |

Retirement cases live in `packages/storage/src/repository-transitions.test.ts`:

| ID | Named proof assertion |
|---|---|
| `A2A-RET-001` | repository and all active bindings retire in one immediate transaction |
| `A2A-RET-002` | forced failure rolls back repository and binding retirement together |
| `A2A-RET-003` | repeated retirement is idempotent and performs no state rewrite |
| `A2A-RET-004` | a retired repository cannot receive a new binding |
| `A2A-RET-005` | attempted mutation of a retired repository's inspection relation is rejected and historical evidence remains immutable |
| `A2A-RET-006` | retired identity reservations permit registration under a new repository ID |
| `A2A-RET-007` | repository unretire or reverse transition is rejected |
| `A2A-RET-008` | direct repository deletion is rejected |

Migration cases use `packages/storage/src/migration-0003.test.ts`, existing migration
tests, and immutable migration digest checks:

| ID | Named proof assertion |
|---|---|
| `A2A-MIG-001` | fresh schema 3 has every table, column, index, trigger, FK, and catalog row |
| `A2A-MIG-002` | populated schema 2 forward migration preserves every row and sequence |
| `A2A-MIG-003` | all schema-1/schema-2 triggers and catalogs remain active |
| `A2A-MIG-004` | changed migration checksum fails closed |
| `A2A-MIG-005` | interrupted migration rolls back completely and leaves schema at 2 |
| `A2A-MIG-006` | `foreign_key_check` and `integrity_check` are clean after both migration paths |
| `A2A-MIG-007` | accepted snapshot/SSE reconstruction remains unchanged after migration |
| `A2A-MIG-008` | modified old migration bytes are rejected by checksum verification |

Contract cases live in `packages/contracts/src/repository.test.ts`:

| ID | Named proof assertion |
|---|---|
| `A2A-CON-001` | minimal valid registration request is accepted |
| `A2A-CON-002` | unknown registration fields, including process/Git controls, are rejected |
| `A2A-CON-003` | omitted display name whose derived basename is unsafe must be rejected by A2b rather than stored |
| `A2A-CON-004` | repository response with bounded status, evidence recency, and risk summary is accepted |
| `A2A-CON-005` | response claims of executable, ready, reviewed, or mergeable are rejected |
| `A2A-CON-006` | inspection response carrying raw stderr, environment, or configuration values is rejected |
| `A2A-CON-007` | reaffirm request missing expected version or expected inspection is rejected |
| `A2A-CON-008` | malformed or unknown retire/unbind request fields are rejected |

Process and scope cases:

| ID | Permanent proof location |
|---|---|
| `A2-PROC-001` | this proposed plan plus required independent design review |
| `A2-PROC-002` | Phase B disposition and accepted-plan reconciliation appendix; intentionally not claimed complete in Phase A |
| `A2-PROC-003` | post-implementation completion report with real committed head only; intentionally deferred |
| `A2-PROC-004` | digest and Git-diff checks against the A2 supplement in every implementation gate |
| `A2-SCOPE-001` | enhanced `check-forbidden-scope` test, migration text check, target-diff inventory, and dependency graph inspection |

The implementation report may claim only cases actually run. Process cases remain
open until their stated lifecycle point. The two cross-slice cases `A2-PROC-005` and
`A2-SCOPE-002` are A2b cases, not omitted A2a proofs; section 18 defers both explicitly.

## 16. Documentation and ADR updates

`ADR-017-repository-evidence-and-persistence.md` records:

```text
three evidence layers and exact full-record byte digest
no canonicalization/authenticity overclaim
pure reducer and terminal statuses
inspection-first deferred circular registration linkage
same-parent composite ownership and nullable-FK handling
environmental baseline/reaffirmation semantics
non-retired global identity reservation
binding/retirement state machines
optimistic version and immediate-transaction concurrency
A2a/A2b authority split
```

ADR-002 gains the schema-3 deferred-cycle, nullable-membership, and transition-trigger
rules. ADR-013 needs no semantic amendment because audit catalogs were already designed
for migration-owned inserts; ADR-017 links to it instead.

Architecture, security, and operations documentation will state that schema 3 is durable
but still uncomposed: there is no route, no configured inspector, and no browser feature.
Operations documents migration 3, preservation/reset behavior, and the fact that stored
evidence can be administered only after A2b exists. README and CLAUDE identify A2a as the
active accepted implementation slice only after operator approval; they do not claim
repository registration is usable.

## 17. Exact verification commands planned for implementation

Only commands actually run may appear in completion evidence. Planned commands:

```text
pnpm install --frozen-lockfile

pnpm exec biome format --write \
  packages/domain/src/ids.ts \
  packages/domain/src/ids.test.ts \
  packages/domain/src/audit.ts \
  packages/domain/src/index.ts \
  packages/domain/src/repository.ts \
  packages/domain/src/repository.test.ts \
  packages/contracts/src/ids.ts \
  packages/contracts/src/index.ts \
  packages/contracts/src/repository.ts \
  packages/contracts/src/repository.test.ts \
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
  packages/storage/migrations/0001-ct02-foundation.sql \
  packages/storage/migrations/0002-ct03-planning.sql \
  protected/CT-04-protected-acceptance-spec.yaml \
  work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml

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

The full `pnpm check` gate includes all CT-01 through A1 regression tests, Playwright,
scope, and original protected-package verification. Focused storage tests use real SQLite
files, `foreign_key_check`, `integrity_check`, multiple connections for concurrency, and
direct SQL rather than repository-only examples.

## 18. A2b work intentionally deferred

A2a does not implement or partially compose any of the following:

- operator-facing source/reserved-root or Git executable/search-path configuration;
- lazy A1 inspector creation or memoization;
- a server-owned A1 adapter or any import of `@craftingtable/git`;
- authorization decisions for Owner/Editor/Viewer or active membership;
- registration, reinspection, reaffirmation, binding, unbinding, or retirement application
  services;
- two-inspection quiescence orchestration;
- exact A1 error-to-assessment mapping at runtime;
- digest → JSON parse → A1 parse → projection comparison orchestration;
- audit writes, denied/failed audit policy, or application transactions;
- repository workspace-event kinds or payload schemas;
- schema 4 or any `workspace_events` rebuild/correlation columns;
- notifier calls or post-commit delivery;
- Fastify composition, routes, HTTP status mapping, CSRF/origin wiring, or route inventory;
- snapshot/SSE repository projection, browser invalidation, activity text, or any repository
  page;
- `A2-PROC-005`: A2b replanning from the accepted, committed A2a source and its fresh
  fan-out decision;
- `A2-SCOPE-002`: the A2b authority/composition scope proof;
- updating immutable work-contract drafts or claiming repository/base resolution;
- target refs, exact base commits, change requests, branch/worktree/diff/artifact behavior;
- startup reconciliation, polling, automated repair, remote Git, credentials, or mutation.

A2b must be source-planned afresh against the accepted and committed A2a implementation.

## 19. Honest fan-out check

The proposal predicts:

```text
33 files, below the A2a ~45-file trigger
one migration
one persistence model: repository + inspection evidence + project binding
one assurance domain: invalid durable graphs and transitions
no new dependency
no new authority boundary
no server or browser layer
no Git import
no command transaction, event, or notifier behavior
```

The domain, contract, and storage changes are three representations of the same repository
evidence model, not unrelated product surfaces. The circular linkage, baseline, binding,
and retirement rules must be reviewed together because splitting them would leave an
unusable or weak intermediate schema for A2b.

No further fan-out is recommended at this source state. That conclusion is conditional,
not rhetorical: discovery of a second migration, more than roughly 45 files, a need for
Git/server/browser composition, a second persistence model, or inability to express the
commit-time graph under SQLite requires a new planning-feedback proposal before code
continues.

## 20. Phase A handoff

The independent reviewer should challenge in particular:

1. the inspection-first circular insertion order and every deferred-FK commit case;
2. the exact unified transition trigger, including baseline and retirement coupling;
3. actor membership semantics for revoked historical members versus A2b active-role policy;
4. the success/failure null-coupling and SQL taxonomy mirror;
5. exact UTF-8 string digest semantics and the absence of canonical/authenticity claims;
6. every same-workspace/wrong-parent and nullable relationship in section 12;
7. the 33-file/9,000-line ceiling and whether any item is secretly A2b.

Stop here. Do not create an accepted plan or implement source.
