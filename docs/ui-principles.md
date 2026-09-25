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

## Page anatomy

Every page reads top to bottom in the same order, so the operator never has to
hunt for state or for the next step:

1. **Identity.** `PageHeader`: crumbs, one `h1`, one line of context, the page-level
   state badge, and the actions that apply to the whole page.
2. **State.** A `StatusStrip` of labelled facts (branch, target, model, cost, turns,
   revision). Never an unlabelled "a · b · c" line.
3. **What needs you.** An `ActionBar` with the primary action first. Typed waiting
   reasons are grouped by who resolves them (`Reasons`): *Needs you*, *Waiting on
   automation*, *Waiting on other work*.
4. **Working sections.** `Section`s with a title, count, and one-line summary of their
   current state, always expanded. Long pages carry a `SectionNav` ("On this page").
5. **Reference and history.** Collapsible `Section`s that start closed: branch settings
   on an item page, plan metadata, diagnostics, activity, audit.

Explanatory prose about the model lives in an `About` disclosure inside the section it
describes, not under its title. A section shows state first and explains itself on
request. Forms open from a named action ("Set up finalization", "New roadmap", "Launch
a run") rather than rendering permanently; a page with nothing to do does not read as
a form.

### Copy

- A heading (`h1`–`h6`, `legend`, a `Section` or `PageHeader` title) is a name, not a
  sentence: at most eight words.
- A paragraph that is always shown is at most about 160 characters. Longer explanation
  goes in the section's `About`. A paragraph that depends on state (an error, a result,
  a warning) may be longer, but it states the fact first.
