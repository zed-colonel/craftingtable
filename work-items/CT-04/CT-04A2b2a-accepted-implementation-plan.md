# CT-04A2b2a accepted implementation plan

**Status:** Accepted-plan candidate; source implementation remains unauthorized pending operator approval

**Slice:** CT-04A2b2a — Repository feature and evidence boundary

**Parent:** CT-04A2b2 — Authorized repository lifecycle and CT-04A parent fan-in

**Accepted-plan baseline:** `886ddded3305d028b45f078cdff1a818d25bd41f`

**Pinned source archive head:** `dd9c9699f0d86cae00fc1bf0d054224880c8dbed`

**Date:** 2026-08-11

## 1. Authority, lineage, and stop condition

This plan reconciles:

1. `work-items/CT-04/CT-04A2b2a-proposed-implementation-plan.md`, SHA-256
   `3ef9120e09a525a0f7d132979a713dda5ea215bcee054020bb6a0b5efa2f7ba1`;
2. `review-findings/CT-04/CT-04A2b2a-design-review.md`, SHA-256
   `aacedcb46718ec719f32ae7f5d94c03449e681325b94720dc91132d73cd900bf`;
3. `work-items/CT-04/CT-04A2b2a-design-review-disposition.md`, SHA-256
   `710995b1c269ad933d0ef814d399a540b143af75ac91a0284350a52e48087c66`;
4. operator decisions D-01(a), D-02(a), D-03(a), and D-04(a);
5. the active A2b2a contract, accepted A1/A2a/B1 plans and implementation,
   protected matrices, and planning-feedback addendum.

It supersedes the proposal only after operator approval. The required next sequence is:

```text
operator approves this accepted plan
    -> implementation of exactly this A2b2a tree
    -> deterministic checks and implementation report
    -> exact-head code review
```

Do not implement while this file remains an unapproved candidate. Do not edit protected
specifications or later-child contracts. D-03 Part 1 is already complete in the separate
plan-independent commit `886ddded3305d028b45f078cdff1a818d25bd41f`; this plan claims
only the remaining Part 2 work.

## 2. Reconciled seams

### 2.1 A1 package-root seam and D-01 amendment

`packages/git/src/index.ts` currently exports the observation factory, parser,
comparator, runtime constants, and closed A1 types. A2b2a adds exactly one behavior-neutral
package-root re-export:

```ts
export { calculateCoreIdentityFingerprint } from './comparison.js';
```

It does not export `createParsedObservation`, command-runner types, configuration
dependencies, filesystem boundaries, or any process capability. The re-export preserves
one fingerprint algorithm and permits package-root-only fixtures. The amended source-map
row is pinned at SHA-256
`73a1a8f0e217fa1335ce7b62f13c35954e23fb13886e554087a143e0333fb8c1`.

A1's sole process import remains:

```text
packages/git/src/command-runner.ts -> node:child_process
```

No other A1 source or test changes are permitted.

### 2.2 A2a evidence seam

`packages/domain/src/repository.ts` owns durable vocabulary and the pure reducer.
`SuccessfulRepositoryInspection` stores exact observation JSON/digest plus 16 observation
projections. `RegisteredRepository` repeats nine identity/version projections.

`packages/storage/src/repository-types.ts`, re-exported at the storage package root, owns:

```text
serializeRepositoryObservation
sha256ExactUtf8
verifyExactUtf8Sha256
```

The adapter must reuse the serializer and verifier. It must not implement hashing or
serialization locally. A2b2a calls no storage mutator and changes no storage file,
migration, or durable vocabulary.

### 2.3 Server and B1 seams

`apps/server/src/config.ts` has no repository feature group. `composition.ts` has no
provider. `server.ts`, the route inventory, and all routes have no repository operation.
Those HTTP files remain unchanged.

B1's event vocabulary, storage journal, notifier path, browser invalidation, and
descriptions remain unchanged and unused. A2b2a emits no event and performs no audit,
notification, or durable write.

### 2.4 D-03 repaired gate baseline

The accepted-plan baseline already proves:

- B1 inventory is frozen over `e3b69c6..b8a5493`;
- no A2b2a path was added to `CT04A2B1_ALLOWED_CHANGED_PATHS`;
- `b8a5493..worktree` has a separate plan-independent inventory;
- the 12 planning files, two gate files, B1 tail process artifacts, and narrow A2b2a
  process-artifact classes are admitted;
- `pnpm check:protected` is green.

Implementation modifies that live A2b2a inventory only through Part 2 in §16.

## 3. Dependency and process-authority boundary

```text
@craftingtable/domain        @craftingtable/storage
          ^                         ^
          | server-owned values     | exact serializer/digest helpers
          +-------------+-----------+
                        |
       repository-observation-port / policy
                        ^
                        |
repository-observation-adapter -> @craftingtable/git package root
                        ^
                        |
             lazy guarded provider -> later B2b service
```

The one and only composed production file allowed to import `@craftingtable/git` is:

```text
apps/server/src/services/repository-observation-adapter.ts
```

The adapter may import `@craftingtable/storage` and `@craftingtable/domain`. No other
server production file may import A1, including type-only, dynamic, require, re-export,
or deep-import forms. `packages/git/src/index.ts` is the A1 package's own root and is not
a second composed consumer.

Manifest rules:

- `apps/server/package.json` becomes the only composed application production dependency
  on `@craftingtable/git`;
- the accepted `packages/testing/package.json` seam dependency remains present and is
  positively asserted;
