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

## Claims ledger: docs/security.md (R-I7 part 4)

Checked against the code at `remediation/p3` 3a03927. 189 claims in the new doc, each below with
its evidence: 167 true as carried from the old doc, 13 new and checked, 9 fixed (the old doc said
otherwise). Nine old statements were false or stale (listed after the tables). A few carried
claims were not traced end to end (listed). Paths are repository-relative;
`rs` = `apps/server/src`, `ag` = `packages/agents/src`.

### Intro and threat model

| # | Claim | Checked against | Result |
|---|---|---|---|
| 1 | A signed-in browser can make the daemon start a coding agent with write access | `rs/routes/agent-runs.ts` (launch route, access `editor`), `docs/api-routes.md` | true |
| 2 | The daemon is the only authority over workflow state; the browser submits typed commands | AGENTS.md architectural boundaries; every command declares a body schema (`rs/routes/route-access.ts:141-145`) | true |
| 3 | Nothing an agent writes widens its own authority | Claude `--setting-sources ''` (`ag/claude-code/arguments.ts:26-35`), Codex isolation flags (`ag/codex/isolation.ts:9-18`), Git pinning (`packages/git/src/pinning.ts:150-215`) | new |

### Trust boundaries (table)

| # | Claim | Checked against | Result |
|---|---|---|---|
| 4 | Every test file named in the table exists | `ls` of each path at 3a03927 (the opt-in `sandbox-real.test.ts` left out: it runs only with `CRAFTINGTABLE_REAL_CLAUDE=1`) | new |
| 5 | Services repeat role checks as a second line | e.g. `rs/services/execution-service.ts:1643` (`requireRole` in `mergeWorktree`), `rs/routes/route-access.ts:180-181` comment | true |
| 6 | TLS termination by a proxy is outside the daemon | `rs/config.ts:818-822` (accepts an HTTPS public origin without TLS files) | true |

### Network and the browser origin

| # | Claim | Checked against | Result |
|---|---|---|---|
| 7 | Loopback by default | `rs/config.ts:778` (`?? '127.0.0.1'`) | true |
| 8 | Non-loopback host refused without TLS or an HTTPS public origin | `rs/config.ts:149,782,818-822` | true |
| 9 | TLS cert and key must be set together and absolute | `rs/config.ts:811-817` | true |
| 10 | `Host` must name the public origin's host, a loopback name, or the listen address unless a wildcard | `rs/routes/browser-security.ts:47-77` | true |
| 11 | Refused with 421 before any route runs | `rs/routes/browser-security.ts:81-84` (`onRequest`) | true |
| 12 | CSP: own scripts, styles, fonts, requests, `data:` images, no plugins, base or framing | `rs/routes/browser-security.ts:10-22` | true |
| 13 | Referrer-Policy, X-Frame-Options, nosniff, COOP on every answer | `rs/routes/browser-security.ts:25-31,86-90` | true |
| 14 | Event streams carry them too | `rs/routes/browser-security.ts:37-45`; `rs/routes/agent-runs.ts` (`eventStreamHeaders()`) | true |
| 15 | A route that sets one keeps its own | `rs/routes/browser-security.ts:86-89` (`hasHeader`) | true |
| 16 | Plan files, archives, build records served as `text/plain` attachments under `default-src 'none'; sandbox` | `rs/routes/planning.ts:330-354`, `rs/routes/package-imports.ts:231-233`, `rs/routes/runtime-evidence.ts:89-91` | new |
| 17 | The daemon can serve the built app | `rs/config.ts:825-830` (`CRAFTINGTABLE_WEB_DIST`), `rs/routes/static-web.ts` | true |

### Authentication and sessions

