# CT-04A2b2b — Registration, inspection, and environmental reaffirmation lifecycle

**Status:** Source-grounded child contract proposed for operator adoption  
**Parent:** `CT-04A2b2 — Authorized repository lifecycle and CT-04A parent fan-in`  
**Depends on:** Accepted A1, A2a, B1, and A2b2a source  
**Accepted A2b2a runtime head:** `0c2e9ba68abecd904bae81a9faae5074b4e29fb6`  
**Attached archive head:** `094c78382e4bd7f00e397cdfe3ec6284a9c9f04f`  
**Attached archive SHA-256:** `e44813b5d9f1d67573e83ec6848ff3811afa031dc68db73c44e60f5d3b53d128`  
**Risk:** Critical

## 1. Objective

Compose the accepted repository observation/evidence boundary with the accepted repository persistence and journal boundaries to implement:

- common repository list and detail queries;
- Owner-only administrative detail;
- ordered inspection-history queries;
- Owner-only repository registration;
- Owner/Editor explicit inspection;
- Owner-only environmental-evidence reaffirmation;
- exact authorization-before-host-access behavior;
- coherent state, inspection, audit, event, commit, and notifier ordering.

The slice ends before repository retirement and project binding.

## 2. Governing statements

> **A lifecycle command may request an observation. It may not obtain raw Git authority.** The only production Git import remains the accepted A2b2a adapter.

> **Stored evidence is verified before new host access.** A corrupt or incompatible accepted baseline creates governed local evidence and state without calling A1.

> **Every command is auditable; every command that reaches the evidence boundary is evidentiary.** Provider acquisition failure occurs before a repository observation and therefore writes bounded command audit, not a fictional inspection row.

> **Workspace activity is not inspection history.** Unchanged success, bounded no-state failures, and non-advancing reaffirmation remain queryable through immutable inspection history even when no workspace event exists.

> **Expected operational observations are domain results, not server crashes.** A recorded inspection may succeed or fail while the HTTP command itself completes and returns the current repository state.

## 3. Scope decision

A further split is not required at contract time. The accepted source leaves one coherent lifecycle surface:

```text
strict route
    → authentication / CSRF / workspace role
    → stored-baseline verification
    → accepted A1 observation port
    → accepted A2a reducer and storage
    → accepted B1 audit/event transaction
    → commit
    → optional post-commit notifier
```

Phase A must nevertheless propose a split before implementation if the reconciled tree:

- exceeds roughly 45 files;
- adds any schema migration;
- adds a new workspace-event kind;
- adds a browser repository page or asynchronous web fetch surface;
- adds repository retirement or project binding;
- imports `node:child_process` or `@craftingtable/git` outside the accepted adapter;
- introduces another authority or persistence boundary.

## 4. Accepted source boundaries

### 4.1 A1

A1 owns local Git/process/path inspection and returns typed observations and typed failures.

### 4.2 A2a

A2a owns repository status, immutable inspection evidence, environmental baseline, bindings, reducer semantics, and storage repositories.

### 4.3 B1

B1 owns repository workspace-event vocabulary, structural journal correlations, storage mapping, and exhaustive browser event projection/activity descriptions.

### 4.4 A2b2a

A2b2a owns:

```text
RepositoryInspectorProvider
RepositoryObservationPort
A1 adapter and vocabulary parity
exact stored evidence verification
repository identity verification
observation comparison
A1 failure-to-assessment mapping
```

B2b may extend this port narrowly where registration needs comparison of two fresh observations. It may not create an alternate comparator in a lifecycle service.

## 5. Required source corrections

### 5.1 Fresh-observation comparison

Registration observes the same candidate twice before any repository exists. The accepted port currently compares a fresh observation only against a branded stored repository baseline.

Add one narrow method, conceptually:

```ts
compareFresh(
  first: RepositoryObservationEvidence,
  second: RepositoryObservationEvidence,
): RepositoryObservationComparisonResult;
```

The adapter must verify exact JSON digests, parse both through A1, verify every projected field, require compatible policy versions, and use the accepted A1 comparator. Lifecycle code may not compare the evidence fields independently.

### 5.2 Standalone reaffirmation attempts

The accepted storage API can append `verification` attempts and can atomically append a successful, baseline-advancing `reaffirmation`. It cannot append:

```text
failed reaffirmation
successful reaffirmation that does not advance the baseline
successful reaffirmation whose assessment transitions to mismatch/unavailable
```

Add one narrow append capability that permits only `verification | reaffirmation`, preserves all A2a success/failure constraints, rejects `registration`, and remains composable inside an outer immediate transaction. Keeping `appendVerification` as a compatibility wrapper is acceptable.

### 5.3 Reaffirmation response contract

The current reaffirmation response accepts only a successful inspection. A reaffirmation command may durably produce a failed inspection or a successful non-baseline-advancing inspection.

Change the response to carry:

```text
repository
inspection: RepositoryInspectionSummary
changed: boolean
baselineAdvanced: boolean
```