- no other application or production package gains the dependency;
- the lockfile records only the new server workspace importer edge.

No file outside accepted A1/tooling imports `node:child_process` or `child_process`.

## 4. Exact implementation tree and budget

`+` is new and `~` is modified relative to the accepted-plan baseline. The source-map
amendment and D-03 Part 1 are already planning changes and are not implementation work.

```text
~ README.md
~ CLAUDE.md
~ apps/server/package.json
~ pnpm-lock.yaml

~ packages/git/src/index.ts

~ apps/server/src/config.ts
~ apps/server/src/config.test.ts
~ apps/server/src/composition.ts
+ apps/server/src/composition.test.ts

+ apps/server/src/services/repository-observation-port.ts
+ apps/server/src/services/repository-observation-policy.ts
+ apps/server/src/services/repository-observation-policy.test.ts
+ apps/server/src/services/repository-observation-adapter.ts
+ apps/server/src/services/repository-observation-adapter.test.ts
+ apps/server/src/services/repository-inspector-provider.ts
+ apps/server/src/services/repository-inspector-provider.test.ts

~ packages/domain/src/repository.ts
~ packages/domain/src/repository.test.ts

~ scripts/check-forbidden-scope.mjs
~ scripts/check-forbidden-scope.test.mjs
~ scripts/check-ct04-protected-package.mjs
~ scripts/check-ct04-protected-package.test.mjs

~ docs/architecture.md
~ docs/security.md
~ docs/operations.md
~ docs/decisions/README.md
+ docs/decisions/ADR-019-optional-repository-feature-and-evidence-translation.md
```

Budget:

| Area | Files | Added/changed-line budget |
|---|---:|---:|
| domain assessment/reducer | 2 | 80-140 |
| additive A1 package-root export | 1 | 5-15 |
| server config/composition and tests | 4 | 300-450 |
| port/policy/adapter/provider production | 4 | 550-800 |
| focused adapter/provider/policy tests | 3 | 800-1,050 |
| Part 2 scope/protected gates and tests | 4 | 300-420 |
| manifests/lockfile | 2 | 20-50 |
| ADR/product documentation | 7 | 180-225 |
| **Total** | **27** | **2,235-3,150 ceiling** |

There are two production layers, one existing host-observation authority composition,
zero new persistence boundaries, zero migrations, and zero HTTP/browser layers. The
review independently confirmed no further fan-out. Exceeding 3,150 changed lines, 35
files, a second Git import, or another authority boundary requires replanning.

## 5. Optional repository configuration

### 5.1 Server-owned immutable type

`config.ts` imports no A1 type. It adds:

```ts
type RepositoryFeatureConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly allowedSourceRoots: readonly string[];
      readonly reservedDataRoot: string;
      readonly artifactRoot: string;
      readonly managedWorktreeRoot: string;
      readonly gitExecutable?: string;
      readonly executableSearchPath?: string;
      readonly commandTimeoutMs: number;
      readonly creationTimeoutMs: number;
      readonly inspectionTimeoutMs: number;
      readonly stdoutLimitBytes: number;
      readonly stderrLimitBytes: number;
      readonly terminationGraceMs: number;
      readonly retryDelayMs: number;
    };
```

`ServerConfig` gains `repositoryFeature`. Returned arrays/objects are copied and frozen.
Only the adapter translates this value into A1 options.

### 5.2 Exact environment set

```text
CRAFTINGTABLE_REPOSITORY_ROOTS
CRAFTINGTABLE_ARTIFACT_ROOT
CRAFTINGTABLE_MANAGED_WORKTREE_ROOT
CRAFTINGTABLE_GIT_BIN
CRAFTINGTABLE_GIT_SEARCH_PATH
CRAFTINGTABLE_GIT_TIMEOUT_MS
CRAFTINGTABLE_GIT_CREATION_TIMEOUT_MS
CRAFTINGTABLE_GIT_INSPECTION_TIMEOUT_MS
CRAFTINGTABLE_GIT_STDOUT_LIMIT_BYTES
CRAFTINGTABLE_GIT_STDERR_LIMIT_BYTES
CRAFTINGTABLE_GIT_TERMINATION_GRACE_MS
CRAFTINGTABLE_REPOSITORY_PROVIDER_RETRY_DELAY_MS
```

There is no Boolean flag. Absence of all 12 means disabled. Presence of any means the
operator requested the feature; an empty value is present and malformed.

### 5.3 Disabled, partial, and valid semantics

```text
none present
  -> {enabled:false}; daemon starts
  -> zero factory, filesystem, executable, or host work
  -> existing planning/authentication composition remains available

any present but roots absent
  -> synchronous startup error

roots present but neither GIT_BIN nor GIT_SEARCH_PATH present
  -> synchronous startup error; no ambient PATH fallback

roots + only GIT_BIN
  -> valid

roots + only GIT_SEARCH_PATH
  -> valid

roots + both
  -> valid; explicit GIT_BIN wins

complete structurally valid group
  -> enabled idle provider; no A1 creation at startup
```

Artifact/worktree roots default to `<dataDir>/artifacts` and
`<dataDir>/worktrees`. Explicit values must be normalized absolute strict descendants of
`dataDir` and disjoint from each other. No directory is created. The adapter passes
exactly `[dataDir]` as A1 `reservedRoots`; the parent reservation covers both children
without violating A1's no-overlap rule.

