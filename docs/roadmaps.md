# Running roadmaps

A roadmap delegates work items, or a concurrency map's slices, to automated cycles: the daemon
creates each item's branch and worktree when it is eligible, runs its cycle (design, implement,
review, remediate) and waits for a merge. This guide covers using one; how the pages look is in
[ui/surfaces.md](ui/surfaces.md#roadmaps), and the reasons are in
[ADR-029](decisions/ADR-029-sequential-roadmap-execution.md),
[ADR-030](decisions/ADR-030-controlled-parallel-roadmaps.md) and
[ADR-033](decisions/ADR-033-delegated-integration-and-plan-finalization.md).

## Before the first roadmap

- Register the repository (**Repositories**), and set each plan's repository and integration
  branch (**Projects →** a project **→ Repository & branches**). A roadmap refuses an item whose
  plan has none.
- In a repository with adopted checks, every merge needs those checks to have passed on the
  reviewed commit; a roadmap's cycle in a repository with no adopted checks stops as
  `repository-checks-undeclared` before anything launches. Adopt `.craftingtable/checks.json` on
  **Repositories → Checks** first.
- Set the workspace's agent defaults (**Settings → Agents**); a new entry starts from them.

## A roadmap of work items

1. **Roadmaps → New roadmap.** Name it, choose **Sequential** or **Parallel**, and add work items
   from the workspace's plans. Each entry has its agents and step permissions, instructions,
   completion limits and, in parallel mode, exclusion groups. A sequential roadmap must list each
   required predecessor before its dependents; a prerequisite outside the roadmap still blocks.
2. **Save.** Saving records a revision and starts nothing. The roadmap opens on its own board.
3. **Start roadmap.** One delegated roadmap runs per workspace at a time: stop or finish the other
   first. Closing the browser leaves scheduling running.
4. **Merge.** A cycle that reaches merge approval waits in Needs you, unless the roadmap's merge
   policy merges it (below). Only that entry's own merge releases what depends on it: a mergeable
   verdict is not enough, and marking the item complete by hand stops the roadmap on it. An item
   completed before the roadmap reached it counts as done.

**Sequential** runs one entry at a time, in list order: a blocked entry holds every later one.
In each registered checkout it also waits while any other unmerged worktree or reservation
exists, including manual worktrees and other roadmaps' work.

**Parallel** treats list order as priority: an eligible later entry starts while an earlier one
is blocked. It admits work up to the roadmap's in-flight limit and its per-repository limit (both
2 by default, 1–16); in-flight counts work awaiting merge, paused or needing attention, while
"Cycles running" counts only running cycles. Several roadmaps sharing a checkout are held to the
tightest per-repository limit among them. In either mode, an item that already has an unmerged
worktree, manual or not, is not given another. Entries sharing an **exclusion group** (exact names, comma
separated) never overlap: the group is held until the holder merges or its worktree is removed.
The workstation's own slots (**Settings → Capacity**) bound every roadmap together.

Change a parallel roadmap's limits in **Settings → Capacity** while it is a draft, paused or
needing attention.
The scheduling mode cannot change while attempts are in flight; lowering a limit cancels nothing.

## Pause, stop, edit and restart

- **Pause roadmap** stops new admissions and pauses running cycles; a cycle awaiting merge keeps
  waiting, and you can merge it while paused. Nothing new starts until **Resume roadmap**.
- **Pause item** and **Resume item** (a running parallel roadmap) hold one entry; other eligible
  entries carry on, and individually paused entries stay paused when the roadmap resumes.
- **Stop roadmap** ends the roadmap and its cycles and leaves their worktrees for manual work. A
  stopped or completed roadmap is history; create a new one for what remains.
- **Edit queued entries** (draft, paused or needing attention): started entries keep their work
  item, settings and, in a sequential roadmap, their place at the front. Each save is a new
  revision, listed on the roadmap's **History**; new attempts bind it, started ones keep theirs.
  When a plan's branch settings change, its entries stop for you until you save the queued
  entries again.
- **Restarts.** A deploy or `systemctl stop` drains: the restarted daemon resumes running roadmaps
  and interrupted steps by itself. After a crash a running roadmap shows **Resume required after
  restart**: inspect its current items, then **Resume roadmap**
  ([ADR-066](decisions/ADR-066-drained-restarts-and-session-resume.md)).

## Agents and permissions

On a roadmap of work items, each entry's agents sit beside its step permissions in **Edit queued
entries**. Saving writes the permissions to the roadmap's definition and the agents to an agent
assignment ([ADR-064](decisions/ADR-064-agent-profile-delegation.md)), which reaches the future
steps of cycles already started; a change of agents alone saves no new revision. Agents change
only while the roadmap is paused, a draft or needing attention. A map roadmap sets them per
settings level in its setup's **Automation and agents** step. A form that starts one action (a
cycle, a hand-off, a recovery, a finalization stage) shows the agent it would use and lets you
change it for that action only.

