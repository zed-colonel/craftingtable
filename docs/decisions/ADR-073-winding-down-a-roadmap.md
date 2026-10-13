# ADR-073: Winding down a roadmap

- **Status:** accepted
- **Date:** 2026-10-13
- **Refines:** ADR-029, ADR-041, ADR-049

## Context

A roadmap could be stopped but never wound down (R-B11, operator 2026-10-13). Stop saved the
roadmap `stopped`, then stopped each attempt's cycle in a loop with no error handling: a reserved
merge or a stale cycle version threw mid-loop, the cycles it never reached stayed live, a second
Stop was refused because the roadmap had ended, and the cycle worker kept launching their steps.
Decision preparations, integration resolutions and reservations were never settled, and a crash
left nothing that said a stop was under way. A pending amendment could save a stopped roadmap
`paused` again.

Nothing released what a finished roadmap held. A plan version had no status: the project's active
pointer was its only state, and a version whose items had started could never be replaced,
because started items never return to proposed. Its unmerged worktrees still counted against
repository capacity, its repository policy kept freezing the default branch, and nothing removed
its worktrees and branches or preserved unmerged work. The live cross-project roadmap (b81d5f92,
WI v2 and EXO v2) had to be retired so that WorldInterface could restart as single-application
work beside a new roadmap in the same workspace.

## Decision

The operator's eight decisions of 2026-10-13 are in R-B11's entry; this records the design they
produced.

**One settle path.** Stop and wind down are one command (`RoadmapSettlement`,
`services/roadmap-settlement.ts`); a plain Stop is a wind-down that retires nothing.

- A preflight with no writes refuses with typed codes: `merge-in-flight` (a reserved merge on the
  roadmap's work or on a version to retire), `finalization-active` (an open finalization of a
  version to retire), `version-in-use` (another non-ended roadmap names the version, or work this
  roadmap does not own is live on it), `preview-stale` (the preview changed since it was read),
  `version-conflict` (a Stop's expected roadmap version is old), `wind-down-in-progress` (another
  command is settling it with other choices).
- Then the roadmap's `roadmap_wind_downs` row is written `settling`, in the same transaction as
  its audit entry. While it is `settling` the scheduler does not advance the roadmap and the cycle
  worker does not reconcile the cycles it owns: the row is the hold.
- Each step is idempotent and re-derives what is left from stored state: per owned cycle, cancel
  a live run, end an investigation, abandon an integration resolution the cycle owns (named in the
  preview), stop it with code `roadmap-wound-down`, release reservations its ended runs still
  hold; cancel live preparation runs; reject a pending amendment on this roadmap as moot; then,
  in one transaction, stop the roadmap (a completed one stays completed), write the retirements,
  clear a retired version's active pointer and mark the row `settled`.
- A step that fails records itself on the row (`incomplete`), which opens one
  `wind-down-incomplete` item in Needs you; every scheduler pass, and so every start, resumes a
  `settling` row. The command is a no-op once settled with the same choices.
- A roadmap stopped before this existed has no row; winding it down only finishes what Stop left.
  A settled row is entered again only to add retirements; a retirement is never undone.

**Retirement.** `retired_plan_versions` holds one immutable row per retired version with its
disposition: `superseded` (replaced by other work) or `parked` (resumed later as a fresh, revised
version on the same integration branch). Started items stay `admitted` with their history and
receipts; retirement is what releases them, not a new item status. A retired version:

- no longer blocks making another version active (`requireIdleProject`, whose refusals are now
  typed: `project-has-admitted-work`, `project-has-unmerged-worktrees`,
  `project-has-delegated-roadmap`, `project-has-open-finalization`);
- holds no repository capacity, does not keep another plan's integration branch from ADR-041's
  cleanup, and its repository policy freezes nothing (`requirePolicyMergeTarget`);
- cannot be named by a saved roadmap (`plan-version-retired`), and re-importing a bundle identical
  to it is refused with the same code instead of answering the retired version.

Wound down is derived, never stored on the roadmap: a roadmap is wound down when its row is
`settled`. A project whose newest version is retired and that has no active version shows
"Parked" or "Retired" by that version's disposition.

**Cleanup.** A separate command, only on a wound-down roadmap, and the only part that touches Git
(`services/repository-cleanup.ts`).

- Selection is by record, never by branch pattern: the worktrees of the retired versions, of the
  roadmap's attempts (retired ones included) and of its preparations. A worktree that another
  non-ended roadmap owns, or that has a live run or an active cycle, is listed and left.
- Each active worktree is removed under the normal removal rules; a dirty one is kept and listed
  unless the operator ticks discard.
- Each selected branch that still exists is deleted only by compare-and-swap at the tip the plan
  recorded. A branch whose tip is an ancestor of the integration commit pinned when the plan was
  made, while that commit is an ancestor of the live integration head, is deleted
  (`deleteContainedBranch`). Any other branch first gets an ordinary local tag
  `<repository directory>/parked/<branch tail>` at its tip (`preserveRef`, create-only), then is
  deleted against that tag. A branch checked out in a worktree that stays is refused.
- Never touched: default branches, every plan's integration branches (ADR-041's finalization
  cleanup stays their only path), baseline tags, any existing tag, and the operator's
  `craftingtable/checks` branches. Both Git functions are moving operations for the protected-ref
  watch, so a run in progress elsewhere in the repository is not told its refs moved.
- The plan is persisted in `repository_cleanups` with each action's state. Each action is audited
  `authorized` before its Git step and `done` (or `kept`, `refused`) after it, under the worktree
  mutation guard and the repository's merge lock, with a bounded retry while the repository is
  busy. Repeating the command resumes the persisted plan, never a recomputed one; it runs only
  when the operator issues it, so the daemon deletes no ref after a restart on its own.

**Preview and authority.** Each command's GET computes a preview and its SHA-256 digest from
stored state and Git; the POST recomputes it and refuses `preview-stale` on any difference, so a
preview survives a restart and holds no capability. Both commands are `control` routes, so R-A6's
decision boundary is unchanged: the wind-down is an editor's and asks for the password again when
it retires a version; the cleanup is an owner's and always asks.

## Consequences

- Stop can no longer leave live cycles behind or be refused half-done; it may be refused before it
  starts, by code.
- A wound-down roadmap's cycles end as `stopped` with action `roadmap-wound-down` in their audit
  entry; R-B4 moves that code into its stop record, R-B5's kernel consumes the hold, and R-B6
  reuses it as its per-roadmap drain.
- Parked tags are local and visible in `git tag`; a `git push --tags` would publish them.
- One more operator surface exists, a lifecycle control replacing Stop, not a per-stop recovery
  panel.

## Alternatives considered

- **A `retired` work-item status.** Needs a trigger rebuild of `work_items` and changes every
  reader of item status; the version's retirement already says what is needed (decision 1).
- **Selecting branches by the `ct/*` pattern.** It would delete the running WorldInterface
  roadmap's branch on the live repository; records name exactly what the roadmap made.
- **Deleting integration branches in the wind-down.** ADR-041's finalization cleanup already owns
  that, with its own checks; WI's new work builds on `wi-fabric-2` (through `wi-standalone-base`)
  and EXO keeps `exo-v3`.
- **A stored preview capability.** Recomputing is cheap and needs no expiry or cleanup.
