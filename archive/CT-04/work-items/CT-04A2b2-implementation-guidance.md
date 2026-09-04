# CT-04A2b2 implementation guidance

## 1. Dependency direction

```text
@craftingtable/domain
        ↑
@craftingtable/contracts      @craftingtable/git
        ↑                           ↑
@craftingtable/storage      server evidence adapter
        ↑                           ↑
        └──────── server lifecycle services ────────┐
                                                    ↓
                                              Fastify routes
```

Only the evidence adapter imports `@craftingtable/git`. Storage never imports Git. Git never imports storage, HTTP, auth, audit, events, or browser code.

## 2. A2b2a recommended architecture

### 2.1 Configuration

Extend `ServerConfig` with a discriminated feature configuration:

```ts
type RepositoryFeatureConfig =
  | { readonly enabled: false }
  | {
      readonly enabled: true;
      readonly inspectorOptions: RepositoryInspectorOptions;
      readonly retryDelayMs: number;
    };
```

Parsing rule:

```text
no repository-related env values
    enabled:false

some but incomplete values
    startup error

complete values
    validate syntax/relationships and retain immutable options
```

A2b2a should not create artifact or worktree directories. It supplies their reserved paths to A1 path policy.

### 2.2 Provider

Recommended internal port:

```ts
interface RepositoryInspectorProvider {
  status(): 'disabled' | 'not-created' | 'available' | 'temporarily-unavailable' | 'unavailable';
  get(): Promise<RepositoryObservationPortResult>;
}
```

The provider:

- shares one in-flight creation;
- memoizes success;
- caches configuration-required/not-retryable failure until restart;
- caches retryable failure for one bounded interval;
- never exposes roots, Git path, or A1 error evidence to unauthorized HTTP callers;
- does not create A1 until a later authorized service asks for it.

### 2.3 Sole A1 adapter

Suggested responsibilities:

```text
construct and hold RepositoryInspector
verify A1/domain constant parity
inspect one admitted path
verify exact stored observation
compare parsed observations
normalize A1 errors into server-internal results
map results to RepositoryObservationAssessment
```

The lifecycle service consumes server-owned types, not A1 types.

### 2.4 Exact stored evidence verifier

Input should include the full `SuccessfulRepositoryInspection`. Verify:

```text
SHA-256 of exact observationJson
JSON parse
A1 parseRecordedObservation
observation and inspection policy versions
canonical top/Git/common paths
object format
inodes and core fingerprint
devices
risk scope/pattern/classification/signals
observedAt
```

A comparison-array field belongs to the inspection interpretation, not the raw observation; do not demand it from A1 observation JSON.

Failure result should distinguish:

```text
digest mismatch
JSON invalid
A1 record invalid
unsupported observation version
policy version mismatch
projected-column mismatch
A1/domain vocabulary mismatch
```

The existing domain can use `stored-evidence-invalid` for projected mismatch if no new durable reason is justified. The accepted plan must document that mapping.

### 2.5 Assessment mapping

Add:

```ts
{ kind: 'repository-class-changed'; reason: RepositoryInspectionErrorCode }
```

or an equally explicit closed variant. The reducer maps it to:

```text
identity-mismatch / repository-class-changed
```

Priority:

```text
class error
core difference
environment difference
risk difference
same
```

Operational errors map by exact code rather than broad subject alone. In particular:

```text
path-unavailable / metadata-unreadable → unavailable
observation-raced                     → no-state-change failure
abort/timeout/overflow/spawn/malformed→ no-state-change failure
recorded evidence errors              → evidence-invalid
```

## 3. A2b2b service architecture

Prefer separate query and command concerns:

```text
RepositoryQueryService
    list/detail/admin/inspection history

RepositoryLifecycleService
    register/inspect/reaffirm

RepositoryCommandAuthorization
    workspace membership/role and bounded denied audit
```

Routes remain thin: authenticate, parse strict contracts, call services, parse response contracts.

### 3.1 Registration

Use two A1 observations outside the write transaction. Require no differences in core, environment, or risk. Store one exact observation, normally the second, and include both digests plus equality booleans in bounded audit metadata.

In one outer transaction:

```text
recheck duplicate classification through A2a repository
register repository + inspection if created
append repository.register audit
append repository-registered only if created
```

After commit, notify only if created/event appended.

Same-workspace exact duplicate returns `created:false`. A foreign reservation returns non-disclosing conflict. A conflicting same-workspace non-active row directs the operator to inspect, reaffirm, or retire rather than re-registering.

### 3.2 Verification preparation and commit

Separate host work from transactional application:

```ts
prepareVerification(...): Promise<PreparedRepositoryVerification>
commitVerification(tx, prepared, context): VerificationCommitResult
```

This is necessary so B2c can reuse the same prepared verification inside a binding transaction without a second notifier or nested top-level command.

`PreparedRepositoryVerification` should bind:

```text
workspace/repository
expected version
accepted baseline inspection ID
new inspection ID and evidence
assessment
A1 feature/provider generation or policy version
prepared-at time
```

