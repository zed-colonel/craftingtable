# UI review: information architecture, navigation, decision and blocker surfaces (prefix UI)

Reviewer scope: `apps/web/src` (App.tsx, features/execution, features/planning, features/workspace,
features/home, components/, lib/route.ts), `docs/ui-principles.md`, ADR-015, and the captures in
`docs/ui-walkthrough/` (mainly `2026-09-23-investigation-evidence-after`, captured from commit
`2000759`, compared with `2026-09-16-before/after` and `2026-09-20-after-decision-inbox`).
I also read the daemon's notification attention logic and the wire contracts the UI consumes,
and ran read-only queries against the live DB. Repository HEAD at review time: `bf08c0b`.

Line numbers refer to HEAD `bf08c0b`. "CONFIRMED" means verified in code, screenshots or the DB.
"HYPOTHESIS" means the mechanism is confirmed but the operator-visible frequency or impact is inferred.

---

## Summary

- **The UI has no single model of "what needs the operator".** At least six independent
  derivations exist, and they disagree:
  - the daemon's notification service;
  - `AttentionStrip` / the rail count;
  - `RoadmapAttention`;
  - the attention tone on the Roadmaps page;
  - the resolver map in `Reasons`;
  - the reason-string regexes in `CyclePanel`.

  The Dashboard's "Needs your attention" section and the rail badge count only cycles in
  `needs-attention`/`awaiting-merge`. Roadmap-level decisions are invisible from the Dashboard.
  These include shared-decision approvals, plan acceptance, map adoption, verification-environment
  approval, amendments, dependency refresh, and restart resume. This is the root cause of pain
  point 1 (UI-01).
- **Recovery forms are chosen by matching English prose.** The UI regex-matches `cycle.reason`
  (e.g. `'Remediation limit reached.'`, `/^(Implementation|Review) needs your input\./`) and
  blocker messages (`'Resource '`). The daemon writes browser navigation instructions into
  blocker text. Any wording change silently breaks routing to the right form (UI-02).
- **One concept, many surfaces, many names.** Examples:
  - Checkpoint-evidence accept/reject is posted from three different panels.
  - Architecture decisions can be authored or requested through five paths.
  - "Decision" means four different things: map/scheduling decisions, architecture decisions,
    finalization finding decisions, and amendment decisions (UI-03).
- **Genuine operator decisions are buried in setup panels.** "Shared architecture decisions"
  sits inside "Dependency environments and evidence", about 3,400 px down the Roadmaps page, and
  appears again inside design recovery on the work-item page, but only after "Refresh available
  evidence" (UI-04).
- **The Roadmaps page has become a mega-page.** It renders every roadmap, including completed
  ones, with all panels expanded into one document:
  - **Size:** 21,401 px tall at 1440 wide (it was 5,418 px on 2026-09-16), about 6,750 TSX lines
    behind it, 18 sections, 65 disclosures, 101 buttons, and 33 in-page "reveal" jumps.
  - **Duplication:** the supervision and evidence panels for the same concurrency map render twice
    on the same page (UI-05).
- **No real progress or dependency view exists** (pain point 2):
  - The "Focused dependency view" is a bounded, indented text tree that repeats shared nodes and
    labels almost everything "waiting".
  - Project lanes list parent IDs only.
  - Work-item predecessors and dependents are plain text, not links.
  - The API already exposes a full cross-project DAG with satisfaction state. It lacks a
    single-project plan-graph endpoint and a joined "graph + live activity + attention"
    projection (UI-06).
- **Navigation is split.** There is a pure router (`lib/route.ts`) and, beside it, an ad hoc
  second routing layer:
  - 35 of 49 in-app anchors are raw `href`s that cause full document reloads (dropping unsaved
    drafts).
  - Cross-page targets are encoded in `#hash`/`?query`, which individual components parse
    themselves.
  - Roadmaps have no route of their own (UI-07).
- **Dead ends.** Examples (UI-08):
  - "NEEDS YOU" items on the work-item page tell the operator in prose to go elsewhere, with no
    link.
  - Notifications and links drop the operator on a generic `/roadmaps`.
  - The "Request clarification" deep link is silently ignored unless a specific panel happens to
    be mounted.
- **Misclassification and noise:**
  - Operator-owned evidence (plan acceptance, checkpoint approval) is listed under "Waiting on
    other work" (UI-09).
  - "Integration conflicts" and "Model service recovery" panels render when nothing is wrong
    (UI-10).
- **Page weight and prose:**
  - Work-item pages are 1,650–3,130 px tall on desktop and up to about 5,100 px on a phone.
  - Feature components contain about 169 long prose paragraphs (about 8.5k words).
  - About 68 distinct domain terms appear in the Roadmaps page components (UI-11, UI-12, UI-18).
- **Maintainability.** `App.tsx` (1,739 lines, 47 `useState`) centralises some state. Newer
  features bypass it with self-fetching panels that use their own polling (3 s / 5 s) and
  `window` CustomEvents. Some panels, such as the shared-decision inbox on the roadmap, never
  refresh on their own (UI-13).
- **Settings are scattered.** Agent selection is edited in 7+ places, reviewer responsibilities
  in 3, and integration policy in 3 (UI-14).
- **`docs/ui-principles.md` has become an accretion log** of per-slice rules. That feeds the
  spaghetti rather than preventing it (UI-15).

---

## Map

### Shell and routing

- `components/WorkspaceShell.tsx` holds the rail: workspace picker, then Dashboard (count =
  `attentionCycles(cycles).length`), Runs (live count), Agenda (admitted count), Roadmaps,
  Projects, Repositories, Import plan, Settings, All workspaces, Account.
- `lib/route.ts` is a pure `parseRoute`/`buildPath` pair covering 14 route shapes. There is no
  query or hash in the `Route` type and no roadmap-detail route. `lib/use-route.ts` handles
  `pushState` and `popstate`.
- A second, ad hoc "routing" layer sits beside it:
  - `lib/reveal-element.ts` opens `<details>` ancestors, scrolls, and waits up to 10 s with a
    MutationObserver for panels that are still fetching.
  - Components read `window.location.hash` or `search` directly:
    - `DesignRecoveryPanel.tsx:76-81`
    - `RuntimeEvidencePanel.tsx:54-60`
    - `RoadmapAgentProfilesPanel.tsx:34,52`
    - `RoadmapCapacityPanel.tsx:18`
    - `HostSchedulingPanel.tsx:63`
  - Raw `<a href>` links cause full document reloads (UI-07).

### App.tsx (1,739 lines)

- **State (lines 148-253):** 47 `useState` plus the projection reducer. Its slots are page detail
  (project, planVersion, workItem, run, runEvents, diff), execution (repositories, status,
  profiles, worktrees/runs), busy/error/notice slots per command family, cycles, and
  `refreshToken`.
- **Loaders:**
  - The snapshot, audit and workspaces effect (380-422) re-runs on every `refreshToken` change.
  - The cycles effect (457-473) does the same.
  - One route-switch effect (477-596) holds the if/else chain of per-route loaders. On the
    work-item route it makes 5 parallel requests.
  - The run event paging effect is at 598-635.
- **Event model:** SSE events mark scopes stale, and `scheduleRefresh` debounces a
  `refreshToken` bump by 200 ms (203-211, 428-451). Every invalidating event refetches
  everything for the current route.
- **Commands:** the `itemCommand` and `executionCommand` wrappers (790-856) and about 20 handlers
  (858-1053) are passed down as props.
- **Page composition:**
  - The Dashboard is assembled inline (1137-1200).
  - The work-item page is assembled inline from `WorkItemPage`, `PlanBranchPanel`, `CyclePanel`
    (with the render props `renderDesignRecovery` and `renderReviewRecovery`), `DelegationPanel`,
    `ExecutionScopesPanel` and `DiffView` (1369-1591).
  - The run page receives a `ProviderRecovery` list and an `onResolveDesign` callback
    (1605-1683).
- **Self-fetching pages:** `RoadmapsPage` (1222-1230) receives no `refreshToken`. It fetches and
  polls on its own.

### Data-fetch patterns

There are two co-existing architectures.

1. **App-owned:** App fetches, passes props down, and refreshes through SSE invalidation plus
   `refreshToken`. This covers the dashboard, runs, agenda, project, plan version, work item,
   run, settings core and repositories.
2. **Self-fetching panels:** these call `request()` directly and have their own refresh logic.

   | Panel | How it refreshes |
   |---|---|
   | `RoadmapsPage` | Polls every 3 s (`RoadmapsPage.tsx:167`) |
   | `CrossProjectPanel` | Polls a POST `supervision/preview` every 5 s (`CrossProjectPanel.tsx:171-190`) and listens for `craftingtable:runtime-saved` |
   | `RuntimeEvidencePanel` | Loads once, then reloads on `craftingtable:saved-plan-changed` or a roadmap revision change (`RuntimeEvidencePanel.tsx:93-113`) |
   | `FinalizationPanel` | Polls every 3 s (`:100`) |
   | `NotificationPanel` | Polls every 5 s (`:39`) |
   | Others that fetch on mount or on explicit refresh | `ExecutionScopesPanel`, `ScopeReviewRecovery`, `ScopeRepairPanel`, `CheckpointRecoveryPanel`, `DesignRecoveryPanel` (preview), `DecisionPreparationPanel`, `MapAmendmentPanel`, `HostSchedulingPanel`, `RoadmapCapacityPanel`, `RoadmapAgentProfilesPanel`, `StoragePanel`, `ConcurrencyImports`, `PlanBranchPanel`, `WorktreeBranchPanel` |

### Pages and what they render (desktop capture heights, 1440 wide, 2026-09-23 capture)

| Route | Page | Main sections (in order) | Height |
|---|---|---|---|
| `/workspaces/:ws` | Dashboard (inline in App) | Header, **Needs your attention** (cycles only), StatusCards (live runs, in agenda, ready, dependency-blocked, completed), Live runs, Project cards, Activity (collapsed), Audit (collapsed) | 900 |
| `/runs` | RunsPage | Header, Run history (≤100 rows, `workspaceRunsResponseSchema` max 100) | 1,113 |
| `/agenda[/filter]` | AgendaPage (titled "Work items") | Filter tabs, one table (ID, title with slice disclosures, project, state, risk, blockers text) | 900–2,928 |
| `/roadmaps` | RoadmapsPage | Header, agent-profile link, About, [editor], **one Section per roadmap** (see UI-05), Cross-project roadmaps (ConcurrencyImports) | up to **21,401** |
| `/projects` | inline | ProjectCards | – |
| `/projects/:p` | ProjectPage | Header, plan versions, PlanBranchPanel, WorkItemTable, source artifacts, diagnostics | – |
| `/projects/:p/plans/:v` | PlanVersionPage | Branch settings (PlanBranchPanel with RepositoryPolicyPanel), **FinalizationPanel**, WorkItemTable, artifacts, archives, identity, diagnostics | 1,799–2,455 |
| `/work-items/:id` | WorkItemPage plus App composition | Header (Admit / Remove / Complete), Overview (predecessors as text), Repository & branches, **Automated cycle** (CyclePanel with up to 11 nested recovery panels), Delegation (worktrees, merge, launch, runs), **Execution slices and parent acceptance**, Diff | 1,654–3,130 |
| `/runs/:id` | RunPage | Header, ProviderRecovery, outcome, findings, "Resolve design questions on work item", handoff, activity feed, send message | 1,200–2,000 |
| `/settings` | SettingsPage | Workspace identity/name, Agent profiles (WorkspaceProfilesSection), Roadmap agent profiles, Execution capacity (HostSchedulingPanel with RoadmapCapacityPanel), Storage, Notifications | 2,845 |
| `/repositories`, `/import`, `/account`, `/workspaces` | – | – | – |

