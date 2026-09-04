# CT-04B — Exact-base change requests and controlled branch identity

**Parent:** CT-04  
**Risk:** High  
**Dependencies:** accepted CT-04A  
**Primary areas:** change-request domain, admitted work-item binding, exact commit resolution, target refs, server-generated branch names, migration 0004

## Objective

Allow an Owner or Editor to turn one admitted work item and its current non-executable draft into a durable `ChangeRequest` bound to one project repository, one configured local target ref, one exact full base commit, and one reserved server-generated branch identity.

CT-04B performs no worktree or branch mutation. It proves all identity and authorization facts before CT-04C may create host state.

## Required outcomes

- add branded `ChangeRequestId`;
- add a strict `ChangeRequest` domain state machine beginning in `draft`;
- add migration 0004 with coherent workspace/project/work-item/draft/repository binding;
- require the source work item to be `Admitted`;
- require one active project/repository binding;
- revalidate repository identity;
- enumerate or validate allowed local target refs through typed Git inspection;
- resolve a target ref to one full commit object ID;
- store target ref and exact base SHA separately;
- generate the task branch on the server under repository policy;
- validate ref format and reject collisions;
- allow at most one open change request per admitted work item in CT-04;
- create state, audit, and workspace event atomically;
- expose read-only list/detail APIs and browser-neutral contracts;
- project repository/base facts into a separate resolved-contract view without marking the CT-03 draft executable.

## Binding decisions

- The authoritative base is a full object ID resolved as a commit with `^{commit}` semantics.
- Abbreviated IDs, tags without commit peeling, trees, blobs, and free-form branch descriptions are rejected.
- The first release normally uses the current configured target-ref commit as the base. A historical-base feature requires a reviewed policy and ancestry proof.
- The browser does not supply an arbitrary branch. The daemon generates one from server-owned, bounded identifiers under a configured prefix.
- Creating the database record does not create the branch; the name is a reservation and expected identity for CT-04C.

## Required adversarial coverage

```text
CR-OWNERSHIP
CR-BASE
CR-TARGET-REF
CR-BRANCH
CR-IDEMPOTENCY
JOURNAL-CHANGE-REQUEST
```

## Non-goals

- no branch mutation;
- no worktree;
- no GitOperation side effect;
- no diff;
- no agent execution;
- no approval of verification, path scope, backend, or environment.

## Exit gate

```text
AQ-01 can produce one durable local change request only after admission and repository binding.
The exact base commit and target ref are visible and distinct.
The branch name is generated, valid, bounded, and collision checked.
Cross-workspace and same-workspace/wrong-project mixtures fail at the database boundary.
Duplicate create is idempotent or rejected according to the accepted request-key policy.
No Git branch or worktree exists yet.
```