| # | Claim | Checked against | Result |
|---|---|---|---|
| 18 | No registration route | `docs/api-routes.md` (auth routes: login, logout, password, session(s), revoke, step-up) | true |
| 19 | `admin bootstrap` is interactive and refuses a password argument | `rs/cli.ts:33-36,84` | true |
| 20 | Passwords 12–1024 UTF-8 bytes | `rs/security/password-hasher.ts:3-4,10-17` | new |
| 21 | Argon2id | `rs/security/password-hasher.ts:22` | true |
| 22 | Session tokens 32 random bytes, stored as SHA-256 digests | `rs/security/session-tokens.ts:8-19` | true |
| 23 | Each session has its own CSRF token | `rs/services/auth-service.ts` login (`generateCsrfToken`, stored on the session) | true |
| 24 | Cookie HttpOnly, SameSite=Strict, path `/`, Secure on HTTPS origin | `rs/routes/http.ts:69-78`, `rs/config.ts:888` | true |
| 25 | Lifetime 30 days by default (`..._LIFETIME_SECONDS`) | `rs/config.ts:833` (2,592,000 s) | true |
| 26 | Idle end 24 h (`..._IDLE_SECONDS`) | `rs/config.ts:844`, `rs/services/auth-service.ts:189-199` | true |
| 27 | Event streams check the session each iteration without counting as use | `rs/services/run-event-stream-service.ts:42`, `rs/services/workspace-event-stream-service.ts:42` (`touch = false`) | true |
| 28 | A hidden tab reads nothing, so it is signed out after the idle span | `apps/web/src/App.tsx:165-176` (hidden tabs read nothing; a visible tab re-reads Git-derived queries each minute) | fixed: "an open tab reads every minute, so it keeps its session" |
| 29 | Throttle per username and per client address | `rs/services/auth-service.ts:107-112` | true |
| 30 | Five failures in 15 min lock the key for 15 min | `rs/security/login-throttle.ts:42-44` | true |
| 31 | 429, reason `login-rate-limited`, `Retry-After` | `rs/server.ts:231-235` | true |
| 32 | An attempt counts before its password is checked; success takes its count back | `rs/security/login-throttle.ts:57-101` | true |
| 33 | Behind `tailscale serve` the address is the last `X-Forwarded-For` entry from a loopback peer | `rs/routes/request-security.ts:22-37` | true |
| 34 | One audit row per username window, one per lock | `rs/services/auth-service.ts:121-141` | true |
| 35 | At most two checks at once, 32 waiting, more refused | `rs/services/auth-service.ts:46`, `rs/security/login-throttle.ts:144-155` | true |
| 36 | In memory, at most 10,000 keys, a counting key never dropped | `rs/security/login-throttle.ts:45,119-128` | true |
| 37 | Password change needs the current password and revokes every other session | `rs/services/auth-service.ts:233-299` | true |
| 38 | `admin reset-password` is interactive and local; revokes sessions in one transaction | `rs/cli.ts:294-340`, `rs/services/password-reset-service.ts` | true |
| 39 | No web reset route | `docs/api-routes.md` | true |
| 40 | Sign-in and password change recheck credentials after hashing | `rs/services/auth-service.ts:156-160,254-263` | true |
| 41 | Logs redact cookie, authorization, set-cookie | `rs/server.ts:120-124` | true |
| 42 | Audit rows carry no bodies, passwords or tokens | `rs/services/auth-service.ts` audit `metadata` (usernameNormalized, counts only) | true |

### Route access and step-up

| # | Claim | Checked against | Result |
|---|---|---|---|
| 43 | Access values `public`, `session`, `member`/`editor`/`owner`, `installation` | `rs/routes/route-access.ts:18-27` | true |
| 44 | `public` is health and sign-in only | `docs/api-routes.md` (two public routes) | true |
| 45 | Workspace roles only under `/api/workspaces/:workspaceId/` | `rs/routes/route-access.ts:110,130-134` | true |
| 46 | `installation` = owner of every active workspace | `rs/routes/route-access.ts:107,227-228`; `rs/services/workspace-service.ts:279-282` | true |
| 47 | Every command declares tag and body schema | `rs/routes/route-access.ts:141-145` | new |
| 48 | Start refused for no access, viewer mutation, public mutation other than login, missing tag or body | `rs/routes/route-access.ts:123-154,192-199` | fixed: old doc lacked tag and body (R-H5) |
| 49 | `api-routes.md` generated from the route table | `docs/api-routes.md:3`; `apps/server/test/route-inventory.ts` | new |
| 50 | Guard runs before the body is read (`preParsing`) | `rs/routes/route-access.ts:210-229` | true |
| 51 | No session: 401 | `rs/routes/route-access.ts:288-290`; `rs/server.ts` (`UnauthenticatedError` → 401) | true |
| 52 | Command without CSRF header, other origin or cross-site fetch: 403 | `rs/routes/route-access.ts:297-311`; `rs/security/origin-policy.ts:6-14` | true |
| 53 | CSRF header name `x-craftingtable-csrf` | `rs/config.ts` (`CSRF_HEADER_NAME`) | new |
| 54 | Non-member: 404, recorded as denied | `rs/services/workspace-service.ts:255-256,291-294` | true |
| 55 | Below the role, or installation without owning every workspace: 403 | `rs/services/workspace-service.ts:296-298`; `rs/routes/route-access.ts:227-228` | true |
| 56 | Sign-in checks origin and JSON media type before reading the body | `rs/routes/auth.ts:44-55` | new |
| 57 | Guard attaches the caller; handlers use `contextOf` | `rs/routes/route-access.ts:78-86,218` | true |
| 58 | Step-up checked after the body is parsed, before schema validation | `rs/routes/route-access.ts:233-248` (two `preValidation` hooks in that order) | true |
| 59 | Step-up window 10 minutes; `POST /api/auth/step-up` | `rs/services/auth-service.ts:40`; `rs/routes/auth.ts:125` | true |
| 60 | Body with `permissionMode: 'unrestricted'` anywhere, or `unrestricted` in a `permissions` record | `rs/routes/route-access.ts:269-285` | fixed: old doc lacked the `permissions` record (R-E5b) |
| 61 | Control starting/resuming work under stored unrestricted settings (not pause, stop, abandon) | `rs/routes/route-access.ts:251-267`; `rs/routes/roadmaps.ts:374-382`, `rs/routes/work-cycles.ts:283-290`, `rs/routes/finalizations.ts:71-82` | true |
| 62 | Final promotion: finalization `merge`, or a worktree merge into the default branch | `rs/routes/finalizations.ts:71-75`; `rs/routes/execution.ts:427-433` | true |
| 63 | 403 `step-up-required` / `step-up-failed` | `rs/server.ts:243-247` | true |
| 64 | Browser asks once for every command waiting, sends each again; declining leaves the refusal | `apps/web/src/components/StepUpDialog.tsx:5-27`; `apps/web/src/lib/api-client.ts:61-96` | true |
| 65 | A wrong password counts toward the username's lock | `rs/services/auth-service.ts:307-310` | true |
| 66 | Held per session in memory | `rs/services/auth-service.ts:47-51,341-344` | true |
| 67 | Later work under granted settings does not ask again | step-up hooks run only on HTTP commands (`rs/routes/route-access.ts:233-238`) | true |