When enabled, `dataDir`, source roots, child roots, `GIT_BIN`, and each search-path entry
must be nonempty, absolute, lexically normalized, equal to `resolve(value)`, NUL-free,
and at most 4096 UTF-8 bytes. Source roots contain 1-32 unique entries, are pairwise
non-overlapping in both ancestor directions, and do not overlap `dataDir`. Search-path
entries are unique directories separated by `node:path.delimiter`.

Exact synchronous startup failures include:

- empty, relative, non-normalized, unresolved, NUL-containing, or overlong paths;
- duplicate, ancestor-overlapping, dataDir-overlapping, or more-than-32 source roots;
- invalid or overlapping artifact/worktree children;
- missing roots or missing both explicit Git-resolution choices;
- malformed, fractional, out-of-range, or incoherent numbers;
- enabled non-normalized `dataDir`, including trailing separator and `.`/`..` cases.

Existence, realpath, directory kind, symlink components, POSIX/UID/platform, colon ceiling
representability, executable evidence, and Git version stay solely in A1 and occur on
first use. A missing, symlinked, or colon-containing root starts enabled/idle, then A1
returns `invalid-root-policy`; the provider becomes permanently unavailable, never
disabled.

### 5.4 Numeric defaults and bounds

| Variable | Default | Accepted rule |
|---|---:|---|
| `GIT_TIMEOUT_MS` | 5000 | integer 100-30000 |
| `GIT_CREATION_TIMEOUT_MS` | `2 * command + 5000` | integer 1000-90000 and `>= command` |
| `GIT_INSPECTION_TIMEOUT_MS` | `2 * command + 5000` | integer 1000-90000 and `>= 2 * command` |
| `GIT_STDOUT_LIMIT_BYTES` | 65536 | integer 16384-1048576 |
| `GIT_STDERR_LIMIT_BYTES` | 65536 | integer 1024-1048576 |
| `GIT_TERMINATION_GRACE_MS` | 250 | integer 50-2000 |
| `REPOSITORY_PROVIDER_RETRY_DELAY_MS` | 5000 | integer 100-60000 |

## 6. Internal port and composition seam

### 6.1 Type-chained port

The port imports domain types only and exposes server-owned results:

```ts
interface RepositoryObservationPort {
  inspect(input: {
    readonly requestedPath: string;
    readonly signal?: AbortSignal;
  }): Promise<RepositoryObservationResult>;

  verifyStored(
    inspection: SuccessfulRepositoryInspection,
  ): StoredRepositoryObservationVerificationResult;

  verifyRegisteredIdentity(
    repository: RegisteredRepository,
    observation: VerifiedStoredRepositoryObservation,
  ): RegisteredRepositoryIdentityVerificationResult;

  compare(
    baseline: VerifiedRepositoryBaseline,
    current: RepositoryObservationEvidence,
  ): RepositoryObservationComparisonResult;
}
```

`VerifiedStoredRepositoryObservation` is returned only after exact inspection-row
verification. `VerifiedRepositoryBaseline` is returned only after the nine repository
columns agree. `compare` accepts only the latter. Defensive reparse occurs before A1
comparison, so structural casts fail closed.

Port/result exports contain no A1 brand, inspector, factory, options, executable,
search path, roots, command kind, argv, environment, stdout/stderr, process result, or
spawn handle. No method accepts arbitrary commands or option arrays.

### 6.2 Composition injection

`ServiceOverrides` gains an optional server-owned `repositoryInspectorProvider`.
Provider construction accepts an internal server-owned `RepositoryObservationPortFactory`
and `MonotonicClock`. Production supplies the sole adapter factory and
`performance.now`; tests supply fakes. Neither factory nor clock exposes A1 types.

Composition creates one provider unless overridden and exposes the provider in the
internal `ServiceSet`. `buildServer` receives no repository dependency. Service creation
does not call `get()`. B2b must call the provider only after authorization and may inject
the provider override to prove authorization-before-host-access.

## 7. Provider state machine, concurrency, and fault latch

Closed states:

```text
disabled
idle
creating(shared promise)
available(memoized guarded port)
cooldown(bounded failure, retry-not-before)
permanently-unavailable(bounded failure)
```

| State | Concurrent `get()` behavior | Retry/cache | Restart |
|---|---|---|---|
| disabled | same `feature-disabled`; factory count zero | never | disabled if vars remain absent |
| idle | first caller installs promise before await | creation selects available/cooldown/permanent | idle |
| creating | every caller awaits the same promise and result object | caller abort does not cancel shared creation; A1 creation deadline bounds it | idle |
| available | same guarded port, no re-creation | success memoized for process lifetime | idle and lazily revalidated |
| cooldown | same failure before monotonic deadline | exact `retryDelayMs`; first caller after deadline creates once | idle |
| permanently-unavailable | same bounded failure | no retry before restart | idle so corrected host/package/config is re-evaluated |

Only retryable A1 creation failures enter cooldown. Configuration-required,
not-retryable, construction parity, unexpected factory throw, or adapter invariant fault
enter permanent state. There is no timer, background retry, exponential backoff,
stale-success eviction, disabled fallback, or ambient configuration fallback.

The guarded port owns an atomic permanent-fault latch and notifies the provider. If an
actual A1 error tuple contradicts policy or a verified wrapper fails defensive reparse:

1. that call returns `adapter-invariant-fault` with no assessment;
2. the port latches and the provider transitions `available -> permanently-unavailable`;
3. calls already executing finish with their bounded result;
4. every future method or `get()` returns the same permanent failure without A1 access;
5. restart clears only in-memory state and rechecks lazily.

