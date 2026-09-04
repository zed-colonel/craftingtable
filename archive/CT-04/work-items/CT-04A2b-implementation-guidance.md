# CT-04A2b implementation guidance

## 1. Purpose

This document recommends source-specific shapes for both children. It does not authorize implementation and does not replace each child's Phase A plan and independent design review.

## 2. Dependency direction

After B1 and B2, the intended direction is:

```text
@craftingtable/domain
    ↑
@craftingtable/contracts       @craftingtable/git
    ↑                              ↑
@craftingtable/storage        exact server adapter only
    ↑                              ↑
@craftingtable/server ─────────────┘
    ↑
@craftingtable/web
```

Rules:

- domain and contracts never import Git, storage, server, or browser;
- storage never imports Git or server;
- only one exact server adapter imports `@craftingtable/git`;
- lifecycle services consume a server-owned port, not A1 types;
- routes never import Git or storage directly;
- browser consumes contracts and never host paths beyond authorized summaries;
- the scope checker enforces these exact edges.

## 3. B1 recommended event model

### 3.1 Domain base

Extend the event base with optional branded correlations:

```ts
repositoryId?: RepositoryId;
repositoryInspectionId?: RepositoryInspectionId;
repositoryBindingId?: ProjectRepositoryBindingId;
```

Keep all existing fields and schema version 1 unless the wire representation itself becomes incompatible. Adding registered event variants is not by itself a wire-version break.

### 3.2 Introduced-schema map

Add a map analogous to audit actions:

```ts
WORKSPACE_EVENT_KIND_INTRODUCED_IN_SCHEMA
```

This provides a deterministic domain-to-catalog parity test.

### 3.3 Migration 0004

Preferred rebuild protocol:

```text
insert schema-4 event kinds
create guard table
remove old append-only triggers
rename workspace_events to workspace_events_schema3
create schema-4 table
copy exact old rows in sequence order with new columns NULL
assert count and max sequence
assert legacy rows have NULL repository correlations
assert foreign_key_check/integrity_check
restore indexes and append-only triggers
drop old table and guard
```

Verify the next inserted sequence exceeds the prior maximum. Do not assume explicit sequence inserts automatically preserve every AUTOINCREMENT detail without testing.

### 3.4 Correlation constraints

Use structural columns and composite FKs. Add kind-specific CHECK or trigger logic so nullable FKs cannot silently skip required relationships.

Recommended matrix:

```text
legacy kinds
    repo/inspection/binding all NULL

repository-registered
    repository and inspection non-NULL
    project, work item, binding NULL

repository-status-changed
    repository non-NULL
    binding/project/work item NULL
    inspection may be NULL only for retirement semantics

repository-evidence-changed
    repository and inspection non-NULL
    project/work item/binding NULL

binding events
    project, repository, binding non-NULL
    work item and inspection NULL
```

The accepted plan must state whether retirement's missing inspection is enforced from payload cause through Zod/service only or also through a JSON-aware trigger. Do not imply the database proves a condition it does not prove.

### 3.5 Storage append

The event append boundary should accept structural correlations independently of payload. It must not parse IDs from payload JSON.

The mapper remains an exhaustive switch with `assertNever` or equivalent compile-time closure. Strict payload validation remains in contracts and server/browser boundaries.

### 3.6 Projection

Extend `StaleScopes` with repository list and IDs. Do not add repository fetches or pages. B1's job is to preserve event meaning and provide future invalidation vocabulary.

Activity text uses React text rendering only. It never renders diff/HTML or administrative paths.

## 4. B2 recommended A1 adapter

Create a server-owned port that hides A1 types from the lifecycle service:

```ts
interface RepositoryObservationPort {
  availability(): RepositoryFeatureAvailability;
  inspect(requestedPath: string, signal?: AbortSignal): Promise<PortInspectionResult>;
  verifyStoredObservation(input: StoredObservationInput): StoredObservationVerification;
  compare(recorded: VerifiedStoredObservation, current: PortObservation): PortComparisonResult;
}
```

Only an exact adapter module imports `@craftingtable/git`.

The adapter must fail closed if A1 and domain disagree on:

```text
observation version
risk scan scope version
risk scan regex
risk signals
error code set
error-subject mapping
core/environment/risk difference vocabularies
```

The A2a SQL layer intentionally does not duplicate every A1 semantic constant. B2 owns the runtime package-root parity proof.

## 5. Feature configuration

Recommended behavior:

```text
No repository-related variables present
    feature disabled; daemon starts

Repository roots absent but another repository variable present
    startup error: incomplete explicit configuration

Repository roots present but malformed/overlapping
    startup error

Configuration structurally valid
    store immutable options; create A1 lazily after authorization
```

Memoization policy:

