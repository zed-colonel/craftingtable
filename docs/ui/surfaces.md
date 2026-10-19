# Surfaces

One short spec per page: its route (under `/workspaces/:id` unless it says otherwise), what it is
for, its parts in order, where it links and what it posts. Routes are parsed and built in
`apps/web/src/lib/route.ts`. Every page follows the anatomy in
[visual-language.md](visual-language.md) and the rules in
[information-architecture.md](information-architecture.md).

## Shell

`WorkspaceShell`: the rail holds the workspace picker; the workspace's pages (Dashboard, Needs you
with the open item count, Runs with the live count, Work items with the in-agenda count, Roadmaps,
Projects, Repositories, Import plan, Settings); under "Everywhere", Workspaces and Account; then the
live-connection badge, the theme toggle and Log out. Every workspace page except the dashboard and
Needs you shows the open items as one compact strip above its header. When a refresh or the event
stream fails, the page says so and keeps the last committed state.

## Workspaces

`/workspaces` (outside any workspace): every workspace as a card with its projects and counts,
then **New workspace**. `/` opens the workspace used last, else this list.

## Dashboard

`/workspaces/:id`. Its `h1` is the workspace's name, with **Import plan**. In order: Needs you (the
top five items, with **Open inbox**; absent when nothing is open), Operator wait (collapsed), the
status cards (live runs, in agenda, ready for admission, dependency-blocked, completed, and
needs-attention imports when there are any; each opens the list it counts), Live runs (with
**All runs**), the project cards, then Activity and Audit as closed disclosures.

## Needs you

`/inbox`: every open item, most blocking first, then oldest; each row names the stop, its title,
"unblocks N" and its age. Items about the workstation (storage) are shown only to an owner of every
active workspace.

`/inbox/:itemId`: the item's stop and message, its facts (waiting since, unblocks, notified), a
link to where it happened, and the decisions that resolve it, chosen from its code
(`decisions/registry.ts`), with the item's own actions where it has them (re-verify,
acknowledge). A merge decision names the full source and target branches, with explicit
**Merge** and **Cancel**. A resolved item says so and links to the subject's current item, if any.

## Work items

`/agenda[/:filter]`: work items across the workspace's active plans, one state at a time (All, In
agenda, Ready for admission, Dependency-blocked, Completed). The rail opens In agenda.

`/work-items/:workItemId` is a drill-down (R-E4) that answers "where is this, what does it wait on,
and who acts" before it shows a form:

