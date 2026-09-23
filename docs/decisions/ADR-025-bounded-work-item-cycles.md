# ADR-025: Bounded work-item cycles with operator merge approval

Status: accepted  
Date: 2026-09-10

## Context

AQ-03 exercised the complete handoff and structured findings path manually. A mergeable
verdict can still contain useful minor fixes. Automating the existing commands therefore
needs an independent completion policy, persistent control state, and an explicit merge stop.

## Decision

One cycle controls one selected worktree for an admitted work item. Required predecessors
must be completed before starting or advancing. Schema 9 stores the cycle, its run reservation,
initiating user, fixed per-step agent/model/permissions, and completion policy. Updates use
version checks and append audit and workspace events atomically. The daemon runs the controller;
the browser projects state and issues authenticated, CSRF-protected commands.

The cycle runs design, implementation, review, and remediation using existing run roles and
complete handoffs. The daemon ends completed agent sessions before advancing. Design proceeds
only when the final message ends with an explicit `## Open questions` section containing `none`.
Missing, truncated, or unresolved checkpoints pause for operator attention.

Completion requires a valid consolidated review, a mergeable verdict, an asserted met exit gate,
zero open blocking/major/minor findings, and at most the configured number of nits (default 3).
Default limits are three remediation rounds and 120 minutes per step. Two remediation rounds
with the same open IDs/severities and gate/verdict stop for attention. Limits never weaken the
quality policy. Reviewer evidence remains an assertion; the controller does not independently
run or prove the project's acceptance checks.

Explicit unanswered `## Open questions` in successful implementation, remediation, or review
outcomes stop the ordinary cycle before another step. Legacy results without that section remain
valid. The browser provides **Continue with guidance** for questions and stalled reviews. An
authenticated answer or changed approach is one-shot guidance: it applies to the next run of the
step it was given for (and that step's ADR-062 service retries and completion continuations), is
recorded in that run's brief, and is not inherited by later steps. Only the instructions given at
cycle start apply to every step. (Amended 2026-09: accumulated guidance contradicted later
steps.) Guidance resets the bounded stall window and uses the existing allowance. It never
grants extra rounds or approves a finding. If the allowance is exhausted, the separate explicit
additional-round authorization can carry answers alongside its grant. Invalid reports, conflicts,
and independent-review scope boundaries retain their existing guards.

Before review, the daemon requires a clean managed branch and records its commit. It checks
that identity after review and again at operator merge. Automated merge approval pins Git's
source operand to that reviewed commit. A daemon guard prevents launches and resumes during
an operator merge/removal. The operator still selects the merge target; approval does not
claim that the resulting merge commit has independently passed checks against a changed target.

Automation never invokes merge. Awaiting-merge and needs-attention states remain visible across
browser reloads in workspace notices. Email/SMS and operating-system notifications are deferred.
Pause leaves the current session under manual control. Resume explicitly adopts the latest
manual run only when it continues the cycle’s handoff lineage; a manual review is repeated because its starting commit was not recorded. Stop
cancels the owned process and returns the item to the manual flow. Settings are fixed for a
cycle; changing them requires stopping and starting a new one.

Run IDs are reserved before launch. Startup pauses running cycles and marks interrupted runs;
it never silently retries a process. Pending launches can be cancelled, and a late backend
session is terminated without writing to closed storage. Background work remains delegated to
the initiating user while that user is active and remains an owner/editor; session expiry or
logout does not revoke a deliberate cycle. Manual commands cannot compete with running cycles.

## Consequences

The existing manual flow remains available, with explicit takeover controls. This is a usable
single-item loop; a roadmap, cross-project dependencies, parallel scheduling, outbound notices,
and independently executed acceptance checks can build on it later. Findings consolidation and
severity remain reviewer responsibilities, so the operator's final inspection remains material.

## Alternatives considered

A verdict-only stop leaves minor fixes behind. Endless remediation cannot distinguish quality
improvement from churn. Automatically accepting incomplete reports hides missing evidence.
A general workflow language or cross-project scheduler would expand authority before this
single-item controller has been exercised on real work.