### Growth evidence

- Roadmaps cross-project capture height:
  - 5,418 px (2026-09-16-after)
  - 10,981 px (2026-09-20-after-decision-inbox)
  - 21,401 px (2026-09-23)
- Work-item design recovery: 2,619 px, growing to 2,836 px.
- `git log --since=2026-09-10 -- apps/web/src` has 60 commits. About 20 of them add or adjust a
  recovery or decision surface (for example `ec75719`, `9675f17`, `79ee66e`, `acf9aeb`,
  `48283ca`, `0c88b5a`, `8ee321f`, `f3b3f27`, `027ee49`, `bfdd295`, `3605f01`, `bf08c0b`).
- About 50 feature `.tsx` files were added since 2026-09-01.

### Live data context (read-only DB)

- 4 roadmaps: 3 completed, 1 paused. The paused one is the cross-project roadmap with
  **171 entries**.
- 80 work items and 236 `work_item_dependencies` edges.
- 1 concurrency definition: 33 parents, 69 slices, 95 checkpoints, 335 milestones and 1,221
  dependency edges, per the capture.
- Non-terminal cycles:

  | Item | State | Reason |
  |---|---|---|
  | WI-04/domain | `awaiting-merge` | Reason lists four unmet checkpoint/slice prerequisites |
  | EXO-03/domain, EXO-04/domain | `paused` | – |
  | WI-09/domain | `needs-attention`, design step | "Design investigation finished… use Resolve design questions" |

---

## Deliverable 1: inventory of decision, blocker and recovery surfaces

Legend for the concept column:

| Code | Concept |
|---|---|
| **AGG** | Aggregated "needs you" list |
| **CYC** | Cycle continue/recover |
| **EVD** | Checkpoint or plan evidence decision |
| **ADR** | Architecture decision |
| **ENV** | Environment or resource authorization |
| **REV** | Reviewer responsibility assignment |
| **SCH** | Roadmap scheduling control |
| **MRG** | Merge or acceptance approval |
| **WAIT** | Dependency or prerequisite wait display |
| **CFG** | Configuration that gates progress |

All API paths are under `/api/workspaces/:ws`.

### A. Cross-page aggregators

| # | Component (file) | Host page(s) | Trigger | Posts | Concept |
|---|---|---|---|---|---|
| A1 | `AttentionStrip` (components/AttentionStrip.tsx) | Dashboard (section), every other workspace page (compact strip) | cycle `needs-attention` or `awaiting-merge` and no `scopeReviewWait` (`:5-11`) | none. Navigates to the work item (and selects the worktree) or to the plan version (`App.tsx:1078-1091`) | AGG (cycles only) |
| A2 | Rail Dashboard count (WorkspaceShell.tsx:71-76) | all | same as A1 | none | AGG |
| A3 | StatusCards (components/StatusCards.tsx) | Dashboard | planning counts | none. Links to the agenda filters | WAIT |
| A4 | Live runs "N waiting for you" (App.tsx:1163-1187) | Dashboard | run status `waiting` | none | AGG |
| A5 | Push notifications (server `notification-service.ts:226-440`) and "Recent notification activity" (NotificationPanel.tsx:278-291) | phone / Settings | Server-side rules: cycle merge/attention with automation-policy suppression; run failed/finished; "Verification setup needed"; "Checkpoint evidence needed"; roadmap entry holds; roadmap `needs-attention`; storage | none. `path` points to a work item, plan version, `/roadmaps` or `/settings` | AGG (a different rule set) |
| A6 | `RoadmapAttention` "Next roadmap actions" (planning/RoadmapAttention.tsx) | Roadmaps (per roadmap) | entries in `needs-attention`, `awaiting-merge` or `paused` with no blockers ("recovery"); blockers all `review` or `authorization`+`'Resource '` ("setup"); roadmap reason starts with `'Daemon restarted.'` | none. Raw-href link "Open work item recovery", plus `revealElement` to the entry, reviewer list or native panel | AGG |
| A7 | Roadmap Section attention tone (RoadmapsPage.tsx:667-679) | Roadmaps | the same rules re-implemented | none | AGG |
| A8 | Host scheduling "Occupied slots and recorded waits" (HostSchedulingPanel.tsx:198-230) | Settings | capacity waits | none (links) | WAIT |
| A9 | `Reasons` "Needs you / Waiting on automation / Waiting on other work" (components/Reasons.tsx:29-39) | work item (ExecutionScopesPanel), Roadmaps (CrossProjectPanel fallback) | typed `PhaseBlocker.kind` | none | WAIT/AGG |

### B. Roadmaps page (`/roadmaps`)

| # | Component (file) | Trigger | Posts | Concept |
|---|---|---|---|---|
| B1 | Roadmap ActionBar (RoadmapsPage.tsx:772-847) | status | `roadmaps/:id/control` {start, pause, resume, stop} | SCH |
| B2 | "Resume required after restart" label (RoadmapAttention.tsx:4-8) | reason prefix | (B1 resume) | SCH |
| B3 | Entry rows: status, reason, "Resume item"/"Pause item", "Set up verification environment", "Assign independent reviewer responsibilities" (RoadmapsPage.tsx:904-1036) | per-entry progress | `roadmaps/:id/control` {pause/resume, entryId} | SCH/WAIT |
| B4 | Unsaved-settings banner (RoadmapsPage.tsx:764-771) | dirty drafts | none | CFG |
| B5 | `ScopeRecoveryPanel` "Independent review recovery" (planning/ScopeRecoveryPanel.tsx) | cross-project roadmap | `roadmaps/:id/scope-recovery` | CYC (policy) |
| B6 | `CrossProjectPanel` "Cross-project supervision" (planning/CrossProjectPanel.tsx) | cross-project roadmap | `supervision/preview` (a POST, polled every 5 s), `supervision/roadmap` (save), `supervision/adopt` | AGG/CFG/WAIT |
| B6a | ↳ "Settings and plan review" steps 1–2 (`:487-560`) | plan acceptance state | none (reveals B12) | EVD |
| B6b | ↳ "Before Start" setupRequirements with Resolve buttons (`:622-693`) | `view.setupRequirements` | none (reveals) | AGG |
| B6c | ↳ "Map decision adoption · x/y approved" (`:694-744`) | map decisions | `supervision/adopt` | ADR-like ("scheduling decisions") |
| B6d | ↳ Queued settings and ReviewerResponsibilities (`:745-975`) | editing | `supervision/roadmap` | REV/CFG |
| B6e | ↳ Milestone cards: "Trace requirements", "Open work item / advance scope" (raw href), "Submit or review checkpoint evidence", "Review map decisions" (`:283-356`) | node.action | none | WAIT |
| B6f | ↳ "Launch readiness · N slices…" with "Why this slice waits" (`:1060-1100`) | nodes | none | WAIT |
| B6g | ↳ "Focused dependency view", `DependencyGraph` and `PhaseRequirements` (DependencyRequirements.tsx) | select | none | WAIT |
| B7 | `RoadmapDelegationPanel` "Change future delegation" (planning/RoadmapDelegationPanel.tsx) | roadmap paused | `roadmaps/:id/delegation` | REV/CFG |
| B8 | `DecisionPreparationPanel` "Prepare architecture decision briefs" (planning/DecisionPreparationPanel.tsx) | on open | `roadmaps/:id/decision-preparations` (GET), `roadmaps/:id/prepare-decision` | ADR (agent-prepared) |
| B9 | `RuntimeEvidencePanel` "Dependency environments and evidence" (planning/RuntimeEvidencePanel.tsx) | cross-project | `concurrency-definitions/:id/runtime` GET, `…/configure`, `discover`, `inspect`, `submit`, `decide`, `generate-plan` | CFG/EVD |
| B10 | ↳ `NativeVerificationPanel` "Verification environments" | environment needs approval | `…/runtime/audit-native`, `authorize-native` | ENV |
| B11 | ↳ `DependencyRefreshPanel` "Dependency pin refresh" | provider advanced | `…/runtime/preview-refresh`, `refresh` | CFG/EVD |
| B12 | ↳ "Saved plan acceptance · STACK-PLAN-ACCEPTED" (`:209-289`) | plan state | `…/runtime/generate-plan`, then `decide` in B15 | EVD |
| B13 | ↳ `SharedDecisionInbox` "Shared architecture decisions" (`:291-303`) | `view.decisionInbox` | `…/runtime/propose-decision`, `…/runtime/decide` | ADR |
| B14 | ↳ `ArchitectureDecisionPanel` "Advanced manual decision preparation and clause staging" (`:304-325`) | always | `…/runtime/propose-decision` | ADR |
| B15 | ↳ Evidence review ("Submit qualification or checkpoint evidence", per-submission Accept/Reject evidence) (`:654-1000+`) | submissions | `…/runtime/submit`, `…/runtime/decide` | EVD |
| B16 | `MapAmendmentPanel` "Planning amendments and reconciliation" (planning/MapAmendmentPanel.tsx) | pending proposal or binding drift | `roadmaps/:id/amendments` (GET), `…/amendments/preview`, `…/amendments/decision`, `…/finalization-readiness` (GET) | CFG/ADR-like |
| B17 | `ConcurrencyImports` "Cross-project roadmaps" (planning/ConcurrencyImports.tsx) | imported map selected | `concurrency-imports`, `concurrency-definitions/:id/bindings`; **mounts a second CrossProjectPanel and a second RuntimeEvidencePanel** (`:239-255`) | CFG (duplicates B6/B9–B15) |

### C. Work-item page (`/work-items/:id`)

