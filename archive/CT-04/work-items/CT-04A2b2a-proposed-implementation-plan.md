# CT-04A2b2a proposed implementation plan

**Status:** Proposed for independent design review; source implementation is not authorized

**Slice:** CT-04A2b2a — Repository feature and evidence boundary

**Parent:** CT-04A2b2 — Authorized repository lifecycle and CT-04A parent fan-in

**Planning checkout:** `0c1918bafccc47e8d89599ab1486642f235a190e`

**Pinned source archive head:** `dd9c9699f0d86cae00fc1bf0d054224880c8dbed`

**Date:** 2026-07-31

## 1. Authority, lineage, and mandatory stop

This is the Stage 1 source-specific proposal. It authorizes no production edit.
The required next sequence is:

```text
independent design review of this proposal
    -> operator disposition of every finding
    -> disposition artifact and accepted implementation plan
    -> operator approval of the accepted plan
    -> only then A2b2a implementation
```

This turn creates only this proposal. It does not create an accepted plan,
implementation report, migration, source edit, or implementation commit.

The local checkout is a direct child of the archive pin:

```text
HEAD    0c1918bafccc47e8d89599ab1486642f235a190e
parent  dd9c9699f0d86cae00fc1bf0d054224880c8dbed
commit  pre-ct04a2b2 chore: stage design package
```

`git diff dd9c969..HEAD` contains only the 11 A2b2 planning-package files.
There is no production, test, migration, manifest, lockfile, ADR, or existing
documentation difference from the pinned source. The worktree was clean before
this proposal was created.

Accepted immutable facts reproduced at the planning checkout:

```text
migration 0003  526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4
migration 0004  409553eb1c6a7eb978be9fc2dae6ddb9eb1d51e0f016f4b5c6d571edbaf5f29e
CT-04 protected  ce7a101ca3a988cc1b6395653baa0bfca885d057109eae12f9c5d9544f090f64
A2 supplement     1000d564f01712b7dc2c59570dbfd6c498192f77c1cc5c13715e55c4b656429c
A2b supplement    255fe8b61ede97aa3366ab5e81214031ef2053e89c0246b0b9c4c7b14278ebad
```

## 2. Reconciled current seams

### 2.1 Accepted A1 seam

`packages/git/src/index.ts` is the only package-root API. It exports the
observation-only factory, parser, comparator, runtime constants, and closed A1
types. Its only production process import remains:

```text
packages/git/src/command-runner.ts -> node:child_process
```

No production server file imports `@craftingtable/git`. A1 performs no import-time
lookup or spawn. Inspector creation is asynchronous and returns a result union.
Inspection returns a branded parsed observation or a bounded typed error.

No A1 source or test file changes in A2b2a.

### 2.2 Accepted A2a seam

`packages/domain/src/repository.ts` owns:

- stored observation/risk/difference/error vocabularies;
- successful and failed inspection records;
- `RepositoryObservationAssessment` and `reduceRepositoryState`;
- the status reason `repository-class-changed`.

The current assessment union has no `repository-class-changed` variant. Its
ordinary and reaffirmation reducer switches therefore cannot produce the already
accepted `identity-mismatch / repository-class-changed` transition.

`SuccessfulRepositoryInspection` contains the exact stored JSON and digest plus
16 observation projections. Comparison arrays are inspection interpretation and
are not fields in A1 observation JSON.

`packages/storage/src/repository-types.ts` owns exact UTF-8 digest helpers and
storage write/read types. A2b2a neither changes nor calls a storage mutator.
Migrations 0003 and 0004 remain immutable.

### 2.3 Accepted B1 seam

The five repository event kinds, schema-4 correlations, fail-closed mapper,
browser invalidation, and safe descriptions already exist. A2b2a consumes none of
those write paths and introduces no event producer. Unchanged and failed
inspections deliberately have no workspace event; B2b retains that lifecycle proof.

### 2.4 Current server seam

`apps/server/src/config.ts:4-13` has one flat `ServerConfig` and no repository
feature group. `configFromEnv()` is synchronous.

`apps/server/src/composition.ts:19-28` exposes auth, workspace, planning, work-item,
notifier, and stream services. `createServices()` creates no Git/provider object.

`apps/server/src/server.ts:23-30` and the route inventory contain no repository
dependency or route. They remain unchanged.

`apps/server/package.json` has no `@craftingtable/git` dependency.

