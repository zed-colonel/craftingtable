# ADR-026: Plan integration branches and review freshness

Status: accepted  
Date: 2026-09-10

## Context

AQ-04 completed through automation, but worktree creation still depended on the primary
checkout and the operator chose its merge target separately. Parallel work needs an explicit
integration baseline and approval that becomes stale when that baseline changes.

## Decision

Schema 10 stores mutable repository/integration-branch settings per imported plan version,
separate from the immutable plan. The plan page is the permanent configuration surface;
Projects is directly accessible from the navigation rail. New plan versions require an
explicit choice. Existing plans do not need reimporting.

New item worktrees branch from the configured local integration branch's exact current
commit and record that branch as their merge destination. The primary checkout's selected
branch is irrelevant. Settings changes affect future worktrees only. Existing worktrees
retain their original base and adopt or retarget an existing integration branch explicitly.
Creating an integration branch is an explicit settings command with a selected starting
branch; the merge command never creates a missing destination.

Every new review, manual or automated, records the item commit, integration commit,
and worktree version. Review requires a clean managed branch containing the integration
commit; merge requires that context to remain unchanged. Retargeting and integration updates
increment the worktree version, invalidating prior reviews even if no commit changes.
The operator must pause a cycle and end live sessions before these mutations. Updating uses
a normal merge into the item branch, aborts conflicts, and never completes an item. Resuming
an awaiting-merge cycle after updating launches a fresh review with the existing handoff
lineage. Review briefs require repository checks on the combined state; the daemon verifies
commit identity, not the truth of reviewer test claims.

Required predecessors must be completed and their recorded integration commits must be
ancestors of the selected integration head and, at run launch, the item head. Manually completed
items can receive operator-attested commit evidence, verified against the integration branch,
without editing immutable completion records. This attests commit inclusion, not semantic
correctness. Item diffs use the common ancestor with integration; original starting provenance
remains visible on the worktree.

## Consequences

The existing daemon guard covers worktree launch, update, retarget, removal, and merge.
Operator merges also serialize per repository and pass an exact source commit plus expected
target commit to Git. External Git activity is checked at the operation boundaries; the daemon
cannot lock out arbitrary processes running with the operator's OS authority. The preexisting
Git/SQLite crash gap during final merge and cleanup remains; no distributed transaction is
claimed. No automatic revision-to-main promotion, rebase, force-push, roadmap scheduler, or
cross-project concurrency is introduced.

## Alternatives considered

Import-only configuration would strand existing plans. A mutable project-wide target would
silently affect work already underway. Verdict-only approval would remain valid after unrelated
integration changes. Per-plan settings plus recorded worktree and review context avoid those
ambiguities while keeping the manual flow.