### What the browser can submit

| # | Claim | Checked against | Result |
|---|---|---|---|
| 68 | No shell command, argv or executable path from the browser | `packages/contracts/src/*.ts` request schemas (no argv/executable request field; `executable` fields are responses at `execution.ts:88,96`) | fixed: old "never … a path the daemon will execute" (SEC-06) |
| 69 | Repository path must be under `CRAFTINGTABLE_REPOSITORY_ROOTS`; unset refuses all | `rs/services/execution-service.ts:466-490`; `rs/config.ts:369-375` | true |
| 70 | Links resolved before Git reads; Git given the resolved path; top level checked again | `rs/services/execution-service.ts:501-508` | true |
| 71 | Registered repositories keep working | `rs/config.ts:45-49` comment; registration is the only call | true |
| 72 | Daemon derives worktree branch and path | `rs/services/execution-service.ts` (`slug`, worktree root) | true |
| 73 | Branch names validated, argument arrays, no rebase or force-push | `rs/services/execution-service.ts:154-166`; no `rebase`/`push` in `packages/git/src` | true |
| 74 | Check adoption takes a ref and expected commit; commands come from `.craftingtable/checks.json` | `packages/contracts/src/repository-checks.ts:56-62,198-207` | new |
| 75 | Cleanup names a preview by id, never a path | `packages/contracts/src/storage-policy.ts:27,69-73` | true |

### Agent processes