## Merges and conflicts

A roadmap's automation decides two things, each manual by default and overridable per entry:

- **Integration merges:** automatic merges into the integration branch when the review gate
  holds. `main`, `master`, every registered repository's default branch, a plan's additional
  protected branches and finalization destinations are never automatic targets, and a slice that
  changes the repository's check definitions is always merged by a person
  ([security.md](security.md#merge-and-promotion-authority)).
- **Integration conflicts:** an agent resolves a conflicted update from integration, with up to
  three attempts; the daemon commits only the exact merge it reserved
  ([ADR-032](decisions/ADR-032-delegated-integration-conflict-resolution.md)).

In a parallel roadmap, or one that merges or resolves automatically, a cycle whose integration
branch moved updates from it at an idle review boundary and is reviewed again, up to the
roadmap's refresh limit per item (3 by default, at most 20). At the limit the cycle stops as
`integration-refresh-limit`: update from integration by hand, then resume.

**Change future delegation** (a map roadmap's setup, while it is a draft, paused or needing
attention, and no agent run or cycle is running in the workspace) changes the
merge policy and reviewer responsibilities for selected entries, started ones included, without
resuming anything or reopening plan acceptance.

## Cross-project maps

A concurrency map schedules slices of work items across several projects
([ADR-043](decisions/ADR-043-package-imports-and-concurrency-previews.md),
[ADR-048](decisions/ADR-048-cross-project-supervision.md)).

1. **Import.** **Roadmaps → Import concurrency map** takes a ZIP up to 8 MiB. The map gets its own
   page and starts nothing.
2. **Bind.** On the map's page, bind each of its projects to an exact plan version and repository,
   and save. A map whose bindings no longer match the workspace shows diagnostics; nothing is
   rebound implicitly.
3. **Supervise.** Choose a planning target, and whether to run only its prerequisites or the full
   map with the target first. The preview lists the included and excluded milestones. Review the
   map's scheduling proposals and adopt them all for these exact bindings, with a rationale;
   adoption passes no checkpoint. Then **Create cross-project roadmap**; from then on the map is
   supervised from that roadmap's setup.
4. **Set up.** The roadmap's **Setup** tab is a checklist: plan and repository bindings, the
   dependency environment (pinned upstream commits), verification environments, reviewer
   responsibilities and delegation, automation and agents, plan acceptance, shared architecture
   decisions, and submitted evidence and builds.
5. **Accept the plan.** Where the map's plan checkpoint is one the daemon can attest, generate the
   saved-plan evidence and review and accept it; otherwise submit independently reviewed evidence
   for it ([ADR-050](decisions/ADR-050-generated-plan-acceptance-evidence.md)). Acceptance covers
   the map and its archives, the bindings and plan archives, the adopted proposals, decisions
   approved with staged clauses, each entry's reviewer responsibilities, the target and selection,
   resource profiles and locks, and the upstream pins. Names, instructions, agents, automation,
   completion policy and capacity are not part of it, so changing them leaves it valid.
6. **Start.** Start and Resume refuse while plan acceptance, a binding, the adoption or (for a
   map with upstream projects) the pinned dependency environment is missing, and say which.

While it runs, slices move through started, merged and verified, and a work item through parent
acceptance ([ADR-045](decisions/ADR-045-slice-execution-and-parent-acceptance.md)); the board
shows what each waits on and what it unblocks. Shared architecture decisions are prepared and then
approved by you ([ADR-059](decisions/ADR-059-shared-design-decisions.md),
[ADR-065](decisions/ADR-065-future-delegation-and-decision-preparation.md)); preparing is never
approval.

**Amendments.** To change a running map's plans, import the revised plans without making them
active, configure their branches, import and bind the revised map, then preview and propose the
exact replacement on the roadmap's **History**. A proposal holds the roadmap; apply or reject it
with a rationale; reusing integrated code is opt-in and transfers no approval. Either way the
roadmap stays paused until you resume it
([ADR-049](decisions/ADR-049-reviewed-map-amendments-and-finalization.md)).

## Finalization

Once every item of a plan version is completed, finalize it from its plan version page: staged
reviews (correctness, conformance, simplification, polish, a final independent review) on a
candidate branch, then a promotion you approve for the exact candidate and destination commits.
No roadmap policy promotes ([ADR-042](decisions/ADR-042-staged-plan-finalization.md)). A map
roadmap's **History** shows each project's finalization readiness and links to its plan.

## Where it asks for you

Every stop a roadmap needs you for is an item in **Needs you**, and the roadmap's board lists its
own. Waits the controller clears itself (prerequisites, capacity, exclusion groups, phase gates)
show on the board and in its status list, and never notify. Configured notifications are sent from
the same items ([operations.md](operations.md#notifications)).