- memoize a successful inspector;
- deduplicate concurrent creation attempts;
- cache explicit configuration-required failures for a bounded interval or process lifetime according to the accepted plan;
- do not convert a transient creation error into permanent success or silently disabled state;
- expose no root inventory or Git diagnostics to unauthorized callers.

## 6. Service ordering

### 6.1 Registration

```text
authenticate and require Owner
    ↓
validate strict request and display name
    ↓
obtain feature/inspector after authorization
    ↓
inspect candidate twice
    ↓
require same core + environment + risk evidence
    ↓
serialize one exact accepted observation
    ↓
outer BEGIN IMMEDIATE transaction
    register repository/inspection through A2a primitive
    append bounded repository.register audit
    append repository-registered event only when created
    commit
    ↓
notify only when an event was appended
```

Audit metadata should carry both exact observation digests and boolean comparison results without raw observation JSON, Git directories, config values, or stderr.

Same-workspace duplicate returns existing with no duplicate event. Foreign-workspace identity conflict returns a non-disclosing conflict and no event in the foreign workspace.

### 6.2 Verification

Before A1:

```text
authorize Owner/Editor
load repository
reject retired/terminal as defined
check expected version
load accepted baseline inspection
verify exact stored digest
parse through A1 adapter
verify projected columns
```

If stored evidence fails, do not call A1. In one transaction append a storage-integrity failed inspection, apply evidence-blocked transition where allowed, write audit/event, commit, then notify.

If stored evidence is valid, call A1 and normalize the result.

Assessment priority for successful comparison:

```text
core differences        → core-identity-changed
else environment        → environment-evidence-changed
else risk               → risk-evidence-changed
else                     → same
```

A1 repository-class error subjects map to the new explicit `repository-class-changed` assessment. Process/configuration/observation-raced classes map according to the accepted no-state-change/unavailable policy.

### 6.3 Reaffirmation

Check expected version and expected latest successful inspection before A1. Recheck in the write transaction. Require fresh observation with same core and still-different environment. A same-environment observation means reaffirmation is no longer required and must not silently advance the baseline.

### 6.4 Binding

Perform fresh verification. In one outer transaction:

- append inspection and audit;
- apply any state transition and event;
- only if the re-read repository remains active at the expected version, insert/idempotently resolve the binding;
- append bind audit/event;
- commit once;
- notify once if one or more events were appended.

Do not bind first and then discover the repository became unavailable.

### 6.5 Retirement

No A1 call. `retireWithBindings` plus audit and accepted B1 events occur in one outer transaction. Emit one repository status event plus one binding-retired event per affected binding, then one notifier call.

### 6.6 Explicit binding retirement

No A1 call. Retire exactly one binding, preserve repository and sibling bindings, append audit/event in the same transaction, notify after commit, and make repeats idempotent.

## 7. Audit policy

Use the schema-3 actions and outcomes.

```text
repository.register    succeeded / denied / failed
repository.inspect     succeeded / denied / failed
repository.reaffirm    succeeded / denied / failed
repository.retire      succeeded / denied / failed
repository.bind-project succeeded / denied / failed
repository.unbind-project succeeded / denied / failed
```

Bound metadata only. No raw stderr, environment, config values, exact observation JSON, tokens, or unbounded paths.

Unauthorized nonmembers retain established non-disclosing behavior. Known members with insufficient role receive a bounded denied audit before host access where policy permits audit without creating a cross-workspace side channel.

## 8. Outer transaction and deferred constraints

A2a primitives may use nested transactions/savepoints. B2 wraps authoritative state + audit + event in one outer `BEGIN IMMEDIATE` transaction.

The reciprocal inspection-parent constraint is checked only at the outermost commit. A nested primitive returning is not final success. Service tests must inject a failure after primitive writes and prove total rollback and no notifier.

## 9. Error mapping

The accepted plan should publish a closed HTTP mapping table.

Suggested classes:

```text
invalid caller/path request             400/422
missing/foreign resource                indistinguishable 404
known member lacks role                 403
expected-version or state conflict      409
observation-raced                       409 retryable
repository class / ownership refusal    422 actionable
feature unavailable/config required     503 bounded
Git timeout/overflow/spawn fault         503 bounded
stored evidence integrity failure       409 or 500-equivalent protected error,
                                        with repository moved evidence-blocked
```

The exact status choices require design review. No response exposes another workspace, raw Git stderr, full environment, or administrative paths unless the caller is authorized for the explicit administrative endpoint.

## 10. Parent fan-in

After B2 acceptance run:

- all B1 and B2 focused suites;
- all original A2b cases;
- all original CT-04A protected cases;
- A1 real-Git cases through the service;
- A2a direct-SQL and reducer suites;
- CT-01 through CT-03 regression;
- schema 1→2→3→4 migration and restart;
- SSE replay after missed notifier;
- foreign-workspace and revoked-member behavior;
- scope checker proving one production Git process authority and one exact server Git adapter.