Status/failure results expose no config values, roots, Git paths, raw observation,
stderr, environment, token, or foreign identifier.

## 8. A1/domain parity

Before inspector creation the adapter checks all package-root runtime facts actually
available:

1. observation version equals the domain stored version;
2. inspection policy version equals the domain current-policy constant;
3. risk scope version and exact pattern equal domain constants;
4. ordered risk signals equal the domain array;
5. ordered A1 error codes equal the domain A1 code array;
6. every exported code/subject mapping equals the domain mapping and server policy table;
7. closed `Record<Union, true>` tables are compile-time exhaustive for A1
   core/environment/risk difference unions and their ordered keys equal domain arrays;
8. compile-time tables cover the A1 subject/category/operation/retryability value sets.

Category and retryability mappings are not exported runtime values. They are therefore
not claimed as construction-time parity. Every actual A1 error is normalized only after
its code, subject, category, operation, and retryability agree with the exhaustive server
policy. Any mismatch is an adapter invariant fault and activates §7's permanent latch;
no assessment is guessed.

Array equality checks length and ordered members. Record equality checks exact key sets.
Missing, extra, reordered, or remapped values fail closed. Positive tests use the real
package root; drift cases use isolated package-root module replacement. There is no
production injection seam for A1.

## 9. Exact observation production and verification

### 9.1 Inspection success

On A1 success the adapter:

1. retains the parsed observation only inside the adapter;
2. calls storage `serializeRepositoryObservation(observation)` exactly once;
3. derives all 16 projections from that same parsed object;
4. returns server-owned evidence with the storage helper's exact JSON and digest.

The adapter imports no `node:crypto`, `createHash`, or server-local serializer.

### 9.2 Stored inspection verification

Input is one complete `SuccessfulRepositoryInspection`. Stop at the first failure:

```text
1. require construction-time runtime parity
2. call verifyExactUtf8Sha256(observationJson, observationSha256)
3. JSON.parse the exact stored string once
4. call A1 parseRecordedObservation(parsed unknown)
5. compare all 16 stored inspection projections with the parsed observation
6. return VerifiedStoredRepositoryObservation
```

There is no current-policy-equals-recorded step. A recorded historical policy is valid if
it is exact, parseable, and projection-consistent. Policy comparability belongs only to
`compareRepositoryObservations`.

Digest failure occurs before JSON/A1 parse, comparison, live inspection, or host access.
Scalar fields use strict equality; `riskSignals` uses same length/order/elements.

| Stored field | Parsed A1 field |
|---|---|
| `observationVersion` | `observationVersion` |
| `inspectionPolicyVersion` | `inspectionPolicyVersion` |
| `observedAt` | `observedAt` |
| `canonicalTopLevel` | `canonicalTopLevel` |
| `canonicalGitDirectory` | `canonicalGitDirectory` |
| `canonicalCommonGitDirectory` | `canonicalCommonGitDirectory` |
| `objectFormat` | `objectFormat` |
| `topLevelInode` | `coreIdentity.topLevelInode` |
| `commonDirectoryInode` | `coreIdentity.commonDirectoryInode` |
| `coreFingerprintSha256` | `coreIdentity.fingerprintSha256` |
| `topLevelDevice` | `environmentalEvidence.topLevelDevice` |
| `commonDirectoryDevice` | `environmentalEvidence.commonDirectoryDevice` |
| `riskScanScopeVersion` | `riskScan.scanScopeVersion` |
| `riskScannedKeyPattern` | `riskScan.scannedKeyPattern` |
| `riskClassification` | `riskScan.classification` |
| `riskSignals` | `riskScan.signals` |

`gitVersion` is A1-runtime-validated and full-digest-covered but has no A2a projected
column. Exact JSON/digest are handled before projections. Base inspection metadata and
comparison arrays are not observation projections.

### 9.3 Registered identity verification

`verifyRegisteredIdentity` compares exactly these nine shared fields:

```text
observationVersion
inspectionPolicyVersion
canonicalTopLevel
canonicalGitDirectory
canonicalCommonGitDirectory
objectFormat
topLevelInode
commonDirectoryInode
coreFingerprintSha256
```

Single-field disagreement returns `registered-identity-mismatch`, assessed as
`evidence-invalid / stored-evidence-invalid`, without exposing either value. The method
does not check registration/baseline inspection foreign keys; migration 0003 already
owns those constraints.

### 9.4 Round-trip fixture

The permanent positive fixture builds a valid observation shape, calls package-root
`calculateCoreIdentityFingerprint`, proves package-root `parseRecordedObservation`
accepts it, returns it from mocked `inspect`, constructs a complete successful inspection
from adapter output, then requires both verification methods to succeed. Mutating one
serialized byte with the original digest fails before parse counters advance.

## 10. Closed evidence failures and durable B2b disposition

The server-internal reasons are closed. “Storage tuple” below means the only accepted
A2a-owned tuple:

```text
origin=storage-integrity
code=stored-evidence-digest-mismatch
subject=stored-evidence-integrity
category=observation
operation=verify-stored-record
retryability=not-retryable
```