### 2.5 Current gate gap discovered during reconciliation

The baseline `pnpm check:scope` passes. The focused domain/config/scope tests pass
(3 files, 45 tests). `pnpm check:protected` currently fails because the B1
changed-path allowlist recognizes `CT-04A2b2.md` but not ten other files in the
new pinned A2b2 planning package. This is a cumulative-inventory transition gap,
not a production defect. The implementation must update the checker so it:

1. continues proving the accepted B1 tree and immutable pins;
2. admits the exact A2b2 planning package already present at this checkout;
3. admits only the accepted A2b2a implementation tree after review;
4. requires every non-documentary A2b2a protected ID to have a permanent
   test-title anchor.

No protected specification is edited to repair the gate.

## 3. Dependency direction and exact authority boundary

```text
@craftingtable/domain
        ^
        | copied durable vocabulary and pure reducer
        |
server repository-observation-port / policy
        ^
        |
server repository-observation-adapter  -> @craftingtable/git
        ^
        |
server lazy provider -> later authorized B2b service
```

The one and only production server file permitted to import
`@craftingtable/git` is exactly:

```text
apps/server/src/services/repository-observation-adapter.ts
```

No barrel re-export of A1 is added. No other server file imports A1, including
type-only, dynamic, require, or re-export syntax. The adapter imports only the
package root. It does not deep-import A1 files.

`@craftingtable/server` gains the workspace dependency on `@craftingtable/git`.
The lockfile records only that workspace importer edge. Domain, contracts,
storage, web, planning, agents, and testing manifests remain unchanged.

## 4. Exact target tree and recalculated budget

`+` is new and `~` is modified. No other file is permitted without returning to
design review.

```text
~ README.md
~ CLAUDE.md
~ apps/server/package.json
~ pnpm-lock.yaml

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

Budget based on the current source and the concrete types/algorithms below:

```text
26 changed/new files
8 new TypeScript modules/tests: 4 production modules and 4 test modules
2,130-3,150 total added/changed lines, allocated below
2 production layers: domain and server
1 development-assurance layer: gates and documentation
1 already-accepted host observation authority composition
0 new persistence boundaries
0 migrations
0 HTTP/browser layers
```

The reviewable line budget is allocated, not left as one undifferentiated
estimate:

| Area | Files | Added/changed-line budget |
|---|---:|---:|
| domain constant, class variant, reducer tests | 2 | 80-140 |
| server config/composition and tests | 4 | 300-450 |
| port/policy/adapter/provider production | 4 | 500-750 |
| observation/provider focused tests | 3 | 700-1,000 |
| scope/protected gates and tests | 4 | 350-500 |
| manifests/lockfile | 2 | 20-50 |
| ADR and product documentation | 7 | 180-260 |
| **Total** | **26** | **2,130-3,150 ceiling** |

The 3,150-line upper bound is the implementation stop/review ceiling. Crossing
that ceiling or the 35-file stop condition requires replanning rather than
silently consuming more budget.

The protocol trigger is roughly 60 files, more than one new authority boundary,
or a major schema plus substantial browser surface. This slice is below every
trigger. Its policy, adapter, and provider are separate modules but one coherent
evidence boundary, not separate authorities. **No further fan-out is proposed.**

Stop and return to planning if implementation needs a second Git import,
another process authority, a migration, storage mutation, route, notifier,
event producer, browser source, or more than roughly 35 files.

## 5. Optional repository configuration

### 5.1 Server-owned type

`config.ts` adds no A1 import. It exports a discriminated immutable group:

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

`ServerConfig` gains `repositoryFeature: RepositoryFeatureConfig`. Arrays and
objects are copied and frozen before return. The adapter alone translates this
server-owned value to A1 `RepositoryInspectorOptions`.

### 5.2 Exact environment variables

The complete repository-related set is:

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

There is no Boolean enable flag. Presence is the operator's explicit intent.

### 5.3 Disabled, partial, and valid behavior

```text
none of the 12 variables present
    repositoryFeature = {enabled:false}
    daemon starts
    no A1 factory call, filesystem check, executable lookup, or spawn
    existing authentication/planning/runtime behavior is unchanged

any variable present
    explicit group requested
    an empty string counts as present and malformed

explicit group without CRAFTINGTABLE_REPOSITORY_ROOTS
or without both GIT_BIN and GIT_SEARCH_PATH
    synchronous startup configuration error