| # | Component (file) | Trigger | Posts | Concept |
|---|---|---|---|---|
| C1 | WorkItemPage header lifecycle (planning/WorkItemPage.tsx) | item status | `work-items/:id/admit`, `remove-from-agenda`, `complete` | CFG |
| C2 | Overview predecessors/dependents (WorkItemPage.tsx:175-204) | always | none (**not links**) | WAIT |
| C3 | `PlanBranchPanel` and `RepositoryPolicyPanel` | always (collapsible) | `plan-versions/:v/branch-settings`, `…/repository-policy`, `work-items/:id/worktrees` | CFG |
| C4 | `CyclePanel` "Automated cycle" (execution/CyclePanel.tsx) | active cycle | `cycles/:id/control` {pause, resume, stop}, `work-items/:id/cycles` (start) | CYC |
| C5 | ↳ cycle reason plus "Resolve checkpoint evidence for this slice" (`#slices` link) (`:203-210`) | `mergeRequirementsWait` | none | WAIT |
| C6 | ↳ `WorkflowStatus` "Controller work and operator questions" (execution/WorkflowStatus.tsx) | `cycle.workflow` | none. Raw hrefs to `/roadmaps` and `/roadmaps#architecture-decisions-…`, or a `#cycle-…` anchor | ADR/WAIT |
| C7 | ↳ `ProviderRecovery` "Model service recovery" (execution/ProviderRecovery.tsx) | `cycle.providerRecovery` present | `cycles/:id/control` {retry-provider, pause} | CYC |
| C8 | ↳ `CycleRemediationRecovery` "Continue remediation" (execution/CycleRemediationRecovery.tsx) | reason starts with `'Remediation limit reached.'` and more (`CyclePanel.tsx:139-148`) | `cycles/:id/control` {authorize-remediation, additionalRounds, instructions} | CYC |
| C9 | ↳ `CycleGuidanceRecovery` "Continue with guidance" (execution/CycleGuidanceRecovery.tsx) | questions, or reason prefix `'Two remediation rounds'`, or regex `^(Implementation\|Review) needs your input\.` (`CyclePanel.tsx:150-157`) | `cycles/:id/control` {resume, instructions} | CYC |
| C10 | ↳ `DesignRecoveryPanel` "Resolve design questions" (execution/DesignRecoveryPanel.tsx) | step `design`, paused or needs-attention, `canMutate` (`CyclePanel.tsx:407-411`) | `cycles/:id/design-recovery` GET preview, POST {investigate or continue} | CYC/ADR |
| C11 | ↳↳ `SharedDecisionInbox` (the same component as B13) | preview has a decision inbox | `…/runtime/propose-decision`, `decide`; "Request clarification" pre-fills C10 | ADR |
| C12 | ↳↳ `BaselinePreparationPanel` "Historical baseline preparation" | always, inside C10 | `cycles/:id/baseline-preparation` | CFG |
| C13 | ↳↳ "Evidence investigation" with `SourceRunReport` | investigation finished | none | ADR |
| C14 | ↳ `HistoricalEvidencePanel` | `baselinePreparation` | none | – |
| C15 | ↳ `IntegrationResolutionPanel` "Integration conflicts" (execution/IntegrationResolutionPanel.tsx) | **any** paused or needs-attention cycle (`:31-33`) | `cycles/:id/integration-resolution` {inspect, resolve, resume, abandon} | CYC |
| C16 | ↳ `ScopeRepairPanel` "Source changes required" (via `renderReviewRecovery`, App.tsx:1453-1468) | read-only scope cycle, paused or needs-attention | `cycles/:id/scope-repair` GET/POST | CYC |
| C17 | ↳ `ScopeReviewRecovery` "Recover slice verification", "Recover parent acceptance" or "Review again" (execution/ScopeReviewRecovery.tsx) | read-only scope cycle, paused, needs-attention or completed | `cycles/:id/control` {resume or review-again, instructions}; GET `execution-scopes` | CYC |
| C18 | `DelegationPanel` "Delegation": merge gate badge, Merge form, Launch a run, worktree remove (execution/DelegationPanel.tsx) | worktrees | `worktrees/:id/merge`, `work-items/:id/runs`, `worktrees/:id/remove` | MRG |
| C19 | ↳ `WorktreeBranchPanel` (update from integration, retarget) | per worktree | `worktrees/:id/update`, `retarget`, `branch-status` | CFG |
| C20 | `ExecutionScopesPanel` "Execution slices and parent acceptance" (execution/ExecutionScopesPanel.tsx) | the item has map slices | `work-items/:id/scope-scheduling` (authorize early development), `work-items/:id/worktrees` (create slice, verification or acceptance worktree), `worktrees/:id/scope-evidence` ("Record slice verification" or "Accept parent after review") | MRG/WAIT/ENV |
| C21 | ↳ `Reasons` per phase ("NEEDS YOU: Authorization / Review", "WAITING ON OTHER WORK: Evidence / Dependency") | phase blockers | none. **The resolution lives on /roadmaps with no link** | WAIT/ENV/REV |
| C22 | ↳ `CheckpointRecoveryPanel` "Checkpoint acceptance before merge" (execution/CheckpointRecoveryPanel.tsx) | merge-phase blocker message starts with `'Checkpoint '` (ExecutionScopesPanel.tsx:195-212) | `…/runtime/checkpoint-recovery/:worktreeId` GET, `…/runtime/prepare-checkpoint`, `…/runtime/decide` | EVD |

### D. Plan-version page (`/projects/:p/plans/:v`)

| # | Component | Trigger | Posts | Concept |
|---|---|---|---|---|
| D1 | `FinalizationPanel` "Finalize integration" (execution/FinalizationPanel.tsx) | always | `plans/:v/finalizations` (start), `finalizations/:id/control` (pause, stop, merge, cleanup…) | MRG/CYC |
| D2 | ↳ `FinalizationStageDecision` and `FinalizationCheckpoint` "Next finalization step" (the same aria-label in both) | finalization cycle paused or needs-attention | `finalizations/:id/control` {defer-nits, remediate-findings, authorize-remediation, resume, stage selection…} | CYC/EVD |
| D3 | ↳ "Approve final promotion" (FinalizationPanel.tsx:654-700) | awaiting merge | `finalizations/:id/control` {merge} | MRG |
| D4 | `PlanCompletion` (also on ProjectPage and ProjectCards) | completed plan, cleanup failures | cleanup retry | MRG |

### E. Run page (`/runs/:id`)

| # | Component | Trigger | Posts | Concept |
|---|---|---|---|---|
| E1 | `ProviderRecovery` (the same component as C7) (App.tsx:1608-1631) | cycle's current run with `providerRecovery` | `cycles/:id/control` {retry-provider, pause} | CYC |
| E2 | "Resolve design questions on work item" (RunPage.tsx:364-367) | design cycle paused or needs-attention | none. Navigates to the work item | CYC |
| E3 | HandoffForm, send message, end, cancel | live or active worktree | `runs/:id/{message,end,cancel}`, `work-items/:id/runs` | CYC |

### F. Settings (`/settings`)

| # | Component | Trigger | Posts | Concept |
|---|---|---|---|---|
| F1 | `HostSchedulingPanel` "Execution capacity" | always | `host-scheduling` | CFG/WAIT |
| F2 | ↳ `RoadmapCapacityPanel` "Roadmap in-flight limits" | `?roadmap=` | `roadmaps/:id/capacity` | CFG |
| F3 | `RoadmapAgentProfilesPanel` (editBlocker with an "Open roadmap" raw link) | `?roadmap=` | `roadmaps/agent-profiles`, `roadmaps/:id/agent-profiles` | CFG |
| F4 | `StoragePanel` ("Storage needs attention" notification target) | storage state | `storage/*` | CFG |
| F5 | `NotificationPanel` | always | `notifications` | AGG (history) |

### G. Agenda (`/agenda`)

- G1 — the table's Blockers column and slice "Start requires:" disclosure (planning/AgendaPage.tsx). No command. Concept: WAIT.

### Clusters: the same concept surfaced several times, often under different names

| Cluster | Surfaces | Vocabulary variants | Notes |
|---|---|---|---|
| **K1. "What needs me"** | A1, A2, A4, A5, A6, A7, A9, B6b, B4, C21, F1 waits | "Needs your attention", "Next roadmap actions", "Before Start", "Needs you", "Needs attention", "Verification setup needed", "Checkpoint evidence needed", "Resume required after restart" | Six rule sets, none complete (UI-01) |
| **K2. Checkpoint or plan evidence accept/reject** (`runtime/decide`) | B12 and B15 (roadmap), B13 and C11 (shared decision approval), C22 (work item) | "Accept evidence / Reject evidence", "Approve", "Resolve plan acceptance", "Review and accept saved plan", "Review checkpoint evidence", "Submit or review checkpoint evidence", "Checkpoint acceptance before merge", "Review clause approval" | One daemon command, four UIs |
| **K3. Architecture decisions** | B13, C11 (the same component in two hosts), B14 (manual), B8 (agent-prepared brief), C10 investigate mode, C11 "Request clarification", C6 question routing | "Shared architecture decisions", "decision inbox", "Prepare architecture decision", "Resolve design questions", "Evidence investigation", "Request clarification", "Approve with changes" (which only opens an editor), "Approve a limited scope", "clause staging" | Three ways to have an agent prepare or clarify a decision (B8, C10, C11) |
| **K4. "Decision" overloaded** | B6c map/scheduling decisions, K3 architecture decisions, D2 finalization finding decisions, B16 amendment decisions, ConcurrencyImports "Proposed decisions (18)" | "Map decision adoption", "Review scheduling decisions", "Review map decisions", "Resolve map adoption" | Four unrelated meanings of one word |
| **K5. Continue a stopped cycle with operator input** | C4 Resume, C7 Retry, C8, C9, C10 continue, C15, C17, D2, B3 "Resume item", E3 handoff | "Resume automation", "Continue with guidance", "Continue remediation / Authorize more remediation", "Resolve design questions", "Resolve integration conflicts", "Resume scope review / Start fresh scope review / Review again", "Next finalization step", "Retry now", "Resume item" | Mostly the same endpoint (`cycles/:id/control` or `finalizations/:id/control`) plus instructions. Form choice is made by reason-string regex (UI-02) |
| **K6. Independent-review source repair** | C16 (manual delegation), B5 (automatic policy), the CyclePanel read-only hint (`:289-295`) | "Source changes required / Delegate source fixes", "Independent review recovery", "Address … through the owning slice" | – |
| **K7. Verification environment / resource authorization** | B10, B3 "Set up verification environment", A6 setup list, B6a "Review native approval", B6b "Review verification environments", C21 "NEEDS YOU Authorization: Resource controlled-native-test-host needs…" (prose, no link), A5 "Verification setup needed" | "native verification", "verification environments", "qualified environment approval", "workstation readiness" | – |
| **K8. Reviewer responsibilities** | B6d, B7, B3/A6 "Assign independent reviewer responsibilities", C21 "Review: Evidence profile … needs unassigned reviewer qualifications" (prose, no link) | "reviewer responsibilities", "reviewer qualifications", "reviewer roles", "delegation" | – |
| **K9. Plan acceptance** | B6a step 2, B6b, B12, B4 banner, F1 "Roadmaps affected by workstation changes", C21 "Evidence: Checkpoint STACK-PLAN-ACCEPTED must pass…" (listed under **waiting on other work**) | "plan acceptance", "saved plan acceptance", "STACK-PLAN-ACCEPTED", "plan-acceptance evidence", "saved-plan review" | – |
| **K10. Merge / acceptance approval** | C18 Merge, A1 "Awaiting merge approval", B3 "Awaiting merge approval / Ready for scope acceptance", C20 "Accept parent after review / Record slice verification", D3 "Approve final promotion" | – | Consistent in concept but spread across three pages |
| **K11. Prerequisite waits** | C2, C5, C6 "Waiting for prerequisites" with a generic link, C20 phases, B3 "Waiting on prerequisites", B6e/f/g, G1 | "Waiting for prerequisite work", "Merge blocked by requirements", "Waiting on other work", "Dependency-blocked", "waiting" | Answering "who is waiting on what" means combining four displays (UI-06) |
| **K12. Agent selection** | Settings WorkspaceProfilesSection, F3, roadmap editor CycleSettingsFields, B6d defaults and overrides, C4 setup form, C4 "Cycle settings and future agents" (read-only), C10 agent picker, B8 profile, C15 HandoffForm, D1/D2 FinalizationStageSetup and FinalizationRecoveryAgent, C18 launch | – | UI-14 |

---

## Deliverable 2: navigation map

Click counts are counted from the Dashboard.

| Blocker | Shortest path today | Clicks / scroll | Notes |
|---|---|---|---|
| Work-item cycle needs guidance or remediation | Dashboard → AttentionStrip row → work item → scroll to Automated cycle | 1 click and about 1 screen of scroll | This is the one good path |
| Finalization step | Dashboard → AttentionStrip → plan-version page → Finalize integration → Next finalization step | 1 click and 1–2 screens | – |
| Slice merge blocked by checkpoint evidence | Dashboard → AttentionStrip "Merge blocked by requirements" → work item → "Resolve checkpoint evidence for this slice" (`#slices`, which jumps to the bottom) → CheckpointRecoveryPanel → Prepare → Accept | 3–4 clicks and about 2 screens | The same evidence is also decidable at `/roadmaps` → B15 |
| **Shared architecture decision awaiting approval** | Not on the Dashboard. Rail → Roadmaps → find the cross-project roadmap section → scroll about 3,400 px past Scheduler, capacity, Independent review recovery, Cross-project supervision, Before Start, Verification environments, pin refresh and plan acceptance → card → "Review saved proposal" → confirm and approve | 2–3 clicks and **about 4 desktop screens** | Alternative from a question on a cycle: Dashboard → work item → WorkflowStatus link → **full reload** of `/roadmaps#architecture-decisions-<def>` → reveal-on-load. Or: work item → "Resolve design questions" → "Refresh available evidence" → the same card embedded |
| Plan acceptance (Start/Resume blocked) | Not on the Dashboard. Roadmaps → "Open plan acceptance" (reveal) → "Generate plan-acceptance evidence" → reveal submission (inside the JSON packet) → check the box, add a rationale → Accept | 4–5 clicks inside a 20k-px page | – |
| Verification environment approval | Not on the Dashboard. The work-item page says "NEEDS YOU … Open Dependency environments and evidence → Verification environments" as **prose**. The operator must navigate manually: Roadmaps → "Review verification environments" → audit → rationale → approve | 3+ clicks with no link from the place that reports it | – |
| Map adoption 0/18 | Roadmaps only (B6c) | – | – |
| Pending amendment | Roadmaps only (B16) | – | – |
| Resume after daemon restart | Roadmaps only (B2). Not in AttentionStrip; only a push notification exists | – | – |
| Capacity waits | Settings → Execution capacity → open disclosure | 2 clicks | – |