- Keep one-line consequences beside the action they describe ("Does not resume the
  roadmap"), not in a paragraph above the form.
- A recovery panel renders only while there is something to recover. It disappears once
  the stop is resolved. Do not add a new per-stop recovery panel; see the review
  program's rules (R-A5/R-A6 own the inbox and the consolidated decision components).
- `apps/web/src/copy-rules.test.ts` enforces the first two rules on every component.

The shared primitives live in `apps/web/src/components/` and are the only way to build
these parts. Feature components keep their data props; the anatomy is a composition
rule, not a data change. `pnpm ui:walkthrough` takes dated captures of every page on
desktop and phone (indexed in `docs/ui-walkthrough/`); take one before and after
structural UI work.

## Shell

- A 220px navigation rail on the left holds the workspace picker, the workspace's
  pages (Dashboard, Runs, Work items, Roadmaps, Projects, Repositories, Import plan,
  Settings), the cross-workspace pages (Workspaces, Account), the live-connection badge,
  the theme toggle, and Log out. Navigation appears nowhere else.
- A page's `h1` is its rail label. The Dashboard is the one exception: its `h1` is the
  workspace's name, because the dashboard is the workspace's home.
- `/` resolves to the last workspace used; `/workspaces` lists every workspace as a
  card with its projects and counts and hosts the new-workspace form.
- The dashboard is: a Needs your attention section (cycles waiting for a merge
  approval or a decision; absent when empty), status cards (live runs, in agenda,
  ready for admission, dependency-blocked, completed, and needs-attention when
  non-zero), the live runs list, project cards, then Activity and Audit as collapsed
  disclosures. Every other workspace page shows the same waiting cycles as one compact
  strip above its header, and the Dashboard rail link carries their count.

## Vocabulary

### Glossary

These are the operator-facing terms. Use them in labels, headings and messages. Wire and
format names are not renamed: where a term differs from its wire name, the wire name is
given in brackets. Internal identifiers (binding revision, generation, digest,
fingerprint, reservation, dispatch) appear only inside disclosures.

```text
Plan version         an imported, immutable plan; its work items are what gets delegated
Work item            one deliverable of a plan version (AQ-01), with the states below
Slice                a part of a work item that a map schedules on its own:
                     started, merged, verified
Map                  a concurrency map: which slices and checkpoints may proceed together
Scheduling proposal  a map's proposed scheduling rule (CS-D01), adopted by the operator
                     before the map runs [format: decisions]
Checkpoint           a map milestone that passes only on reviewed evidence
Worktree             the isolated Git checkout that one piece of work happens in
Run                  one agent session in a worktree: design, implement, review, remediate
Cycle                the controller's sequence of runs for one worktree, up to merge
Roadmap              a delegated sequence of work items, or a map target, that the
                     controller schedules
Finding              an issue a review reported, with an ID, severity and status
Finding disposition  the operator's recorded choice about findings at a finalization
                     stage, with its rationale [wire: finalization decisions]
Evidence             reviewed proof that a slice, work item or checkpoint meets its
                     requirements
Stop                 where automation halts. Every stop has a code and an owner:
                     "Needs you" when the operator owns it, a wait when the controller does
Finalization         the staged whole-plan review and polish of an integration branch
Promotion            the operator-approved merge of the final candidate into its
                     destination
Capacity             how many runs the workstation admits at once, for development and
                     for verification
```

A stop the operator owns asks for one of five things: a design choice, a plan change, an
authorization (approval or more attempts), a finding disposition, or a promotion. Stops the
controller owns are waits: on a dependency, on a resource, or on its own retry. Name each
flow by the stop it resolves, not by the panel that hosts it.

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

Keep sequential execution the default. Parallel mode shows its in-flight and per-repository
limits with a link to Settings, plus a bounded integration-refresh allowance. Label order as priority, show each
entry's exact waiting reason, and distinguish dependency, capacity, exclusion, and operator
attention. In-flight counts include paused and merge-ready work; running-cycle counts do
not. Individual pause/resume controls must not imply that sibling work will stop. Existing
work-item links retain the review, diff, manual takeover, and explicit merge controls.
Saved cross-project roadmaps also show occupied/total development and verification slots shared
by the workstation. Explain when this limit is lower than the roadmap's in-flight allowance.
Work-item rows name the active slice, its early-development approval and start requirements;
parent acceptance blockers remain labelled separately.

An implementation or review question, or a stalled review with attempts remaining, exposes
**Continue with guidance** beside the cycle status. Show the remaining allowance, retain an
unsent answer across state refreshes, and require explicit guidance before continuing. This action
does not increase the budget or resume the roadmap. Exhausted reviews use the additional-attempt
form, where answers can accompany the explicit grant.

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


New finalization setup defaults to focused stages. Keep per-stage settings in disclosures and
show each stopping rule beside its scope, profiles and budget. Correctness/conformance slices
must retain a final whole-plan check. During execution, show the current stage, selected batch,
independent allowances, optional follow-up work and obligation evidence with stale-commit labels.
The single next-step form switches between stage selection, explicit plan-adjustment approval and
recovery. Empty optional selections are valid and keep suggestions open. Stage verification does
not restart discovery; required findings and genuine questions still need action. Exact final
promotion approval remains separate. Legacy round setup and existing attempts stay usable.

## Cross-project import drafts

Show imported concurrency definitions under Roadmaps with an explicit inactive label and
no execution controls. Keep exact project/plan choices visible, preserve missing/mismatched
binding diagnostics, and group long source hashes, phase requirements and resource details
in wrapping disclosures. Saving bindings records identity only; adoption and Start are
separate future actions. Plan ZIP replacement means a new preserved version, with an explicit
active-version choice and a link to configure that version's branches.

Unstarted items in the agenda offer **Remove from agenda** beside the existing actions.
It returns the item to Proposed and preserves admission history. Show the daemon's
reason when work history, an active worktree or roadmap prevents removal; no completion
is recorded and dependencies stay blocked.


Execution slices live on their parent's work-item page. Distinguish a prepared worktree,
started execution, merged slice, verified slice and accepted parent. Give each active slice
its own cycle selector; review-only worktrees offer review runs instead of implementation
cycles. The roadmap editor may select bound slice identities without silently adopting map
decisions. Show unmet capabilities and evidence obligations before execution; never label
slice integration as parent completion. Parent acceptance is an explicit review/evidence
command, with separate fresh verification controls when integration has moved.

Execution scopes show distinct start, merge, verification and parent-acceptance requirements,
with dependency, evidence, review, authorization and resource labels. Show local admission
capacity and current reservations beside their phase. Early-development authorization names
the exact bound slice and preserves the parent barrier. Resource waits are progress states;
qualification-unavailable labels must not imply an approved environment or completed check.


Cross-project supervision explicitly selects a target and distinguishes limiting its scope from
prioritizing it within a full roadmap. Preview included and excluded milestones before creation/Start.
Use project lanes with expandable parent/slice cards on desktop and a wrapping grouped list on phones.
A focused requirement opens its provider's work-item or evidence controls. Show independent progress
and separate target, selected-scope, parent-acceptance, finalization and publication states. Scheduling
adoption has its own proposal review and rationale; it never presents imported checkpoints as passed.
Defaults and project/activity/individual settings overrides belong in disclosures. Frozen attempts show
the settings they actually used; queued settings can be edited while paused.


Keep amendments in the existing roadmap: choose an exact candidate, preview changed requirements,
queued work, attempt dispositions and evidence, then record a proposal that holds execution. Apply and
reject need a rationale; reuse is opt-in and described as code provenance, not verification approval.
Show immutable decision history and links to preserved attempts. Applying does not Resume. Project
finalization readiness counts all original parents and links to the established staged controls; partial
target progress, promotion and publication stay separate. Keep these controls usable as a wrapping phone
form with disclosure panels for detailed impact.

Cross-project startup requirements have direct resolution actions. Local setup proposes exact
pins and required consumer relationships, captures fingerprint inputs for review and requires
explicit saving. Keep external qualification evidence separate. Selected work is grouped by
project ownership; physical placement never implies execution order. Show cross-project
requirements by phase, including inherited gates, and expandable checkpoint-to-provider chains.
Dependency navigation opens collapsed ancestors, scrolls and moves keyboard focus. Launch previews
show current phase eligibility and waits without promising dispatch ahead of resource/capacity checks.


Saved plan acceptance is a visible setup step. Name the saved roadmap revision, exact binding
and environment generation, distinguish unsaved edits, and list missing prerequisites beside
the disabled generator. Generating facts and independently accepting the plan are separate
controls. Generated evidence opens directly for review, names the operator's review responsibility
and requires confirmation plus rationale. Start/Resume remain separate; a stale saved snapshot
requires regeneration. Never present collected configuration as a completed technical test.

Design questions have a recovery action beside the cycle's status, with links from its run
and existing execution slice. Show the recorded questions, saved facts and hash-identified
shared documents before guidance, supporting text files and agent selection. Distinguish a
bounded investigation that always returns for review from a design continuation that may
advance. Do not present another worktree creation button as recovery for an existing slice.


Design recovery exposes historical baseline setup separately from answers and agent launch. Show exact
application/upstream commits, proposed local tags, storage location, preparation state and errors; require
explicit confirmation before preparation. Read-only source baseline fields distinguish imported obligations
from selectable historical upstream refs. Prepared sources are not passing tests. Keep collection logs
accessible from the browser, label bounded/truncated previews, and preserve guidance after failures.

Roadmap supervision starts with actionable scheduler and work-step recovery reasons. A restart
checkpoint says Resume required and stays separate from plan acceptance and remediation recovery.
Show saved/unsaved queued settings and acceptance of the exact saved revision together. Disable
unchanged saves; unsaved edits block generation/acceptance of plan evidence and Start/Resume.
Reviewer responsibilities use independent checkboxes with source-scope context and direct focus
links to the controls. Existing assignments stay visible; no assignment is made implicitly.
Amendment maintenance follows routine supervision and starts collapsed unless a proposal is pending.

Shared architecture decisions appear as actionable cards on both the roadmap and design recovery.
Show current full or limited approval, scope and approval time beside the recorded question.
Recommendations explain the proposed choice, rationale, alternatives and consequences in ordinary
language. Collect source references automatically and keep provenance in disclosures. Preparing
an exact decision and explicitly approving it remain separate; neither starts a run. Limited
approval identifies consumers and retained obligations, with the saved-plan review consequence.
Historical questions remain readable but do not hide newer approvals. Keep draft edits and
expanded evidence stable during background refreshes. Surface completed investigations beside
the shared decision and on work-item recovery, with on-demand access to their original report.
Show structured-report errors without hiding evidence or inventing a complete recommendation.


Execution capacity lives in Workspace Settings with shared workstation pools and a selected-roadmap
editor in one section. Roadmaps show occupied/total development and independent verification slots,
in-flight allowances and a Manage capacity link that selects the roadmap. Avoid duplicate capacity
forms in roadmap setup; new drafts keep existing defaults and link to Settings before Start.
Explain ordinary work-item reviews versus independent verification/parent acceptance, installation
ownership versus workspace authority, and persistence. Name occupied runs and in-flight work with
links. Label recorded cycle waits separately from undispatched roadmap work. Put edits behind named
actions; explicit refresh preserves drafts and their original versions, and stale drafts cannot save.
Changing capacity requires paused scheduling and renewed applicable saved-plan acceptance; show
which roadmaps need review. Do not resume, repin dependencies or approve anything implicitly.

Controller obligations and operator questions have separate presentation. Show a dependency
wait with its named prerequisites and roadmap link; do not invite an implementation repair
for an administrative checkpoint. Show pending separate security/checkpoint reviews and their
real run provenance. Every operator question names either Shared architecture decisions (with
the mapped checkpoint) or this work item's Continue with guidance form. Shared questions from
implementation and review must appear in that inbox. Agent checkpoint attestations must not
be labelled as a human approval.

## Agent profile settings

Workspace settings present four defaults (Design, Implementation, Review, Remediation), then
optional specialist overrides with their effective inherited selection visible. Codex effort
is explicit or labeled as using local configuration. Recommendations map to the actual field
names in an About disclosure and never silently set preferences. Separate workspace-default
saving from applying selections to existing roadmaps; the latter names the selected scopes,
includes future steps of started cycles, and explains that plan evidence remains valid.
Retain unsaved edits on refresh and reject stale saves. Link directly from a roadmap into its
settings selection. Keep finalization's per-stage controls and recovery override distinct.

Paused roadmap supervision exposes **Change future delegation** separately from saved-plan
editing. The operator selects entries (including started ones), integration policy and reviewer
responsibilities, then confirms a reasoned grant. Current reports retain their original authority;
this operational change neither resumes scheduling nor requires new plan-acceptance evidence.
Supported technical checkpoint responsibilities must be discoverable in the main role checklist.

**Prepare architecture decision** is available before the owning development slice can start.
Its form collects a checkpoint, model, time limit and optional guidance; source references are
controller-collected. Show the preparation's state and run link, with a refresh action leading
to the existing shared decision inbox. Preparation must never be described as approval or as
permission to implement a gated work item.