complete structurally valid group
    immutable enabled options retained
    no A1 creation at startup
    first later authorized provider get performs A1 creation
```

Both Git resolution variables may be present because accepted A1 semantics make
the explicit executable win and ignore the search path. There is never ambient
`PATH` fallback in production; at least one explicit resolution variable is
mandatory whenever the feature is enabled.

`CRAFTINGTABLE_REPOSITORY_ROOTS` and
`CRAFTINGTABLE_GIT_SEARCH_PATH` use `node:path.delimiter`. They must contain
1-32 nonempty, unique, absolute, lexically normalized entries with no NUL and a
maximum of 4096 UTF-8 bytes each. Source roots must be pairwise disjoint in both
ancestor directions and must be disjoint from the entire configured `dataDir`
subtree. Search-path entries are directories to which A1 appends `git`; each is
absolute and normalized. `GIT_BIN` is one absolute normalized path.

The artifact and managed-worktree roots default to `<dataDir>/artifacts` and
`<dataDir>/worktrees`. An explicit value must be absolute, normalized, a strict
descendant of `dataDir`, and disjoint from the other child root. A2b2a creates
neither directory. Because A1 rejects nested members inside its `reservedRoots`
array, the adapter passes exactly `[dataDir]`; that single reservation already
covers both child roots. The two named child roots remain immutable future path
policy, not created capability.

Synchronous configuration proves syntax and lexical topology. Existing-directory,
realpath, symlink-component, POSIX/UID, executable, Git-version, and colon-ceiling
checks remain A1's single source of truth and occur lazily on first authorized
use. Thus B2-CFG-005 startup coverage uses relative, nonnormalized, duplicate,
and overlapping roots; environmental invalidity becomes a typed first-use
provider failure rather than duplicated filesystem policy in `config.ts`.

### 5.4 Exact numeric bounds

The server validates the accepted A1 bounds before retaining options:

| Variable | Default | Accepted rule |
|---|---:|---|
| `GIT_TIMEOUT_MS` | 5000 | integer 100-30000 |
| `GIT_CREATION_TIMEOUT_MS` | `2 * command + 5000` | integer 1000-90000 and `>= command` |
| `GIT_INSPECTION_TIMEOUT_MS` | `2 * command + 5000` | integer 1000-90000 and `>= 2 * command` |
| `GIT_STDOUT_LIMIT_BYTES` | 65536 | integer 16384-1048576 |
| `GIT_STDERR_LIMIT_BYTES` | 65536 | integer 1024-1048576 |
| `GIT_TERMINATION_GRACE_MS` | 250 | integer 50-2000 |
| `REPOSITORY_PROVIDER_RETRY_DELAY_MS` | 5000 | integer 100-60000 |

Malformed, fractional, out-of-range, or incoherent explicit values fail startup.
No value is read from request data or exposed through an HTTP contract.

## 6. Internal observation port: authority does not escape

`repository-observation-port.ts` imports domain types only. It defines the
smallest B2b-facing internal surface:

```ts
interface RepositoryObservationPort {
  inspect(input: {
    readonly requestedPath: string;
    readonly signal?: AbortSignal;
  }): Promise<RepositoryObservationResult>;

  verifyStored(
    inspection: SuccessfulRepositoryInspection,
  ): StoredRepositoryObservationVerificationResult;

