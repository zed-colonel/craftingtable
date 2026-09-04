# CT-04A2b2c — Retirement, project binding, and CT-04A parent fan-in

**Status:** Preliminary child contract; source-specific planning begins after A2b2b acceptance  
**Parent:** CT-04A2b2  
**Depends on:** accepted CT-04A2b2b  
**Risk:** Critical

## 1. Objective

Complete the repository administrative lifecycle: fresh-verification project binding, explicit unbind, Owner repository retirement, final route inventory, and the complete CT-04A parent fan-in suite.

## 2. Required outcomes

- bind an active repository to a same-workspace project only after fresh governed verification;
- commit the verification result and create the binding only if the repository remains active at the expected version;
- make same repository/project binding idempotent and conflicting binding explicit;
- retire exactly one binding without changing the repository or sibling bindings;
- retire a repository without A1, atomically retiring all active bindings;
- emit one repository status event and one binding-retired event per affected project;
- preserve prior/resulting binding versions and project IDs in retirement results/events;
- extend the storage retirement result if necessary to return full retired-binding evidence rather than IDs only;
- keep retirement and unbind idempotent without duplicate audit/events/notifier;
- expose the final accepted repository binding and retirement routes;
- run the original CT-04A, A2, A2b, A1, A2a, B1, and B2 protected suites;
- verify exact route inventory and absence of CT-04B+ behavior;
- write the CT-04A parent completion report and final exact-head review evidence.

## 3. Binding transaction

Host inspection occurs before the transaction through the accepted B2a boundary. The outer transaction:

```text
re-reads repository/project/version
appends inspection evidence
applies any state transition and event
creates binding only if repository remains active
appends bind audit/event
commits once
```

A repository that becomes non-active is not bound. The state/evidence outcome remains durable.

## 4. Retirement transaction

Retirement does not call A1:

```text
re-read repository/version
retire all active bindings
retire repository
append repository audit/status event
append one binding-retired audit/event per binding as required
commit
notify once
```

The current storage result returns binding IDs only. The accepted plan must show how project IDs and prior/resulting versions are obtained without an incoherent second transaction.

## 5. Routes

Likely additions:

```text
POST   /api/workspaces/:workspaceId/repositories/:repositoryId/retire
GET    /api/workspaces/:workspaceId/projects/:projectId/repository-binding
PUT    /api/workspaces/:workspaceId/projects/:projectId/repository-binding
DELETE /api/workspaces/:workspaceId/projects/:projectId/repository-binding
```

## 6. Parent fan-in

Parent completion must prove complete end-to-end behavior using a real temporary repository through A1 and the HTTP/service/storage/event path. Child tests alone are insufficient.

## 7. Non-goals

No change request, branch, worktree, diff, artifact store, agent, checks, code review, readiness, merge, remote Git, or LAN deployment.

## 8. Exit gate

```text
fresh verification gates binding;
unbind preserves repository and sibling bindings;
retirement is host-independent, atomic, complete, and idempotent;
all affected projects receive reconstructible events;
complete parent protected suite passes;
CT-04A is accepted without CT-04B+ leakage.
```