| Internal reason | Assessment | Exact B2b durable disposition |
|---|---|---|
| `stored-digest-mismatch` | evidence-invalid / stored-evidence-digest-mismatch | storage tuple |
| `stored-json-invalid` | evidence-invalid / stored-evidence-invalid | storage tuple; bounded evidence records internal reason |
| `a1-record-invalid` | evidence-invalid / stored-evidence-invalid | exact A1 `recorded-observation-invalid` tuple returned by parser |
| `unsupported-observation-version` | evidence-invalid / unsupported-observation-version | exact A1 parser tuple |
| `projected-inspection-mismatch` | evidence-invalid / stored-evidence-invalid | storage tuple; bounded field discriminator only |
| `registered-identity-mismatch` | evidence-invalid / stored-evidence-invalid | storage tuple; bounded field discriminator only |
| `comparison-policy-version-mismatch` | evidence-invalid / inspection-policy-version-mismatch | exact A1 comparator tuple |
| `adapter-vocabulary-mismatch` | no assessment | no inspection row; provider permanently unavailable |
| `adapter-invariant-fault` | no assessment | no inspection row; provider permanently unavailable |

The reuse of the storage tuple is required because A2a deliberately accepts exactly one
disjoint storage-integrity tuple and rejects cross-origin combinations. A2b2a does not
widen that vocabulary. Genuine A1 failures retain `errorOrigin:'a1'` and their actual
tuple. Systemic adapter faults are never fabricated as A1 or repository-state evidence.
A2b2a itself writes none of these rows; the table binds B2b's later transaction design.

## 11. Comparison and assessment

`compare()` defensively reparses the verified baseline and current adapter evidence,
calls `compareRepositoryObservations`, and preserves:

```text
coreDifferences
environmentalDifferences
riskDifferences
sameCoreIdentity
sameEnvironmentalEvidence
sameRiskScanEvidence
assessment
```

Policy mismatch is returned only by A1 comparison and maps per §10. Defensive reparse
failure is an adapter invariant fault, no assessment, and permanently latches the port.

Successful assessment priority:

```text
nonempty core          -> core-identity-changed, retaining all arrays
else nonempty env      -> environment-evidence-changed, retaining risk array
else nonempty risk     -> risk-evidence-changed
else                   -> same
```

An actual A1 error with subject `repository-class-changed` is handled before generic
operational logic. The exact-code policy makes `observation-raced` a no-state-change
failure despite its repository-unavailable subject.

## 12. Domain `repository-class-changed` correction

Add:

```ts
{
  readonly kind: 'repository-class-changed';
  readonly reason:
    | 'symlink-rejected'
    | 'ownership-refused'
    | 'not-primary-repository'
    | 'not-git-repository'
    | 'unsupported-object-format'
    | 'unsupported-repository-extension';
}
```

Validation rejects any other reason. Ordinary apply and reaffirmation map the six class
reasons from active, unavailable, or identity-evidence-changed to:

```text
identity-mismatch / repository-class-changed
```

Existing identity-mismatch, evidence-blocked, and retired terminal behavior remains.
No status/reason, storage field, contract, or migration vocabulary changes.

## 13. Complete A1 error policy

The implementation is an exhaustive `Record<A1Code, Policy>`. Each actual error must
also match its category, operation validity, and retryability before this assessment is
used.

| A1 code | Required subject / category / retryability | Assessment |
|---|---|---|
| `invalid-options` | policy-configuration / configuration / configuration-required | no-state-change-failure |
| `unsupported-platform` | host-environment / configuration / retryable | no-state-change-failure |
| `root-daemon-refused` | host-environment / configuration / retryable | no-state-change-failure |
| `invalid-root-policy` | policy-configuration / configuration / configuration-required | no-state-change-failure |
| `git-not-found` | host-environment / configuration / retryable | no-state-change-failure |
| `git-not-executable` | host-environment / configuration / retryable | no-state-change-failure |
| `git-executable-changed` | host-environment / configuration / retryable | no-state-change-failure |
| `unsupported-git-version` | host-environment / configuration / retryable | no-state-change-failure |
| `invalid-path` | caller-input / path-policy / not-retryable | no-state-change-failure |
| `outside-allowed-root` | policy-configuration / configuration / configuration-required | no-state-change-failure |
| `reserved-root-overlap` | policy-configuration / configuration / configuration-required | no-state-change-failure |
| `path-unavailable` | repository-unavailable / path-policy / retryable | unavailable / path-unavailable |
| `symlink-rejected` | repository-class-changed / path-policy / not-retryable | repository-class-changed |
| `ownership-refused` | repository-class-changed / path-policy / not-retryable | repository-class-changed |
| `repository-metadata-unreadable` | repository-unavailable / path-policy / retryable | unavailable / metadata-unreadable |
| `not-primary-repository` | repository-class-changed / path-policy / not-retryable | repository-class-changed |
| `not-git-repository` | repository-class-changed / path-policy / not-retryable | repository-class-changed |
| `unsupported-object-format` | repository-class-changed / path-policy / not-retryable | repository-class-changed |
| `unsupported-repository-extension` | repository-class-changed / path-policy / not-retryable | repository-class-changed |
| `spawn-failed` | git-boundary-fault / git-process / retryable | no-state-change-failure |
| `aborted` | host-environment / configuration / retryable | no-state-change-failure |
| `timed-out` | git-boundary-fault / git-process / retryable | no-state-change-failure |
| `stdout-overflow` | git-boundary-fault / git-process / retryable | no-state-change-failure |
| `stderr-overflow` | git-boundary-fault / git-process / retryable | no-state-change-failure |
| `signal-terminated` | git-boundary-fault / git-process / retryable | no-state-change-failure |
| `git-command-failed` | git-boundary-fault / git-process / retryable | no-state-change-failure |
| `invalid-output-encoding` | git-boundary-fault / git-process / retryable | no-state-change-failure |
| `malformed-version-output` | git-boundary-fault / git-process / retryable | no-state-change-failure |
| `malformed-identity-output` | git-boundary-fault / git-process / retryable | no-state-change-failure |
| `malformed-feature-output` | git-boundary-fault / git-process / retryable | no-state-change-failure |
| `feature-count-exceeded` | git-boundary-fault / git-process / retryable | no-state-change-failure |
| `observation-raced` | repository-unavailable / path-policy / retryable | no-state-change-failure |
| `recorded-observation-invalid` | recorded-evidence-invalid / observation / not-retryable | evidence-invalid / stored-evidence-invalid |
| `unsupported-observation-version` | recorded-evidence-invalid / observation / not-retryable | evidence-invalid / unsupported-observation-version |
| `inspection-policy-version-mismatch` | evidence-not-comparable / observation / not-retryable | evidence-invalid / inspection-policy-version-mismatch |