No route may claim baseline advancement merely because the operator requested reaffirmation.

## 6. Route surface

Exactly these routes are introduced:

```text
GET  /api/workspaces/:workspaceId/repositories
POST /api/workspaces/:workspaceId/repositories
GET  /api/workspaces/:workspaceId/repositories/:repositoryId
GET  /api/workspaces/:workspaceId/repositories/:repositoryId/admin
GET  /api/workspaces/:workspaceId/repositories/:repositoryId/inspections
POST /api/workspaces/:workspaceId/repositories/:repositoryId/inspect
POST /api/workspaces/:workspaceId/repositories/:repositoryId/reaffirm
```

No generic Git, process, path-inspection, command, environment, route, or query endpoint exists.

## 7. Read semantics

### 7.1 Common reads

Owner, Editor, and Viewer may list and read repository state for a workspace in which they are active members.

Common responses exclude:

- canonical Git directory;
- canonical common Git directory;
- exact stored observation JSON;
- filesystem device and inode values;
- raw A1 diagnostics;
- configuration roots and executable paths.

### 7.2 Administrative detail

Only Owner may read the administrative detail that includes the accepted administrative identity projection. It still excludes exact observation JSON, raw A1 diagnostics, environment, and repository configuration values.

### 7.3 Inspection history

Active members may read up to the contract maximum in descending inspection sequence. The history remains available when the repository feature is disabled or temporarily unavailable.

Reads use stored evidence only and never call the provider or A1.

## 8. Authorization and browser security

| Operation | Owner | Editor | Viewer |
|---|---:|---:|---:|
| List/common detail/history | yes | yes | yes |
| Administrative detail | yes | no | no |
| Register host path | yes | no | no |
| Explicit inspect | yes | yes | no |
| Reaffirm environment | yes | no | no |

Every mutation uses the existing authentication, session, CSRF, and origin chain before service logic.

A nonmember receives the established indistinguishable 404 and no host access. A known active member with insufficient role receives 403 before provider creation or inspection and a bounded repository-action denial audit where the accepted policy requires it.

## 9. Provider and evidence rules

### 9.1 Provider acquisition failure

If the feature is disabled, in cooldown, or permanently unavailable before a port is obtained:

- no repository inspection row is created;
- the command writes bounded failed audit after authorization;
- repository state and version remain unchanged;
- no workspace event or notifier occurs;
- the route returns `503 service-unavailable`.

This is not an exception to evidence truth: no repository observation occurred.

### 9.2 Stored baseline verification

Before a new A1 inspection for an existing repository:

```text
load repository and accepted-environment inspection
verify exact stored digest
parse through A1
verify projected inspection fields
verify registered repository identity
```

Failure produces a failed `storage-integrity` inspection, an `evidence-blocked` transition where allowed, audit, and a repository-status event. A1 is not called.

### 9.3 Adapter invariant failure

An adapter vocabulary/invariant failure is a service-integrity failure rather than repository evidence. It latches the accepted provider state, writes bounded failed audit, changes no repository state, creates no inspection row, and returns `503`.

## 10. Registration lifecycle

```text
authorize active Owner
validate request and safe display name
obtain observation port
inspect candidate first time
inspect candidate second time
compare through compareFresh
require same core, environment, and risk evidence
prepare exact accepted second observation
outer immediate transaction:
    recheck same/foreign identity reservation
    register repository and registration inspection when new
    append bounded audit
    append repository-registered event only when new
commit
notify once only when event appended
```

Rules:

- display name omitted uses the validated top-level basename; unsafe basename rejects before commit;
- first or second observation failure writes bounded failed audit only, because no repository parent exists;
- any difference between the two complete observations is non-quiescent and registers nothing;
- registration success stores the second observation; audit metadata may carry both observation digests and comparison booleans, never raw observations;
- same-workspace exact active duplicate returns the existing repository with `created:false`, no duplicate event or notifier;
- same-workspace non-active identity returns conflict and directs the operator to the lifecycle route;
- a foreign active reservation returns a non-disclosing conflict and writes nothing in the foreign workspace;
- a retired reservation does not block a new RepositoryId;
- concurrent registration yields one creation and one idempotent/conflict result, never two active rows.

## 11. Explicit inspection lifecycle

```text
authorize Owner/Editor
load repository and require expected version
reject terminal status before provider
verify stored accepted baseline
obtain port
inspect current path
normalize assessment
outer immediate transaction:
    re-read repository/version
    append one verification inspection
    apply reducer transition when required
    append bounded audit
    append zero or one status/evidence event
commit
notify only when an event exists
return repository + inspection + changed
```

Expected recorded outcomes return the strict inspection response even when the inspection outcome is `failed`.

Event mapping:

```text
same                         → no event
no-state-change failure      → no event
risk evidence changed        → repository-evidence-changed
environment changed          → repository-status-changed
core identity changed        → repository-status-changed
repository class changed     → repository-status-changed
unavailable                  → repository-status-changed when status changes
evidence invalid             → repository-status-changed
accepted evidence returns    → repository-status-changed when status changes
```

