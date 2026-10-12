# R-I7 claims ledger

The claims checked against the code while R-I7's rest was built (2026-10-12, P3 build order step
6), one section per rewritten document: each claim, where it was checked (file:line at
`remediation/p3` 3a03927 unless noted), and its result (`true`, `new` from the code, or
`fixed` with what the old text said). Each section ends with the old claims found false or stale,
what was dropped, and the code defects and operator questions found. The register entry
[R-I7](register.md#r-i7) summarizes them; the independent review's own spot checks are recorded
there too. Like the rest of this directory, it describes the code as it was checked.

## Claims ledger: docs/ui/ and docs/roadmaps.md (R-I7 parts 3 and 5's roadmap guides)

Checked against `remediation/p3` at 3a03927. 171 claims: 136 `true` (carried over or rewritten
and confirmed), 17 `new` (written from the code), 18 `fixed` (the old text was false or stale).
"False or stale in the old doc" lists 26 old claims, fixed here or not carried over.
Paths are under `apps/web/src/` unless they start with a package or `apps/server`.

### ui/README.md

| # | Claim | Checked against | Result |
|---|---|---|---|
| 1 | copy-rules test checks heading length and long prose outside `About` | copy-rules.test.ts:7-23 | true |
| 2 | links test: in-app navigation through `Link`, no raw href | links.test.ts:7-15 | true |
| 3 | boundary test: one poster per decision command in `decisions/<kind>/`; requests in API modules; board reaches no request | decisions/boundary.test.ts:7-25, 1036-1046, 1486-1499 | true |
| 4 | anatomy test covers `Reasons`, `Section`, `StatusStrip` | components/anatomy.test.tsx:11-60 | new |
| 5 | `pnpm ui:walkthrough` captures every page on desktop and phone | package.json `ui:walkthrough`; docs/ui-walkthrough/README.md | true |
| 6 | ADR-072 replaced ADR-015's "no graph canvas" | docs/decisions/ADR-072 header | true |
| 7 | the API inventory is generated | package.json `routes:inventory`; docs/api-routes.md | new |

### ui/information-architecture.md

| # | Claim | Checked against | Result |
|---|---|---|---|
| 8 | inbox at `/workspaces/:id/inbox`, item at `/inbox/:itemId` | lib/route.ts:95, 263-268 | true |
| 9 | open items most blocking first, then oldest | apps/server/src/services/attention-service.ts:104 | true |
| 10 | item page hosts decisions chosen from its code by `decisions/registry.ts` | features/inbox/InboxPage.tsx:13-16; decisions/registry.ts:21-60 | true |
| 11 | notifications open the item pages | ui-principles (old):102; NeedsYou.tsx:8-11; attention item `path` | true |
| 12 | where an item carries the stop, the page shows "… decided in Needs you. Open the decision" | features/execution/DelegationPanel.tsx:385-396; CyclePanel.tsx:269-282; ExecutionScopesPanel.tsx:267-277; FinalizationPanel.tsx:521 | true |
| 13 | with no item, the decision renders in place with the same component | DelegationPanel.tsx:397-405 (`MergeApproval`); CyclePanel.tsx:284-297 (`CycleDecision`); app/pages/RunRoute.tsx:34-36 | true |
| 14 | setup steps and Repositories → Checks host the same decision components; an item renders one setup step | features/planning/RuntimeEvidencePanel.tsx imports (PlanAcceptance, ArchitectureDecisions, …); RepositoryChecksPanel.tsx → CheckAdoption; decisions/registry.ts `RoadmapItemPart` | fixed: old "decisions are made only in the inbox" (UI-15) left setup out |
| 15 | no new per-stop recovery panels (program rule 1) | docs/review/.../program.md:9-15 | true |
| 16 | linking-instead-of-rendering is kept by review, not a test | no test found asserting it | new |
| 17 | decision commands' requests in the kind's own `*-api.ts`, importable only from its directory | decisions/boundary.test.ts:1400-1422 (`decisionModuleProblems`) | true |
| 18 | `cycles/:id/control` and `finalizations/:id/control` name one component per decision | decisions/boundary.test.ts:155-195 (`SHARED`) | true |
| 19 | decision commands = routes tagged `decision` in the generated inventory | decisions/boundary.test.ts:872-940 | true |
| 20 | the test fails on a second poster, unowned/doubly owned route, request outside API module, foreign import of a kind | decisions/boundary.test.ts:816-940, 1043-1048, 1417-1430 | true |
| 21 | one feed `GET /api/workspaces/:id/attention` read by inbox, rail count, dashboard, strip, roadmap list | apps/server/src/routes/attention.ts:14; WorkspaceShell.tsx:40 (`attentionCount`); app/WorkspaceView.tsx:125-127; NeedsYou.tsx; RoadmapBoardPage.tsx:202, 466-485 | true |
| 22 | who acts next / entry waits are the daemon's words, shown as given | features/planning/SliceStrip.tsx:7-12; features/roadmap-board/SelectionPanel.tsx:146-149 | true |
| 23 | where the daemon returns actions (cycle, finalization) the page offers only those | packages/contracts/src/work-cycle.ts:462 (`actions`); decisions/finalization/FinalizationStep.tsx:27-31 | true |
| 24 | pages choose which controls to show from a record's status | features/execution/CyclePanel.tsx:143-154; RoadmapBoardPage.tsx:397-427 | new |
| 25 | commands carry versions; stale refused | apps/server/src/services/roadmap-service.ts:1811-1812 (`Roadmap changed; refresh …`) | true |
| 26 | label maps in lib (`attention-labels`, `execution-labels`, `planning-labels`) and `roadmap-labels` | lib/*.ts; features/planning/roadmap-labels.ts | new |
| 27 | a new code without a label fails `pnpm typecheck` | lib/attention-labels.ts:7 (`Record<AttentionItemCode, string>`); execution-labels.ts:80 | new |
| 28 | branch on codes, never on message text (program rule 4) | program.md:38-39; scripts/check-forbidden-scope.mjs (prose-branching check) | true |
| 29 | colour never carries a state alone | lib/execution-labels.ts:12-15; StatusStrip.tsx:12-16 | true |
| 30 | rail holds picker, workspace pages, Workspaces and Account, badge, theme toggle, Log out | components/WorkspaceShell.tsx:68-195 | true |
| 31 | `SectionNav` reaches sections; `PageTabs` sibling pages (roadmap tabs, Settings pages) | components/SectionNav.tsx:7-11; PageTabs.tsx:4-7; used in RoadmapBoardPage.tsx:854, SettingsPage.tsx:89 | fixed: old omitted Settings pages |
| 32 | body links go to subjects; no page rebuilds a menu | DashboardRoute.tsx (All runs, Open inbox); RoadmapsPage.tsx:121-133 | fixed: old "Navigation between pages appears nowhere else" (UI-15 contradiction) |
| 33 | `h1` is the rail label; dashboard's is the workspace's name | DashboardRoute.tsx:39-41; InboxPage.tsx:68-69; RunsPage.tsx:119-120; AgendaPage.tsx:39-40 | true |
| 34 | in-app links via `Link`, `PathLink` for daemon paths; plain anchors for fragments, API downloads, external | links.test.ts:7-15, 39-50; lib/navigation.tsx | true |
| 35 | path names page and subject; board `?view`, `?select` | lib/route.ts:78-90, 168-180 | true |
| 36 | selecting replaces the history entry | RoadmapBoardPage.tsx:355-363 (`{ replace: true }`) | true |
| 37 | `#focus` revealed once the page loads | lib/route.ts:74-77; lib/reveal-element.ts | true |
| 38 | links stored before a split open the holding page | lib/route.ts:50-70 (`roadmapTabForFocus`), 32-36 (`SETTINGS_FOCUS`), 183-196 | true |
| 39 | parse/build are pure, no routing library (ADR-015) | lib/route.ts:9-16 | true |
| 40 | forms open from named actions; launch form exception | features/execution/DelegationPanel.tsx:253-256; FinalizationPanel.tsx:230; RoadmapsPage.tsx:116; ConcurrencyImports.tsx:617 | true |
| 41 | reference and history start closed; working sections open | components/Section.tsx:3-11 | true |

### ui/glossary.md

| # | Claim | Checked against | Result |
|---|---|---|---|
| 42–58 | the 17 terms (plan version … capacity) as defined | packages/domain (work-item, execution, roadmap, finalization-stages); lib/*-labels.ts; HostSchedulingPanel | true (17 rows) |
| 59 | "Run … design, implement or review" (three roles) | packages/domain/src/execution.ts `AgentRunRole`; lib/execution-labels.ts:39-43 | fixed: old listed remediate as a run kind |
| 60 | "Needs you" term: operator-owned stops as attention items | packages/domain/src/attention-item.ts:10-19 | new |
| 61 | every stop has a typed code and owner, declared in the same write (ADR-067) | packages/domain/src/attention.ts:1-11, 217-235 | true |
| 62 | operator-owned stops are items labelled by code | lib/attention-labels.ts:1-7 | true |
| 63 | the five decision kinds as naming guidance, plus "act on something that went wrong" codes | lib/attention-labels.ts (`manual-run-failed`, `restart-session-lost`, `storage-pressure`, `protected-ref-moved`) | fixed: old said every operator stop is one of five things |
| 64 | controller waits: `ENTRY_WAIT` list | packages/domain/src/attention.ts:143-163 | fixed: old listed three waits |
| 65 | claimed stops stay controller-owned until the claim lapses | packages/domain/src/attention.ts:184-197 | true |
| 66 | `Reasons` groups: Needs you / Waiting on automation / Waiting on other work | components/Reasons.tsx:47-51 | true |
| 67 | board actor words: Needs you, Agent at work, Waiting, Done | features/roadmap-board/SelectionPanel.tsx:16-19; SliceStrip.tsx:103 | true |
| 68 | `Proposed → In agenda → Completed`; in progress derived | lib/planning-labels.ts:32-36; app/pages/WorkItemRoute.tsx:54-57 | true |
| 69–73 | the five state labels and meanings | lib/planning-labels.ts:11-23 | true |
| 74 | project card counts "Ready"/"Blocked" are the one abbreviation | features/planning/ProjectCards.tsx:43-62 | fixed: old "a bare Ready/Blocked never appears" (DOC-03 #7) |
| 75 | merge readiness decided by the daemon (`mergeGateFor`) | apps/server/src/services/execution-service.ts:105-150 | true |
| 76 | the 13 merge-gate labels | lib/execution-labels.ts:80-94 | fixed: old listed 6, with old wording |
| 77 | "Review has no verdict yet": running, did not finish, or no verdict | execution-service.ts:118-122, 134-135, 146-150 | fixed |
| 78 | run status labels | lib/execution-labels.ts:17-25 | new |
| 79 | cycle status labels | lib/execution-labels.ts:65-72 | new |
| 80 | roadmap status labels incl. "Resume required after restart" | features/planning/roadmap-labels.ts:5-17 | new |
| 81 | reported model shown beside requested when they differ | features/execution/RunPage.tsx:471-472 | true |
| 82 | subscription cost shown as estimate `≈$x (est.)` | lib/execution-labels.ts:101-108 | true |

### ui/visual-language.md

| # | Claim | Checked against | Result |
|---|---|---|---|
| 83 | tokens in styles/tokens.css, rules in global.css | styles/tokens.css:1-7 | true |
| 84 | dark default; light theme redefines tokens; toggle in rail; persists; OS preference not consulted | tokens.css:7, 79; lib/theme.ts:1-34; WorkspaceShell.tsx:181-189 | true (OS note new) |
| 85 | accent teal for focus, links, primary | tokens.css:25-29 | true |
| 86 | semantic colours amber/blue/green/red/grey | tokens.css:32-42 | true |
| 87 | panels padded 1rem, 0.75rem on phones; 0.25–2rem scale | global.css:328; 1647-1649; tokens.css:45-51 | fixed: old "gaps 0.75–1rem" not a rule in the CSS |
| 88 | body text 14px, 16px on phones | tokens.css `--text-base: 0.875rem`; global.css:1626-1630 | fixed: old "the type scale starts at 14px" (12px and 13px sizes exist) |
| 89 | monospace for identifiers etc. | tokens.css `--font-mono`; StatusStrip `mono` facts | true |
| 90 | every dashboard count opens its list | components/StatusCards.tsx:19-22, 89-97 | true |
| 91 | live-run pulse is the only motion; reduced motion disables all animation/transition | global.css:29-37, 504-515 | true |
| 92 | rail 220px wider than 900px; compact header with Menu at ≤900; closes on navigation or Escape; new destination at top | global.css:116, 1504-1530; WorkspaceShell.tsx:52-66, 116-127 | true |
| 93 | phone: ≤600px or ≤900px coarse; 44px targets; 16px form text | global.css:1625-1685 | true |
| 94 | tables/patches scroll inside panels | global.css `.table-scroll`; RepositoriesPage.tsx:73 | true |
| 95 | board lanes/graph and plan graph need 900px | features/roadmap-board/use-wide.ts:3-4; RoadmapBoardPage.tsx:229-232; app/pages/ProjectRoute.tsx (`useWide`) | new |
| 96 | focus ring, landmarks, one `h1` | global.css:23-27; PageHeader.tsx:28 | true |
| 97 | `Section` keeps landmark and name collapsed | components/Section.tsx:12-14; anatomy.test.tsx:36 | true |
| 98–102 | anatomy: PageHeader (crumbs, h1, subtitle, status, actions); StatusStrip; ActionBar primary first, danger last; Section title/count/summary; collapsible reference | components/PageHeader.tsx:8-45; StatusStrip.tsx:12-16; ActionBar.tsx:3-6; Section.tsx:3-11 | true |
| 103 | `About` starts closed and holds model explanation | components/About.tsx:3-7 | true |
| 104–107 | copy rules: 8 words; 160 characters; state exemptions; conditional does not exempt | copy-rules.test.ts:7-23, 55-73 | true |
| 108 | recovery control renders only while there is something to recover | R-E6 entry; ProviderRecovery/IntegrationResolution gating (register R-E6) | true |

### ui/surfaces.md

| # | Claim | Checked against | Result |
|---|---|---|---|
| 109 | rail entries and counts (Needs you, Runs live, Work items in agenda) | WorkspaceShell.tsx:68-96 | true |
| 110 | strip on every page but dashboard and inbox | app/WorkspaceView.tsx:125-127 | true |
| 111 | refresh/stream failure warnings keep last state | app/WorkspaceView.tsx:103-123 | new |
| 112 | Workspaces: cards with projects and counts, New workspace; `/` → last workspace | features/home/WorkspacesPage.tsx:8-90; App.tsx:129; lib/route.ts:68-69 | true |
| 113 | dashboard order incl. Operator wait (collapsed), top five items | app/pages/DashboardRoute.tsx:36-106; NeedsYou.tsx:19; OperatorWaitSection.tsx:67-74 | fixed: old omitted Operator wait |
| 114 | status cards list, needs-attention imports card only when non-zero | components/StatusCards.tsx:30-82 | true |
| 115 | inbox rows: label, title, unblocks N, age | features/inbox/InboxPage.tsx:125-148 | true |
| 116 | storage items shown only to an installation owner | packages/domain/src/attention-item.ts:60-64; attention-service.ts:90-92 | new |
| 117 | item page: message, facts, "Open where it happened", decisions; resolved item links current | InboxPage.tsx:79-122 | true |
| 118 | Work items route `/agenda[/:filter]`, five filters, rail opens In agenda | lib/route.ts:18-25, 245-250; AgendaPage.tsx:14-20; WorkspaceShell.tsx:82-86 | new |
| 119 | work item header actions and disabled-with-reason removal | features/planning/WorkItemPage.tsx:100-134 | true |
| 120 | slice strip contents; posts nothing | SliceStrip.tsx:7-12, 103-111 | true |
| 121 | section order Overview, Branches, Automation, Slices, Delegation, Runs, Diff | app/pages/WorkItemRoute.tsx:74-94 | true |
| 122 | branches open only as next step | WorkItemRoute.tsx:121-128 | true |
| 123 | Other phases disclosure | features/execution/ExecutionScopesPanel.tsx:251 | true |
| 124 | project page parts | features/planning/ProjectPage.tsx:25-155 | new |
| 125 | plan version page order; graph at ≥900px | app/pages/ProjectRoute.tsx:80-140; PlanVersionPage.tsx:30-130 | true |
| 126 | finalization: Set up finalization; stages; promotion names commits and offers branch removal unchecked; Pause/Stop; cleanup retry | FinalizationPanel.tsx:217-230, 409-430, 491-511; decisions/finalization/FinalPromotion.tsx:6-103; packages/domain/src/finalization-stages.ts:6-20 | true |
| 127 | runs list: live first, 50 recent | apps/server/src/services/execution-service.ts:785-809 | new |
| 128 | run page actions: hand-off, View diff, End session, Cancel run, Resolve design questions | features/execution/RunPage.tsx:346-387; app/pages/RunRoute.tsx:34-36 | true |
| 129 | findings grouped open / verified resolutions / withdrawn | features/execution/ReviewFindings.tsx:61-74 | true |
| 130 | activity pane: chips with counts, system hidden, tool output collapsed, follow at bottom, Jump to latest | RunPage.tsx:54-77, 229-260, 545-598 | true |
| 131 | agent text escaped; outcome formats bold and inline code only | features/execution/RunOutcome.tsx:7-36; SourceText.tsx:5 (no `dangerouslySetInnerHTML` anywhere) | true |
| 132 | message box while live | RunPage.tsx:604-630 | new |
| 133 | Roadmaps list: New roadmap, agent defaults link, Active, Finished (closed), Cross-project roadmaps with ZIP ≤ 8 MiB | features/planning/RoadmapsPage.tsx:98-200; ConcurrencyImports.tsx:592-645 | true |
| 134 | board page: scheduler reason, own items, status, mode, shared slots with Manage capacity | RoadmapBoardPage.tsx:459-560 | true |
| 135 | Edit queued entries only for a roadmap without a map, draft/paused/needs-attention | RoadmapBoardPage.tsx:407-418 | true |
| 136 | board (status strip, Gates strip, lanes per map repository or project, selection panel; checkpoints never cards) | features/roadmap-board/RoadmapBoard.tsx:11-31, 233-235; apps/server/src/services/roadmap-board.ts:34-47, 97-122 | true |
| 137 | graph at ≥900px; phone list; board posts and reads nothing | RoadmapBoardPage.tsx:229-232, 605-640; NeighbourhoodGraph.tsx:47-50; decisions/boundary.test.ts:1486-1499 | true |
| 138 | setup checklist steps for a map roadmap; one step at a time; plain roadmap points to editor | features/planning/setup-steps.tsx:4-18; RoadmapBoardPage.tsx:665-753 | true |
| 139 | history: amendments (map) and saved revisions | RoadmapBoardPage.tsx:756-800 | true |
| 140 | map page parts; supervisor until a roadmap supervises the current binding revision | features/planning/ConcurrencyImports.tsx:37-41, 259-560 | true |
| 141 | repositories sections; checks adopted by a person; tools with Refresh models and outside sources | features/execution/RepositoriesPage.tsx:56-260 | true |
| 142 | import: files or ZIP, new or existing project, can leave inactive, three outcomes | features/planning/ImportPlanPage.tsx:96-230; PlanArchiveForm.tsx:225-249; lib/planning-labels.ts:84-88 | true |
| 143 | Settings pages; Notifications and Storage for an owner; rename by owner; capacity panels | features/workspace/SettingsPage.tsx:23-162; app/pages/SettingsRoute.tsx:76-100 | true |
| 144 | stored pre-split Settings links open the holding page | lib/route.ts:32-36, 183-210 | true |
| 145 | Account: Change password, sessions revocable | features/account/AccountPage.tsx:45-111; components/SessionPanel.tsx | true |

### roadmaps.md

| # | Claim | Checked against | Result |
|---|---|---|---|
| 146 | a roadmap refuses an item whose plan has no Repository & branches | apps/server/src/services/roadmap-service.ts:1673 | true |
| 147 | adopted checks gate merges; no adoption → `repository-checks-undeclared` for a roadmap's cycle | packages/domain/src/attention.ts (code); docs/security.md (old) :675-688 | true |
| 148 | entry fields (agents, permissions, instructions, completion limits, exclusion groups in parallel) | packages/domain/src/roadmap.ts:63-79; features/planning/RoadmapEditor.tsx:528-535 | true |
| 149 | sequential: predecessors listed first; outside prerequisites still block | roadmap-service.ts:1696-1712 | true |
| 150 | one delegated roadmap per workspace | roadmap-service.ts:1828-1833 | true |
| 151 | own merge releases dependents; mark-complete stops the queue; completed-before items reused | roadmap-service.ts:3783-3786, 3631-3663 | fixed: old "only operator merges release started prerequisites" (delegated merges also do) |
| 152 | sequential strict order; repository limit 1 incl. manual worktrees and other roadmaps | roadmap-service.ts:2517-2520, 3888-3957 | true |
| 153 | parallel: priority order; limits 2/2 default, 1–16; in-flight counts; tightest shared limit; no duplicate worktree; exclusion groups held until merge or removal | packages/domain/src/roadmap.ts:31-42; packages/contracts/src/roadmap.ts:43-45, 57-60; roadmap-service.ts:3865-3957 | true |
| 154 | limits edited in Settings → Capacity while draft, paused or needs attention; parallel only | roadmap-service.ts:997-1014; features/planning/RoadmapEditor.tsx:315-337 | fixed: old "set maximum in-flight when creating" |
| 155 | mode cannot change with attempts in flight; lowering limits cancels nothing | roadmap-service.ts:1623-1630, 1021 | true |
| 156 | Pause / Resume / Stop / item controls semantics | roadmap-service.ts:1925-1960, 1999-2075, 1813-1827 | true |
| 157 | edit: started entries fixed; revisions on History; branch-settings change stops entries | roadmap-service.ts:1611-1695, 3836-3841; RoadmapBoardPage.tsx:773-800 | fixed: "View revisions" is now History → Saved revisions |
| 158 | drained restart resumes; crash → Resume required after restart | roadmap-service.ts:2244-2257; roadmap-labels.ts:13-17 | fixed: old "Restart requires explicit roadmap resume" |
| 159 | agents: assignment (ADR-064) after permissions save; agents-only change no revision; only when draft/paused/needs-attention; map per settings level | features/planning/RoadmapEditor.tsx:232-262; roadmap-service.ts:510-530; RoadmapBoardPage.tsx:551-565 | true |
| 160 | merge policy manual by default, per-entry override; protected targets; check-definition slices merged by a person | packages/domain/src/roadmap.ts:22-30, 77; apps/server/src/services/branch-service.ts:733-760; docs/security.md (old) :701-708 | true |
| 161 | conflict resolution: three attempts, exact reserved merge | apps/server/src/services/work-cycle-service.ts:4619 | true |
| 162 | refresh: parallel or automatic policy; idle review boundary; limit 3 default, ≤20; `integration-refresh-limit` | work-cycle-service.ts:4130-4160, 4200-4228; packages/contracts/src/roadmap.ts:45 | fixed: old "Conflicts abort the update and require manual attention" (not with conflict delegation) |
| 163 | Change future delegation: map setup, paused, no agents running; operational grant; no plan-acceptance change | roadmap-service.ts:899-958; features/planning/CrossProjectPanel.tsx:641 | true |
| 164 | import ZIP ≤ 8 MiB, own page, starts nothing | ConcurrencyImports.tsx:604-635 | true |
| 165 | adoption of all proposals with rationale; passes no checkpoint | decisions/adoption/MapAdoption.tsx:5-7, 59-72 | true |
| 166 | target selection modes; preview of included/excluded; Create cross-project roadmap | CrossProjectPanel.tsx:95-97, 427-431, 498-527, 1150 | true |
| 167 | plan acceptance generated where the daemon attests, else independent evidence; inputs | apps/server/src/services/plan-acceptance-policy.ts:17-31, 174-183; cross-project-service.ts:308-313 | fixed: old "changing capacity requires renewed saved-plan acceptance" |
| 168 | Start/Resume refuse while acceptance, binding, adoption or pinned environment missing | cross-project-service.ts:373-386; roadmap-service.ts:1835-1858 | true |
| 169 | amendments: proposal pauses; apply/reject with rationale; reuse opt-in; stays paused | apps/server/src/services/map-amendment-service.ts:456-500, 518-530, 690-705; decisions/amendment/AmendmentDecision.tsx:128-421 | true |
| 170 | finalization readiness on History, links to plan | AmendmentDecision.tsx:466-500 | true |
| 171 | controller waits never notify | packages/domain/src/attention.ts:1-11 | true |

(Rows 42–58, 69–73, 98–102 and 104–107 group several claims each and count once per number.)

### False or stale in the old doc

From `docs/ui-principles.md`:
1. :179 "A bare 'Ready', 'Blocked', 'Approved', or 'Verified' never appears" → `ProjectCards.tsx:51,55` render `Ready` and `Blocked` count labels → glossary states the one abbreviation (DOC-03 #7).
2. :16-17 "the type scale starts at 14px" → `--text-xs` 12px and `--text-sm` 13px exist; body is 14px → visual-language.
3. :164-173 merge readiness: 6 labels → the daemon has 13 gate reasons with other wording (`lib/execution-labels.ts:80-94`) → glossary.
4. :79-80 "Navigation between pages appears nowhere else" → bodies link to subjects (UI-15) → information-architecture.
5. :99 "Needs you … is the one place decisions are made" → setup steps and Repositories → Checks host the same decision components; a page renders the decision when no item carries the stop → information-architecture.
6. :103-106 dashboard composition → omitted the Operator wait section → surfaces.
7. :147-150 "A stop the operator owns asks for one of five things" → codes also cover failed runs, lost sessions, storage, moved protected branches → glossary.
8. :149 controller waits "on a dependency, on a resource, or on its own retry" → `ENTRY_WAIT` has more kinds → glossary.
9. :129 "Run … design, implement, review, remediate" → three run roles; remediation is an implement run → glossary.
10. :277-278 "Saved cross-project roadmaps also show occupied/total … slots" → every roadmap's board does (`hostCapacity` always sent) → surfaces.
11. :282-292 guidance and integration conflict recovery "beside the cycle status" → decisions in Needs you (`decisions/cycle`, `decisions/integration`), in place only without an item → information-architecture.
12. :330 "Legacy round setup and existing attempts stay usable" → legacy finalization retired for new starts (R-B10) → dropped.
13. :338 "adoption and Start are separate future actions" → both exist → roadmaps.
14. :364 "project lanes with expandable parent/slice cards" → lanes per map repository; cards are work items, slices are chips → surfaces.
15. :396, :417 design questions and shared decisions "beside the cycle's status" / "cards on both the roadmap and design recovery" → decision components in Needs you and setup → information-architecture.
16. :437 "Changing capacity requires … renewed applicable saved-plan acceptance" → capacity is not a plan-acceptance input (`plan-acceptance-policy.ts:174-183`) → roadmaps.
17. :443-445 "Every operator question names either Shared architecture decisions … or … Continue with guidance" → questions are attention items with their own decision components → dropped.

From `docs/operations.md` "Sequential roadmaps" and "Parallel roadmaps":
18. :566, :613 schema 12 upgrade notes → history → dropped.
19. :578-579 merge from the item's "Merge…" confirmation → the merge is decided in Needs you (`MergeApproval`) → roadmaps.
20. :585, :621 "Cross-project requirements … are not imported" / "does not import the draft cross-project map" → maps are imported → roadmaps.
21. :592, :649 "View revisions" → the roadmap's History → Saved revisions → roadmaps.
22. :604-607 Pushover reminders for roadmap stops → notifications are sent from attention items (ADR-070) → roadmaps (one line).
23. :613-615 limits set when creating → set in Settings → Capacity → roadmaps.
24. :619-620 "only operator merges release started prerequisites" → a delegated integration merge releases too → roadmaps.
25. :627-629 "Conflicts abort the update and require manual attention … No controller performs a final merge" → conflict delegation exists; integration merges may be automatic, promotion never → roadmaps.
26. :644-645 "Restart requires explicit roadmap resume" → a drained restart resumes by itself (ADR-066) → roadmaps.

### Dropped

- Per-slice paragraphs from ui-principles :238-483 not listed above (finalization form internals, cross-project startup, saved-plan acceptance, design recovery, historical baseline, roadmap supervision, execution capacity, controller obligations, agent profile settings, future delegation, decision preparation): each now lives in its decision component's file under `decisions/<kind>/` and its ADR; surfaces.md keeps only page structure, and roadmaps.md the operator's flow. The old text is archived verbatim.
- ui-principles :226-227 merge confirmation wording: component detail of `MergeApproval`.
- operations :599-602 "Git and SQLite still do not form an atomic transaction …": a recovery hint not re-verified against the current reservation code; the reservation rule is in architecture.md.
- operations :637-641 item preparation failure reminders: notifications are from items.

### Code defects

1. `features/planning/RoadmapsPage.tsx:134-141` ("About roadmaps") says "Restarting the daemon requires explicit resume." Since drained restarts (ADR-066) that holds only after a crash. Copy is stale (UX text: see Questions).
2. `lib/planning-labels.ts:4-7` says a bare "Ready" or "Blocked" never appears; `ProjectCards.tsx:51,55` render both. Comment or labels are wrong.
3. `components/WorkspaceShell.tsx:19` says navigation lives in the rail "and nowhere else"; pages link to subjects. Comment overstates.
4. `app/WorkspaceView.tsx:177-187` builds the Projects page header by hand instead of `PageHeader`; cosmetic anatomy bypass.
5. Five source comments still cite `docs/ui-principles.md` (`copy-rules.test.ts:8`, `lib/execution-labels.ts:14`, `lib/planning-labels.ts:6`, `styles/global.css:1899`, `styles/tokens.css:2`) and `global.css:2962` "(ui-principles)": the coordinator re-points them with the split.

### Questions for the operator

1. Project cards' "Ready" and "Blocked" count labels: keep them as the documented abbreviation, or rename to "Ready for admission" and "Dependency-blocked" (a label change on the dashboard and Projects page)? The draft documents current state.
2. The Roadmaps page's About copy (defect 1): correct it to "A drained restart resumes by itself; after a crash, resume explicitly"? A copy change only.