All operational no-state-change failures may later become bounded failed B2b evidence
but cannot automatically mutate repository identity. A2b2a performs no write.

## 14. Permanent test strategy

| Concern | Permanent location and proof |
|---|---|
| optional config | `config.test.ts`: absent, every partial combination, bin-only/search-only/both/neither, numeric bounds, all enumerated lexical failures, enabled dataDir normalization |
| lazy environmental failure | provider/adapter tests: missing, symlinked, and colon-containing root starts idle then permanent, never disabled |
| composition/injection | `composition.test.ts`: provider override, default disabled planning/auth behavior, zero eager calls, no buildServer dependency |
| provider states | `repository-inspector-provider.test.ts`: shared promise/result, success memoization, cooldown edges, permanent cache, restart/new instance, available fault latch, same bounded failure |
| fixture provenance | adapter test calls package-root fingerprint calculator and real parser; no deep import |
| serializer authority | source assertion forbids hash primitive; adapter output equals storage serializer/helper |
| full round trip | adapter `inspect -> SuccessfulRepositoryInspection -> verifyStored -> verifyRegisteredIdentity` succeeds |
| digest short circuit | one-byte mutation fails before JSON/A1/host counters |
| 16 inspection projections | table mutation of every field and ordered risk signals |
| nine repository projections | single-field mutation of every shared field |
| historical policy | byte/digest/projection-valid N-1 record verifies; only comparison decides comparability |
| parity/drift | real positive; missing/extra/reordered/remapped runtime values; post-available tuple drift permanently latches |
| compare cast defence | invalid wrapper yields adapter invariant fault, no assessment |
| class/reducer | all six class errors across ordinary/reaffirmation status matrices |
| all A1 mappings | one generated row per exhaustive policy entry; tuple drift cannot be assessed |
| manifest/import scope | accepted testing edge positive; web/storage additions and testing-edge removal negative; sole adapter import exact |
| D-03 containment | B1 allowlist contains no A2b2a path; fabricated repository route rejected by live A2b2a inventory |
| protected residuals | checker rejects treating a residual-bearing ID as fully closed |

Tests use fixed values and fake clocks. They create no machine-specific paths and no
child-process authority outside A1. Adapter drift tests replace only the package root.

## 15. Protected-ID proof and residual register

All 38 A2b2a acceptance IDs and their identical protected counterparts are registered.
“Closed here” means A2b2a proves the complete expected outcome. “B2b residual” is
machine-readable in the protected checker and prevents premature closure.

| IDs | A2b2a proof | Closure / exact B2b residual |
|---|---|---|
| `B2-CFG-001`, `A2B-CFG-001` | disabled config/composition preserves existing planning/auth and performs zero host calls | Closed here |
| `B2-CFG-002`, `A2B-CFG-002` | disabled provider returns bounded actionable feature-unavailable and makes zero A1 calls | B2b residual: authorized HTTP operation maps result to actionable unavailable response; unauthorized requests return first |
| `B2-CFG-003`, `A2B-CFG-003` | enabled provider creates lazily and succeeds once | B2b residual: authorization/membership/role checks complete before `get()` |
| `B2-CFG-004`, `A2B-CFG-004` | complete partial/malformed matrix fails startup rather than disabling | Closed here |
| `B2-CFG-005` | enumerated lexical inputs fail startup; environmental inputs fail permanently on first use | Closed here |
| `B2-CFG-006`, `B2A-SRC-008` | concurrent first use shares one promise/result | Closed here |
| `B2-CFG-007`, `A2B-CFG-007`, `B2A-SRC-009` | exact cooldown, permanent cache, success memoization, restart | Closed here |
| `B2-CFG-008`, `A2B-CFG-008` | provider/port results and status contain no roots/config/Git/raw evidence; operations docs are bounded | B2b residual: every common/admin HTTP response and audit metadata maintains non-disclosure |
| `A2B-CFG-005` | at least one explicit Git resolution; ambient PATH impossible | Closed here |
| `A2B-CFG-006` | feature absence does not disable storage queries or planning/auth composition | B2b residual: repository read/admin HTTP operations remain available according to their authorization policy |
| `B2-ADP-001` | exact real package-root/domain parity and creation succeeds | Closed here |
| `B2-ADP-002`, `B2A-SRC-002`, `B2A-EVID-006` | drift matrices and runtime tuple fault latch fail closed | Closed here |
| `B2-ADP-003`, `B2A-SRC-003`, `B2A-EVID-001` | storage serializer plus full producer/verifier/baseline round trip | Closed here |
| `B2-ADP-004`, `B2A-SRC-003`, `B2A-EVID-002` | digest mismatch short-circuits before parse/host | Closed here |
| `B2-ADP-005`, `B2A-SRC-004`, `B2A-EVID-003`, `B2A-EVID-004` | JSON, parser, version, and historical-policy boundary cases | Closed here |
| `B2-ADP-006`, `B2A-SRC-005`, `B2A-EVID-005` | all 16 inspection and nine repository projection mutations | Closed here |
| `B2-ADP-007`, `B2A-SRC-001`, `B2A-SRC-006`, `B2A-ASMT-001` | all six class mappings and reducer matrices | Closed here |
| `B2-ADP-008`, `B2A-SRC-007`, `B2A-ASMT-005` | exact operational codes are no-state-change | Closed here |
| `B2-ADP-009`, `B2A-ASMT-002` | core priority, all arrays retained | Closed here |
| `B2-ADP-010`, `B2A-ASMT-003` | environment priority, risk retained | Closed here |
| `B2A-ASMT-004` | risk-only exact assessment | Closed here |
| `B2A-ASMT-006` | two unavailable reasons exact; raced remains no-state-change | Closed here |
| `B2-PROC-001` | pinned proposal, independent review, complete disposition, accepted plan | Closed here after operator accepts this plan |
| `B2-SCOPE-001` | exact import/manifest scanners; A1 process anchor unchanged | Closed here |
| `B2A-SRC-010` | exact live inventory and no route/audit/event/notifier/storage/browser/CT-04B scan | Closed here |