The transaction may not append more than one status transition event for one repository version. A risk-evidence event may accompany a transition only when the accepted reducer explicitly carries the risk disposition.

## 12. Environmental reaffirmation lifecycle

Only Owner may invoke reaffirmation.

Preconditions before provider access:

```text
repository exists in workspace
expected version matches
status is identity-evidence-changed
expectedLatestSuccessfulInspectionId matches current history
stored accepted baseline verifies
```

Then:

```text
inspect fresh current state
reduce with reaffirm-environment
outer immediate transaction:
    recheck version and latest-successful ID
    append reaffirmation inspection for every reached-port outcome
    if baselineAdvanceRequired:
        advance accepted environment baseline and transition active
    else:
        apply any ordinary governed transition or keep state unchanged
    append audit
    append event only for accepted state/evidence consequence
commit
notify only for event
```

Rules:

- environment still differs with same core → successful baseline advancement and active status;
- same or risk-only evidence → append successful reaffirmation, reject baseline advancement as no longer required, and return the current state; no false baseline claim;
- core/class/unavailable/evidence-invalid → preserve reaffirmation kind and apply the ordinary governed result;
- A1 failure → append failed reaffirmation and preserve baseline;
- provider failure before a port exists → audit only, no inspection;
- stale version/latest-successful ID → conflict before host access where derivable and again inside the transaction;
- every successful baseline advance preserves RepositoryId and all project bindings.

## 13. Audit policy

Use the existing actions:

```text
repository.register
repository.inspect
repository.reaffirm
```

and the existing outcomes:

```text
succeeded
denied
failed
```

Audit metadata is bounded and derived. It may include:

```text
request ID
repository/inspection ID when locally visible
prior/resulting version
assessment kind
inspection outcome and exact normalized failure code
first/second observation digests for registration
same-core/environment/risk booleans
difference counts
created/existing disposition
feature/provider failure class
requested-path SHA-256 and UTF-8 byte length
```

It must not include:

```text
raw observation JSON
raw stdout/stderr
child environment
Git config values
credentials/tokens
foreign workspace or repository IDs
unbounded paths, reasons, or diagnostics
```

## 14. HTTP outcome policy

- malformed strict request → 400 `invalid-request`;
- unauthenticated → 401;
- known member insufficient role → 403;
- missing/foreign resource → indistinguishable 404;
- stale version, terminal state, duplicate/conflict, or reaffirmation-not-required → 409 `conflict`;
- provider disabled/unavailable or adapter invariant fault → 503 `service-unavailable`;
- a recorded expected inspection result, including failed A1/storage-integrity evidence, returns 200 with the strict result body;
- unexpected invariant breach → 500 without internal detail.

The shared API error contract may add generic `service-unavailable`; it must not expose provider internals as a public enum.

## 15. Outer transaction and notifier rules

Every state-producing command uses one outer `storage.transaction`. Existing nested repository operations may use savepoints, but the enclosing immediate transaction owns atomicity across:

```text
inspection evidence
repository transition/baseline update
bounded audit
workspace event
```

Failure injection after any nested repository write and before outer commit must roll back all four classes.

Notifier rules:

- call only after successful outer commit;
- call exactly once per command when one or more events were appended;
- do not notify for unchanged success, no-state failure, denied command, provider failure, version conflict, transaction rollback, or duplicate registration without event;
- durable SSE polling remains recovery for a lost notification.

## 16. Required source changes

The accepted Phase A plan must reconcile, at minimum:

- narrow fresh-observation comparison extension in the observation port/adapter;
- narrow standalone reaffirmation-attempt storage API;
- reaffirmation response union and `baselineAdvanced` field;
- generic `service-unavailable` API error code and handler;
- repository query and lifecycle services;
- one strict repository route module and route inventory;
- server dependency injection and test support;
- audit/event transaction composition;
- protected-scope checker updates;
- ADR and operations/security documentation.

No migration, new event kind, browser repository page, or Git-package implementation change is expected.

## 17. Non-goals

- repository retirement;
- project binding or unbind;
- repository-side writes;
- target ref, exact base, branch, worktree, diff, artifact, agent, check, review, readiness, or merge behavior;
- background polling or startup reconciliation;
- remote Git;
- general shell/process route;
- browser repository pages;
- changes to the original CT-04 protected specifications.

## 18. Exit gate

```text
common and Owner-only reads are correctly scoped and work with the feature disabled;
Owner registration uses two matching observations and commits one coherent registration;
explicit inspection verifies stored evidence before host access and records every reached-port attempt;
Owner reaffirmation records every reached-port attempt and advances only a still-valid environmental baseline;
provider/adapter failures do not become fictional repository evidence;
state, inspection, audit, event, commit, and notifier ordering are atomic;
expected operational failures are represented without leaking process detail;
no retirement or binding route exists;
no new Git/process authority exists;
all focused and inherited B2b cases pass.
```