| # | Claim | Checked against | Result |
|---|---|---|---|
| 76 | Only `PROCESS_AUTHORITY` modules spawn: process.ts, runner.ts, local-check, pinned-cargo, native-environment | `scripts/check-forbidden-scope.mjs:108-123` (five entries) | true |
| 77 | `check:scope` fails any other production module importing a process capability | `scripts/check-forbidden-scope.mjs:79-91,1294-1305` | true |
| 78 | Every spawn uses argument arrays, `shell: false` | `ag/process.ts:455`, `packages/git/src/runner.ts:184`, `ag/pinned-cargo.ts:294-538`, `ag/native-environment.ts:81` | true |
| 79 | Agent sessions and daemon Git run in their own process group, ended SIGTERM then SIGKILL, bounded output | `ag/process.ts:455-456,486-547`; `packages/git/src/runner.ts:184-207,243` | fixed: old "every spawn … a detached process group" (pinned Cargo's and the native probes' `spawnSync` are not) |
| 80 | Agent env: named base variables, `LC_*` | `ag/child-environment.ts:7-34` | true |
| 81 | Proxy and CA variables | `ag/child-environment.ts:37-47` | true |
| 82 | Vendor login variables (Claude three, Codex three) | `ag/claude-code/backend.ts:49-53`; `ag/codex/session.ts:22` | true |
| 83 | `CRAFTINGTABLE_AGENT_ENV_ALLOW` adds names | `rs/config.ts:434-439`; `ag/child-environment.ts:55-65` | true |
| 84 | Desktop variables, `XDG_RUNTIME_DIR`, SSH agents not passed | `ag/child-environment.ts:1-6` (not in any list) | true |
| 85 | Short private directory `<root>/<12 hex>`, mode 0700 | `rs/services/agent-run-service.ts:194-195,2548-2564` | true |
| 86 | Used by a sandboxed Claude process as its own TMPDIR | `ag/claude-code/backend.ts:143-157` | fixed: old doc implied every run's agent process uses it; Codex does not |
| 87 | Removed at run end; a start removes only run-named directories, never through a link | `rs/services/agent-run-service.ts:211-222` | true |
| 88 | Commands use the run's scratch as TMPDIR, TMP, TEMP | `rs/services/agent-run-service.ts:2093-2097`; Claude `CLAUDE_CODE_TMPDIR` `ag/claude-code/backend.ts:155-157` | true |
| 89 | Process record (pid, start time, boot id, installation device+inode) at `<data>/state/processes/<runId>.json` | `rs/services/agent-run-service.ts:2610-2643`; `rs/config.ts:875` | true |
| 90 | No sandboxed command can read or write it | `rs/config.ts:876-880` (state dir in protected reads); sandbox write lists `ag/claude-code/arguments.ts:76-78`, `ag/codex/arguments.ts:26-43` | true |
| 91 | A `process.json` in the run directory is ignored | `rs/services/agent-run-service.ts:2747` comment and code | true |
| 92 | Reaping rules (boot, start time, leader; leaderless members' session, start, marker) | `ag/process.ts:309-418` | true |
| 93 | Never pid 0/1 or the daemon's own group | `ag/process.ts:331-332,343-344` | true |
| 94 | A record from another installation is left alone and journaled | `rs/services/agent-run-service.ts:2683-2701` | true |
| 95 | Claude loads no settings, MCP, skills, plugins, auto-memory; CLAUDE.md applies | `ag/claude-code/arguments.ts:26-35,138` | true |
| 96 | Codex: plugins, apps, hooks, memories disabled; MCP servers and user skills switched off | `ag/codex/isolation.ts:9-50`; `ag/codex/backend.ts:91-98` | true |
| 97 | Unexpected Codex approval or input requests declined | `ag/codex/session.ts:368-390` | true |

### Agent sandboxes

| # | Claim | Checked against | Result |
|---|---|---|---|
| 98 | `auto`: classifier; commands without asking in the sandbox | `ag/claude-code/arguments.ts:147,169-170` | true |
| 99 | Claude `edit-only`: edits accepted, prompts denied, no commands | `ag/claude-code/arguments.ts:24-25,147,167-168` (`acceptEdits`, `--permission-prompts none`, no auto-allow) | true |
| 100 | Codex runs commands without asking under both | `ag/codex/arguments.ts:15-17,179` | true |
| 101 | `unrestricted`: no checks, no sandbox; needs step-up | `ag/claude-code/arguments.ts:171-172`; `ag/codex/arguments.ts:151,189`; `rs/routes/route-access.ts:269-285` | true |
| 102 | Claude refuses unsandboxed commands and will not start without the sandbox | `ag/claude-code/arguments.ts:144-146` | true |
| 103 | Codex approval policy `never` | `ag/codex/arguments.ts:179` | true |
| 104 | Every posture but unrestricted sandboxes Claude's Bash | `ag/claude-code/arguments.ts:123-125` | true |
| 105 | Claude commands write worktree, run directories, scratch, source caches | `ag/claude-code/arguments.ts:76-78,148-150`; `--add-dir` run directories `:51-53` | true |
| 106 | Git directory deny list | `ag/claude-code/arguments.ts:100-120` | true |
| 107 | Local ports, and no host but the sources' (strict allowlist) | `ag/claude-code/arguments.ts:155-159` | fixed: old "reaching nothing but loopback" (the setting allows local binding; whether host loopback services are reachable was not verified, see below) |
| 108 | Claude's file tools denied the protected paths by permission rules | `ag/claude-code/arguments.ts:127-139` | true |
| 109 | WebFetch/WebSearch not limited, by decision | `rs/` none; `ag/claude-code/arguments.ts` (network rules apply to the sandbox only); register R-G14 | true |
| 110 | Codex profile `craftingtable`, selected on thread and every turn | `ag/codex/arguments.ts:12,143-151,181-188` | true |
| 111 | Codex writes worktree, temp, run dirs, caches; network only the sources' hosts via proxy; none without a source | `ag/codex/arguments.ts:26-43,156-165` | true |
| 112 | Codex Git grants (objects, refs, logs, own Git dir; read-only objects/info, commondir, gitdir) | `ag/codex/arguments.ts:59-75` | true |
| 113 | Granted only when they are the primary checkout's own; none under `worktreeConfig` | `rs/services/agent-run-service.ts:2083-2084`; `ag/codex/arguments.ts:61` | true |
| 114 | Verified with Codex CLI 0.160.0 | `ag/codex/arguments.ts:54,88` comments | true |
| 115 | Shared denied-read list (`sandboxDeniedReads`) and its entries | `ag/sandbox-reads.ts:18-39` | true |
| 116 | For Codex the whole `~/.claude` | `ag/codex/arguments.ts:93-106` | true |
| 117 | Protected paths: database dir, default and configured backup dirs, settings dir | `rs/config.ts:876-880`; `rs/services/storage-service.ts:133-141` | true |
| 118 | More than one existing masked file: refused, `environment-unavailable`; cycle `agent-environment-unavailable` | `ag/codex/arguments.ts:114-133`; `ag/codex/backend.ts:83`; `rs/services/step-outcome.ts:81,462` | true |
| 119 | Outside sources from `outside-sources.json`, read at start | `rs/config.ts` `outsideSourcesSetting`, `:877` | true |
| 120 | Only kind `cargo`: index and static hosts, never the API | `ag/outside-sources.ts:24-30` | true |
| 121 | Caches: `registry` and `git` of the daemon's Cargo home | `ag/outside-sources.ts:37-46`; `rs/services/agent-run-service.ts` (`CARGO_HOME: this.config.cargoHome`) | true |
| 122 | Start refused for an invalid file, one where agents write, a cache over the daemon's files | `rs/config.ts:650-705` | true |
| 123 | Read-only runs get no sources; unrestricted not limited | `ag/outside-sources.ts:98-100`; `ag/codex/arguments.ts:15-17` | true |
| 124 | Journal notes at launch what commands may reach | `ag/outside-sources.ts:88-110` | true |
| 125 | Preparations and investigations run read-only: Claude Read/Glob/Grep, Codex read-only sandbox, escalation denied | `rs/services/agent-run-service.ts:1186-1200,2111-2113`; `ag/claude-code/arguments.ts:38-40`; `ag/codex/arguments.ts:151,189` | true |
| 126 | Investigation worktree compared after the run; `worktree-changed` holds the stop until acknowledged or restored | `rs/services/work-cycle-service.ts:854`; `rs/services/investigation.ts:118`; `rs/services/errors.ts:78` | true |

### The daemon's own Git

| # | Claim | Checked against | Result |
|---|---|---|---|
| 127 | Every daemon Git command runs through `runner.ts` | `scripts/check-forbidden-scope.mjs:114-117`; `packages/git/src/runner.ts` | true |
| 128 | fsmonitor off, hooksPath, excludesFile, attributesFile | `packages/git/src/runner.ts:85-94` | true |
| 129 | Diffs pass `--no-ext-diff --no-textconv` | `packages/git/src/checkpoint.ts:50-51,88-89`; `packages/git/src/resolution.ts:38` | true |
| 130 | Named variables only, C locale, no system configuration | `packages/git/src/runner.ts:45-66` | true |
| 131 | Global config is the identity file with name and email only | `packages/git/src/runner.ts:61,96-115` | true |
| 132 | Replace refs ignored | `packages/git/src/runner.ts:63-64` | new |
| 133 | Git directories named explicitly | `packages/git/src/runner.ts:67-76` | true |
| 134 | Worktree pointer must name an entry of a trusted repository that names it back | `packages/git/src/pinning.ts:206-214` | true |
| 135 | A managed worktree with its own Git directory is refused | `packages/git/src/pinning.ts:186-187,196` | true |
| 136 | A disagreeing `commondir` refused | `packages/git/src/pinning.ts:72-85,200-202` | true |
| 137 | Non-empty `config.worktree` in a managed run's Git directory refused, for its worktree and repository | `packages/git/src/pinning.ts:103-140,206` | true |
| 138 | Fails `untrusted-git-directory` | `packages/git/test/git-directory-pinning.test.ts` | true |
| 139 | No-repository commands not pinned | `packages/git/src/pinning.ts:176-188` | true |
| 140 | `GIT_INDEX_FILE` only when the daemon makes one | `packages/git/src/runner.ts:33,65-66` | true |
| 141 | A repository's own configuration still applies (merge drivers, signing) | `packages/git/src/merge.ts:193-194` | true |
| 142 | Ref watch: branches and tags before and after a run; daemon's own moves excluded | `rs/services/ref-watch.ts:9-46` | true |
| 143 | Journaled, audited `agent-run.protected-ref-moved`, kept in `protected_ref_moves` | `rs/services/agent-run-service.ts:567`; `packages/storage/migrations/0035-protected-ref-flags.sql:5` | true |
| 144 | One inbox item per repository until owner/editor acknowledges exactly the listed moves | `rs/services/attention-projector.ts:526`; `rs/services/attention-service.ts:42-75` | true |
| 145 | A move is never changed or deleted | `packages/storage/migrations/0035-protected-ref-flags.sql:12-26` | true |
| 146 | Snapshots in memory; a restart ends the watch | `rs/services/ref-watch.ts:44-45` | new |

### Checks and builds

| # | Claim | Checked against | Result |
|---|---|---|---|
| 147 | Launchers `ct-check`, `ct-act`, `ct-native`, pinned Cargo's builds leave spool requests | `ag/check-spool.ts:34`; `ag/pinned-cargo.ts:1-3` comment | true |
| 148 | Daemon records receipts only while the run is live | `rs/services/check-request-service.ts:433-434` | true |
| 149 | Spool: no links or FIFOs followed; replies created exclusively | `ag/check-spool.ts:173-176,200` | true |
| 150 | Check unit properties (read-only FS, private /tmp, empty /dev/shm, no network, no new privileges, runtime limit, `env -i`) | `ag/local-check.ts:1029-1092` | true |
| 151 | Runtime dir and Docker/D-Bus sockets hidden; local CI keeps only its Docker socket | `ag/local-check.ts:1094-1109` | fixed: old doc said "no check unit sees the user's runtime directory", without local CI's exception |
| 152 | `CRAFTINGTABLE_CHECK_CONFINEMENT=none` runs plain process groups | `rs/config.ts:440-442,63-68` | true |
| 153 | Private clones and pinned checkouts; unit sees no agent-written root | `ag/local-check.ts:1284,2221-2321` | true |
| 154 | Fresh Cargo home per check, verified local registry, offline | `ag/local-check.ts:2178,2207` | true |
| 155 | Rustup-managed toolchain, `path` refused, wrappers cleared | `ag/local-check.ts:1486-1551` | true |
| 156 | Adoption only by a person, at an exact commit | `packages/contracts/src/repository-checks.ts:202-207`; `rs/services/repository-checks-service.ts` | true |
| 157 | Definition-changing slice merged only by a person approving by digest; a roadmap never merges it | `rs/services/execution-service.ts:264-330` (delegated → `CheckAdoptionRequiredError`) | true |
| 158 | Check-only manifest, one launcher `ct-check`, others refused | `rs/services/runtime-evidence-service.ts:2693-2751`; `ag/local-check.ts:2145-2158` | true |
| 159 | Any merge needs daemon-recorded receipts of each adopted check; a review without the adoption refused | `rs/services/runtime-evidence-service.ts:2780-2813` | true |
| 160 | No adoption: a roadmap's cycle stops as `repository-checks-undeclared` | `rs/services/runtime-evidence-service.ts:2708-2715`; `rs/services/work-cycle-service.ts:2361` | true |
| 161 | act: refuses container, services, reusable workflow, docker:// steps; daemon-owned HOME and cwd | `ag/local-check.ts:341-365,814,975` | true |
| 162 | Native unit bounded in CPU, memory, tasks, time | `ag/native-environment.ts:48-68` | true |

(Two further claims in this section, the pinned exports' refusals and the native approval's
binding, are carried unchanged from the old doc's R-G13 and ADR-054 paragraphs; spot-checked by
ADR text only, not traced in code. Counted under "not traced" below.)

### Merge and promotion authority, Delegated work, Untrusted input, Credentials, Outbound, Storage

| # | Claim | Checked against | Result |
|---|---|---|---|
| M1 | Mergeable only with nothing live and a finished review for the current version and target (investigations aside) | `rs/services/execution-service.ts:111-152` | true |
| M2 | Merge rechecks, verifies commits, reserves an operation; commit built without a worktree; CAS or fast-forward; moved or checked-out target refused | `packages/git/src/merge.ts:193-274,406-508` | true |
| M3 | Protected automatic targets: main, master, all registered defaults, plan protected branches, finalization destinations | `rs/services/branch-service.ts:733-765` | true |
| M4 | Resolution: HEAD, MERGE_HEAD, index, tree, no untracked files; abort only the recorded merge | `packages/git/src/resolution.ts:35-64,160-175,200-212` | true |
| M5 | Final promotion needs a session and no delegation | `rs/services/execution-service.ts:1754-1757` | true |
| M6 | Plan checkpoint recognized by `mapCapabilities`, attested only for known obligations | `packages/domain/src/map-capabilities.ts:18-33,160-176,282-289`; `rs/services/plan-acceptance-policy.ts:10-24` | fixed: old "the supported `STACK-PLAN-ACCEPTED` setup contract" |
| M7 | Upload cannot carry server-only markers | `packages/contracts/src/runtime-evidence.ts:84-` (strict request) vs `:232-249` (stored record) | true |
| D1 | Background work acts as the recorded delegator, rechecked each pass | `rs/services/roadmap-service.ts:2342-2350` | true |
| D2 | Controller reviews: saved delegation; unowned cycle's security review authorized by its starter; owned without delegation authorizes none | `rs/services/workflow-policy.ts:42-65` | true |
| D3 | Assignment carries backend, model, effort only; only while paused | `packages/contracts/src/agent-profiles.ts:14-17,97-101`; `rs/services/roadmap-service.ts:516-523` | new |
| D4 | Preparation grant only while paused; grantor rechecked | `rs/services/roadmap-service.ts:885-891,1521-1529` | true |
| D5 | Map adoption needs binding, every proposal, rationale | `packages/contracts/src/cross-project.ts:69-73`; `rs/services/map-adoption-policy.ts:31` | true |
| D6 | Amendment needs current version and exact impact digest | `rs/services/map-amendment-service.ts:521` | true |
| U1 | YAML caps | `packages/planning/src/limits.ts:20-24` | true |
| U2 | ZIP limits and refusals | `packages/planning/src/archive.ts:60-178` | new (numbers) |
| U3 | No `dangerouslySetInnerHTML` | `apps/web/src/features/planning/SourceText.tsx:5`; grep of `apps/web/src` | true |
| U4 | `VERDICT:` must agree with the report | `rs/services/review-report.ts:70` | true |
| C1 | Credentials file 0600 in a 0700 directory, written whole and renamed | `rs/security/credential-file.ts:46-93` | true |
| C2 | Development daemon uses `craftingtable-dev` | `rs/dev-defaults.ts:8-21` | true |
| C3 | Credentials in the database move to the file at start | `rs/composition.ts:538` | true |
| C4 | Database 0600, directories 0700 | `packages/storage/src/database.ts:37-61`; `rs/services/storage-service.ts:822-829` | true |
| C5 | One pre-migration copy; others over 14 days go, never the newest | `packages/storage/src/migrations.ts:200-240` | true |
| O1 | Pushover: fixed endpoint, redirects refused, 10 s, bounded response | `rs/services/notification-transport.ts:25-28,86` | true |
| O2 | Owners only; delivery rechecks the configuring owner | `rs/services/notification-service.ts:163,374-378` | true |
| O3 | crates.io index: redirects refused, timeout, 500 per ten minutes | `rs/services/crate-checksums.ts:54-59,128-132` | true |
| O4 | No other daemon `fetch` | grep of `apps/server/src`, `packages/*/src` | true |
| S1 | Storage routes need `installation` | `docs/api-routes.md:137-139` | true |

### False or stale in the old doc

1. **"Claude runs have no OS sandbox, so for them the database itself stays writable by the agent
   until R-G5's sandbox increment"** (old 696-697). Claude's Bash has run in Claude Code's OS
   sandbox since R-G5 (`ag/claude-code/arguments.ts:122-161`), the database directory is a denied
   read, and nothing of `<data>/state` is writable. Fixed in *Agent sandboxes*.
2. **Credentials "omitted from … spawned-agent environments"** (old 339-340, AGT-17), framed when
   agents inherited the whole desktop environment. Agents now start from a named allowlist
   (`ag/child-environment.ts:7-65`), and the credentials live in a file the sandboxes deny. Fixed in
   *Agent processes* and *Credentials and stored secrets*.
3. **"The browser never submits … a path the daemon will execute"** (old 97, SEC-06). The browser
   submits a repository path the daemon runs Git in; it is now bounded by
   `CRAFTINGTABLE_REPOSITORY_ROOTS`. Rewritten as "no shell command, argument vector or executable
   path", with repository paths listed under their roots rule.
4. **"For the supported `STACK-PLAN-ACCEPTED` setup contract"** (old 609). The literal is gone from
   production code; the plan checkpoint is whichever one the map declares, recognized by
   `mapCapabilities` (R-F2), and attested only when its obligations are the known ones. Fixed under
   *Merge and promotion authority*.
5. **"A cycle … never resumes automatically after restart"** (old 311), **"restart … still requires
   explicit Resume"** (old 377-378) and **"restart never silently resumes agents"** (old 580). A
   drained restart resumes running cycles and roadmaps and each interrupted step's vendor session
   (ADR-066, `rs/services/restart-resume.ts`); only a crash or an undrained stop waits. Dropped from
   security.md (workflow, not a boundary); the current rule is in architecture.md and operations.md.
6. **"An open tab reads every minute, so it keeps its session"** (old 79-80). Only a visible tab
   re-reads its Git-derived queries each minute; a hidden tab reads nothing, and streams do not
   count as use. Fixed.
7. **"Every spawn uses argument arrays with `shell: false`, a detached process group … and bounded
   output"** (old 119-120). Pinned Cargo's and the native probes' `spawnSync` calls are argument
   arrays but not detached groups. Narrowed to agent sessions and daemon Git.
8. **"Each run's agent process … `<data>/t/<12 hex>`"** (old 255-258). Only a sandboxed Claude
   process uses that directory as its TMPDIR; Codex's does not. Narrowed.
9. **Claude commands "reaching nothing but loopback and the outside sources' hosts"** (old 263).
   The setting is `allowLocalBinding` plus a strict domain allowlist; the doc now says what the
   settings say ("may listen on local ports and reach no host but the sources'"). Not verified:
   whether a sandboxed command can connect to a service on the host's loopback (Claude Code's
   Linux sandbox runs commands in a network namespace; not testable without the real CLI).