The adversarial cases `B2-CONFIG`, `B2-ADAPTER`, `B2A-STORED-EVIDENCE`, and
`B2A-ASSESSMENT` map to the same rows. There are 30 case IDs; each must appear in a
permanent test title or the documentary register. The checker parses exactly the 38
protected IDs, records `closed-here` or `b2b-residual`, and fails if any residual text is
missing or if a residual-bearing case is marked fully satisfied.

## 16. D-03 Part 2 and forbidden-scope checks

Part 2 extends only the separate A2b2a live inventory created in commit `886ddde`:

1. add the 27 exact implementation filenames in §4;
2. keep process artifacts governed by existing slice-anchored regexes;
3. parse all 38 protected A2b2a IDs;
4. require permanent anchors for behavior proved here;
5. encode §15 residuals and prohibit full-closure reporting for them;
6. retain the frozen B1 pair and assert `CT04A2B1_ALLOWED_CHANGED_PATHS` has no A2b2a path;
7. reject a fabricated `apps/server/src/routes/repositories.ts`.

The general scope checker permits `@craftingtable/git` production import only in the
exact adapter, while preserving the accepted testing seam. It detects type, multiline,
dynamic, require, re-export, deep-import, and comment-obscured forms. Negative fixtures
cover port/provider/composition/domain/contracts/storage/web/other service imports,
child process in the adapter, web/storage manifest edges, and removal of the testing
edge.

Final diff must leave these unchanged:

```text
protected/**
work-items/CT-04/*protected*.yaml
work-items/CT-04/CT-04A2b2{,b,c}.md
packages/git/src/** except index.ts
packages/contracts/**
packages/storage/**
packages/domain/src/workspace-events*
apps/server/src/routes/**
apps/server/src/server.ts
apps/server/src/route-inventory.test.ts
apps/web/**
packages/storage/migrations/**
```

## 17. ADR and documentation

ADR-019 records:

- the exact absent/partial/valid configuration group;
- explicit Git resolution and no ambient PATH;
- enabled-only dataDir normalization;
- lexical startup versus lazy A1 environmental authority;
- the one adapter import and operation-specific port;
- storage-owned serialization/digest helpers;
- D-01 package-root fingerprint re-export;
- inspection and repository projection chains;
- D-02 comparator-owned policy comparability;
- parity limits and runtime tuple fault latch;
- provider concurrency/cooldown/permanent/restart behavior;
- closed internal reasons and durable/no-write dispositions;
- why no route, lifecycle transaction, audit, event, or notifier exists.

Architecture shows only the observation boundary. Security covers authority confinement,
non-disclosure, and fail-closed evidence. Operations documents all 12 variables, exact
defaults/bounds, startup behavior, lazy failures, and restart/cooldown policy. README and
CLAUDE describe the slice without claiming repository lifecycle availability. No UI
principles change is needed.

## 18. Deterministic implementation sequence

Only commands actually run may appear in implementation evidence.

### Slice 0 — pins and repaired baseline

```bash
git rev-parse HEAD
git merge-base --is-ancestor dd9c9699f0d86cae00fc1bf0d054224880c8dbed HEAD
git merge-base --is-ancestor 886ddded3305d028b45f078cdff1a818d25bd41f HEAD
pnpm check:scope
pnpm check:protected
sha256sum \
  protected/CT-04-protected-acceptance-spec.yaml \
  work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml \
  work-items/CT-04/CT-04A2b-protected-acceptance-supplement.yaml \
  packages/storage/migrations/0003-ct04a2a-repository-model.sql \
  packages/storage/migrations/0004-ct04a2b-repository-journal.sql
```

### Slice 1 — additive A1 export and domain correction

