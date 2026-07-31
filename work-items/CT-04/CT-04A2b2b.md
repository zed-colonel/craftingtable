# CT-04A2b2b — Registration, inspection, and environmental reaffirmation lifecycle

**Status:** Preliminary child contract; source-specific planning begins after A2b2a acceptance  
**Parent:** CT-04A2b2  
**Depends on:** accepted CT-04A2b2a  
**Risk:** Critical

## 1. Objective

Use the accepted evidence boundary to implement authenticated repository registration, common and administrative queries, explicit verification, and Owner environmental reaffirmation. Commit inspection evidence, repository state, audit, accepted B1 workspace events, and notifier behavior coherently.

## 2. Required outcomes

- add common repository list/detail, owner administrative detail, and inspection-history queries;
- register a repository only after two matching quiescent observations;
- preserve both exact observation digests and comparison booleans in bounded audit metadata;
- implement same-workspace idempotency and foreign-workspace nondisclosing conflict;
- implement explicit verification with expected-version checks before host access;
- verify stored baseline integrity before calling A1;
- append one immutable inspection for every explicit verification attempt;
- apply same, risk, environment, core, repository-class, unavailable, evidence-invalid, and no-state-change outcomes correctly;
- implement Owner environmental reaffirmation with exact latest-successful-inspection and version guards;
- append evidence for reaffirmation requests even when the baseline is not advanced or the attempt fails;
- add any minimal storage API required for standalone reaffirmation-attempt evidence;
- use outer transactions for state + audit + event; notify once after commit only when an event exists;
- add strict repository lifecycle routes for this child only;
- preserve feature-disabled reads while host mutations return bounded feature-unavailable responses;
- keep retirement and project binding absent.

## 3. Expected routes

```text
GET  /api/workspaces/:workspaceId/repositories
POST /api/workspaces/:workspaceId/repositories
GET  /api/workspaces/:workspaceId/repositories/:repositoryId
GET  /api/workspaces/:workspaceId/repositories/:repositoryId/admin
GET  /api/workspaces/:workspaceId/repositories/:repositoryId/inspections
POST /api/workspaces/:workspaceId/repositories/:repositoryId/inspect
POST /api/workspaces/:workspaceId/repositories/:repositoryId/reaffirm
```

Exact naming is reviewed during Phase A. No generic Git route exists.

## 4. Source-grounded persistence gap

The current storage API can:

- append a `verification` attempt;
- atomically append a successful baseline-advancing `reaffirmation`.

It cannot append a successful non-baseline-advancing or failed `reaffirmation` attempt as a standalone inspection. The accepted plan must add a narrow storage primitive or generalize the inspection append safely. Reusing `verification` would erase the operator action and is not acceptable.

## 5. Registration rule

```text
authorize Owner
strict request validation
obtain feature after authorization
inspect twice
require same core, environment, and risk evidence
serialize one accepted exact observation
outer transaction:
    register repository/registration inspection
    append bounded audit
    append repository-registered only when created
commit
notify only when event appended
```

Failed registration has no repository or inspection parent. It may produce bounded request-workspace audit only.

## 6. Inspection rule

```text
authorize and check expected version before A1
verify accepted stored baseline through A2b2a
if invalid: no A1; append failed evidence + governed transition
else inspect current host state and classify
outer transaction:
    re-read version/state
    append immutable attempt
    apply reducer transition if any
    append audit
    append zero or one B1 state/evidence event
commit
notify only for event
```

Unchanged success and failed/no-state-change evidence produce no event or notifier. Inspection history remains queryable explicitly.

## 7. Reaffirmation rule

Only Owner may reaffirm. The command checks expected repository version and expected latest successful inspection before A1 and again inside the transaction.

A still-same-core, still-environment-different observation advances the baseline and returns active. Same/risk-only means reaffirmation is no longer required. Core/class/unavailable/evidence-invalid outcomes follow ordinary governed state behavior. Every attempt remains durable evidence.

## 8. Non-goals

- no repository retirement;
- no project binding or unbind;
- no branch/worktree/diff/agent/check/review/merge behavior;
- no browser repository views;
- no parent-completion claim.

## 9. Exit gate

```text
registration, inspection, and reaffirmation are authorized and durable;
stored evidence is verified before host access;
every explicit attempt appears in ordered history;
state/audit/event/notifier semantics match B1;
feature-disabled reads remain available;
retirement and binding remain absent;
all B2b focused cases pass.
```