Also corrected in passing: the old "No check unit sees the user's runtime directory" omitted local
CI's Docker socket (`ag/local-check.ts:1094-1109`); route declarations now include R-H5's tag and
body schema; the step-up body check covers R-E5b's `permissions` record.

### Not traced end to end

Carried from the old doc and the ADRs without tracing every line of code: the pinned-export
refusals (links, submodules, unsafe names, oversized trees; R-G13), the native approval's binding
(ADR-054), checkpoint commits' content binding (ADR-031), what a push carries (old Pushover
section), agent output truncation before storage, and the storage roots' device pinning (ADR-034).

### Dropped

- **Per-ADR workflow paragraphs** (old 473-757), not security boundaries; each is in its ADR:
  background completion recovery (ADR-037), nit deferrals (ADR-038, retired), finalization agent
  changes (ADR-040), integration branch removal (ADR-041), stage-by-stage finalization rules
  (ADR-042), local runtime discovery and dependency refresh mechanics (ADR-058), candidate
  checkpoint preparation detail (ADR-060), historical baseline preparation (ADR-052), design
  recovery (ADR-051), scope-recovery delegation detail (ADR-056, ADR-057), operator-designated
  reviewer responsibilities (ADR-048), Kata service detail (ADR-054), planning amendment mechanics
  beyond the authority rule (ADR-049). The authority rule each carried is kept once, in *Merge and
  promotion authority* or *Delegated work*.
