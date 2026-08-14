# CT-04A2b2b implementation guidance

## 1. Purpose

This is source-specific guidance, not implementation authorization. The Phase A plan may refine file names and internal class boundaries while preserving every contract invariant.

## 2. Recommended dependency direction

```text
routes
  ↓
repository query/lifecycle services
  ↓                ↓
workspace auth     repository observation port/provider
  ↓                ↓
storage repositories     accepted A1 adapter
  ↓
audit + workspace events
```

Rules:

- routes never import `@craftingtable/git` or storage row types;
- only the accepted adapter imports `@craftingtable/git`;
- storage never imports server or Git;
- lifecycle services receive `RepositoryInspectorProvider` or a narrower acquisition port through dependency injection;
- public contracts never expose provider, child-process, raw observation, or path-policy types.

## 3. Recommended server modules

```text
apps/server/src/services/
├── repository-query-service.ts
├── repository-lifecycle-service.ts
├── repository-response-mapper.ts
├── repository-lifecycle-errors.ts
└── existing observation/provider files

apps/server/src/routes/
└── repositories.ts
```

A separate registration and inspection service is acceptable if the accepted plan demonstrates a better boundary. Do not scatter one lifecycle transaction across route callbacks.

## 4. Fresh-observation comparison extension

Add to `RepositoryObservationPort`:

```ts
compareFresh(
  first: RepositoryObservationEvidence,
  second: RepositoryObservationEvidence,
): RepositoryObservationComparisonResult;
```

Recommended adapter behavior:

1. verify each `observationJson` against its exact digest;
2. parse JSON;
3. parse through A1;
4. compare every evidence projection with the parsed observation;
5. require equal supported observation and policy versions;
6. call accepted A1 comparison;
7. normalize differences and assessment through the accepted policy;
8. latch invariant failure on impossible vocabulary/shape drift.

Do not construct a synthetic `RegisteredRepository` or `SuccessfulRepositoryInspection` merely to reuse the stored-baseline method.

## 5. Standalone inspection append extension

Recommended storage API:

```ts
interface AppendRepositoryInspectionAttemptInput {
  workspaceId: WorkspaceId;
  repositoryId: RepositoryId;
  expectedVersion: number;
  inspection: InspectionWrite & {
    kind: 'verification' | 'reaffirmation';
  };
}

appendInspectionAttempt(input): InspectionAppendResult;
```

`appendVerification` may delegate to this method to preserve accepted tests. The implementation must continue to reject:

- `registration` kind;
- terminal repository status;
- foreign workspace/repository;
- stale repository version;
- duplicate inspection ID;
- success/failure field coupling violations.

No schema migration is required.

## 6. Query service

Recommended methods:

```text
listRepositories(context, workspaceId)
repositoryDetail(context, workspaceId, repositoryId)
repositoryAdminDetail(context, workspaceId, repositoryId)
inspectionHistory(context, workspaceId, repositoryId)
```

All use read transactions and stored summaries only. No provider access.

The response mapper should parse every outbound value through the shared strict contract before route send.

## 7. Authorization helper

The repository lifecycle needs one helper that preserves existing non-disclosure while adding repository-action denial audit.

Recommended semantics:

```text
nonmember / missing workspace
    WorkspaceService records workspace.access.denied
    throw NotFound
    no repository-action audit

known active member with insufficient role
    append repository.<action> outcome denied
    throw Forbidden
    no provider/host call

allowed role
    continue
```

Do not weaken or duplicate session/CSRF/origin checks; routes still use `authorizeMutation` before calling services.

## 8. Provider acquisition helper

Map provider outcomes to a generic service failure:

```text
feature-disabled
creating/temporary cooldown failure
permanent creation failure
adapter invariant failure
```

Public API returns 503 `service-unavailable` with bounded messages. Audit metadata may identify a small allowlisted failure class but not internal root paths, Git executable, retries, or raw exception text.

No inspection row is written because no port observation occurred.

## 9. Exact stored-baseline verification helper

For an existing repository:

```text
load acceptedEnvironmentInspectionId
load that successful inspection
port.verifyStored
port.verifyRegisteredIdentity
```

If either fails:

- construct a failed inspection with `origin:'storage-integrity'` and the accepted stored error vocabulary;
- reduce with the returned `evidence-invalid` assessment;
- commit inspection, transition, audit, and status event atomically;
- do not call `port.inspect`;
- return the recorded inspection result.

## 10. Registration service details

### 10.1 Display name

If supplied, use the strict parsed value. If omitted:

```text
extract POSIX basename from requestedPath shape
validate through repositoryDisplayNameSchema
reject if unsafe
```

Do not canonicalize the requested path in lifecycle code; A1 does that.

### 10.2 Double observation

```text
first = port.inspect(requestedPath)
second = port.inspect(requestedPath)
comparison = port.compareFresh(first.evidence, second.evidence)
```

All three must succeed. Require:

```text
sameCoreIdentity
sameEnvironmentalEvidence
sameRiskScanEvidence
```

A different `observedAt` is expected and not a difference category.

### 10.3 Audit metadata

Recommended bounded success metadata:

