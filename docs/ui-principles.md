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
- Keep the desktop rail above 900px. At narrower widths, use a compact header
  with a Menu button; navigation expands in the page and closes on navigation or
  Escape. New destinations start at the top on these screens.
- On phones, use at least 44px touch targets and 16px form text. Stack controls
  and metadata; wrap long paths, branch names, and findings. Tables and patches
  scroll inside their own panels, never by widening the page.

## Shell

- A 220px navigation rail on the left holds the workspace picker, the workspace's
  pages (Dashboard, Runs, Agenda, Roadmaps, Projects, Repositories, Import plan, Settings), the
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
- Agent HTML is always escaped. The final-outcome panel above activity supports controlled
  bold and inline-code formatting; it never evaluates HTML or loads remote content. The full
  original message remains available in a disclosure. A validated report is shown as findings
  separately, and closed findings are grouped apart from open work.
- Findings retain their IDs, severity, status, location, and full explanation on
  phones. Separate findings visibly and let long locations wrap.
- Merge confirmation shows the complete source and target branches as wrapping
  text, alongside the explicit Merge and Cancel controls.

## Accessibility

- Full keyboard navigation and visible focus states.
- Semantic landmarks and one `h1` per page.
- Colour is never the sole carrier of status.
- Respect reduced-motion preferences.

## Roadmaps

Keep sequential execution the default. Parallel mode exposes in-flight and per-repository
limits plus a bounded integration-refresh allowance. Label order as priority, show each
entry's exact waiting reason, and distinguish dependency, capacity, exclusion, and operator
attention. In-flight counts include paused and merge-ready work; running-cycle counts do
not. Individual pause/resume controls must not imply that sibling work will stop. Existing
work-item links retain the review, diff, manual takeover, and explicit merge controls.

Integration conflict recovery belongs beside the cycle status. Show conflicting paths, exact
item and incoming commits, agent attempt links and the selected resolution profile. Wrap paths
and commit IDs on phones. Keep completion of the integration update distinct from final merge
approval. Abandonment names the merge resolution it discards and explains that unrelated edits and
untracked files may remain.


## Integration policy and final review

Roadmaps expose separate merge and conflict-delegation controls with manual defaults and
per-entry overrides. Execution displays the policy bound to the started attempt, even after
queued defaults change. Questions and exhausted recovery remain attention states.

Plan finalization lives on the plan-version page beside branch settings. Its setup names
round count, profiles, focus and final destination. Each attempt shows its integration
snapshot, current outcome above activity, complete candidate diff, history and controls.
Pause retains the integration hold; Stop explains retained work. Final approval names the
exact candidate and destination commits and is always a separate operator action.
Successful merges with cleanup failures display a retry action without implying the merge
failed or holding dependent items back. All controls remain usable on phone layouts.

Finalization uses one **Next finalization step** form for selected finding decisions,
additional remediation and resumption guidance. Selection, required rationale, extra attempts
and the resulting allowance belong together; a disabled action explains the missing input.
Do not show a separate remediation form that silently ignores the selected batch. Setup names
the independent initial remediation budget and distinguishes it from scheduled polish passes.

Completed plan headers and project cards name the final destination; detail views retain the
merge commit and completion date. Work-item completion and final plan promotion remain distinct.
Final approval offers an unchecked local integration-branch removal option. Completed attempts
retain a separate removal/retry action with the exact branch and snapshot. Cleanup errors say
that promotion completed and the branch was retained; historical branch settings explain an
intentional removal instead of showing a missing-branch error.