```bash
pnpm exec biome format --write \
  packages/git/src/index.ts \
  packages/domain/src/repository.ts \
  packages/domain/src/repository.test.ts
pnpm exec tsc -b packages/git packages/domain
pnpm exec vitest run packages/domain/src/repository.test.ts packages/git/src/comparison.test.ts
```

### Slice 2 — config, port, adapter, provider, composition

```bash
pnpm install --lockfile-only
pnpm exec biome format --write \
  apps/server/package.json \
  apps/server/src/config.ts \
  apps/server/src/config.test.ts \
  apps/server/src/composition.ts \
  apps/server/src/composition.test.ts \
  apps/server/src/services/repository-observation-port.ts \
  apps/server/src/services/repository-observation-policy.ts \
  apps/server/src/services/repository-observation-policy.test.ts \
  apps/server/src/services/repository-observation-adapter.ts \
  apps/server/src/services/repository-observation-adapter.test.ts \
  apps/server/src/services/repository-inspector-provider.ts \
  apps/server/src/services/repository-inspector-provider.test.ts
pnpm typecheck
pnpm exec vitest run \
  apps/server/src/config.test.ts \
  apps/server/src/composition.test.ts \
  apps/server/src/services/repository-observation-policy.test.ts \
  apps/server/src/services/repository-observation-adapter.test.ts \
  apps/server/src/services/repository-inspector-provider.test.ts
```

### Slice 3 — Part 2 gates, docs, and regression

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
pnpm format:check
pnpm lint
pnpm typecheck
pnpm build
pnpm test
pnpm test:e2e
pnpm check
```

### Final structural proof

```bash
rg -n "@craftingtable/git" apps packages -g '*.ts' -g '*.tsx' -g 'package.json'
rg -n "node:child_process|child_process" apps packages -g '*.ts' -g '*.tsx'
git diff --check
git diff --name-only 886ddded3305d028b45f078cdff1a818d25bd41f
git diff --exit-code 886ddded3305d028b45f078cdff1a818d25bd41f -- \
  protected/ \
  packages/git/src/command-runner.ts \
  packages/git/src/comparison.ts \
  packages/contracts/ \
  packages/storage/ \
  apps/server/src/routes/ \
  apps/server/src/server.ts \
  apps/server/src/route-inventory.test.ts \
  apps/web/ \
  work-items/CT-04/CT-04A2b2-protected-acceptance-supplement.yaml
git status --short
```

## 19. Explicit non-goals

A2b2a adds optional config, a lazy guarded observation provider, one A1 adapter,
serializer-backed evidence translation, exact inspection/repository verification, and
the class assessment correction. It adds no:

```text
repository lifecycle route or any route
server repository HTTP error mapping
authorization service or role decision
audit append or vocabulary
workspace event append or kind
notifier call, producer, or SSE behavior
repository/inspection/binding storage mutation
transaction composition
registration, inspection, or reaffirmation command
retirement, bind, or unbind behavior
repository query service or HTTP disclosure path
browser source or invalidation change
directory creation
Git mutation, remote Git, worktree, branch, ref, diff, or artifact behavior
change request, agent, verification, review, readiness, or merge behavior
ActionQueue, WorldInterface, or Exoskeleton dependency
CT-04B-or-later behavior
```

## 20. Invariant-completeness confirmation

```text
Every A1 error code has one documented mapping.
  Confirmed: §13 has exactly 35 exhaustive rows; actual tuple agreement is runtime checked.

Every stored projected field is checked against parsed observation.
  Confirmed: §9.2 checks all 16 inspection projections; §9.3 additionally checks all nine
  repository identity/version projections through an unskippable type chain.

Every provider state has concurrency, retry, and restart behavior.
  Confirmed: §7 covers six states and adds available -> permanent invariant-fault demotion.

Every feature-disabled state preserves existing planning/auth behavior.
  Confirmed: §5, §6, §7, §14, and §15 require zero host work and unchanged composition.

Every exported type is necessary for B2b but carries no raw process authority.
  Confirmed: §6 exports only the provider, operation-specific port, chained verified values,
  and closed results. Raw A1/process/config authority remains in the sole adapter.
```

## 21. Design-review reconciliation appendix

| Finding | Accepted-plan resolution |
|---|---|
| `B2A-F-01` | §3 manifest rule preserves/positively asserts testing seam |
| `B2A-F-02` | §§2.2, 9 storage serializer/digest helpers only |
| `B2A-F-03` | §§9.4, 14 full inspect-to-baseline round trip |
| `B2A-F-04` | D-01(a), §§2.1, 9.4 package-root fingerprint export |
| `B2A-F-05` | D-02(a), §§9.2, 11 comparator owns policy comparability |
| `B2A-F-06` | §§7-8 runtime tuple validation and permanent fault latch |
| `B2A-F-07` | §15 complete closure/residual register |
| `B2A-F-08` | D-03(a), §§2.4, 16 frozen B1 plus separate two-part gate |
| `B2A-F-09` | §5.3 enabled-only normalized dataDir |
| `B2A-F-10` | §5.3 unambiguous at-least-one Git resolution matrix |
| `B2A-F-11` | §10 closed reasons and durable/no-write dispositions |
| `B2A-F-12` | D-04(a), §§6.1, 9.3 chained repository identity proof |
| `B2A-F-13` | §§7, 11 compare reparse invariant fault |
| `B2A-F-14` | §§5.3, 14 exact startup/lazy failure sets |
| `B2A-F-15` | §6.2 provider/factory/clock composition injection |

Stop here. Await explicit operator approval before changing any implementation file.