- **Header:** the item and its state, with **Admit into agenda**, or **Remove from agenda** (an
  unstarted item; disabled with the daemon's reason when history or work prevents it) and
  **Mark complete**.
- **Slice strip** (a work item with slices): each slice's milestone chips, who acts next and on
  what as the daemon decides it, and "Open in Needs you" when an item carries it. It posts nothing.
- **Sections, in order:** Overview (facts, exit gate, required and recommended predecessors and
  what it unblocks, as links with their states), Branches (repository & branches; reference once
  work has started, and on a work item with slices from the start), Automation, Slices (the next
  phase's requirements, the others in "Other phases"), Delegation (worktrees, merge gates and the
  launch form behind **Launch a run…**), Runs (once there is a run), Diff.
- A stop an item carries links to it ("Open the decision"); otherwise the decision renders here.

## Projects and plan versions

`/projects`: the project cards; a project whose newest version a wind-down retired, with no active
version, is labelled "Retired" or "Parked". `/projects/:projectId`: the active plan's completion, Repository &
branches, summary tiles, its work items, risk, plan versions, source artifacts and import
diagnostics.

`/projects/:projectId/plans/:planVersionId`: the version's completion, Repository & branches, then
**Finalize integration** (below), its work items, and, at 900px and wider, its dependency graph
(every work item right of what it requires, its state in words, each node opening its page). Then
source artifacts, the original planning archives (when it came from a ZIP), and, closed, the
version's identity and diagnostics.

## Finalization

The **Finalize integration** section of a plan version's page. Setup opens from **Set up
finalization**: stages (correctness, conformance, simplification, polish, final independent
review), each with its profiles, scope, checks and remediation budget in disclosures, and the
final destination. A running finalization shows its stage, progress, complete candidate diff and
history, with **Pause finalization** and **Stop finalization**. The next step (a stage's batch, a
plan change, more attempts, a resume) and the final promotion, which names the exact candidate and
destination commits and offers removing the local integration branch (unchecked), are decisions:
they link to Needs you when an item carries them. A promotion whose cleanup failed offers the
retry without implying the merge failed.

## Runs

`/runs`: live runs first, then recent ones. `/runs/:runId`: the run's role, status and actions
(the hand-off to a next run, View diff, End session and Cancel run while live, and, while its
cycle is stopped at design, "Resolve design questions" linking to the item that holds the stop, or
to the work item when none does), its outcome and validated findings (open, verified resolutions,
withdrawn), a run summary, the diff, Activity, and, while the run is live, a message box for the
agent. Activity is its own scroll pane: filter chips with counts (system events hidden and tool
output collapsed by default), and it follows new events only while the reader is at its bottom;
**Jump to latest** returns. Agent text is always escaped; the outcome panel formats bold and
inline code and nothing else, and the full recorded final message stays in a disclosure.

## Roadmaps

`/roadmaps`: **New roadmap**, a link to the workspace's agent defaults, Active roadmaps, Finished
roadmaps (closed), and Cross-project roadmaps: **Import concurrency map** (a ZIP up to 8 MiB) and
the imported maps, each linking to its page.

`/roadmaps/:roadmapId[/setup|/history]`: the roadmap's name and progress, then `PageTabs`:

- **Board:** the scheduler's reason, the roadmap's own Needs you items, its status, mode and the
  workstation's shared slots (with **Manage capacity**), the controls (Start, Pause, Resume, and
  **Edit queued entries** on a roadmap without a map while it is a draft, paused or needs
  attention), then **Stop or wind down…** (**Wind down…** once it has ended) and, on a wound-down
  roadmap, **Clean up repositories…**, then the board, graph or list, and the entries with their
  individual controls. `RoadmapWindDown` owns both forms: the daemon's preview (what stops, the
  resolutions it abandons, the items that resolve, each plan version with Keep or Retire as
  superseded or parked, or why it cannot be retired), the progress of a settling record, typed
  refusals, and the cleanup's plan (worktrees to remove, branches to delete or keep in parked
  tags, what stays and why) with a discard choice for dirty worktrees. Cleaning up is an owner's.
  An incomplete wind-down's inbox item opens these controls. The
  board (R-E3b): a status strip (Needs you, Agents at work, Waiting, Done), a Gates strip of the
  unsatisfied checkpoints slices wait on, one lane per map repository (a project for a roadmap
  without a map) whose cards are work items, and a selection panel with each open entry's wait
  verbatim, its root blockers, what it unblocks and links. Checkpoints are never cards. The graph
  ([ADR-072](../decisions/ADR-072-roadmap-neighbourhood-graph.md)) draws the selection's
  neighbourhood at 900px and wider; a phone gets the grouped list. The board posts nothing and
  selecting reads nothing.
- **Setup:** for a map roadmap, an ordered checklist (plan and repository bindings, dependency
  environment, verification environments, reviewer responsibilities and delegation, automation and
  agents, plan acceptance, shared architecture decisions, submitted evidence and builds), one step
  shown at a time. A roadmap without a map points to Edit queued entries and Settings.
- **History:** planning amendments and reconciliation (a map roadmap) and the saved revisions.

## Map page

`/roadmaps/maps/:definitionId`: one imported map: its identity and original ZIP, the exact project
and plan bindings (saved explicitly), binding history, then, until a roadmap supervises the current
binding revision, the target scope supervisor that creates one; after that the map's supervision
is on that roadmap's setup. Then its targets, scheduling proposals, resources and evidence
profiles, work items and slices, and package limitations, in disclosures.

## Repositories

`/repositories[#repository-checks-<id>]`: Registered repositories, Checks (each repository's
adopted `.craftingtable/checks.json`, adopted here by a person), **Register a repository**, and
Tools on the workstation (the agent CLIs and their model catalogs with **Refresh models**, and the
outside sources, read-only).

## Import plan

`/import`: planning files or a planning ZIP, into a new project or as a version of an existing one;
a ZIP into an existing project can leave the new version inactive. The result says whether a new
version was imported, it was identical to one, or validation failed, with its diagnostics.

## Settings

`/settings[/agents|/capacity|/notifications|/storage]`, one page per section behind `PageTabs`:
General (the workspace's name, renamed by an owner), Agents (the workspace's agent defaults: four
step defaults and optional specialist overrides, each with its effective selection and source,
and the step time limit new cycles and roadmap entries start with),
Capacity (the workstation's development and verification slots and each parallel roadmap's limits),
and, for an owner, Notifications (Pushover) and Storage. A link stored before Settings was split
opens the page holding its element.

## Account

`/account` (outside any workspace): **Change password** and the user's sessions, each revocable.