- **Integration refresh and paused-cycle refresh rules** (old 380-395; ADR-030, R-C4, R-C5):
  scheduling behaviour; the authority (the delegator, rechecked) is kept in *Delegated work*.
- **History**: "Until R-G14, `auto` let Codex's own reviewer approve…", "since R-G13's second/fourth
  increment", "since R-G4 (2026-09-28)", dated operator-decision annotations. Current state only.
- **Operational detail moved to operations.md**: the outside sources file format and rules, the
  Cargo home's seeding and crates.io index caching, Pushover setup, check logs' location, Claude
  Code's `claude-<uid>` socket directory detail.
- **Storage cleanup eligibility** (old 460-470: Cargo cache markers, 30-day expiry): retention
  policy, in operations.md and ADR-034/ADR-039; the deletion boundary is kept.
- **Model-only roadmap updates** (old 748-757): replaced by the current assignment rule (R-E5b,
  ADR-064) in *Delegated work*.

### Code defects

1. **Read-only Codex runs have no denied reads** (MEDIUM). A decision preparation or a question
   stop's investigation on Codex runs in Codex's `read-only` sandbox with no permission profile
   (`ag/codex/arguments.ts:15-17,145-151,186-189`; asserted by
   `packages/agents/test/codex/arguments.test.ts:159`), so its commands can read the daemon's
   database, backups, the credentials file and the operator's `~/.ssh`, `~/.aws` and the like, and
   the model sees what they print. A Claude read-only run is protected (no Bash; its Read tool is
   denied the protected paths, `ag/claude-code/arguments.ts:127-139`). Fixing it changes an agent
   sandbox, so it is the operator's call (see Questions). Recorded in security.md's Known limits.
2. **Stale path in a test comment** (LOW). `packages/agents/test/claude-code/sandbox-real.test.ts:16`
   tells the reader to run `packages/agents/src/claude-code/sandbox-real.test.ts`; the test lives
   under `test/`.
3. **Native environment probes inherit the daemon's whole environment** (LOW, observation).
   `ag/native-environment.ts:78-80` spawns the fixed version probes with `{ ...process.env }`
   rather than the named allowlist the agents get. The commands are fixed (no agent input), so
   this is drift from the "named variables only" rule rather than an exposure.

### Questions for the operator

1. Should read-only Codex runs get a read-only permission profile that carries the shared denied
   reads (code defect 1)? It changes what a decision preparation or investigation can read, and
   needs Codex's read-only profile form to be verified against CLI 0.160.0 first.
2. The session cookie still has no `__Host-` prefix (SEC-04 recommended it). Adopting it renames
   the cookie, which signs everyone out once at deploy. Listed as a known limit; adopt or leave?
