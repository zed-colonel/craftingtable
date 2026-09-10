# CraftingTable UI principles

CraftingTable is a technical tool used for hours at a time, often from a laptop on
the couch while agents work on the workstation. The interface should read like a
good terminal: dark, dense enough that nothing important is off-screen, calm, and
honest about state.

## Desired qualities

- Dark by default. Near-black surfaces, high-contrast text, one saturated accent
  (teal) used for focus, links, and the primary action. A light theme exists for
  bright rooms; the toggle lives in the rail and the choice persists in the browser.
- Semantic colour is reserved for state: attention (amber), active (blue), ready
  (green), blocked (red), done (grey). Colour never carries a status alone; the label
  is always visible text.
- Tight spacing. Panels are padded at 1rem, gaps are 0.75–1rem, and the type scale
  starts at 14px. Empty space is a layout tool, not a default.
- Monospace for identifiers, branches, paths, models, and numbers; sans for prose.
- Every number is a door: a count on the dashboard opens the list it counts.
- Dense operational detail where work is being inspected (runs, diffs, agenda) and
  summaries everywhere else.
- Motion only when it communicates a state transition (a live-run pulse); no
  decorative animation, and none at all under reduced-motion.
- Desktop-first, but usable on a laptop at 900px where the rail collapses above
  the content.

## Shell

- A 220px navigation rail on the left holds the workspace picker, the workspace's
  pages (Dashboard, Runs, Agenda, Projects, Repositories, Import plan, Settings), the
  cross-workspace pages (All workspaces, Account), the live-connection badge, the
  theme toggle, and Log out. Navigation appears nowhere else.
- `/` resolves to the last workspace used; `/workspaces` lists every workspace as a
  card with its projects and counts and hosts the new-workspace form.
- The dashboard is: status cards (live runs, in agenda, ready for admission,
  dependency-blocked, completed, and needs-attention when non-zero), the live runs
  list, project cards, then Activity and Audit as collapsed disclosures.

## Vocabulary

Work items move through `Proposed → In agenda → Completed`; "In progress" is derived
from an active worktree or a live run and is never stored. Use exactly:

```text
Proposed               imported and preserved, not yet in the agenda
Ready for admission    proposed, every required predecessor completed
Dependency-blocked     waiting on a required predecessor that is not completed
In agenda              admitted; delegation happens from here
In progress            admitted with a live worktree or run
Completed              merged through a reviewed worktree, or marked done by hand
```

Merge readiness is a property of a worktree, decided by the daemon from its runs:

```text
Needs a review run                 no review has run on this worktree
Review has no verdict yet          the review has not ended with a verdict line
Review requested changes           the latest review said changes-requested
A run started after the review     the branch may have changed; review again
A run is live in this worktree     wait or end it
Reviewed and mergeable             the Merge action is offered
```

Runs show the model the backend reported (not only the one requested) and label a
subscription session's cost as an estimate (`≈$0.28 (est.)`), because Claude Code
reports API-equivalent figures even when it is billed to a subscription.

A bare "Ready", "Blocked", "Approved", or "Verified" never appears.

## Run page

- The event feed is its own scroll pane. It follows new events only while the
  reader is already at its bottom; scrolling up stops following and a "Jump to
  latest" control returns. The page itself never moves under the reader.
- Groups (messages, tools, notices, system) are filter chips with counts; system
  events are hidden by default and tool output is collapsed by default.
- Everything from the agent is rendered as text, never markup.

## Accessibility

- Full keyboard navigation and visible focus states.
- Semantic landmarks and one `h1` per page.
- Colour is never the sole carrier of status.
- Respect reduced-motion preferences.