  compare(
    recorded: VerifiedStoredRepositoryObservation,
    current: RepositoryObservationEvidence,
  ): RepositoryObservationComparisonResult;
}
```

Server-owned result types carry only:

- exact JSON/digest and durable observation projections on success;
- closed normalized A1 failure fields on an A1 failure;
- closed stored-integrity reason on a stored-evidence failure;
- all three difference arrays, all three equality booleans, and one assessment
  on successful comparison.

They carry no A1 branded type, `RepositoryInspector`, inspector options,
executable, search path, roots, command kind, argv, environment, stdout, stderr,
spawn handle, raw process result, or factory. No method accepts an arbitrary
command or option array.

`VerifiedStoredRepositoryObservation` is constructible only by the adapter's
successful verifier. Comparison reparses its exact JSON through A1 and rechecks
its projections, so a structural cast or stale wrapper cannot bypass the
runtime boundary.

The provider returns the port only after its factory succeeds. Later B2b
services may receive this operation-specific observation authority after
authorization; they never receive A1 process authority.

Stored-integrity failures are a distinct server-internal union, not fabricated
`errorOrigin:'a1'` records. A2b2a maps them to the domain assessment but performs
no durable inspection write. B2b must consume this truthful internal result
under its separately reviewed evidence-write policy; A2b2a does not widen
migration 0003's accepted failure taxonomy.

Every exported port type is required either to inject the port into B2b or to
describe one of its method results. Test-only A1 facades are not exported from
production. Adapter tests use Vitest module replacement at the package-root
boundary instead of adding a raw-inspector dependency-injection API.

## 7. Lazy provider state machine and restart policy

`repository-inspector-provider.ts` imports the server port/factory, never A1.
Its internal closed state is:

```text
disabled
idle
creating(shared promise)
available(memoized port)
cooldown(bounded failure, retry-not-before)
permanently-unavailable(bounded failure)
```

Its public status is the corresponding bounded discriminant. Status and failure
results contain no root, executable, search path, raw A1 evidence, or config
value.

Exact transitions:

| State | `get()` and concurrency | Failure/retry | Restart |
|---|---|---|---|
| disabled | returns `feature-disabled`; factory count stays zero | never retries in this process | recreated disabled if vars remain absent |
| idle | first caller installs one creation promise before awaiting | result chooses available/cooldown/permanent | recreated idle |
| creating | every concurrent caller awaits the same promise and receives the same result object | caller cancellation does not cancel shared creation; A1's aggregate creation deadline bounds it | in-memory promise is lost; new process starts idle |
| available | every caller receives the same port; no further creation | success memoized for process lifetime | recreated idle and lazily revalidated |
| cooldown | calls before deadline return the same bounded failure with no creation | when monotonic deadline expires, first caller transitions through creating; retryable A1 failures only | recreated idle |
| permanently-unavailable | every call returns the same bounded failure | configuration-required, not-retryable, vocabulary mismatch, or unexpected adapter invariant fault; no retry before restart | recreated idle so corrected host/config/package state is re-evaluated |

The cooldown is exactly `retryDelayMs`, default 5000 ms, measured with an
injected monotonic clock (`performance.now()` in production). There is no
exponential backoff, background timer, eager retry, or stale-success eviction.
A retry after cooldown is again concurrency-deduplicated.

A factory throw is caught and normalized to an internal adapter fault cached
until restart. An explicit creation failure never becomes `disabled` and never
falls back to ambient configuration.

`composition.ts` creates one provider per runtime and exposes it in the internal
`ServiceSet`; `buildServer` receives no repository dependency. Creating services
does not call `provider.get()`.

## 8. A1/domain parity algorithm

Parity runs synchronously in the sole adapter before any A1 inspector creation.
Failure returns `adapter-vocabulary-mismatch`, is nonretryable for the process,
and prevents every lifecycle operation.

The adapter performs these exact checks:

1. `REPOSITORY_OBSERVATION_VERSION` equals the domain's stored observation
   version.
2. `REPOSITORY_INSPECTION_POLICY_VERSION` equals a new domain current-policy
   constant. Stored inspection fields remain `number` so historical mismatch is
   still representable.
3. risk scope version and exact regex equal the domain constants.
4. ordered risk signals equal the domain array.
5. ordered A1 error codes equal the domain A1 error-code array.
6. for every code, A1's exported subject map equals the domain subject map and
   the complete server policy table below.
7. closed server `Record<Union, true>` tables are compile-time exhaustive over
   A1 core/environment/risk difference types; their ordered keys equal the three
   domain arrays at runtime.
8. closed compile-time tables over A1 subject/category/operation/retryability
   types equal the domain runtime arrays.
9. every actual A1 error is normalized only after its code, subject, category,
   operation, and retryability agree with the table. Drift becomes an adapter
   invariant failure, never a guessed assessment.

Array comparison checks length and each ordered element; it does not use
one-directional inclusion. Record checks compare the exact key set. This makes
both additions and removals fail closed.

The production adapter test uses the real package root for the positive parity
case and isolated Vitest module replacement for missing, extra, reordered, and
remapped vocabulary cases. No production injection seam exposes A1.

## 9. Exact stored-evidence verification

Input is one complete `SuccessfulRepositoryInspection`. The adapter executes
these steps in order and stops at the first failure:

```text
1. require the adapter's A1/domain parity proof to have succeeded
2. SHA-256 the exact UTF-8 bytes of observationJson
3. require observationSha256 to be exactly 64 lowercase hexadecimal characters,
   then compare it byte-for-byte with the computed lowercase digest