### Duplicated entry points

- **Cross-project supervision and dependency evidence** for one definition render twice on
  `/roadmaps`: once under the roadmap and once under "Cross-project roadmaps" when the imported
  map is selected (ConcurrencyImports.tsx:239-255, visible in `42-roadmap-recovery-delegation.png`).
  - The second copy offers "Create cross-project roadmap" even though a roadmap for that
    definition already exists.
  - Both copies render `id="architecture-decisions-${definitionId}"` (RuntimeEvidencePanel.tsx:291
    does not namespace it by `panelId`), so the DOM contains duplicate ids.
- **"Manage agent profiles"** links appear in the RoadmapsPage header (`:263`), in each roadmap
  (`:748`), in CrossProjectPanel (`:762`) and in CyclePanel (`:339`). "Manage capacity" appears
  at `:342`, `:742` and CrossProjectPanel `:810`.
- **Shared decisions** have two hosts (B13, C11). **Checkpoint evidence** has three or four hosts
  (K2).
- **Provider recovery** has two hosts (C7, E1).

### Dead ends (details in UI-08)

- Work-item predecessors and dependents are plain text (WorkItemPage.tsx:179-204).
- The Agenda blockers column is text.
- C21 "NEEDS YOU" items have no link.
- WorkflowStatus "Open roadmap requirements" goes to the generic `/roadmaps`.
- Every roadmap notification goes to the generic `/roadmaps`.
- HostScheduling "Roadmaps affected" goes to the generic `/roadmaps`.
- The RoadmapAgentProfiles editBlocker "Open roadmap" goes to the generic `/roadmaps`.
- The SharedDecisionInbox "Request clarification in design recovery" link hash is ignored unless
  DesignRecoveryPanel happens to be mounted.
