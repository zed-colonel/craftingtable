# CT-04C — Crash-reconciled managed worktree lifecycle

**Parent:** CT-04  
**Risk:** Critical  
**Dependencies:** accepted CT-04B  
**Primary areas:** durable Git operations, branch/worktree side effects, restart reconciliation, cleanup safety, minimal NUL-safe clean/dirty status, migration 0005, generation placeholder

## Objective

Provision and remove one daemon-managed local worktree for a `ChangeRequest` without treating subprocess exit as the sole source of truth. Every side effect is preceded by durable intent and followed by observation-based classification. Daemon restart reconciles partial states without duplication or destructive guessing.

## Required outcomes

- add `GitOperationId`, `ManagedWorktreeId`, and minimal `GenerationId`;
- add migration 0005 with structural ownership, active-operation exclusion, one worktree per change request, and one open generation placeholder;
- add typed worktree-add and worktree-remove Git functions;
- generate the managed path under the configured worktree root from server-owned IDs;
- commit operation intent before subprocess execution;
- suppress hooks and prompts to the extent defined by the accepted policy;
- capture bounded structured subprocess outcome evidence;
- inspect branch, worktree registry, path, `HEAD`, and repository identity after execution;
- classify `succeeded`, `failed`, `uncertain`, `blocked`, or `reconciled` honestly;
- run startup and explicit reconciliation for nonterminal operations;
- serialize active operations per repository with database constraints plus a process-local lock;
- create one open generation placeholder only when a managed worktree is established;
- add the minimal NUL-safe `status --porcelain=v2 -z` reader required to distinguish clean from dirty/unsupported cleanup state;
- reject cleanup for dirty, unknown, mismatched, replaced, or unsupported state;
- remove with `git worktree remove` without force;
- never use recursive deletion fallback;
- retain the task branch after worktree cleanup;
- publish semantic audit/events after authoritative state commits.

## Crash matrix requirement

The accepted plan must identify a deterministic test seam before and after:

```text
operation-intent commit
running-state commit
subprocess spawn
branch creation
worktree registry update
worktree directory creation/checkout
subprocess exit observation
post-effect repository inspection
outcome transaction commit
post-commit notifier
```

Tests must exercise partial states that can be constructed with real temporary repositories, not only mocked return values.

## Required adversarial coverage

```text
WT-PROVISION
WT-CRASH
WT-RECONCILE
WT-CONCURRENCY
WT-CLEANUP
WT-REPLACEMENT
JOURNAL-WORKTREE
```

## Non-goals

- no agent execution;
- no repository checks;
- no controller-owned generation commit;
- no branch deletion;
- no merge/rebase/reset/stash;
- no remote Git;
- no diff viewer.

## Exit gate

```text
A valid change request provisions exactly one branch/worktree under the managed root.
A daemon restart reconstructs or honestly blocks every injected partial state.
Blind retry cannot create duplicate worktrees or reuse a wrong branch.
A clean exact managed worktree can be removed safely.
Dirty, untracked, staged, conflicted, wrong-branch, wrong-head, unknown-path, and replaced-repository cleanup attempts are rejected.
No force or recursive deletion path exists.
```