4. JSON.parse the exact stored string once
5. call A1 parseRecordedObservation(parsed unknown)
6. require parsed inspection policy to equal the current accepted policy
7. compare every stored observation projection to the parsed observation
8. return VerifiedStoredRepositoryObservation
```

Digest mismatch returns
`evidence-invalid / stored-evidence-digest-mismatch` before JSON parse, A1 parse,
A1 comparison, A1 live inspection, or any host access.

Invalid JSON returns `evidence-invalid / stored-evidence-invalid`. A1 parser
errors map exactly: `recorded-observation-invalid` to `stored-evidence-invalid`,
`unsupported-observation-version` to the same named reason, and
`inspection-policy-version-mismatch` to the same named reason. Current-policy
mismatch is classified identically even before a live comparison.

The projected-column comparison is strict scalar equality plus ordered-array
equality over all 16 projected fields:

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
| `riskSignals` | `riskScan.signals`, same length/order/elements |

The table contains all 16 accepted observation-projection properties; the
implementation and tests enumerate them explicitly, including ordered equality
for the `riskSignals` array.

`gitVersion` is runtime-validated inside the parsed exact JSON but has no A2a
projected column; its exact bytes remain covered by the full-record digest.
`observationJson` and `observationSha256` are verified by steps 2-5. Base
inspection identity/ownership fields and the three optional comparison arrays
are not A1 observation projections and are therefore not falsely compared to
the observation.

Any projected mismatch returns `evidence-invalid / stored-evidence-invalid` and
names only a bounded field discriminator internally; it includes neither the
stored nor parsed path/value. No live host inspection occurs during stored
verification.

## 10. Comparison, assessment priority, and evidence preservation

`inspect()` serializes the successful A1 parsed observation exactly once with
`JSON.stringify`, hashes those exact UTF-8 bytes, and derives all projections
from that same object. It returns server-owned evidence, not the A1 brand.

`compare()` reparses/revalidates both inputs through A1, calls
`compareRepositoryObservations`, and on success returns all of:

```text
coreDifferences
environmentalDifferences
riskDifferences
sameCoreIdentity
sameEnvironmentalEvidence
sameRiskScanEvidence
assessment
```

Difference arrays retain A1's deterministic order and are never dropped when a
higher-priority assessment wins. Assessment priority is:

```text
nonempty core          -> core-identity-changed(coreDifferences)
else nonempty env      -> environment-evidence-changed(environmentalDifferences)
else nonempty risk     -> risk-evidence-changed(riskDifferences)
else                   -> same
```

An A1 failure with subject `repository-class-changed` is mapped before generic
operational handling and becomes the explicit class assessment. No class code
can become a core fingerprint difference, unavailable assessment, or generic
operational identity judgment.

## 11. Domain correction: `repository-class-changed`

Add this closed assessment variant:

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

`validateAssessment()` rejects any other reason. `applyAssessment()` maps it
from active, unavailable, or identity-evidence-changed to:

```text
identity-mismatch / repository-class-changed
```

The reaffirmation switch handles it alongside core mismatch and applies the
same transition. Identity-mismatch, evidence-blocked, and retired terminal
rules remain unchanged. Property/table tests add the class variant to every
ordinary status and reaffirmation assessment matrix and test invalid reasons.

No status, status reason, inspection error code, storage field, contract, or
migration vocabulary changes.

## 12. Complete A1 error-code-to-assessment table

The policy table is a compile-time exhaustive `Record` over the A1 error-code
union. It also asserts the accepted subject/category/retryability tuple before
mapping.

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

Operational no-state-change codes remain eligible to produce bounded failed
evidence in B2b, but the A2b2a reducer result cannot change repository identity
state. In particular, `observation-raced` does not map to unavailable despite
its A1 subject; its exact code wins.

## 13. Fixture strategy and permanent proof locations

No fixture adds child-process authority outside A1. No test deep-imports the A1
runner or creates a machine-specific path.

`repository-observation-adapter.test.ts` uses:

- fixed synthetic observation JSON whose fingerprint is calculated by the
  accepted length-prefixed algorithm;
- the real package-root parser/comparator for the positive case;
- Vitest package-root module replacement for parity drift, creation errors,
  inspect errors, and deterministic comparison arrays;
- one table row per A1 error code, generated from the exhaustive policy table;
- single-field mutation over every stored projection plus JSON/digest/order
  mutations.

`repository-inspector-provider.test.ts` uses a server-owned fake port factory,
deferred promises, and a monotonic fake clock. It proves one in-flight call,
same-object fan-in, lifetime success memoization, cooldown edges, permanent
failure, disabled behavior, unexpected throw, and restart-by-new-instance.

`composition.test.ts` uses temporary SQLite storage and default disabled config.
It proves service/runtime construction, auth/planning composition, and stored
repository query primitives remain available without invoking the factory. It
adds no repository route.

Permanent proof locations:

| Concern | File |
|---|---|
| optional/partial/numeric/root config | `apps/server/src/config.test.ts` |
| disabled composition and no eager creation | `apps/server/src/composition.test.ts` |
| concurrency/cache/restart/non-disclosure | `apps/server/src/services/repository-inspector-provider.test.ts` |
| parity, exact bytes, projections, comparison, error mapping | `apps/server/src/services/repository-observation-adapter.test.ts` and `repository-observation-policy.test.ts` |
| class assessment/reducer | `packages/domain/src/repository.test.ts` |
| sole import/dependency/forbidden scope | `scripts/check-forbidden-scope.test.mjs` |
| all protected ID anchors/cumulative tree/pins | `scripts/check-ct04-protected-package.test.mjs` |
| existing planning/auth/route regressions | existing server suites plus route inventory |

## 14. Acceptance, adversarial, and protected mapping

The acceptance matrix and protected supplement contain the same 38 A2b2a IDs.
The adversarial matrix contains 30 A2b2a cases. Every ID maps below; duplicated
acceptance/protected IDs share the same proof.

### 14.1 Configuration IDs

| IDs | Permanent proof |
|---|---|
| `B2-CFG-001`, `A2B-CFG-001` | config disabled object; composition/default server auth+planning regression; zero factory calls |
| `B2-CFG-002`, `A2B-CFG-002` | provider disabled `get()` returns bounded actionable discriminant; factory/A1 count zero |
| `B2-CFG-003`, `A2B-CFG-003` | valid explicit config, idle provider, first `get()` creates once and returns port |
| `B2-CFG-004`, `A2B-CFG-004` | every partial/empty/relative/incoherent group fails `configFromEnv()` |
| `B2-CFG-005` | duplicate/ancestor/data-root overlap and invalid normalized syntax fail startup |
| `B2-CFG-006`, `B2A-SRC-008` | deferred factory plus concurrent `get()` fan-in proves one creation and same result |
| `B2-CFG-007`, `A2B-CFG-007`, `B2A-SRC-009` | fake clock proves exact cooldown and process-lifetime permanent cache policy |
| `B2-CFG-008`, `A2B-CFG-008` | public provider status/failure serialization contains no roots, executable/search path, or A1 evidence; B2b retains authorization-before-get proof |
| `A2B-CFG-005` | enabled config requires explicit bin/search; adapter never omits both; ambient `PATH` cannot be selected |
| `A2B-CFG-006` | disabled provider is orthogonal to storage queries and existing planning/auth composition; B2b retains future common/admin route proof |

### 14.2 Adapter and source IDs

| IDs | Permanent proof |
|---|---|
| `B2-ADP-001` | real package-root/domain exact parity succeeds before creation |
| `B2-ADP-002`, `B2A-SRC-002`, `B2A-EVID-006` | missing/extra/reordered/remapped constant matrix fails adapter permanently |
| `B2-ADP-003`, `B2A-SRC-003`, `B2A-EVID-001` | exact bytes/digest/A1 parse/all projections returns verified wrapper |
| `B2-ADP-004`, `B2A-SRC-003`, `B2A-EVID-002` | one-byte digest mismatch stops before JSON/A1/host counters |
| `B2-ADP-005`, `B2A-SRC-004`, `B2A-EVID-003`, `B2A-EVID-004` | JSON invalid, A1 invalid, unsupported observation, and policy mismatch return exact integrity assessments |
| `B2-ADP-006`, `B2A-SRC-005`, `B2A-EVID-005` | table mutation of each projected property fails without leaking values |
| `B2-ADP-007`, `B2A-SRC-001`, `B2A-SRC-006`, `B2A-ASMT-001` | all six class errors plus complete reducer status/reaffirm matrix produce class-specific mismatch |
| `B2-ADP-008`, `B2A-SRC-007`, `B2A-ASMT-005` | exact operational-code table produces no-state-change-failure |
| `B2-ADP-009`, `B2A-ASMT-002` | core+environment+risk retains all arrays and selects core |
| `B2-ADP-010`, `B2A-ASMT-003` | environment+risk retains both and selects environment |
| `B2A-ASMT-004` | risk-only selects risk assessment with exact array |
| `B2A-ASMT-006` | two unavailable codes map to their exact reasons; raced remains no-state-change |

### 14.3 Process and scope IDs

| ID | Permanent proof |
|---|---|
| `B2-PROC-001` | this pinned proposal, independent design review, operator disposition, and later accepted-plan hash chain; documentary until review occurs |
| `B2-SCOPE-001` | exact import scanner and manifest rule permit A1 only in the named adapter; child-process anchor remains only A1 runner |
| `B2A-SRC-010` | exact changed-path inventory, unchanged route inventory, and negative scans for routes/audit/events/notifier/storage/browser/CT-04B terms |

The protected checker parses exactly the 38 IDs with `slice: CT-04A2b2a`,
expands compact test-title ranges, exempts only the documentary process item,
and fails on a missing anchor. It does not edit or reinterpret expected outcomes.

## 15. Forbidden-scope, dependency, and immutability checks

`check-forbidden-scope.mjs` gains one exact allow rule:

```text
@craftingtable/git is a permitted production import
iff relative path is
apps/server/src/services/repository-observation-adapter.ts
```

It rejects type imports, multiline imports, dynamic imports, requires, re-exports,
and comment-obscured variants everywhere else. It also requires the workspace
manifest dependency to occur only in `apps/server/package.json`. Existing
`node:child_process`, Exo Stack, A2a purity, B1 exact-edge, tooling separation,
NUL, and migration-literal checks remain intact.

Negative fixtures prove:

- the same import in port, provider, composition, domain, contracts, storage,
  web, or another server service fails;
- a deep A1 import fails;
- child process in the adapter still fails;
- a second server manifest dependency/import fails;
- ActionQueue, WorldInterface, and Exoskeleton remain absent.

The protected checker transitions from B1-only current-worktree inventory to a
cumulative exact A2b2a inventory while preserving B1 hashes/proof anchors. It
admits the 11 pinned A2b2 planning files and this review chain explicitly, not by
a broad directory glob.

The final diff must show no change to:

```text
protected/
work-items/CT-04/*protected*.yaml
work-items/CT-04/CT-04A2b2{,b,c}.md
packages/git/**
packages/contracts/**
packages/storage/**
packages/domain/src/workspace-events*
apps/server/src/routes/**
apps/server/src/server.ts
apps/server/src/route-inventory.test.ts
apps/web/**
packages/storage/migrations/**
```

## 16. ADR and documentation changes

Create ADR-019 recording:

- absent-versus-explicit configuration and exact environment group;
- production explicit Git resolution and no ambient fallback;
- lexical startup validation versus lazy A1 environmental validation;
- one adapter import and server-owned port types;
- parity algorithm and fail-closed drift behavior;
- exact evidence digest/parse/projection order;
- class/core/environment/risk/operational assessment priority;
- provider concurrency, success memoization, cooldown, permanent cache, and
  restart behavior;
- why no lifecycle route, durable mutation, event, or notifier exists yet.

Update architecture to show the newly composed observation boundary but no
lifecycle service. Update security with config non-disclosure, no raw process
authority outside A1, and stored-evidence fail-closed behavior. Update operations
with all 12 variables, defaults/bounds, disabled startup, partial startup error,
lazy first-use failures, retry policy, and no directory creation. Update the ADR
index, README, and CLAUDE to describe A2b2a accurately without claiming usable
repository registration.

No UI-principles change is needed because there is no browser surface.

## 17. Deterministic implementation sequence and commands

Only commands actually run may appear in later implementation evidence.

### Slice 0 — baseline and immutable pins

```bash
git rev-parse HEAD
git merge-base --is-ancestor dd9c9699f0d86cae00fc1bf0d054224880c8dbed HEAD
git diff --name-only dd9c9699f0d86cae00fc1bf0d054224880c8dbed..HEAD
sha256sum \
  protected/CT-04-protected-acceptance-spec.yaml \
  work-items/CT-04/CT-04A2-protected-acceptance-supplement.yaml \
  work-items/CT-04/CT-04A2b-protected-acceptance-supplement.yaml \
  packages/storage/migrations/0003-ct04a2a-repository-model.sql \
  packages/storage/migrations/0004-ct04a2b-repository-journal.sql
```

### Slice 1 — domain correction

```bash
pnpm exec biome format --write \
  packages/domain/src/repository.ts \
  packages/domain/src/repository.test.ts
pnpm exec tsc -b packages/domain
pnpm exec vitest run packages/domain/src/repository.test.ts
```

### Slice 2 — config, port/policy, adapter, and provider

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

### Slice 3 — permanent gates, docs, and complete regression

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
rg -n "@craftingtable/git" apps packages \
  -g '*.ts' -g '*.tsx' -g 'package.json'
rg -n "node:child_process|child_process" apps packages \
  -g '*.ts' -g '*.tsx'
git diff --check
git diff --name-only 0c1918bafccc47e8d89599ab1486642f235a190e
git diff --exit-code 0c1918bafccc47e8d89599ab1486642f235a190e -- \
  protected/ \
  packages/git/ \
  packages/contracts/ \
  packages/storage/ \
  apps/server/src/routes/ \
  apps/server/src/server.ts \
  apps/server/src/route-inventory.test.ts \
  apps/web/ \
  work-items/CT-04/CT-04A2b2-protected-acceptance-supplement.yaml
git status --short
```

The `packages/storage/` no-diff command intentionally includes both migrations
and repository primitives. The target has no legitimate storage edit.

## 18. Explicit forbidden behavior and completion boundary

A2b2a introduces only optional config, a lazy observation provider, one A1
adapter, exact evidence verification/translation, and the class assessment
correction.

It introduces **no**:

```text
repository lifecycle route or any route
server error-response mapping for repository operations
authorization service or role check
audit append or new audit vocabulary
workspace event append or new event kind
notifier call or producer
SSE behavior
repository, inspection, or binding storage mutation
transaction composition
registration, explicit inspection, or reaffirmation command
retirement, bind, or unbind behavior
repository query service or HTTP disclosure path
browser fetch, model, route, page, component, or invalidation change
directory creation
Git mutation, remote Git, worktree, branch, ref, diff, or artifact behavior
change request, agent, verification, review, readiness, or merge behavior
ActionQueue, WorldInterface, or Exoskeleton dependency
CT-04B-or-later behavior
```

Feature-disabled state preserves all existing planning/authentication behavior:
the runtime composes a disabled provider that performs no host work, and no
existing service or route depends on provider availability.

## 19. Invariant-completeness pass

```text
Every A1 error code has one documented mapping.
    Confirmed: all 35 codes appear exactly once in section 12; the exhaustive
    Record and table-driven test make omission/addition a compile/test failure.

Every stored projected field is checked against parsed observation.
    Confirmed: all 16 observation-projection properties are enumerated in
    section 9; exact JSON/digest are checked first; non-observation metadata and
    comparison arrays are explicitly excluded rather than silently ignored.

Every provider state has concurrency, retry, and restart behavior.
    Confirmed: disabled, idle, creating, available, cooldown, and permanently
    unavailable are fully specified in section 7.

Every feature-disabled state preserves existing planning/auth behavior.
    Confirmed: config, provider, composition, existing server suites, and absence
    of a buildServer dependency prove this in sections 5, 7, 13, and 14.

Every exported type is necessary for B2b but carries no raw process authority.
    Confirmed: section 6 limits exports to the operation-specific port and its
    closed results; A1 types, inspector/options/factory/argv/env/process output
    remain inside the sole adapter.
```

## 20. Stage 1 handoff

The proposal is ready for independent design review. Review should challenge in
particular:

1. whether the 12-variable configuration group is the smallest operable set;
2. whether lexical startup validation versus lazy A1 environmental validation
   exactly satisfies B2-CFG-005;
3. whether stored-integrity result provenance remains sufficient for B2b without
   widening A2a's immutable failed-inspection taxonomy;
4. whether every current-policy and projection field is checked at the correct
   boundary;
5. whether provider permanent-versus-cooldown classification is correct for all
   creation failures;
6. whether the cumulative protected checker preserves B1 rather than merely
   widening its allowlist;
7. whether any exported server type accidentally provides raw A1 authority.

Stop here. Do not create the disposition or accepted plan, and do not implement
source until the independent review and operator disposition are complete.