The transaction re-reads everything and rejects stale preparation.

### 3.3 Every attempt remains evidence

Extend storage narrowly so a reaffirmation attempt can be appended independently of baseline advance. One option:

```ts
appendInspection(input: VerificationOrReaffirmationWrite)
```

with explicit repository-state and kind rules. Another is a dedicated `appendReaffirmationAttempt`. The accepted plan must preserve A2a constraints and prevent registration-kind insertion through this API.

### 3.4 Event rules

```text
registration created              → repository-registered
status transition                 → repository-status-changed
risk-only evidence change         → repository-evidence-changed
same / failed no-state-change     → no workspace event
reaffirm baseline transition      → repository-status-changed
```

All explicit attempts still write inspection and audit evidence.

### 3.5 Error responses

Publish a closed mapping. Suggested outcomes:

```text
invalid request/path syntax                  400 or 422
missing/foreign resource                     404 indistinguishable
known member insufficient role               403
authorized feature disabled/unavailable      503 bounded
stale expected version/latest inspection     409
observation-raced/quiescence failure          409 retryable
ownership/repository class rejection          422 actionable
host timeout/overflow/spawn/malformed         503 bounded
stored evidence integrity failure             protected conflict/internal response,
                                             with evidence-blocked state
```

No raw stderr, configuration, root inventory, observation JSON, or foreign IDs.

## 4. A2b2c administrative composition

### 4.1 Fresh-verification binding

B2c calls the accepted B2b preparation step outside the transaction. Inside one outer transaction:

```text
re-read project/repository/version
commit verification evidence and any state transition
if repository remains active at expected resulting version:
    insert/idempotently resolve binding
    append bind audit/event
else:
    keep verification state/evidence
    create no binding
commit once
notify once if events exist
```

### 4.2 Unbind

No A1 call. Retire exactly one binding with expected version. Append audit/event atomically. Repeat is idempotent and produces no duplicate event.

### 4.3 Repository retirement

No A1 call. The storage result must expose full binding transition facts needed by B1 events. Prefer:

```ts
retiredBindings: readonly {
  binding: ProjectRepositoryBinding;
  priorVersion: number;
  resultingVersion: number;
}[]
```

The outer transaction appends:

```text
one repository status event
one project-repository-binding-retired event per binding
bounded audit records
```

and notifies once after commit.

## 5. Audit policy

Reuse schema-3 actions and outcomes. Bounded metadata may include IDs, versions, failure classification, digests, comparison booleans, and counts. It excludes:

```text
raw observation JSON
raw Git stderr/stdout
process environment
repository config values
credentials or tokens
foreign workspace/repository identity
unbounded paths or user content
```

Known-member role denial may write a command-specific denied audit before host access. Nonmember/missing behavior follows existing workspace non-disclosure and must not create cross-workspace side channels.

## 6. Transaction behavior

A2a methods use nested transactions/savepoints. Each lifecycle command uses one outer `storage.transaction` for authoritative state, audit, and events. Tests must inject failure:

```text
after inspection insert
after repository transition
after binding insert/retirement
after audit insert
after one of several events
before outer commit
after commit before notifier
```

Everything before commit rolls back. Missed notification is recovered from the durable event query.

## 7. Expected route inventory

After B2c the accepted API is likely:

```text
GET    /api/workspaces/:workspaceId/repositories
POST   /api/workspaces/:workspaceId/repositories
GET    /api/workspaces/:workspaceId/repositories/:repositoryId
GET    /api/workspaces/:workspaceId/repositories/:repositoryId/admin
GET    /api/workspaces/:workspaceId/repositories/:repositoryId/inspections
POST   /api/workspaces/:workspaceId/repositories/:repositoryId/inspect
POST   /api/workspaces/:workspaceId/repositories/:repositoryId/reaffirm
POST   /api/workspaces/:workspaceId/repositories/:repositoryId/retire
GET    /api/workspaces/:workspaceId/projects/:projectId/repository-binding
PUT    /api/workspaces/:workspaceId/projects/:projectId/repository-binding
DELETE /api/workspaces/:workspaceId/projects/:projectId/repository-binding
```

The exact route grammar is a design-review decision. There is no raw Git or filesystem route.

## 8. Test strategy

- B2a uses fake A1 package-root adapters and exact stored evidence fixtures; it may also use accepted A1 observations from real-Git fixtures.
- B2b uses an injected server-owned observation port to test authorization before host access and deterministic lifecycle outcomes.
- Parent fan-in uses the real accepted A1 inspector against temporary repositories.
- Direct SQL tests continue proving structural ownership and immutable evidence.
- Route tests prove strict contracts, CSRF, origin, session, role, nondisclosure, and inventory.
- SSE tests prove post-commit notification and durable fallback.

## 9. Documentation and ADRs

Expected decisions:

```text
ADR-019 optional repository feature and evidence translation
ADR-020 repository registration and identity lifecycle
ADR-021 project binding, retirement, and CT-04A completion
```

The accepted Phase A plans may combine ADRs if the decision remains coherent. Update architecture, security, and operations as each child lands.
