# Glossary

The operator's words. Use them in labels, headings and messages. Wire and format names are not
renamed: where a term differs from its wire or format name, that name is in brackets. Internal
identifiers (binding revision, generation, digest, fingerprint, reservation, dispatch) belong in
disclosures; some panels still show them outside one.

## Terms

```text
Plan version         an imported, immutable plan; its work items are what gets delegated
Work item            one deliverable of a plan version (AQ-01), in the states below
Slice                a part of a work item that a map schedules on its own; its milestones
                     are started, merged and verified
Map                  a concurrency map: which slices and checkpoints may proceed together
Scheduling proposal  a map's proposed scheduling rule (CS-D01), adopted by the operator before
                     the map runs [format: decisions]
Checkpoint           a map milestone that passes only on reviewed evidence
Worktree             the isolated Git checkout that one piece of work happens in
Run                  one agent session in a worktree: design, implement or review
Cycle                the controller's sequence of runs for one worktree (design, implement,
                     review, remediate), up to merge
Roadmap              a delegated sequence of work items, or a map's target, that the
                     controller schedules
Finding              an issue a review reported, with an ID, severity and status
Finding disposition  the operator's recorded choice about findings at a finalization stage,
                     with its rationale [wire: finalization decisions]
Evidence             reviewed proof that a slice, work item or checkpoint meets its requirements
Stop                 where automation halts; every stop has a code and an owner
Needs you            the stops the operator owns, as attention items
Finalization         the staged whole-plan review and polish of an integration branch
Promotion            the operator-approved merge of the final candidate into its destination
Capacity             how many runs the workstation admits at once, for development and for
                     independent verification
```

## Stops and who moves them

Every stop carries a typed code and an owner, declared by the controller in the same write that
stops the work ([ADR-067](../decisions/ADR-067-typed-attention.md)):

- **The operator owns it:** it is an attention item in Needs you, labelled by its code
  (`lib/attention-labels.ts`). Most ask for a decision: a design choice, a plan change, an
  authorization (an approval, or more attempts), a finding disposition, or a promotion. Others ask
  the operator to act on something that went wrong or changed: a failed run, a lost session, a
  storage alert, a protected branch that moved.
- **The controller owns it:** it is a wait the controller clears by itself. A roadmap entry's
  waits are on prerequisites, capacity, an exclusion group, a phase gate, an integration hold, a
  running review or recovery round, or the cycle's own controller (`ENTRY_WAIT` in
  `packages/domain/src/attention.ts`). A stop that automation has claimed (a roadmap that merges
  automatically, conflict automation, scope recovery) stays the controller's until the claim
  lapses.

Name a flow by the stop it resolves, not by the panel that hosts it. Group waiting reasons by who
moves them, as `Reasons` does: *Needs you*, *Waiting on automation*, *Waiting on other work*. A
board or slice strip names who acts next as *Needs you*, *Agent at work*, *Waiting* or *Done*.

## Work-item states

Work items move through `Proposed → In agenda → Completed`. "In progress" is derived from an
active worktree or a live run and is never stored.

```text
Proposed               imported and preserved, not yet in the agenda
Ready for admission    proposed, every required predecessor completed
Dependency-blocked     waiting on a required predecessor that is not completed
In agenda              admitted; delegation happens from here
Completed              merged through a reviewed worktree, or marked done by hand
```

Use these names in statuses, filters, status cards and the project cards' counts. A bare
"Ready", "Blocked", "Approved" or "Verified" is never a state label (`ProjectCards.test.tsx` and
`planning-views.test.tsx` check the cards).

## Merge readiness

Merge readiness belongs to a worktree and is decided by the daemon from its runs (`mergeGateFor`).
The labels (`MERGE_GATE_LABELS` in `lib/execution-labels.ts`):

```text
Reviewed and mergeable                  the merge is offered
Needs a review run                      no review has run on this worktree
Review has no verdict yet               the latest review is running, did not finish,
                                        or ended without a verdict
Review requested changes                the latest review said changes-requested
A run started after the review; review again
A run is live in this worktree          wait for it or end it
Automation has not reached merge approval
Fresh review of the integration target required
Merging adopts the check definitions this slice changes
Execution scope requirements or review evidence are unresolved
Use scope verification or parent acceptance; this worktree does not merge
Recover the reserved integration merge
Worktree removed
```

## Runs, cycles and roadmaps

Run statuses read *Starting, Working, Awaiting your input, Finished, Failed, Cancelled,
Interrupted*; cycle statuses *Running, Paused, Needs attention, Awaiting merge approval, Stopped,
Completed*; roadmap statuses *Draft, Scheduling enabled, Paused, Needs attention* (*Resume
required after restart* after a crash), *Stopped, Completed*.

A run shows the model the backend reported, beside the one requested when they differ, and labels
a subscription session's cost as an estimate (`≈$0.28 (est.)`): Claude Code reports
API-equivalent figures even when a subscription pays.