```text
firstObservationSha256
secondObservationSha256
sameCoreIdentity
sameEnvironmentalEvidence
sameRiskScanEvidence
created | existing
```

Failure metadata contains a normalized class and requested-path digest/length, not raw path content unless the existing operator audit policy explicitly accepts it.

### 10.4 Transaction

Inside one outer immediate transaction:

- call the accepted registration primitive;
- handle created/existing/local conflict/foreign reservation without throwing before required audit is committed;
- append audit;
- append `repository-registered` only when created, with structural repository/inspection correlation;
- return a command result indicating whether to notify and what HTTP outcome follows.

Throw the public conflict only after the transaction has committed any required caller-workspace audit.

## 11. Inspection service details

Preflight:

```text
role Owner/Editor
repository exists and not terminal
expectedVersion matches
stored baseline verifies
provider available
```

Current observation result cases:

### A1 successful observation

- compare against verified baseline;
- build successful verification inspection;
- reduce via `apply-assessment`.

### A1 normalized failure

- build failed verification inspection;
- use its assessment;
- do not treat `observation-raced`, timeout, overflow, spawn failure, or adapter-neutral operational failure as identity change.

### Adapter failure

- no inspection row;
- failed audit;
- no repository state change;
- 503.

### Outer transaction

- re-read expected version/status;
- append inspection attempt;
- apply transition if reducer says transition;
- append audit with prior/result version;
- append exactly one relevant event, or none;
- commit then notify if an event exists.

If storage reports a version conflict after host observation, return 409 and do not leave an orphan inspection because the outer transaction rolls back.

## 12. Reaffirmation service details

Preflight requires Owner, `identity-evidence-changed`, expected version, and expected latest successful inspection ID.

Every result after reaching the port becomes inspection kind `reaffirmation`:

| Observation result | Inspection | Repository consequence |
|---|---|---|
| environment still differs, core same | successful reaffirmation | `reaffirmEnvironment`, baseline advance, active |
| same | successful reaffirmation | no baseline advance; reducer rejects not-required; no state event |
| risk-only | successful reaffirmation | no baseline advance; repository-evidence-changed event permitted |
| core/class changed | successful reaffirmation | identity mismatch transition |
| unavailable | failed reaffirmation | unavailable transition where accepted |
| no-state operational failure | failed reaffirmation | no state event |
| stored evidence invalid before A1 | failed reaffirmation, storage-integrity | evidence-blocked transition |

For the non-advancing cases, use the standalone append API. For the advancing case, use the accepted `reaffirmEnvironment` primitive.

The response includes `baselineAdvanced:false` for every non-advancing result, regardless of whether repository status changed.

## 13. Event construction

Use only accepted B1 events.

### Registered

```text
repository-registered
repositoryId + registrationInspectionId structural correlation
```

### Status changed

```text
repository-status-changed
repositoryId
optional inspectionId when transition derives from inspection
prior/result status, reason, version
```

### Risk evidence changed

```text
repository-evidence-changed
repositoryId + inspectionId
risk differences and current risk summary
repository version unchanged unless reducer also transitioned
```

If one assessment produces both a status transition and risk evidence disposition, the accepted plan must state whether one or two B1 events are emitted and prove browser invalidation remains complete. Do not invent a new combined event.

## 14. HTTP response policy

Recommended route behavior:

- list/detail/history/admin success: 200;
- registration created/existing: 200 or 201 according to one accepted convention; preserve `created` boolean;
- inspection expected recorded outcome: 200 with inspection union;
- reaffirmation expected recorded outcome: 200 with inspection union and baseline flag;
- preflight conflict/terminal/not-required/version conflict: 409;
- provider/adapter unavailable before a recorded attempt: 503;
- request parse: 400;
- authorization: established 401/403/404.

Avoid using 500 for expected domain or provider outcomes.

## 15. Suggested target tree

```text
packages/contracts/src/
├── auth.ts
├── auth.test.ts
├── repository.ts
└── repository.test.ts

packages/storage/src/
├── repository-types.ts
├── repository-repositories.test.ts
└── repositories/repository-registry/index.ts

apps/server/src/
├── composition.ts
├── server.ts
├── test-support.ts
├── e2e-entry.ts
├── route-inventory.test.ts
├── routes/http.ts
├── routes/repositories.ts
├── services/errors.ts
├── services/repository-query-service.ts
├── services/repository-lifecycle-service.ts
├── services/repository-response-mapper.ts
├── services/repository-observation-port.ts
├── services/repository-observation-adapter.ts
└── focused tests

scripts/
├── check-forbidden-scope.mjs
└── check-ct04-protected-package.mjs

docs/
├── architecture.md
├── security.md
├── operations.md
└── decisions/ADR-020-repository-registration-and-identity-lifecycle.md
```

This is guidance, not an authorized exact tree. The proposed plan must list every file and stay within the fan-out threshold.

## 16. Completion evidence

The completion report should record:

```text
exact base and implementation head
accepted plan/review/disposition hashes
route inventory
provider/port/storage API changes
all commands actually run
focused case IDs and test locations
audit/event/notifier matrix
feature-disabled read proof
outer rollback injection proof
protected file hashes
scope/forbidden behavior proof
known limitations
```