- ConcurrencyImports shows a stale notice ("…will be available in later releases. This draft
  cannot run yet.", `:123-125`).
- The work-item SectionNav omits the slices section (App.tsx:1374-1391).
- There is **no roadmap-detail route**, so every link to "the roadmap" lands on a page that
  stacks all roadmaps.

---

## Deliverable 3: page weight

- **Roadmaps page** (component tree: RoadmapsPage, RoadmapAttention, ScopeRecoveryPanel,
  CrossProjectPanel, DependencyRequirements, RoadmapDelegationPanel, DecisionPreparationPanel,
  ReviewerResponsibilities, RuntimeEvidencePanel, NativeVerificationPanel,
  DependencyRefreshPanel, SharedDecisionInbox, ArchitectureDecisionPanel, MapAmendmentPanel,
  ConcurrencyImports, RoadmapAutomationFields):
  - about 6,750 TSX lines;
  - 18 `Section`/`section` elements, 65 `<details>`, 101 `<button>`, 19 forms or textareas;
  - 33 `revealElement` in-page jumps.
  - Per cross-project roadmap it renders, in order: RoadmapAttention, two StatusStrips, capacity
    prose, ActionBar, ScopeRecoveryPanel, CrossProjectPanel (RoadmapDelegationPanel,
    DecisionPreparationPanel, target/selection, progress strip, "Settings and plan review", two
    ActionBars with 9 buttons, Before Start, adoption, settings, lanes, excluded, readiness,
    focus graph), RuntimeEvidencePanel (native, refresh, plan acceptance, shared decisions,
    advanced ADR, setup, evidence, build records), MapAmendmentPanel, and "Execution attempts
    (171)".
  - It then repeats a similar stack under ConcurrencyImports.
  - Capture height: 21,401 px on desktop and 9,252 px on a phone.
- **Work-item page** (component tree: WorkItemPage, PlanBranchPanel, RepositoryPolicyPanel,
  CyclePanel and its 10 recovery children, DelegationPanel, WorktreeBranchPanel,
  ExecutionScopesPanel, CheckpointRecoveryPanel, SourceRunReport, SharedDecisionInbox,
  HandoffForm, CycleSettingsFields):
  - about 5,330 TSX lines;
  - 14 sections, 26 disclosures, 86 buttons, 30 forms or textareas.
  - Captures range from 1,654 px (completed) to 3,130 px (baseline preparation) on desktop, and
    4,641–5,117 px on a phone.
  - In `20-work-item-design-recovery.png`, one needs-attention design cycle shows these stacked
    panels: status, Model service recovery (not actionable), cycle strip, controls, Resolve
    design questions, Historical baseline preparation, 4 disclosures, the next-action form,
    Integration conflicts (**no conflict exists**), cycle settings, and About.
- **Vocabulary density.** I sampled 80 domain terms (the list is in the Evidence of UI-12).

  | Page | Terms present in its components | Most frequent |
  |---|---|---|
  | Roadmaps | 68 of 80 | "evidence" ≈129 occurrences, "checkpoint" ≈84, "slice" ≈76, "environment" ≈47, "pin" ≈46, "adopt" ≈43 |
  | Work item | 52 of 80 | "worktree" ≈201, "remediation" ≈40 |

  These are source-level counts and include some identifiers, so treat them as indicative.
- **Walls of text.** A heuristic scan of feature components found about 169 prose fragments of
  120 characters or more, about 8,500 words in total. The largest share is in
  RuntimeEvidencePanel (18), CrossProjectPanel (8) and StoragePanel (7). Many are rendered
  unconditionally rather than inside `About` disclosures, contrary to `ui-principles.md` "Page
  anatomy". Examples:
  - ProviderRecovery.tsx:45-49;
  - CycleRemediationRecovery.tsx:29-35;
  - ScopeReviewRecovery.tsx:61-75, where the **h3** is a 40-word sentence;
  - RuntimeEvidencePanel.tsx:218-224;
  - NativeVerificationPanel "Approve non-sensitive repository fixtures…";
  - CrossProjectPanel.tsx:487-560.
  - The screenshots show raw JSON evidence packets inline
    (`41-roadmaps-dependency-graph.png`, bottom).

---

## Deliverable 4: the missing high-level progress view

### What exists today

- **Dashboard:** counts only (planning status cards, per-project counts), live runs, and
  cycle-only attention. No roadmap progress and no dependency information.
- **Runs:** a flat list of up to 100 runs.
- **Agenda:** a table with a readiness filter and a text blockers column. No edges.
- **Plan version and project pages:** a WorkItemTable with blocker text.
- **Roadmaps:**
  - a per-roadmap "x/171 completed" and entry list;
  - CrossProjectPanel lanes, which are just a list of parent IDs with "parent acceptance
    included";
  - "Launch readiness", a list of slices with a count of waiting requirements;
  - the "Focused dependency view" (`DependencyGraph`, DependencyRequirements.tsx:104-160). It is
    an indented text tree bounded to 60 nodes and depth 3. It repeats shared prerequisites (in
    `41-roadmaps-dependency-graph.png`, STACK-PLAN-ACCEPTED appears on almost every branch).
    Every node reads "`<state>` — waiting" or "requirement satisfied". There are no runs, cycle
    steps, attention markers or counts of downstream nodes.
- ADR-015 explicitly forbids a graph canvas ("No graph canvas … for a 14-node graph a table …
  carries the same information"). That premise is obsolete: the live map has 335 milestones and
  1,221 edges.

### Data already available from the API

| Need | Endpoint | Fields |
|---|---|---|
| Cross-project DAG with satisfaction | `POST concurrency-definitions/:id/supervision/preview` (read-only but POST; also polled) | `nodes[]`: `key`, `kind` (slice/work_item/checkpoint), `repository`, `parentId`, `workItemId`, `sourceId`, `title`, required `state`, `satisfied`, `status` (text), `requirements[]` (**edges**), `blockers[]`, `action` (work-item/evidence/adopt/none), `included`, `priority`, `decisionCoverage[]`; plus `setupRequirements[]`, `targetReached`, `selectedScopeComplete`, `fullPlanAccepted`, `finalized`, `published` (contracts `cross-project.ts:65-138`) |
| Imported map structure | `GET concurrency-definitions/:id` | nodes, targets, decisions, counts |
| Roadmap scheduling state | `GET roadmaps` | `definition.entries[]` (entryId, workItemId, executionScope, sourceId, title, integrationBranch), `attempts[]` (entryId → cycleId, status), `progress[]` (entryId, status ∈ queued / dependency-blocked / capacity-blocked / exclusion-blocked / paused / needs-attention / awaiting-merge / running / completed, `phase`, typed `blockers[]`, `reason`, `effectiveAutomation`), `hostCapacity` (contracts `roadmap.ts:223-257`) |
| Live cycle state | `GET cycles` | `WorkCycle`: status, step, workItemId, executionScope, currentRunId, reason, `workflow.questions`, waits, providerRecovery, integrationResolution |
| Live runs | `GET runs` | status, role, workItemId, worktree |
| Per-item phase gates | `GET work-items/:id/execution-scopes` | phases, blockers, reservations (per item; N+1) |
| Decisions and evidence | `GET concurrency-definitions/:id/runtime` | decisionInbox, planAcceptance, submissions, nativeVerification |
| Single-project dependencies | `GET work-items/:id` (per item) → `requiredPredecessors`, `dependents`; `GET work-items` → only `blockerSourceIds` and counts | **No plan-level edge list.** The DB table `work_item_dependencies` has 236 edges but no endpoint exposes it in bulk |
| Live invalidation | SSE `/events` | `work-cycle-changed`, `roadmap-changed`, `agent-run-status-changed`, `scope-evidence-recorded`, `runtime-evidence-changed`, `work-item-completed`, `worktree-merged` |

### What the view should show

This is **Roadmap Board / Graph**, the primary progress surface.

1. **Swimlanes by project** (AQ / WI / EXO / STACK). Each parent work item is a card, with its
   slices as chips inside it (development → merged → verified → parent accepted).
2. **One status vocabulary per node, derived by the daemon:**

   | Status | Example |
   |---|---|
   | Done | – |
   | Running | with step and elapsed time |
   | Queued | eligible |
   | Waiting on other work | names the upstream nodes |
   | Waiting on automation | capacity, retry |
   | **Needs you** | amber, with the attention kind |
   | Not in scope | – |

3. **Edges** for required predecessors. The default is a **focused neighbourhood** (upstream and
   downstream of the selection, transitively reduced) rather than all 1,221 edges.
   - Checkpoints become **gate badges** on the consuming node, not repeated nodes.
   - Critical-path highlighting toward the selected target.
4. **An overlay of live activity** (a pulse on nodes with a live run) and **attention markers**,
   each with a count of downstream nodes it blocks ("approving WI-ADR-012 unblocks 14
   milestones"). This directly answers "which decision matters most".
5. **A side panel on selection:** state, gates by phase, the live run link, and an attention item
   that opens the inbox item in place. The side panel does not host separate decision forms.
6. **A header strip:** target reached, selected-scope progress (x/y), in-flight versus capacity,
   needs-you count, and scheduler state (Running / Paused / Resume required).
7. **Phone layout:** the grouped list with the same status chips (as `ui-principles` already
   asks).

### Feeding endpoints (recommended)

- A new daemon read model, `GET roadmaps/:id/board`. It joins the map nodes, roadmap
  progress/attempts, cycles, live runs and attention items into
  `{ nodes[], edges[], gates[], attention[], summary }`, invalidated by the existing SSE kinds.
- A new `GET plan-versions/:id/graph` from `work_item_dependencies` for single-project plans.
- Keep `supervision/preview` for draft previews only. Stop polling a POST.

---

## Findings

### UI-01: There is no single "needs the operator" model; the Dashboard misses most roadmap-level decisions
- **Severity:** critical
- **Category:** architecture
- **Status:** CONFIRMED
- **Evidence:**
  - `AttentionStrip.tsx:5-11` counts only cycles with `needs-attention` or `awaiting-merge`. It
    feeds both the Dashboard section and the rail badge (`App.tsx:1134,1154,1700`).
  - Other independent derivations:
    - server `notification-service.ts:236-440` (automation-policy suppression, "Verification
      setup needed", "Checkpoint evidence needed", entry holds, roadmap needs-attention,
      storage);
    - `RoadmapAttention.tsx:18-31`;
    - `RoadmapsPage.tsx:667-679`;
    - `Reasons.tsx:29-39`;
    - `CyclePanel.tsx:139-163`.
  - Captures from the same seeded state:
    - `47-dashboard.png` shows "Needs your attention 1: AQ-02 Awaiting merge approval".
    - `42-roadmap-recovery-delegation.png` shows, at the same time: "Proposal saved · awaiting
      your approval" (WI-ADR-012), "Native verification needs approval", "Map decision adoption
      0/18", "Saved configuration needs attention before evidence can be generated", and a
      pending dependency pin refresh. None of these is counted on the Dashboard or the rail.
  - `43-work-item-slices.png` shows two "NEEDS YOU" groups on WI-01 that are also absent from the
    Dashboard.
- **Impact:**
  - The operator cannot trust the Dashboard as the list of things to do. They must visit every
    roadmap and work item to find decisions.
  - Push notifications (A5) point to items the in-app attention list does not show. A restart
    "Resume required" exists only on /roadmaps.
  - Each new blocker type gets its own ad hoc surface. This is pain point 1.
- **Recommendation:**
  - Add a daemon-owned `AttentionItem` projection in the domain/contracts, served at
    `GET /api/workspaces/:ws/attention` and invalidated by a new `attention-changed` SSE event.
    Suggested fields:
    - `id` (stable: kind + subject + version);
    - `kind`, an enum: merge-approval, final-promotion, cycle-guidance, remediation-exhausted,
      design-questions, integration-conflict, scope-repair, shared-decision-approval,
      shared-decision-clarification, plan-acceptance, map-adoption,
      verification-environment-approval, reviewer-assignment, checkpoint-evidence-review,
      amendment-decision, dependency-refresh, restart-resume, provider-exhausted,
      finalization-step, storage;
    - `resolver` (you / automation / other-work);
    - `subject` refs (roadmapId, entryId, workItemId, cycleId, worktreeId, checkpointId,
      planVersionId, definitionId);
    - `title`, `summary`, `blocksDownstream` (count), `createdAt`, `action` descriptor.
  - Make the notification service consume this projection rather than its own rules. The
    Dashboard, rail, inbox and notification deep links all read it.
  - Delete `attentionCycles`, the RoadmapAttention rules and the RoadmapsPage tone logic once
    migrated.
- **Effort:** L
- **Related:** UI-02, UI-03, UI-16; controller and notification areas (pain point 3,
  notifications during transitions).
- **Plan/roadmap format impact:** none (read model only).

### UI-02: Recovery routing depends on English prose: reason-prefix regexes in the UI and navigation prose in daemon blocker messages
- **Severity:** high
- **Category:** architecture
- **Status:** CONFIRMED
- **Evidence:**
  - Reason and message prefix matching in the UI:
    - `CyclePanel.tsx:143` (`reason.startsWith('Remediation limit reached.')`);
    - `CyclePanel.tsx:156-157` (`'Two remediation rounds'`,
      `/^(Implementation|Review) needs your input\./`);
    - `WorkflowStatus.tsx:54`;
    - `RoadmapAttention.tsx:5,27,31` (`'Daemon restarted.'`, `'Resource '`);
    - `RoadmapsPage.tsx:677,951`;
    - `ExecutionScopesPanel.tsx:201` (`'Checkpoint '`).
  - The daemon encodes UI directions in messages: `apps/server/src/services/phase-resources.ts:45-49`
    ("…Open Dependency environments and evidence → Verification environments, audit this
    workstation, then approve native verification.").
  - It uses `kind: 'authorization'` even though `PhaseBlocker.kind` has a `'resource'` member
    (`packages/domain/src/phase-scheduling.ts:3`).
  - The server notification rules duplicate the same `'Resource '` prefix check
    (`notification-service.ts:355-358`).
  - `WorkCycle.reason` is free text (`packages/domain/src/work-cycle.ts:236`), and there is no
    typed recovery or attention discriminator.
- **Impact:**
  - Rewording a daemon message silently removes the correct recovery form. For example, the
    guidance form stops appearing and the generic "Resume automation" appears instead, which does
    not carry the needed answers.
  - It also changes notification behaviour.
  - Tests cannot catch this across the package boundary.
  - Navigation text in messages rots when the UI moves.
- **Recommendation:**
  - Add `WorkCycle.attention?: { kind: AttentionKind; … }`, set by the controller wherever it
    sets the reason.
  - Add `PhaseBlocker.code` (e.g. `environment-approval`, `reviewer-unassigned`,
    `checkpoint-evidence`, `plan-acceptance`, `dependency`) plus structured `refs` (checkpointId,
    resourceId, roles).
  - Remove navigation prose from messages. The UI maps the code to an action or link.
  - Replace every `startsWith` and regex listed above with `kind` or `code` switches. Add a
    contract test that every controller path setting a needs-attention status sets
    `attention.kind`.
- **Effort:** M
- **Related:** UI-01, UI-08, UI-09.
- **Plan/roadmap format impact:** none (runtime state only; persisted cycle JSON gains an
  optional field; older rows fall back to a generic "needs attention").

### UI-03: The same decision concept is surfaced in several places with different names and forms
- **Severity:** high
- **Category:** ux
- **Status:** CONFIRMED
- **Evidence:**
  - Clusters K2, K3, K4, K5 and K7–K9 in Deliverable 1.
  - `…/runtime/decide` is posted from:
    - `RuntimeEvidencePanel` (evidence review and plan acceptance);
    - `SharedDecisionInbox.tsx:162`;
    - `CheckpointRecoveryPanel.tsx:220-235`.
  - `propose-decision` is posted from `SharedDecisionInbox.tsx:135` and from ArchitectureDecisionPanel
    via `RuntimeEvidencePanel.tsx:310`.
  - Agent-prepared decision briefs come from three paths:
    - `DecisionPreparationPanel.tsx:54` (`prepare-decision`);
    - DesignRecoveryPanel investigate mode;
    - SharedDecisionInbox "Request clarification" (`:340-350`).
  - "Approve with changes" only opens an editor (`SharedDecisionInbox.tsx:334-336`).
  - "Decision" is used for:
    - map scheduling proposals ("Map decision adoption", CrossProjectPanel.tsx:694-698);
    - architecture checkpoints;
    - finalization findings (FinalizationStageDecision);
    - amendments (`amendments/decision`, MapAmendmentPanel.tsx:101).
- **Impact:**
  - The operator must learn several UIs for one act ("accept this evidence").
  - They cannot tell whether an approval made in one place satisfies the blocker shown in another.
  - Every new blocker adds another variant.
- **Recommendation:**
  - One component per decision kind, rendered only by the inbox item view (UI-19 in the
    remediation direction):
    - `EvidenceDecision` (prepare → review → accept or reject with rationale);
    - `ArchitectureDecision` (recommendation → edit → approve full or limited → clarify);
    - `CycleContinuation` (one form: guidance text, optional extra remediation rounds, and agent
      override, shown according to `attention.kind`);
    - `MapAdoption`;
    - `EnvironmentApproval`;
    - `AmendmentDecision`;
    - `FinalizationStep`.
  - Other pages show a one-line attention banner linking to the item.
  - Rename map "decisions" to "scheduling proposals" and finalization "decisions" to "finding
    dispositions". Relabel "Approve with changes" to "Edit before approving".
- **Effort:** L
- **Related:** UI-01, UI-04, UI-12.
- **Plan/roadmap format impact:** none if the *wire* names stay. Map files use "decisions" for
  scheduling proposals, so rename only UI labels and keep the format.

### UI-04: Shared architecture decisions are buried inside "Dependency environments and evidence"
- **Severity:** high
- **Category:** ux
- **Status:** CONFIRMED
- **Evidence:**
  - `RuntimeEvidencePanel.tsx:291-326` hosts `SharedDecisionInbox` inside the "Dependency
    environments and evidence" Section, after NativeVerificationPanel, DependencyRefreshPanel and
    Saved plan acceptance.
  - In `42-roadmap-recovery-delegation.png` the card begins about 3,400 px down the page.
  - On the work item, the inbox appears only after clicking "Resolve design questions", then
    "Refresh available evidence" (`DesignRecoveryPanel.tsx:96-99,103-117`).
  - WorkflowStatus links to it with a full-reload hash URL (`WorkflowStatus.tsx:41-46`).
- **Impact:**
  - The most consequential operator decision (an ADR that gates many slices) is the hardest to
    find.
  - Approval requires scrolling past unrelated setup.
  - Disabled-state coupling: `disabled={busy || !canMutate || unsavedSetup}` means unsaved
    dependency-form edits elsewhere on the page disable the decision buttons
    (RuntimeEvidencePanel.tsx:296).
- **Recommendation:**
  - Move architecture decisions to the inbox as first-class items (kind
    `shared-decision-approval`), each with its gating count.
  - On the roadmap board, show a "Decisions" tab or filter. Remove them from RuntimeEvidencePanel
    and DesignRecoveryPanel; those show a link or banner instead.
  - Keep ArchitectureDecisionPanel (manual or advanced) behind an "Author a decision manually"
    action inside the same inbox detail.
- **Effort:** M
- **Related:** UI-01, UI-03, UI-05.
- **Plan/roadmap format impact:** none.

### UI-05: The Roadmaps page is an ever-growing single document with duplicated panels and no per-roadmap route
- **Severity:** high
- **Category:** ux
- **Status:** CONFIRMED
- **Evidence:**
  - `RoadmapsPage.tsx:666-1082` renders every roadmap returned by `GET roadmaps`, including the 3
    completed ones in the live DB (the route does no filtering: `routes/roadmaps.ts:158-166`).
  - Non-cross-project entries default to open (`:899`).
  - Capture heights grew from 5,418 px (2026-09-16-after) to 21,401 px (2026-09-23).
  - `ConcurrencyImports.tsx:239-255` mounts a second `CrossProjectPanel` and
    `RuntimeEvidencePanel` for the same definition. It offers "Create cross-project roadmap"
    (CrossProjectPanel.tsx:367) although one exists (visible in capture 42).
  - Duplicate DOM id `architecture-decisions-${definitionId}` (RuntimeEvidencePanel.tsx:291).
  - `lib/route.ts:27-54` has no `roadmap` route.
  - The page is not connected to App's `refreshToken`/SSE (App.tsx:1222-1230); it polls every 3 s
    (RoadmapsPage.tsx:167).
- **Impact:**
  - Minutes of scrolling per decision.
  - Links and notifications cannot target a roadmap.
  - The two copies of the supervision UI invite contradictory edits.
  - Completed roadmaps add noise.
  - The e2e flake noted in memory (the amendment panel remounting on the 3 s poll) stems from this
    structure.
- **Recommendation:**
  - Split into `/roadmaps` (list of cards: status, progress bar, needs-you count, live count,
    completed ones collapsed under "History") and `/roadmaps/:id` (board plus controls), with
    `/roadmaps/:id/setup` (bindings, dependencies, reviewers, delegation, automation, plan
    acceptance as a checklist) and `/roadmaps/:id/history` (revisions, amendments, decisions).
  - Move concurrency-map import to `/sources/maps/:definitionId` (the bindings editor) and remove
    the duplicate supervision and evidence mounts.
  - Namespace every DOM id by `panelId`.
- **Effort:** M
- **Related:** UI-06, UI-07, UI-13.
- **Plan/roadmap format impact:** none.

### UI-06: There is no high-level progress or dependency view; dependencies appear as text and are often unlinked
- **Severity:** high
- **Category:** ux
- **Status:** CONFIRMED
- **Evidence:**
  - `DependencyRequirements.tsx:104-160` is an indented `<ul>` bounded to 60 nodes and depth 3.
    Shared prerequisites repeat, and there is no live status.
  - The lanes list only parent IDs (CrossProjectPanel.tsx:982-1040).
  - WorkItemPage predecessors and dependents are text (`:179-204`). The Agenda blockers column is
    text (AgendaPage.tsx:141-146).
  - ADR-015 "No graph canvas" was premised on 14 nodes. The live map has 335 milestones and 1,221
    edges.
  - No endpoint exposes plan-level dependency edges: contracts `planning.ts:153-167,203-231` carry
    only per-item predecessors, while the DB holds 236 `work_item_dependencies` rows.
  - Capture `41-roadmaps-dependency-graph.png`.
- **Impact:**
  - This is operator pain point 2. Working out "what blocks what, and which blocker matters most"
    takes minutes of cross-referencing four displays (cluster K11).
  - It feeds wrong prioritisation of decisions.
- **Recommendation:**
  - Implement the Roadmap Board/Graph described in Deliverable 4, backed by a new daemon read
    model `GET roadmaps/:id/board` and `GET plan-versions/:id/graph`.
  - Supersede ADR-015's "No graph canvas" clause with a short ADR: a focused-neighbourhood SVG
    graph with checkpoints as badges, a swimlane board as default, and no pan-zoom canvas library
    unless justified.
  - Layered layout for the neighbourhood can be computed in TypeScript (longest-path ranks). A
    dependency such as `elkjs` or `dagre` is a "new major dependency", which AGENTS.md says
    requires asking.
  - Make every predecessor, dependent and blocker ID a link, and use the same status chips
    everywhere.
- **Effort:** L
- **Related:** UI-01, UI-05.
- **Plan/roadmap format impact:** none. The formats already carry the edges; the new endpoints
  only read them.

### UI-07: Navigation bypasses the router: 35 of 49 in-app links force full reloads, and deep-link state lives in ad hoc hash/query parsing
- **Severity:** medium
- **Category:** bug
- **Status:** CONFIRMED (mechanism). HYPOTHESIS: operators regularly lose unsaved drafts this way.
- **Evidence:**
  - A scan of `<a>` elements in features and components found 49 total: 3 with SPA `onClick`,
    6 external or downloads, 5 in-page hashes, and **35 plain in-app hrefs**.
  - Examples: `RoadmapAttention.tsx:61`, `WorkflowStatus.tsx:30,41`,
    `DesignRecoveryPanel.tsx:153`, `CyclePanel.tsx:339`, `CrossProjectPanel.tsx:326,762,810`,
    `RoadmapsPage.tsx:263,342,742,748`, `SharedDecisionInbox.tsx:304,346`,
    `CheckpointRecoveryPanel.tsx:127,151`, `HostSchedulingPanel.tsx:324,357,363`,
    `MapAmendmentPanel.tsx:153,351,456,502`, `NotificationPanel.tsx:291`.
  - Hash and query targets are parsed per component: `DesignRecoveryPanel.tsx:76-81`,
    `RuntimeEvidencePanel.tsx:54-60`, `RoadmapAgentProfilesPanel.tsx:34,52`,
    `RoadmapCapacityPanel.tsx:18`, `HostSchedulingPanel.tsx:63`.
  - The `Route` type has no query or hash (`route.ts:27-54`). ADR-015 says anything more
    elaborate "would be a reason to revisit this decision rather than to extend the module".
- **Impact:**
  - A full reload repeats session, snapshot, audit and SSE setup. It discards unsent guidance, a
    decision rationale, or unsaved roadmap settings in other panels (ui-principles requires
    retaining unsent answers).
  - Deep links work only if the target component happens to mount and read the hash.
- **Recommendation:**
  - Extend `Route` with the needed sub-routes and typed focus parameters (e.g.
    `{name:'inbox', itemId}`, `{name:'roadmap', roadmapId, tab, focus}`,
    `{name:'settings', section, roadmapId}`).
  - Add a single `<Link route=…>` component that calls `navigate`. Replace every raw in-app href
    with it and ban raw `href="/workspaces` with a Biome rule or a unit test that greps.
  - Replace component-level `location.hash` reads with route parameters, and drop `revealElement`
    for cross-page navigation.
  - Record this in an ADR amending ADR-015.
- **Effort:** M
- **Related:** UI-05, UI-08.
- **Plan/roadmap format impact:** none.

### UI-08: Dead ends: blockers that tell the operator to go elsewhere without a link, generic landing pages, and deep links that silently do nothing
- **Severity:** medium
- **Category:** ux
- **Status:** CONFIRMED
- **Evidence:**
  - "NEEDS YOU" on the work-item page is rendered by `Reasons` from `PhaseBlocker.message` with no
    action (`ExecutionScopesPanel.tsx:175-178`). The messages instruct manual navigation
    (`phase-resources.ts:47`; capture 43).
  - Generic `/roadmaps` targets:
    - `WorkflowStatus.tsx:30` ("Open roadmap requirements");
    - notification paths `notification-service.ts:374,396,420,438`;
    - `HostSchedulingPanel.tsx:324`;
    - `RoadmapAgentProfilesPanel.tsx:169`;
    - `CheckpointRecoveryPanel.tsx:151`.
  - The "Request clarification in design recovery" link (`SharedDecisionInbox.tsx:344-348`)
    depends on DesignRecoveryPanel mounting. That requires an active design cycle that is paused
    or needs attention, plus `canMutate` and `recoverableDesign` (`CyclePanel.tsx:407-411`).
    Otherwise the `#clarify-architecture-…` hash is ignored with no message.
  - The work-item SectionNav omits `#slices` (App.tsx:1374-1391), yet several links target it
    (`CyclePanel.tsx:209,293`; `ScopeReviewRecovery.tsx:99`).
  - Stale copy: "Baseline verification, decision adoption and execution setup will be available
    in later releases. This draft cannot run yet." (`ConcurrencyImports.tsx:123-125`). These
    features exist.
  - Predecessors, dependents and agenda blockers are not links (see UI-06).
- **Impact:** Every dead end costs a manual search. Stale copy misinforms.
- **Recommendation:**
  - With UI-02 codes, every "needs you" row renders an action link to its inbox item.
  - Notification `path` should become `/workspaces/:ws/inbox/:attentionId` (or
    `/roadmaps/:id?focus=`).
  - The clarification flow becomes an inbox action that starts the investigation directly (a
    daemon command), not a hash hand-off.
  - Add `slices` to SectionNav and move the slices section above Delegation.
  - Delete the stale notice.
- **Effort:** S (copy and SectionNav) to M (links via codes).
- **Related:** UI-01, UI-02, UI-07.
- **Plan/roadmap format impact:** none.

### UI-09: The "Waiting on other work" classification hides operator-owned evidence
- **Severity:** medium
- **Category:** ux
- **Status:** CONFIRMED
- **Evidence:**
  - `Reasons.tsx:29-39` maps `evidence` to `other-work` unconditionally.
  - Capture `43-work-item-slices.png` lists "Evidence: Checkpoint STACK-PLAN-ACCEPTED must pass
    with current independently accepted evidence" under **WAITING ON OTHER WORK**. That checkpoint
    is satisfied only by the operator generating and accepting plan evidence (B12).
  - Architecture-decision checkpoints (e.g. WI-ADR-016 in the live WI-04 cycle reason) are
    likewise operator approvals.
  - Meanwhile `review` (a reviewer-role assignment) is classified as "Needs you".
- **Impact:** The operator reads the item as blocked on other agents and waits, while the real
  blocker is their own decision.
- **Recommendation:**
  - Classify by the resolver the daemon reports (UI-02 `code`), not by `kind`.
  - An evidence blocker whose checkpoint is awaiting operator review, or whose plan acceptance is
    ungenerated or unaccepted, is `you`.
  - One whose provider slice is unfinished is `other-work`.
  - Show the provider or checkpoint as a link.
- **Effort:** S (after UI-02)
- **Related:** UI-01, UI-02.
- **Plan/roadmap format impact:** none.

### UI-10: Recovery panels render when nothing needs recovering
- **Severity:** medium
- **Category:** ux
- **Status:** CONFIRMED
- **Evidence:**
  - `IntegrationResolutionPanel.tsx:31-33` renders "Integration conflicts" with "Inspect
    integration conflicts" for any paused or needs-attention cycle, even with no
    `integrationResolution`.
  - `ProviderRecovery.tsx:15` renders whenever `providerRecovery` exists and the cycle is not
    completed or stopped. That includes after recovery, with the text "Continue with the normal
    review, guidance or merge controls for this cycle."
  - Capture `20-work-item-design-recovery.png`: a design-questions cycle shows both panels.
- **Impact:** Visual noise. It suggests problems that do not exist and dilutes the real action.
- **Recommendation:**
  - Render IntegrationResolutionPanel only when `integrationResolution` exists or the attention
    kind is `integration-conflict`. Keep "Inspect for conflicts" as a menu action in cycle
    controls.
  - Render ProviderRecovery only while a retry is pending or retries are exhausted.
- **Effort:** S
- **Related:** UI-11, UI-18.
- **Plan/roadmap format impact:** none.

### UI-11: Walls of text and headings written as sentences
- **Severity:** medium
- **Category:** ux
- **Status:** CONFIRMED
- **Evidence:**
  - About 169 prose fragments of 120 characters or more (about 8.5k words) in feature components
    (heuristic scan).
  - `ScopeReviewRecovery.tsx:61-69` sets an `<h3>` to a 40-word sentence when a provider retry is
    pending.
  - Unconditional explanatory paragraphs: `ProviderRecovery.tsx:45-49`,
    `CycleRemediationRecovery.tsx:32-37,60-64`, `CycleGuidanceRecovery.tsx:26-33`,
    `RuntimeEvidencePanel.tsx:218-224`, `CrossProjectPanel.tsx:487-560` (a 6-branch status
    paragraph), `ExecutionScopesPanel.tsx:368-371`.
  - Raw JSON evidence packets are inline in the review flow (capture 41, bottom).
  - This contradicts `ui-principles.md` "Page anatomy": "Explanatory prose about the model lives
    in an `About` disclosure… A section shows state first".
- **Impact:** The operator must read paragraphs to find the one fact or button that matters.
  Phone pages reach 5–9k px.
- **Recommendation:**
  - Enforce a lint or check: headings ≤ 8 words, and no `<p>` over about 160 characters outside
    `About`.
  - Convert status paragraphs to StatusStrip facts. Keep one-line consequences beside buttons
    ("Does not resume the roadmap").
  - Render JSON packets as structured key/value views, with the raw form in a disclosure.
- **Effort:** M
- **Related:** UI-12, UI-15, UI-18.
- **Plan/roadmap format impact:** none.

### UI-12: Vocabulary density and inconsistent labels
- **Severity:** medium
- **Category:** ux
- **Status:** CONFIRMED
- **Evidence:**
  - 68 of 80 sampled domain terms appear in the Roadmaps page components, and 52 of 80 in the
    work-item components (Deliverable 3). The sample was: slice, parent acceptance, checkpoint,
    evidence, binding revision, generation, pin, conformance, native verification, Kata,
    qualification, concurrency map, milestone, planning target, selection mode, execution scope,
    phase gate, admission slot, reservation, in-flight, exclusion group, integration refresh,
    plan acceptance, shared decision, clause, limited approval, coverage, consumers, retained
    obligation, reviewer responsibilities, independent verification, recovery delegation, repair
    round, amendment, reconciliation, finalization, publication, promotion, remediation,
    allowance, baseline, investigation, controller, reassessment, provider/service retries, early
    development, frozen, repository policy, digest, provenance, receipt, build record, fixture,
    workstation, adoption, attestation, fingerprint, upstream, dispatch, …
  - Inconsistent labels:
    - Rail "Agenda" versus page title "Work items" (`AgendaPage.tsx:40`).
    - Roadmap status `running` is shown as "Scheduling enabled" (`RoadmapsPage.tsx:50`).
    - Merge states: "Awaiting merge approval", "Ready for scope acceptance", "Merge blocked by
      requirements", "Automation has not reached merge approval".
    - "Approve with changes" opens an editor.
    - "decision" is overloaded (UI-03).
- **Impact:** A high cognitive load for a single operator switching contexts. New concepts are
  invented per slice rather than mapped onto existing ones.
- **Recommendation:**
  - Establish a glossary of about 15 operator-facing terms in ui-principles (e.g. *work item,
    slice, gate, decision, evidence review, run, cycle, roadmap, capacity*).
  - Map internal terms (binding revision, generation, digest, fingerprint, reservation, dispatch)
    to disclosures or tooltips only.
  - Rename per UI-03. Align the rail and page titles.
- **Effort:** M
- **Related:** UI-03, UI-11, UI-15.
- **Plan/roadmap format impact:** none (labels only; wire and format names unchanged).

### UI-13: App.tsx monolith plus a second self-fetching architecture, ad hoc event bus, and stale panels
- **Severity:** medium
- **Category:** architecture
- **Status:** CONFIRMED
- **Evidence:**
  - `App.tsx`: 1,739 lines and 47 `useState`.
  - One `refreshToken` refetches the snapshot, audit, workspaces, cycles and all route data on any
    invalidation (380-422, 457-473, 477-596).
  - The work-item page is composed inline with render props (1369-1591).
  - Newer panels self-fetch and poll: RoadmapsPage every 3 s (`:167`), CrossProjectPanel's POST
    preview every 5 s (`:171-190`), FinalizationPanel every 3 s, NotificationPanel every 5 s.
  - Cross-component signalling uses `window` CustomEvents: `craftingtable:runtime-saved` and
    `craftingtable:saved-plan-changed` (RuntimeEvidencePanel.tsx:108,189,642,1030;
    CrossProjectPanel.tsx:134,215,251; CheckpointRecoveryPanel.tsx:235;
    DecisionPreparationPanel.tsx:191).
  - `RuntimeEvidencePanel` reloads only on those events or on a roadmap revision change
    (`:93-113`). New shared-decision recommendations from a finished preparation run do not
    appear until the operator clicks refresh (the DecisionPreparationPanel copy tells them to:
    `:62-64`).
- **Impact:**
  - Two mental models for data freshness. Some views update on SSE, some poll, and some never
    update. The operator sees stale decision state.
  - Maintainers must reason about three refresh mechanisms per change.
  - Adding a panel means another `useEffect` fetch and another bespoke refresh.
  - The performance side (re-renders on transitions) is covered by another reviewer.
- **Recommendation:**
  - Introduce a small query cache keyed by resource (a hand-rolled `useResource(key, loader)` with
    SSE-driven invalidation by event kind and subject id, or TanStack Query if a dependency is
    acceptable, which needs an ask per AGENTS.md).
  - Move page composition into page modules (`pages/WorkItemPage.tsx`, `pages/RoadmapPage.tsx`,
    …) that own their queries.
  - Replace window CustomEvents and polling with SSE invalidation (the daemon already emits
    `roadmap-changed`, `runtime-evidence-changed` and `work-cycle-changed`).
  - Shrink App.tsx to auth, shell and route dispatch.
- **Effort:** L
- **Related:** UI-05, UI-07; performance area.
- **Plan/roadmap format impact:** none.

### UI-14: Settings that gate progress are edited in many places
- **Severity:** medium
- **Category:** simplification
- **Status:** CONFIRMED
- **Evidence:**
  - Agent selection (cluster K12) is edited in: `WorkspaceProfilesSection`,
    `RoadmapAgentProfilesPanel`, roadmap editor `CycleSettingsFields` (RoadmapsPage.tsx:604-617),
    CrossProjectPanel defaults and overrides (`:745-975`), CyclePanel setup form (`:444-453`),
    DesignRecoveryPanel agent picker, DecisionPreparationPanel, IntegrationResolution
    HandoffForm, FinalizationStageSetup / FinalizationRecoveryAgent, and DelegationPanel launch.
  - Reviewer responsibilities are edited in CrossProjectPanel (`:752-773`) and
    RoadmapDelegationPanel.
  - Integration policy is edited in the roadmap editor, CrossProjectPanel settings and
    RoadmapDelegationPanel.
  - Capacity is edited in HostSchedulingPanel and RoadmapCapacityPanel, with links from three
    places.
- **Impact:**
  - The operator cannot predict which setting wins ("queued settings" versus "future delegation"
    versus "agent profiles for future runs").
  - Each surface carries its own explanatory prose about precedence.
- **Recommendation:**
  - Settings → Agents (workspace defaults) → Roadmap setup tab (per-roadmap overrides, reviewer
    responsibilities, integration policy, delegation grants, all in one place with effective
    values shown).
  - Per-action pickers (design recovery, finalization recovery) show the effective selection
    with a "Change for this action" disclosure.
  - Capacity lives only in Settings. The roadmap header shows usage with a link.
- **Effort:** M
- **Related:** UI-05, UI-11.
- **Plan/roadmap format impact:** none (the same saved definitions and commands).

### UI-15: `docs/ui-principles.md` has become a per-slice accretion log that encourages new surfaces
- **Severity:** medium
- **Category:** docs
- **Status:** CONFIRMED
- **Evidence:**
  - The document is 328 lines. From "## Roadmaps" onward (about lines 138-328) it is a sequence of
    feature-specific paragraphs appended per slice, each prescribing where a new control goes.
    Examples:
    - "Integration conflict recovery belongs beside the cycle status";
    - "Design questions have a recovery action beside the cycle's status";
    - "Shared architecture decisions appear as actionable cards on both the roadmap and design
      recovery";
    - "Prepare architecture decision is available before…".
  - It contradicts itself:
    - "Navigation appears nowhere else" (Shell) versus dozens of in-body cross-page links.
    - "Every other workspace page shows the same waiting cycles" versus roadmap-level waits being
      excluded.
    - "project lanes" versus ADR-015 "No graph canvas".
- **Impact:**
  - The normative document prescribes co-locating each recovery with its origin, which is exactly
    the spaghetti pattern.
  - Future agents following it will keep adding surfaces.
- **Recommendation:**
  - Restructure into:
    1. principles and visual language (keep as is);
    2. IA rules: "decisions are made only in the inbox; other pages link", "one status vocabulary",
       "no raw in-app hrefs";
    3. a glossary;
    4. per-surface specs in short subsections.
  - Delete superseded per-slice paragraphs. Amend ADR-015 accordingly.
- **Effort:** S
- **Related:** UI-01, UI-03, UI-12.
- **Plan/roadmap format impact:** none.

### UI-16: AttentionStrip and the notification service disagree about merge approvals
- **Severity:** medium
- **Category:** bug
- **Status:** CONFIRMED (code divergence). HYPOTHESIS: how often it shows in practice.
- **Evidence:**
  - `AttentionStrip.tsx:5-11` includes every `awaiting-merge` cycle except `scopeReviewWait`.
  - The notification service (`notification-service.ts:238-277`) additionally suppresses:
    - cycles that are transitioning;
    - `automatedScopeRecoveryWait`;
    - slice-verification cycles awaiting merge under roadmap ownership;
    - parent acceptance with automatic policy;
    - integration merges with `integrationMerge: 'automatic'`;
    - conflicts with automatic delegation.
  - It also labels merge-requirement waits as "attention" rather than "merge".
- **Impact:**
  - The Dashboard can list "Awaiting merge approval" for work the roadmap will merge or record
    automatically.
  - Push and in-app lists differ, which erodes trust.
- **Recommendation:** This is resolved by UI-01's single projection. Until then, expose a
  daemon-computed `cycle.operatorAction` flag and use it in `attentionCycles`.
- **Effort:** S (interim) / covered by UI-01.
- **Related:** UI-01.
- **Plan/roadmap format impact:** none.

### UI-17: Roadmap supervision panels share mutable page-level "dirty" gates that disable unrelated decisions
- **Severity:** low
- **Category:** ux
- **Status:** CONFIRMED
- **Evidence:**
  - `RoadmapsPage.tsx:68-89,764-808` tracks `dirtyRoadmaps` and `dependencyDrafts`.
  - `RuntimeEvidencePanel.tsx:145,185,255,296,308` disables the shared decision inbox, plan acceptance
    and evidence decisions when *any* roadmap-settings or dependency form on the page is dirty.
  - CrossProjectPanel disables delegation and decision preparation when its own form is dirty
    (`:410-426`).
- **Impact:**
  - An operator who touched a settings field above cannot approve an ADR below, and the only
    explanation is prose far away on the page.
  - This coupling exists because setup and decisions share one page.
- **Recommendation:** Separate setup (the `/roadmaps/:id/setup` route) from decisions (the inbox).
  Where a decision really depends on saved configuration, the daemon rejects stale input (it
  already uses `expectedVersion`), and the UI shows that error.
- **Effort:** S (after UI-05)
- **Related:** UI-04, UI-05.
- **Plan/roadmap format impact:** none.

### UI-18: The work-item page stacks up to about a dozen conditional panels in one "Automated cycle" section; slice gates sit at the bottom
- **Severity:** medium
- **Category:** ux
- **Status:** CONFIRMED
- **Evidence:**
  - CyclePanel children: WorkflowStatus, ProviderRecovery, StatusStrip, ActionBar, read-only hint,
    ScopeRepairPanel and ScopeReviewRecovery, CycleRemediationRecovery, CycleGuidanceRecovery,
    DesignRecoveryPanel (with SharedDecisionInbox, BaselinePreparationPanel and SourceRunReport),
    HistoricalEvidencePanel, IntegrationResolutionPanel, settings disclosure, About, and previous
    cycles (`CyclePanel.tsx:185-470`).
  - Page order: Overview, Branches, Automated cycle, Delegation, **Execution slices** (with the
    "NEEDS YOU" gates), then Diff (App.tsx:1369-1591).
  - Captures are 1,654–3,130 px on desktop and 4,641–5,117 px on a phone.
  - The worktree selector is the only way to see another slice's cycle (`CyclePanel.tsx:184-201`).
- **Impact:**
  - For scoped (map) work the operator must pick a worktree from a dropdown to see each slice's
    state.
  - Gating requirements are at the bottom. The page mixes drill-down detail with decision forms.
- **Recommendation:**
  - Restructure the work item as: header, attention banner (link to the inbox item), a **slice
    strip** (one chip per slice and phase with status), then tabs (Cycle · Runs · Branches &
    worktrees · Gates · Diff).
  - The cycle tab shows status and manual controls only (pause, stop, open run, manual handoff).
    Recovery forms move to the inbox item view (the same component, reachable from here).
- **Effort:** M
- **Related:** UI-03, UI-10, UI-11.
- **Plan/roadmap format impact:** none.

### UI-19: The e2e and walkthrough suites are coupled to current accessible names, so an IA migration needs a test plan
- **Severity:** low
- **Category:** testing
- **Status:** CONFIRMED
- **Evidence:**
  - `e2e/*.spec.ts` totals 3,006 lines, including `walkthrough.spec.ts` and `roadmaps.spec.ts`.
  - Memory notes and ui-principles require keeping exact texts ("Awaiting merge approval",
    "2/2 completed", region labels).
  - A known flake (the amendment panel detaching on the 3 s poll) is recorded in operator memory.
- **Impact:** The IA consolidation will break many specs at once. Without planning, agents will
  keep the old surfaces to keep tests green.
- **Recommendation:**
  - Migrate per surface. Add inbox-based specs first, then delete old-surface specs together with
    their components in the same commit.
  - Take a walkthrough capture before and after each step (per AGENTS.md).
- **Effort:** M (spread across the IA work)
- **Related:** UI-01, UI-05.
- **Plan/roadmap format impact:** none.

---

## Deliverable 5 and remediation direction: proposed near-term unified IA

### Principles

1. **Decisions are made in one place.** The daemon's `AttentionItem` projection drives a
   **Needs you** inbox. Every other page shows at most a one-line banner or chip that links to the
   item (UI-01, UI-03).
2. **Progress is a graph and board, not a list.** The roadmap or plan board is the primary
   progress surface. Work items and runs are drill-downs (UI-06).
3. **Setup is a checklist, not a page of panels.** Roadmap setup is its own route, with ordered
   steps and a clear "ready to start" state (UI-05, UI-17).
4. **One status vocabulary, typed by the daemon** (UI-02, UI-09, UI-12).
5. **Keep the visual language.** Keep the dark theme, teal accent, semantic amber/blue/green/red/
   grey, and the anatomy primitives (PageHeader, StatusStrip, ActionBar, Section, Reasons, About,
   SectionNav). They are sound; the problem is IA, not styling.

### Route table (near term)

| Route | Page | Contents | Replaces or absorbs |
|---|---|---|---|
| `/workspaces/:ws` | **Home** | Needs-you summary (top 5 items plus total, grouped by roadmap), roadmap progress cards (mini board: done / running / waiting / needs-you counts, live pulse), live runs, recent activity (collapsed) | Dashboard; AttentionStrip section; StatusCards move to the Work items page |
| `/workspaces/:ws/inbox` | **Needs you** | A list of `AttentionItem`s filterable by roadmap, project and kind, sorted by `blocksDownstream` then age. Split view on desktop, list then detail on a phone | AttentionStrip, RoadmapAttention, the CrossProjectPanel "Before Start", Reasons "Needs you" rows, host "recorded waits" (as automation items) |
| `/workspaces/:ws/inbox/:itemId` | **Decision** | The decision component for the kind (see the merge table), context (subject card, gate chain, evidence links), consequences | All recovery and decision forms |
| `/workspaces/:ws/roadmaps` | Roadmaps | Cards per roadmap (active first; completed under History) plus "New roadmap" and "Import concurrency map" | the RoadmapsPage list |
| `/workspaces/:ws/roadmaps/:id` | **Roadmap board** | Header (scheduler state, Start/Pause/Resume/Stop), board/graph (Deliverable 4), selection side panel | RoadmapsPage per-roadmap section, CrossProjectPanel lanes, focus and readiness, entry list |
| `/workspaces/:ws/roadmaps/:id/setup` | Roadmap setup | Checklist: bindings → dependency environment → verification environments → reviewer responsibilities and delegation → automation and agents → plan acceptance. Each step shows done or needs-you | CrossProjectPanel settings, RuntimeEvidencePanel setup, NativeVerification setup, RoadmapDelegationPanel, ScopeRecoveryPanel (policy), capacity link |
| `/workspaces/:ws/roadmaps/:id/history` | Roadmap history | Revisions, amendments (history), decision records, evidence submissions (read-only) | "View revisions", MapAmendmentPanel history, evidence review history |
| `/workspaces/:ws/plans/:planVersionId` | Plan | Plan board/graph (single project) plus finalization status. The finalization *decisions* are inbox items | PlanVersionPage (the project page keeps its version list) |
| `/workspaces/:ws/work-items/:id` | Work item (drill-down) | Header, attention banner, slice strip, tabs (Cycle, Runs, Branches & worktrees, Gates, Diff); predecessors and dependents as links | The current work-item page minus recovery forms |
| `/workspaces/:ws/work-items` | Work items | Table plus filters (the former Agenda and StatusCards) | Agenda |
| `/workspaces/:ws/runs`, `/runs/:id` | Runs | Unchanged; ProviderRecovery becomes a banner linking to the inbox | – |
| `/workspaces/:ws/sources` | Sources | Projects, plan imports, concurrency-map imports and bindings, repositories | Projects, Import plan, Repositories, ConcurrencyImports |
| `/workspaces/:ws/settings/:section` | Settings | general · agents · capacity · notifications · storage | SettingsPage single page |

The rail becomes: Home (needs-you count), **Needs you** (count), Roadmaps, Work items, Runs (live
count), Sources, Settings. That is 7 entries instead of 8, and the most important one is visible
and counted.

### Component disposition

| Component | Disposition |
|---|---|
| `AttentionStrip`, `attentionCycles` | **Delete**. Replace with `NeedsYouBanner` (reads `/attention`) and the Home summary |
| `RoadmapAttention`, RoadmapsPage tone logic | **Delete** (they become inbox items and the board header) |
| `CycleGuidanceRecovery`, `CycleRemediationRecovery`, `ScopeReviewRecovery`, plain "Resume automation" | **Merge** into `CycleContinuation` (inbox detail). Shows the guidance field always, extra rounds when `kind = remediation-exhausted`, and fresh-review semantics for scope reviews |
| `DesignRecoveryPanel`, `BaselinePreparationPanel`, `SourceRunReport` | **Move** into inbox detail (kind `design-questions`). The investigation result shows there |
| `IntegrationResolutionPanel` | **Move** to inbox (kind `integration-conflict`). Keep the read-only conflict summary on the work-item Cycle tab |
| `ScopeRepairPanel`, `ScopeRecoveryPanel` | ScopeRepair **moves** to inbox (kind `scope-repair`). The ScopeRecovery policy **moves** to roadmap setup |
| `ProviderRecovery` | **Move** to inbox (kind `provider-exhausted`) only when exhausted. While a retry is pending, show a status chip ("service retry 2/3 at 14:05") with Retry now |
| `SharedDecisionInbox`, `ArchitectureDecisionPanel`, `DecisionPreparationPanel` | **Merge** into `ArchitectureDecision` (inbox kind `shared-decision-approval`), with "Prepare brief with agent" and "Author manually" as actions in it |
| `CheckpointRecoveryPanel`, RuntimeEvidencePanel evidence review, plan-acceptance review | **Merge** into `EvidenceDecision` (kinds `checkpoint-evidence-review`, `plan-acceptance`) |
| `NativeVerificationPanel` | Setup step plus inbox item (kind `verification-environment-approval`) |
| `DependencyRefreshPanel` | Setup step plus inbox item (kind `dependency-refresh`) |
| `MapAmendmentPanel` | Decision part becomes an inbox item (kind `amendment-decision`); history goes to `/roadmaps/:id/history` |
| CrossProjectPanel | **Split**: preview and target selection go to Sources/map and "New roadmap"; settings go to Setup; lanes, focus and readiness go to the Board; "Before Start" becomes Setup checklist state plus inbox items. **Delete** the duplicate mount in ConcurrencyImports |
| `RuntimeEvidencePanel` | **Split** into Setup (pins, environments), inbox (evidence decisions) and History (submissions) |
| `RoadmapDelegationPanel`, `ReviewerResponsibilities` | **Move** to Setup (one reviewer-responsibility editor) |
| `FinalizationStageDecision`, `FinalizationCheckpoint`, final-promotion approval | Inbox kinds `finalization-step` and `final-promotion`. FinalizationPanel keeps progress and setup on the plan page |
| `ExecutionScopesPanel` | **Becomes** the work-item "Gates" tab plus slice strip. Actions (create worktree, record verification, accept parent, authorize early development) stay here as manual controls, or become inbox items when the daemon reports them as needed |
| `DependencyGraph`, `PhaseRequirements` | **Replace** with the Board graph |
| `Reasons` | Keep as a primitive, but the resolver comes from the daemon |
| `WorkflowStatus` | Reduce to a controller-activity chip ("security review running"). Questions become inbox items |
| `HostSchedulingPanel`, `RoadmapCapacityPanel`, `RoadmapAgentProfilesPanel`, `WorkspaceProfilesSection`, `StoragePanel`, `NotificationPanel` | Keep, in `/settings/:section` sub-routes |
| App.tsx page composition | **Move** into `pages/*`, with a resource cache and SSE invalidation (UI-13) |

### Sequencing

1. **Foundation (S–M).**
   - UI-02 typed attention kinds and blocker codes (daemon), then UI-01's `AttentionItem`
     projection, `GET /attention`, and the SSE event.
   - Point notifications at it.
   - UI-07 `Link` component and extended `Route`.
   - UI-10 and the UI-08 copy fixes are quick wins.
2. **Inbox (M–L).**
   - Build the `/inbox` list and detail using the *existing* form components as-is first. Mount
     them from the inbox rather than rewriting them.
   - Replace AttentionStrip with the Home summary and rail counts.
   - Pages keep their forms temporarily but show a banner "Decide in Needs you".
3. **Roadmap split (M).**
   - Add `/roadmaps/:id`, `/setup` and `/history`.
   - Remove the duplicate ConcurrencyImports mounts. Collapse completed roadmaps.
4. **Board/graph (L).**
   - Daemon `roadmaps/:id/board` and `plan-versions/:id/graph` read models.
   - ADR superseding ADR-015's graph clause.
   - Swimlane board plus focused-neighbourhood graph with a live overlay and `blocksDownstream`.
5. **Merge decision components (L).**
   - Consolidate per the disposition table and delete the originals and their per-page hosts.
   - Shrink the work-item page to a drill-down (UI-18).
   - Consolidate settings (UI-14).
6. **Docs and data layer (M–L).**
   - Rewrite ui-principles (UI-15) with IA rules and a glossary (UI-12).
   - Complete the App.tsx decomposition and query cache (UI-13).
   - Take walkthrough captures before and after each step (UI-19).

### Target design in one paragraph

The operator opens Home and sees "4 need you". Each item says what it blocks ("WI-ADR-012
approval, which unblocks 14 milestones across WI and EXO"), and the roadmap cards show progress
with live activity. Clicking an item opens one decision view with the context and the single
form, whatever its kind. Clicking a roadmap opens a board of project lanes, where parents and
slices carry status chips, live runs pulse, and amber markers show where the operator is the
blocker. Selecting a node shows its upstream and downstream gates. Work-item and run pages are
reached from there for detail, never for decisions. Setup is a checklist, and settings live in
one place. The daemon owns every "needs you" judgement, so push notifications, the badge, the
inbox and the board always agree.
