# PERF — Browser performance, data fetching, projection model and read-endpoint cost

Reviewer area: browser refresh model (`apps/web/src/App.tsx`, `apps/web/src/lib/*`), every
polling/refreshing component, the workspace-event → invalidation mapping, render patterns of the
large pages, and the cost of the server GET/preview endpoints those pages call.

Evidence base:
- Code reading at HEAD `bf08c0b` (clean tree at review start).
- Live DB read-only queries (`workspace_events`, table sizes), and a **copy** of the live DB
  ((review-session analysis script, not retained)) used for timing.
- An in-process timing harness ((review-session analysis script, not retained), run with
  `pnpm exec vitest run --config (review-session analysis script, not retained)): it builds the real
  Fastify app via `createServices` + `buildServer` against the DB copy (workers disabled,
  `gitOperations: null`, no agent backends), logs in with a test password hash written into the
  copy, and times each endpoint with `app.inject` (6 calls, first + warm median). It also
  JSON+Zod-parses the bodies (browser-parse proxy) and CPU-profiles the heaviest service calls via
  `node:inspector`. Numbers are from this desktop (Node 24), warm, single request, no concurrent
  load; **git-backed endpoints were not timed** (git disabled), their git fan-out is counted from code.
- The live HTTP API was never called. Nothing in the repository was modified.

Live data scale at review time: 1 workspace, 80 work items, 308 runs, 46,446 run events (485 MB,
mostly `agent_run_events`), 51 cycles, 4 roadmaps (the active one has **171 entries, 25 attempts,
248 KB state, 11 definition revisions totalling 2.0 MB**), 33 evidence submissions (avg 152 KB,
max 519 KB), 3,289 workspace events over 18.3 days.

## Summary

- **Every workspace event triggers a full, scope-agnostic refetch of the current page.** The
  projection reducer computes stale scopes (project/work-item/repository IDs) but `App.tsx` ignores
  them and bumps one global `refreshToken`; that token re-runs snapshot + audit + workspace list +
  **all cycles** + the route's detail loads + every child panel wired to `refreshToken`
  (PERF-01).
- **The 200 ms fixed batching window does not coalesce real transitions.** Measured on the live
  journal: 73 % of all events start their own refresh round (2,389 rounds for 3,289 events). A
  "run finishes → next run starts" transition emits a median **5 events / 4 refresh rounds** (p90
  13 / 10) spread over a median 5.2 s. There is no single-flight or request abort, so overlapping
  rounds queue duplicate server work (PERF-02).
- **The invalidation map is simultaneously over- and under-inclusive.** `notifications-changed`
  (24 % of all events; 494 of them are delivery bookkeeping) forces a full page refetch although no
  refetched data depends on it, while the panels that *do* show roadmap, runtime-evidence, capacity
  and notification state ignore events and either poll (3 s / 5 s) or never refresh (PERF-03,
  PERF-13).
- **Several read endpoints are expensive synchronous CPU on the daemon's single event loop**, which
  also runs the controller workers and SSE streams: `execution-scopes` **~405 ms** (fetched twice
  per round on a work-item page), `cross-project preview` **~190 ms** (polled every 5 s),
  `finalization-readiness` ~166 ms, `roadmaps` **~116 ms / 537 KB** (polled every 3 s), `cycles`
  **~73 ms / 533 KB** (every round, every page), runtime view ~58 ms + git (PERF-04..PERF-08).
- `execution-scopes` is 10× slower than necessary: `scopeChoices` runs on raw storage instead of a
  `mapReadSnapshot`; measured **402 ms → 42 ms** with the memo (PERF-04).
- `/cycles` ships every cycle ever run (46 of 51 completed) with its `designRecovery` blob — 81 % of
  the 533 KB payload — to every page on every round (PERF-05).
- **An open Roadmaps tab alone costs ~7.7 % of the daemon event loop and ~15 MB/min of JSON,
  indefinitely**, even with nothing happening and even when the tab is hidden (PERF-06).
- Git subprocess fan-out on refreshed read paths: ~6 spawns per active worktree per round
  (branch status), 1 + N (completed items) spawns for branch settings on every round *and* every 3 s
  on the plan-version page (PERF-09).
- **Browser render model:** `App.tsx` (1,739 lines) owns ~45 pieces of state; every event
  (two reducer dispatches), every fetch response and a 10 s clock tick re-render the whole page tree;
  there is no `React.memo` anywhere in the app. Heavy trees (RunPage feed, 171-entry roadmap,
  cross-project map) recompute on each of these renders (PERF-10).
- **Run page:** opening the largest run downloads **17.4 MB**, 55 % of which is the unused `raw`
  vendor line on every event, then renders all 2,475 events unvirtualised with 7.3 M characters of
  body text in the DOM, recomputing `JSON.stringify` of every tool input on each App render
  (PERF-11).
- Page freshness is inconsistent: one page mixes event-driven, 3 s-poll, 5 s-poll and load-once
  panels, so after an automated transition parts of the same page update at visibly different
  moments or never (PERF-13) — this is the most plausible concrete source of the operator's
  "page elements react to automated transitions" complaint, together with PERF-07.
- Target: event-scoped invalidation into a small keyed query store (single-flight, SWR, structural
  sharing, visibility-aware), server-computed per-page view models evaluated in one read pass,
  slim list endpoints, ETag+gzip, and removal of all fixed-interval polling except a slow safety
  poll for git-derived state (Remediation direction).

## Map

### Browser data flow today

```text
EventSource /api/workspaces/:id/events?after=N          (lib/use-workspace-event-stream.ts)
  └─ onEvent → dispatch(event-received)                   App.tsx:688-691
        reduceWorkspaceProjection: append to events[100], mark StaleScopes
        (workspace-projection.ts:125-211 — every kind sets workspaceSummary=true or repositoryList)
  └─ effect on projection.stale → dispatch(stale-consumed) + scheduleRefresh()   App.tsx:428-451
        scheduleRefresh: if no timer pending, setTimeout(200ms) → refreshToken++  App.tsx:203-211
  └─ refreshToken is a dependency of:
        (a) snapshot+audit(25)+workspace list, Promise.all       App.tsx:380-422
        (b) GET /cycles (all cycles, every route)               App.tsx:457-473
        (c) route detail loads (see table)                      App.tsx:477-596
        (d) props to child panels: PlanBranchPanel(+RepositoryPolicyPanel), WorktreeBranchPanel,
            ExecutionScopesPanel, ScopeRepairPanel, ScopeReviewRecovery     App.tsx:1321-1581
Run page only: EventSource /runs/:id/events; each run event appended to App state
        (App.tsx:641-657); run-finished/turn-completed/session-started also scheduleRefresh().
Clock: setInterval(setNow, 10 s) re-renders App.                        App.tsx:335-338
Self-polling panels (ignore events): RoadmapsPage GET /roadmaps every 3 s (RoadmapsPage.tsx:129-172);
  CrossProjectPanel POST …/supervision/preview every 5 s (CrossProjectPanel.tsx:163-191);
  FinalizationPanel GET finalizations + branch-settings every 3 s (FinalizationPanel.tsx:78-104);
  NotificationPanel GET notifications every 5 s (NotificationPanel.tsx:26-45).
Load-once panels (never refresh until remount/revision change): RuntimeEvidencePanel
  (RuntimeEvidencePanel.tsx:94-113), MapAmendmentPanel (only on roadmap.version,
  MapAmendmentPanel.tsx:63-68), ConcurrencyImports, HostSchedulingPanel, StoragePanel,
  RoadmapAgentProfilesPanel, RoadmapCapacityPanel, DecisionPreparationPanel.
Every response is Zod-validated in the browser (api-client.ts:40-63). No AbortController, no
  ETag, no cache; server sends `cache-control: no-store` (routes/http.ts:10-12), no compression.
```

### Requests per refresh round, by page (measured server cost on the DB copy)

App-level part on **every** workspace page: snapshot 2.4 ms / 25 KB, audit 1.2 ms / 10.5 KB,
workspaces 1.5 ms / 0.6 KB, cycles 73 ms / 533 KB → **4 requests, ~78 ms sync CPU, ~570 KB**.

| Page | Extra requests per round | Round total (approx.) | Plus continuous polling |
|---|---|---|---|
| Dashboard / Runs | runs (16 ms, 215 KB) | 5 req, ~94 ms, ~785 KB | — |
| Agenda | work-items (5 ms, 32 KB) | 5 req, ~83 ms, ~600 KB | — |
| Roadmaps | none (page ignores events) | 4 req, ~78 ms, ~570 KB | /roadmaps 116 ms+537 KB every 3 s; preview POST 190 ms+361 KB every 5 s per cross-project roadmap; finalization-readiness 166 ms on each roadmap version change |
| Work item | detail, execution, repositories, execution-status, run-profiles, branch-settings (+git), repositories (dup), repository-policy (+git), execution-scopes (405 ms), execution-scopes again via ScopeReviewRecovery when shown (405 ms), scope-repair preview when paused, branch-status per active worktree (6 git spawns each) | **~14-17 req, ~500-950 ms sync CPU, ~650 KB, ≥8 git spawns** | — |
| Run | run detail (brief incl.), work-item execution, execution-status, run-profiles | 8 req, ~85-120 ms, ~600 KB | run SSE also triggers rounds |
| Plan version | plan version, branch-settings (+git 1+N), repositories, repository-policy (+git) | 8 req, ~85 ms + git | finalizations + branch-settings (+git 1+N) every 3 s |
| Project | project, branch-settings (+git), repositories, repository-policy (+git) | 8 req + git | — |
| Settings | execution-status, run-profiles | 6 req, ~80 ms | notifications every 5 s |

Per transition (median 4 rounds, p90 10): a work-item page costs **~2-4 s of blocked daemon event
loop (p90 5-9 s)**; the dashboard ~0.4 s and ~3 MB; the Roadmaps page adds its constant polling.
Each extra open tab multiplies all of this.

### Endpoint cost table (DB copy, warm median, response bytes)

| Endpoint | ms | bytes | Notes |
|---|---|---|---|
| GET /workspaces/:id/work-items/:id/execution-scopes | **408** | 7.6 K | raw storage, no memo (PERF-04) |
| POST …/concurrency-definitions/:id/supervision/preview | **190** | 361 K | map evaluation; polled 5 s |
| GET …/roadmaps/:id/finalization-readiness | 166 | 0.7 K | MapAmendmentPanel |
| GET …/roadmaps | **116** | **537 K** | polled 3 s |
| GET …/cycles | **73** | **533 K** | every round, every page |
| GET …/concurrency-definitions/:id/runtime | 58 + git | — | returned 503 in harness (git disabled) after 58 ms of work |
| GET …/storage | 52 | 2.6 K | settings |
| GET …/runs/:id/event-page?after=0 | 43 | **4.4 M** | 500 events incl. `raw` |
| GET …/work-items/:id/execution | 3-40 | 28-35 K | + git assertReview for mergeable gates |
| GET …/runs | 16 | 215 K | 50 runs, outcomeSummary 73 % of bytes |
| GET …/roadmaps/agent-profiles | 9 | 110 K | |
| snapshot / audit / workspaces / project / plan-version / work-item / repositories / run-profiles / execution-status / branch-settings (git-less part) | 0.3-6 | ≤32 K | cheap |

Browser-side JSON.parse + Zod validation of these bodies in Node: roadmaps 3.9 ms, cycles 3.1 ms,
event-page 8.1 ms, preview 1.5 ms — **validation is not the bottleneck**; rendering and server CPU
are.

CPU profiles (5 iterations each, inclusive time):
- `roadmapService.list` 96 ms/call: `view()` → `complete()`/`milestoneSatisfied` → `acceptedEvidence`
  → `runtimeEvidence.submissions` decode (multi-hundred-KB JSON) and `runtimeInputChanges` →
  `canonicalDefinition` (recursive canonical JSON of whole definitions); `roadmaps.history` decode
  (2 MB of definitions) once per call.
- `workCycleService.list` 59 ms/call vs 1.8 ms raw read: `operatorQuestionRoutes` →
  `workflowContext` and `acceptedEvidence` computed for cycles; `scopeMergeWait` etc. for every
  cycle including completed ones.
- `scopeChoices(storage)` 402 ms/call: `runtimeEvidence.submissions` decode ~115 ms/call self time,
  `imports.definition` decode, `scopeArchitectureDecisions`, `parentAccepted`/`currentScopeReceipt`
  re-evaluated per slice × phase with no memo.
- `crossProject.view` ~180 ms/call: `canonicalDefinition` ~50 ms/call self, `acceptedEvidence`,
  `scopePhaseBlockers`, `milestoneSatisfied`.

### Event volume (live journal)

- 3,289 events / 18.3 days; last 7 days 2,253 events → 1,874 refresh rounds per open page.
- Kinds (last 7 d): notifications-changed 631, agent-run-status-changed 562, work-cycle-changed 422,
  agent-run-started 188, roadmap-changed 178, branches-changed 88, runtime-evidence-changed 73, …
- 201 "run finished → next run of same item started" transitions: events per transition median 5,
  p90 13, max 21; refresh rounds median 4, p90 10, max 17; duration median 5.2 s, p90 46.6 s.
  Example (seq 3248-3254): run `c24cfe20` running→waiting 00:16:46.215, waiting→finished 46.554,
  cycle-changed 49.163, cycle-changed 50.583 (identical payload), cycle-changed 51.059, run
  started 57.063, starting→running 57.596 → **7 events, 7 refresh rounds**, each ≥ 350 ms apart.

### Component sizes (lines)

App.tsx 1,739 · CrossProjectPanel 1,166 · RoadmapsPage 1,091 · RuntimeEvidencePanel 1,064 ·
FinalizationPanel 855 · DelegationPanel 776 · RunPage 648 · SharedDecisionInbox 574 ·
ConcurrencyImports 564 · MapAmendmentPanel 516 · CyclePanel 482. `React.memo`: 0 uses;
`useMemo`: 3 uses in the whole web app. Production bundle: one 768 KB JS chunk, no code splitting.

## Findings

### PERF-01: Every workspace event refetches the whole page; computed stale scopes are ignored
- Severity: high
- Category: performance
- Status: CONFIRMED
- Evidence: `apps/web/src/lib/workspace-projection.ts:125-211` maps every event kind to
  `workspaceSummary: true` (or `repositoryList`) and collects `projectIds`/`workItemIds`/
  `repositoryIds`. `apps/web/src/App.tsx:428-451` only checks *whether* anything is stale, consumes
  it, and calls `scheduleRefresh()`, which increments one global `refreshToken`
  (`App.tsx:203-211`). That token is a dependency of the snapshot/audit/workspace-list load
  (`App.tsx:380-422`), the all-cycles load (`App.tsx:457-473`), every route detail load
  (`App.tsx:477-596`) and seven child panels (`App.tsx:1321, 1351, 1414, 1461, 1473, 1534, 1581`).
  No code reads the IDs in `stale.projectIds`/`workItemIds`; `repositoryIds` is never consumed at
  all. An event about work item A therefore refetches the detail of work item B, the
  audit log, the workspace list, all 51 cycles and 7-10 panel endpoints. Measured per-round cost in
  the Map table (e.g. work-item page ~14-17 requests, ~0.5-0.95 s daemon CPU).
- Impact: every automated step anywhere in the workspace makes the currently viewed page reload
  everything, regardless of relevance; this is the multiplier behind PERF-02/04/05/07/09.
- Recommendation: make invalidation keyed. Replace `refreshToken` with a query store (see
  Remediation direction) where each query declares the event predicates that invalidate it, e.g.
  `workItemDetail(id)` ← `work-item-*`/`worktree-*`/`agent-run-*`/`work-cycle-changed` with
  `event.workItemId === id`; `cycles` ← `work-cycle-changed`; `snapshot` ← only kinds that change
  counts (`work-item-*`, `plan-version-imported`, `agent-run-started/status-changed` for liveRuns);
  `audit` ← only on the dashboard and only when the Audit disclosure is open. Delete the unused
  `repositoryIds` scope or wire it. Keep ADR-003's "event is an invalidation signal" semantics.
- Effort: M
- Related: PERF-02, PERF-03, PERF-12, PERF-14
- Plan/roadmap format impact: none

### PERF-02: Batching does not coalesce transitions; no single-flight, so rounds overlap and queue server work
- Severity: high
- Category: performance
- Status: CONFIRMED
- Evidence: `App.tsx:203-211` fixed 200 ms window starting at the first event. Live journal
  analysis (script over `workspace_events`): 3,289 events → 2,389 rounds (73 % of events start
  their own round); 201 run→next-run transitions: median 5 events / 4 rounds, p90 13 / 10, max
  21 / 17; real inter-event gaps are 0.3-6 s (Map, "Event volume"). The unit test that justifies
  the window uses events 50 ms apart (`App.test.tsx:389-421`), unrepresentative of production.
  Cancellation only discards results (`canceled` flags, e.g. `App.tsx:384, 418-420, 593-595`);
  there is no `AbortController` anywhere in `apps/web/src`, so when a round fires while the previous
  round's 400 ms `execution-scopes` requests are still being computed, the daemon computes both.
  Run-stream events additionally schedule rounds on the run page (`App.tsx:648-654`).
- Impact: per transition the browser performs 4-10 full-page reloads; with PERF-04 on a work-item
  page this is 2-9 s of blocked daemon time per transition, per tab.
- Recommendation: (1) single-flight per query key: at most one request in flight per key; an
  invalidation during flight sets `dirty` and triggers exactly one follow-up fetch when it lands.
  (2) Replace the fixed window with trailing debounce + max-wait (e.g. 400 ms debounce, 2 s
  max-wait) for background invalidations; keep immediate refetch after the operator's own command.
  (3) Abort superseded requests with `AbortController` (server work still happens, but response
  parsing and state churn stop; pair with PERF-04/05 server fixes). (4) Add a test that replays a
  real transition's event timings (e.g. seq 3248-3254) and asserts request counts per key.
- Effort: S (debounce/single-flight in current App) / M (as part of the query store)
- Related: PERF-01, PERF-17, controller event granularity (PERF-18)
- Plan/roadmap format impact: none

### PERF-03: Invalidation map is wrong in both directions (notifications storms, stale roadmap/evidence panels)
- Severity: high
- Category: performance
- Status: CONFIRMED
- Evidence: `workspace-projection.ts:175-178` maps `roadmap-changed`, `notifications-changed` and
  `workspace-updated` to `workspaceSummary: true`; `:166-167` does the same for
  `runtime-evidence-changed`. The snapshot (`apps/server/src/services/workspace-service.ts:190-229`)
  contains no notification, roadmap or runtime-evidence data. Live counts: notifications-changed is
  792 / 3,289 events (24 %); payload actions: delivery 494, attention 296. Conversely the consumers
  of that data ignore events: `RoadmapsPage` polls (`RoadmapsPage.tsx:167`), `CrossProjectPanel`
  polls (`CrossProjectPanel.tsx:186`), `NotificationPanel` polls (`NotificationPanel.tsx:39`),
  `RuntimeEvidencePanel` reloads only on binding/roadmap *revision* change or a window
  CustomEvent (`RuntimeEvidencePanel.tsx:94-113`), so evidence recorded by automation
  (`runtime-evidence-changed`, 73 events/7 d) is not shown until navigation.
- Impact: a quarter of all full-page refetches are caused by notification bookkeeping that changes
  nothing visible; meanwhile roadmap/evidence panels lag by 3-5 s or indefinitely after the events
  that describe exactly their data.
- Recommendation: rewrite the event→query mapping as an explicit table next to the query
  definitions (one place, unit-tested): `notifications-changed` → `notifications` only (and
  `attention` if/when the shell shows notification state); `roadmap-changed` → `roadmaps`,
  `roadmap(id)`, `crossProjectPreview(def)`; `runtime-evidence-changed`/`scope-evidence-recorded`
  → `runtimeView(def)`, `crossProjectPreview(def)`, `executionScopes(workItemId)`. Consider
  server-side: stop emitting a browser-visible event for pure delivery bookkeeping
  (`action: 'delivery'`) or tag it so the browser can ignore it (coordinate with the
  notifications reviewer; ADR-027 says delivery wakes browser streams on purpose).
- Effort: S
- Related: PERF-01, PERF-06, PERF-13
- Plan/roadmap format impact: none

### PERF-04: `execution-scopes` costs ~405 ms of synchronous CPU and is fetched twice per round
- Severity: high
- Category: performance
- Status: CONFIRMED
- Evidence: `apps/server/src/services/execution-service.ts:477-481` calls
  `scopeChoices(this.storage, …)` on raw storage, not `mapReadSnapshot(this.storage)`. Harness:
  `scopeChoices(storage)` median **401.7 ms**, `scopeChoices(mapReadSnapshot(storage))` **42.3 ms**;
  HTTP median 408 ms (WI `eb081f20…`) and 402 ms (WI `6cb749cd…`) for 7.6 KB responses. Profile:
  `runtimeEvidence.submissions` decode (~115 ms/call self; submissions average 152 KB each),
  `imports.definition` decode, `scopeArchitectureDecisions`, `parentAccepted`/`currentScopeReceipt`
  recomputed per slice × phase (`execution-scope.ts:465-560` calls `scopePhaseBlockers` for each of
  3 phases per slice plus `scopeBlockers`). Browser: `ExecutionScopesPanel.tsx:49-61` and
  `ScopeReviewRecovery.tsx:23-42` both fetch the same endpoint on every `refreshToken`; the latter
  also on `cycle.version`. `RoadmapsPage.tsx:98-115` fetches it when choosing an item.
- Impact: ~0.8 s of blocked daemon event loop per refresh round on a work-item page (during which
  SSE, other requests and controller workers wait); multiplied by 4-10 rounds per transition.
- Recommendation: wrap in `mapReadSnapshot` (one-line change, 10× measured); additionally
  memoize per-subject results inside `scopeChoices` (`acceptedEvidence`, `scopeArchitectureDecisions`
  per (definition, binding, subject)); make `runtimeEvidence.submissions` return light rows
  (id/subject/status/digest) and decode the full record only when needed. Browser: fetch once per
  work item (lift into the work-item view model, PERF-14) and pass to both panels. Add a perf
  regression test asserting `scopeChoices` over a fixture with a large definition stays under a
  budget, or at least that it is invoked with a snapshot.
- Effort: S (memo) / M (submission row slimming)
- Related: PERF-07, PERF-08, PERF-14
- Plan/roadmap format impact: none

### PERF-05: `/cycles` sends every historical cycle with its design-recovery blob to every page, every round
- Severity: high
- Category: performance
- Status: CONFIRMED
- Evidence: `App.tsx:457-473` loads `loadWorkCycles` on every `refreshToken` regardless of route.
  `apps/server/src/services/work-cycle-service.ts:135-160` returns all cycles of the workspace and
  computes `automatedScopeRecoveryWait`/`scopeReviewWait`/`scopeMergeWait`/`effectiveCycleProfiles`
  (and `operatorQuestionRoutes` for needs-attention slices) for each. Live data: 51 cycles, 46
  `completed`, 1 `stopped`; response **533 KB**, **73 ms** (service 59 ms vs 1.8 ms raw read).
  Field sizes over all cycles: `designRecovery` 420 KB of ~516 KB state. Browser uses: attention
  strip/count (`AttentionStrip`, `WorkspaceShell attentionCount` — needs only waiting cycles), the
  current work item's cycles (`App.tsx:1487`), and run-page provider recovery (`App.tsx:1608-1614`).
- Impact: ~570 KB and ~78 ms of daemon CPU per round on *every* page, including pages that show no
  cycle detail; grows linearly with history (every finished cycle stays in the payload forever).
- Recommendation: split into (a) `GET /workspaces/:id/attention` — slim list of non-terminal cycles
  needing the operator (id, workItemId, planVersionId, status, step, reason, worktreeId,
  currentRunId, providerRecovery flag) — used by the shell; (b) cycles of one work item, full
  detail, as part of the work-item view (PERF-14). Exclude `completed`/`stopped` cycles by default;
  compute the derived wait/route fields only for non-terminal cycles; send `designRecovery` only
  in the per-item detail.
- Effort: S-M
- Related: PERF-01, PERF-14, UI unification (attention surfaces)
- Plan/roadmap format impact: none

### PERF-06: Roadmaps page polls ~900 KB every 3-5 s forever (≈7.7 % of the daemon, ≈15 MB/min per tab)
- Severity: high
- Category: performance
- Status: CONFIRMED (cost measured on the DB copy; per-minute totals computed from it)
- Evidence: `RoadmapsPage.tsx:129-172` `setInterval(refresh, 3000)` → `GET /roadmaps` (116 ms,
  537 KB: full `roadmap` state incl. 171-entry definition + attempts + per-entry progress, for all 4
  roadmaps including 3 completed). `CrossProjectPanel.tsx:163-191` `setInterval(load, 5000)` →
  **POST** `…/supervision/preview` with CSRF (190 ms, 361 KB). Neither checks `document.hidden`
  (no `visibilitychange` handling anywhere in `apps/web/src`), neither compares the new response to
  the old before `setState`, so each poll re-renders the full page (PERF-10). Per minute:
  20 × 537 KB + 12 × 361 KB ≈ 15 MB of uncompressed JSON; 20 × 116 + 12 × 190 ≈ 4.6 s of synchronous
  daemon CPU (≈7.7 %). `MapAmendmentPanel.tsx:63-68` additionally refetches amendments +
  `finalization-readiness` (166 ms) whenever the polled `roadmap.version` changes.
  `CrossProjectPanel.tsx:137-162` and `RoadmapsPage.tsx:148-165` each also fetch execution-status
  and run-profiles independently.
- Impact: constant load on the same process that runs the controller; over Tailscale the laptop
  continuously downloads and re-renders the largest page of the app even when idle or backgrounded.
- Recommendation: remove both intervals; invalidate `roadmaps` on `roadmap-changed`,
  `work-cycle-changed` (for items bound to the roadmap), `worktree-merged`, `scope-evidence-recorded`,
  `runtime-evidence-changed`, and `crossProjectPreview` on the same set. Keep one slow safety
  refresh (60 s, visible tab only) for git/time-derived state. Server: split `GET /roadmaps` into a
  light list (id, name, status, counts, attention) and `GET /roadmaps/:id/progress` (progress only,
  no definition); serve the definition by revision (immutable, cacheable with ETag). Make preview a
  GET (it is a read; `crossProjectState` has no side effects) so it can be cached/ETagged; if it
  must remain POST for body size, keep it but stop polling it.
- Effort: M
- Related: PERF-03, PERF-08, PERF-10, PERF-13, PERF-16
- Plan/roadmap format impact: none (read-model split only; definitions unchanged)

### PERF-07: Browser refetch storms run on the controller's event loop (UI load slows automation and vice versa)
- Severity: high
- Category: architecture
- Status: CONFIRMED (mechanism); HYPOTHESIS (magnitude of controller delay in production)
- Evidence: all services and workers are composed in one Node process (`apps/server/src/composition.ts`;
  workers started in `server.ts:115-119` `onReady`); storage is synchronous better-sqlite3; the
  heavy handlers above are fully synchronous CPU (profiles show no awaits in `scopeChoices`,
  `roadmapService.view`, `crossProjectState`, `workCycleService.list`). While a 400 ms
  `execution-scopes` or 190 ms preview executes, no SSE frame is written, no other request is
  answered, and roadmap/cycle/notification worker ticks wait. The architecture notes that map
  projections deliberately recompute per read pass (`docs/architecture.md:210-213`), so the worker
  and every page recompute the same evaluation independently.
- Impact: the operator's "UI slowness during automated transitions" is plausibly a feedback loop:
  a transition emits events → each open tab issues its whole-page refetch (0.1-0.95 s CPU per
  round) → event delivery and the next controller step are delayed → more, later events. Two tabs
  (e.g. laptop + desktop) double it.
- Recommendation: (1) cut the per-round cost first (PERF-01/04/05/06); (2) add request timing
  logs (Fastify `onResponse` with duration, route, bytes) and an event-loop-delay histogram
  (`perf_hooks.monitorEventLoopDelay`) exposed on a diagnostics endpoint, so the claim can be
  measured on the live daemon; (3) longer term, compute map-derived projections once per
  "workflow generation" and share them between worker and readers (see Remediation direction,
  phase 3) rather than re-evaluating in each request.
- Effort: S (instrumentation) / L (shared projection)
- Related: controller reviewer (worker ticks, full map evaluation), PERF-04/05/06/08
- Plan/roadmap format impact: none

### PERF-08: Map-evaluation hot spots in roadmap view, cycles list and cross-project preview
- Severity: medium
- Category: performance
- Status: CONFIRMED
- Evidence (CPU profiles on the DB copy): `roadmapService.list` 96 ms — `RoadmapService.list`
  (`roadmap-service.ts:87-90`) creates a fresh `mapReadSnapshot` per roadmap in `view()`
  (`:2069-2070`), so nothing is shared across the 4 roadmaps; hot: `acceptedEvidence` →
  `runtimeEvidence.submissions` decode, `runtimeInputChanges` → `equal` →
  `canonicalDefinition` (`apps/server/src/services/runtime-input-policy.ts:7`,
  `packages/domain/src/concurrency-amendment.ts:3-9`, recursive canonical stringify of whole
  generations), `roadmaps.history` decoding 2 MB of definitions to find the attempt revision
  (`roadmap-service.ts:2183-2190`). `crossProject.view` ~180 ms with `canonicalDefinition` ~50 ms self per call.
  `workCycleService.list` 59 ms of derived work vs 1.8 ms raw read. Evidence submissions are stored
  as single JSON records averaging 152 KB (max 519 KB) and are fully decoded for status checks.
- Impact: these costs are paid on every poll/round (PERF-05/06) and in the controller's own ticks.
- Recommendation: (a) one `mapReadSnapshot` for the whole `list()` call; (b) memoize
  `canonicalDefinition` results per object identity (WeakMap) or compare stored digests instead of
  canonicalising at read time — generations are immutable, so persist a canonical digest at write
  and compare digests; (c) `roadmaps.history` → a `definitionRevision(roadmapId, revision)` lookup
  or only decode the needed revision; (d) split evidence submissions into a light index row and a
  lazily-decoded body; (e) skip derived computations for terminal cycles.
- Effort: M
- Related: PERF-04, PERF-05, PERF-06, PERF-07
- Plan/roadmap format impact: none (storage of digests is additive; plan/roadmap files unchanged)

### PERF-09: Git subprocess fan-out on refreshed read paths
- Severity: medium
- Category: performance
- Status: CONFIRMED (counts from code; latency not measured because git was disabled in the harness)
- Evidence: `branch-service.ts:113-167` `settings()` runs `resolveBranch` plus one
  `isAncestor` per completed work item of the plan version (live: 14 completed items in plan
  `3d8a857d…` → 15 spawns), and `listBranches` when an integration branch was removed. It is called
  by `PlanBranchPanel` on every round (`PlanBranchPanel.tsx:58-77`, mounted — collapsed or not —
  on project, plan-version and work-item pages) and by `FinalizationPanel` every 3 s
  (`FinalizationPanel.tsx:78-104`). `branch-service.ts:597-640` `status()` → `inspectRepository`
  (4 git calls, `packages/git/src/operations.ts` inspectRepository) + `resolveBranch` +
  `isAncestor` = 6 spawns per active worktree per round (`WorktreeBranchPanel.tsx:32-46`, one per
  active worktree in `DelegationPanel`). `RepositoryPolicyPanel.tsx:40-52` → `policyEvidence` (git)
  per round. Work-item execution runs `assertReview` (git) for each mergeable gate
  (`execution-service.ts` merge-gate loop). Runtime view: `pinStatus` → `resolveCommit` per pin
  (`runtime-evidence-service.ts:767-797`).
- Impact: dozens of short-lived git processes per transition per open page, competing with agent
  worktrees for CPU and I/O; `git status` on large worktrees is not cheap.
- Recommendation: cache git-derived facts per (repository, ref) with the ref's resolved SHA as the
  key and a short TTL (e.g. 5 s) inside the git adapter or branch service; compute the
  "recorded merge absent from integration branch" check once per integration-branch head SHA
  (cache by head SHA — the answer cannot change until the head moves); only fetch branch status for
  worktrees whose section is expanded; stop the 3 s FinalizationPanel poll (event-driven
  `branches-changed`/`worktree-merged` + slow safety poll).
- Effort: M
- Related: PERF-06, PERF-13, git reviewer
- Plan/roadmap format impact: none

### PERF-10: Whole-tree re-render on every event, response and clock tick; no memoization anywhere
- Severity: high
- Category: performance
- Status: CONFIRMED (structure); HYPOTHESIS (exact browser frame times, not measured in a browser)
- Evidence: `App.tsx` holds ~45 `useState`s plus the projection reducer and renders every page
  inline (`App.tsx:1093-1693`). Each workspace event produces two App renders (`event-received`,
  then `stale-consumed`, `App.tsx:428-451`); each round adds one render for the token and one per
  resolved fetch group; `setNow` every 10 s re-renders everything (`App.tsx:335-338`) though only
  `RunList` elapsed times need it. `grep` finds 0 `React.memo` and 3 `useMemo` in `apps/web/src`.
  Callbacks passed to pages are fresh closures each render (e.g. `onOpenWorkItem` in
  `App.tsx:1228`), so memoizing children would not help without stabilising props. Polled
  responses are always new objects, so `setState` always re-renders even if unchanged
  (RoadmapsPage, CrossProjectPanel, FinalizationPanel, NotificationPanel). Heavy trees:
  RoadmapsPage renders all 171 entries (inside a closed `<details>`, still rendered) with
  `progress.find`/`attempts.find` per entry (`RoadmapsPage.tsx:904-1060`); CrossProjectPanel
  renders map nodes in several lists (`CrossProjectPanel.tsx:989-1109`); RunPage (PERF-11).
- Impact: jank/unresponsiveness on the laptop proportional to page size × event rate; typing in a
  form on these pages competes with background renders.
- Recommendation: move data into a keyed store with per-key subscriptions (components re-render
  only when *their* query result changes); structural sharing (keep the previous object when
  deep-equal or when a server `version`/ETag is unchanged); move `now` into a `useNow()` hook used
  only by elapsed-time cells; wrap row components (`RunEventItem`, roadmap entry row, map node row)
  in `React.memo`; split `App.tsx` into `AuthGate`, `WorkspaceShell` and one component per route
  with its own queries. Measure with the React Profiler on the Roadmaps and Run pages before/after.
- Effort: M-L
- Related: PERF-01, PERF-11, PERF-14
- Plan/roadmap format impact: none

### PERF-11: Run page downloads 17 MB for a large run (55 % unused `raw`) and renders every event unvirtualised
- Severity: high
- Category: performance
- Status: CONFIRMED (bytes measured; per-render JS cost measured in Node, 12.8 ms; browser cost HYPOTHESIS)
- Evidence: `App.tsx:601-635` walks up to 20 pages × 500 events (`routes/agent-runs.ts:32`
  `EVENT_PAGE_LIMIT = 500`) before streaming; `runEventBaseSchema` includes `raw`
  (`packages/contracts/src/execution.ts:429-436`) and the web app never reads it (no `.raw` usage
  in `apps/web/src`). Largest run `736446e8…`: 2,475 events, payload 7.8 MB + raw 9.7 MB; first page
  alone 4.4 MB (43 ms server). All events live in App state (`App.tsx:240`); each run SSE event
  appends and re-renders App (`App.tsx:641-647`). `RunPage.tsx:598-601` maps every visible event to
  `RunEventItem` (not memoized, `RunPage.tsx:134-161`), which recomputes `eventBody` —
  `JSON.stringify(input, null, 2)` for tool calls, `body.split('\n')` for collapsed items —
  and puts full bodies into the DOM even for collapsed `<details>` (7.3 M characters for this run).
  A Node replica of that per-render work takes 12.8 ms for 2,475 events, before React element
  creation/reconciliation and string comparisons of multi-KB text children. It runs on every App
  render: each run event, workspace event, fetch response and the 10 s tick.
- Impact: slow page open over the LAN, high memory, and feed jank exactly while an agent is
  streaming (when the operator is watching).
- Recommendation: (1) omit `raw` from `event-page` and the run SSE by default; expose it via an
  explicit diagnostics request. (2) Load the tail first (last N events) and page backwards on
  scroll ("Load earlier"), instead of walking forward from 0. (3) Keep run events in a page-local
  store, not App state. (4) `React.memo(RunEventItem)`, compute `body`/`summary` once per event id
  (WeakMap cache), render collapsed bodies lazily only when opened, and window/virtualise the list
  (a simple fixed "render last 300 + load more" is enough without a library).
- Effort: M
- Related: PERF-10, run-journal/storage reviewer (raw retention)
- Plan/roadmap format impact: none

### PERF-12: List payloads carry data the pages do not use
- Severity: medium
- Category: performance
- Status: CONFIRMED
- Evidence: `GET /runs` (`execution-service.ts` `listRuns`, 50 runs) returns `outcomeSummary`
  truncated but averaging 3.2 KB per run (`routes/run-summary.ts:13-21`) — ~73 % of the 215 KB body —
  while `RunList`/`RunsPage` never read it (`outcomeSummary` is only used in `DelegationPanel.tsx:717`
  and `RunPage.tsx:519-522`). The dashboard downloads all 50 runs every round to display only live
  runs (`App.tsx:1071`). The snapshot includes 50 `recentActivity` events that the reducer discards
  on same-workspace reloads (`workspace-projection.ts:242`). Audit (owner-only, 25 rows) and the
  workspace list are refetched every round on every page (`App.tsx:388-392`) though only the
  dashboard shows audit and the list changes only on create/rename. `GET /roadmaps` returns the full
  definition every poll (PERF-06); `/cycles` returns completed cycles (PERF-05).
- Impact: several hundred KB of avoidable transfer and parse per round.
- Recommendation: list endpoints return list-shaped DTOs (run row without outcome; a
  `?status=live` filter for the dashboard); snapshot omits `recentActivity` when called with a
  `since`/`refresh=1` parameter; load audit only when the dashboard Audit disclosure is open;
  refresh the workspace list only on `workspace-created`/`workspace-updated`.
- Effort: S
- Related: PERF-05, PERF-06, PERF-16
- Plan/roadmap format impact: none

### PERF-13: Four different freshness policies on one page produce visibly inconsistent state after transitions
- Severity: medium
- Category: ux
- Status: CONFIRMED
- Evidence: event-driven via `refreshToken` (App-level loads, PlanBranchPanel,
  RepositoryPolicyPanel, WorktreeBranchPanel, ExecutionScopesPanel, ScopeRepairPanel,
  ScopeReviewRecovery); 3 s polling (RoadmapsPage, FinalizationPanel); 5 s polling
  (CrossProjectPanel, NotificationPanel); load-once or revision-only (RuntimeEvidencePanel
  `:94-113`, MapAmendmentPanel `:63-68` on `roadmap.version`, ConcurrencyImports `:36-48`,
  HostSchedulingPanel `:43-57`, StoragePanel `:25-42`, RoadmapAgentProfilesPanel `:46-62`,
  RoadmapCapacityPanel `:30-42`, DecisionPreparationPanel `:37-42`). On the Roadmaps page the
  attention strip (App cycles) updates ~0.2-0.5 s after an event, the roadmap card within 3 s, the
  map panel within 5 s, and the dependency/evidence panel only after navigation. Host capacity
  "in use" counts on Settings never update while the page is open. Pages also fill in piecemeal
  (App-level data, then route data, then each child panel's own request), which reads as the page
  "reacting" several times per transition.
- Impact: the operator sees contradictory states within one page (e.g. a roadmap entry "Running"
  while the attention strip already shows it waiting, or evidence missing that the controller
  already recorded), and elements shift repeatedly — consistent with the reported symptom.
- Recommendation: one freshness policy: every panel's data is a keyed query invalidated by the event
  table (PERF-03), with a single slow visible-tab safety refresh for git/time-derived queries.
  Prefer one aggregated view-model request per page region (PERF-14) so a region updates atomically.
- Effort: M (falls out of the query store work)
- Related: PERF-01, PERF-03, PERF-06, PERF-14, UI-unification reviewer
- Plan/roadmap format impact: none

### PERF-14: Work-item and run pages are assembled from ~15 independent requests with duplicates and static data
- Severity: medium
- Category: architecture
- Status: CONFIRMED
- Evidence: work-item round (`App.tsx:534-551` + panels): work item, execution, repositories,
  execution-status, run-profiles, branch-settings + repositories again (`PlanBranchPanel.tsx:58-77`),
  repository-policy, execution-scopes twice (PERF-04), scope-repair, branch-status × active
  worktrees, plus App-level 4. `execution-status` is static composition data
  (`composition.ts:261-276`) and `run-profiles` changes only on save, yet both are refetched every
  round on work-item, run and settings pages (`App.tsx:535-541, 553, 571-582`) and separately by
  RoadmapsPage, CrossProjectPanel and FinalizationPanel. Each request re-authenticates and runs its
  own read pass, so derived data (scopes, merge gates, cycles) is evaluated repeatedly and may be
  mutually inconsistent (different read instants).
- Impact: request fan-out, duplicated evaluation, and non-atomic page state.
- Recommendation: server-computed view models per page region, each evaluated in one
  `readTransaction` + one `mapReadSnapshot`: `GET /work-items/:id/view` (detail, cycles of the
  item, worktrees, runs, merge gates, execution scopes, branch-settings summary), `GET
  /runs/:id/view`. Fetch `execution-status` and `run-profiles` once per session and invalidate
  only on profile saves (`workspace-updated`/a dedicated event). Git-derived branch status stays a
  separate lazily-loaded query (PERF-09).
- Effort: M-L
- Related: PERF-01, PERF-04, PERF-09, PERF-13
- Plan/roadmap format impact: none

### PERF-15: Non-owner members cannot load any workspace page (audit load is owner-only and inside the snapshot Promise.all)
- Severity: low
- Category: bug
- Status: CONFIRMED by code (not exercised: the live DB has one owner membership)
- Evidence: `workspace-service.ts:231-257` `auditPage` returns 404 (and writes a
  `workspace.access.denied` audit row via `recordDenied`) for any non-owner. `App.tsx:388-417`
  loads snapshot, audit and workspace list with `Promise.all`; a 404 from audit rejects the whole
  group → `snapshot-failed` ("The workspace snapshot could not be loaded") on first load, or
  `refresh-failed` on every later round — and each round appends another denied-access audit row.
- Impact: editor/viewer roles are unusable in the browser; audit log pollution per event.
- Recommendation: load audit separately and only for owners (role is known from the workspace
  list), and only when the dashboard Audit disclosure is open (PERF-12).
- Effort: S
- Related: PERF-12, security reviewer (role model)
- Plan/roadmap format impact: none

### PERF-16: No compression, no validators (ETag) on large JSON responses
- Severity: medium
- Category: performance
- Status: CONFIRMED (server); HYPOTHESIS (that `tailscale serve` does not compress on the way to the laptop)
- Evidence: every API reply sets `cache-control: no-store` (`routes/http.ts:10-12`); no
  compression plugin or zlib use in `apps/server/src` (grep for `compress|gzip|etag` finds none);
  `@fastify/compress` is not a dependency. Bodies of 215-537 KB (and 4.4 MB event pages) are sent
  raw; the deployment serves through `tailscale serve` to a laptop.
- Impact: bandwidth and latency multiply PERF-05/06/11; unchanged responses are re-sent in full.
- Recommendation: gzip/brotli JSON responses above ~8 KB (Fastify compress plugin or a small
  `onSend` hook with `zlib.gzipSync` — an ADR-level dependency decision); add weak ETags computed
  from a cheap version tuple (e.g. max relevant `version`/sequence) or a hash of the body, honour
  `If-None-Match` with 304 while keeping `no-store` semantics replaced by `no-cache` (revalidate
  every time — still never serving stale data). With a query store, a 304 also means "no
  re-render".
- Effort: S-M
- Related: PERF-06, PERF-12, security reviewer (cache headers on authenticated data)
- Plan/roadmap format impact: none

### PERF-17: Polling continues in hidden tabs; no visibility or focus awareness
- Severity: medium
- Category: performance
- Status: CONFIRMED
- Evidence: no `visibilitychange`/`document.hidden` handling in `apps/web/src`; intervals at
  `RoadmapsPage.tsx:167`, `CrossProjectPanel.tsx:186`, `FinalizationPanel.tsx:100`,
  `NotificationPanel.tsx:39`, `App.tsx:336` run regardless. The workspace SSE stream also keeps
  driving full refetches in hidden tabs.
- Impact: forgotten background tabs (on the laptop or the workstation) keep loading the daemon.
- Recommendation: pause intervals and defer invalidation-triggered refetches while hidden; on
  `visibilitychange` to visible, refetch the queries marked stale in the meantime (one round).
- Effort: S
- Related: PERF-06, PERF-02
- Plan/roadmap format impact: none

### PERF-18: Controller emits many small, spread-out commits per transition (browser cannot coalesce them)
- Severity: medium
- Category: architecture
- Status: CONFIRMED (event pattern); HYPOTHESIS (causes of the multi-second gaps — controller area)
- Evidence: live transitions carry 5-13 events over a median 5.2 s (p90 46.6 s) with gaps of
  ~3 s between run finish and the next cycle update and ~6 s between "Starting remediate" and
  `agent-run-started` (e.g. seq 3256→3258, 3259→3260). Consecutive `work-cycle-changed` events
  for the same cycle with an identical payload exist (13 fully identical, 35 with unchanged
  status+step out of 558; e.g. seq 3250/3251, 3257/3258, 3268/3269 "Classifying prior questions…").
  `running→waiting→finished` are separate commits ~0.35 s apart for every run.
- Impact: each intermediate commit is a separate browser round (PERF-02); identical events are pure
  waste; intermediate states flash on screen.
- Recommendation: (controller side) do not append a workspace event when the projected cycle
  status/step/reason did not change; consider marking intermediate controller events as
  `transient` so the browser can debounce them longer; emit the `running→waiting→finished`
  sequence as one commit when it happens within one callback. (Browser side) debounce + max-wait
  (PERF-02). Investigate the 3-6 s gaps in the controller review.
- Effort: S (dedupe) / M (transient marking)
- Related: controller reviewer, notifications reviewer, PERF-02
- Plan/roadmap format impact: none

### PERF-19: No tests or instrumentation guard request volume or read cost
- Severity: low
- Category: testing
- Status: CONFIRMED
- Evidence: the only batching test uses events 50 ms apart and counts only snapshot calls
  (`App.test.tsx:389-421`); no test asserts per-page request counts, dedupe, or that heavy
  projections use `mapReadSnapshot`; the server logs no per-route duration/bytes metric; no
  event-loop-delay metric exists.
- Impact: regressions like PERF-04 (missing memo) and new pollers are invisible until the operator
  feels them.
- Recommendation: (1) a web test that replays a recorded transition (the seq 3248-3254 timings)
  against the query store and asserts at most one request per affected key and zero for unrelated
  keys; (2) a server "read budget" test on a generated large fixture (171-entry roadmap, 150 KB
  evidence records) asserting `roadmaps`, `cycles`, `execution-scopes`, preview stay under a CPU
  budget with generous margins; (3) route timing + bytes in logs and an event-loop-delay gauge.
  The harness in this review ((review-session analysis script, not retained)) is a template: it builds the real app on a
  DB copy with `app.inject`.
- Effort: M
- Related: PERF-02, PERF-04, PERF-07
- Plan/roadmap format impact: none

### PERF-20: Single 768 KB bundle, no code splitting
- Severity: low
- Category: performance
- Status: CONFIRMED
- Evidence: `apps/web/dist/assets/index-*.js` 768,282 bytes; no `React.lazy`/dynamic `import()` of
  pages in `apps/web/src`. Static assets are immutable-cached (`routes/static-web.ts:56-57`), so this
  costs only first/after-deploy loads.
- Impact: slower first load over the LAN; minor compared with PERF-05/06/11.
- Recommendation: lazy-load the heavy roadmap/cross-project/finalization feature modules per route
  after the App split (PERF-10); enable compression (PERF-16).
- Effort: S
- Related: PERF-10, PERF-16
- Plan/roadmap format impact: none

## Remediation direction

### Sequencing

**Phase 0 — stop the bleeding (each S, independent, ~1-2 days total).** These need no design
change and address most of the measured cost:
1. `executionScopes` → `mapReadSnapshot` (PERF-04: 402 → 42 ms), one `mapReadSnapshot` for all of
   `RoadmapService.list` (PERF-08a).
2. Remove the `notifications-changed` → `workspaceSummary` mapping; map `runtime-evidence-changed`
   and `roadmap-changed` only to the panels that show them (PERF-03).
3. Slim `/cycles` (non-terminal only, no `designRecovery`) or add `/attention` for the shell
   (PERF-05); omit `outcomeSummary` from `/runs`; dashboard fetches `?status=live` (PERF-12).
4. Omit `raw` from run event pages/stream; tail-first run loading (PERF-11 parts 1-2).
5. Debounce + max-wait + single-flight around the existing `refreshToken` (PERF-02) and pause
   everything on hidden tabs (PERF-17).
6. Load audit separately, owner-only, dashboard-only (PERF-15).
7. Controller: skip identical cycle events (PERF-18 dedupe) — coordinate with the controller area.

**Phase 1 — a keyed query store and an App split (M-L).** Replace `refreshToken` and the ad-hoc
`useEffect` fetchers with `lib/query-store.ts` (~200-300 lines, no dependency) providing:
`useQuery(key, fetcher)` with per-key subscriptions; single-flight + dirty follow-up; stale-while-
revalidate (last good value stays visible, preserving ADR-003's "failed refetch keeps the last
projection"); structural sharing (reuse previous value when the server version/ETag or deep-equal
says unchanged, so no re-render); an `invalidate(predicate)` API driven by one tested
`eventInvalidations(event) → keys[]` table (replacing `invalidatedBy`); visibility-aware deferral;
workspace-scoped cache reset (preserving the CT03-RR4 "never render the previous workspace" rule).
Then split `App.tsx` into `AuthGate` → `WorkspaceShell` → one route component per page, each
declaring its own queries; move `now` to a hook; memo the row components. Remove all
`setInterval` pollers except a 60 s visible-tab safety refresh for git/time-derived queries.

On the "no data-fetching library" ADR: the required semantics (dedupe, single-flight, SWR,
structural sharing, visibility, keyed invalidation) are exactly TanStack Query's core, and adopting
it would be less code to own. ADR-001/ADR-015 excluded a *router with loaders/data layer* and a
state-management framework mainly to avoid an unrelated rewrite; a query cache is a narrower thing.
Recommendation: build the small custom store first (stays inside the agreed baseline and AGENTS.md's
"ask before a new major dependency"), and write a short ADR amendment recording the store's
semantics; if it grows past ~400 lines or needs mutations/optimistic updates, ask the operator to
approve TanStack Query instead of extending it.

**Phase 2 — server-computed view models and cheap revalidation (M-L).** Per page region, one
endpoint evaluated in one read transaction and one `mapReadSnapshot`: `/workspaces/:id/attention`,
`/work-items/:id/view`, `/runs/:id/view`, `/roadmaps` (light list) + `/roadmaps/:id/progress`
(no definition) + definitions by revision (immutable). Each view carries a `version` (e.g. the
max of the aggregate versions / workspace event sequence it depends on) and an ETag; responses are
gzip-compressed (PERF-16). Git-derived facts are separate lazy queries backed by a SHA-keyed cache
(PERF-09). Workspace events keep being invalidation signals but carry the aggregate keys they touch
(most already carry `workItemId`, `runId`, `cycleId`, `roadmapId`) so the store invalidates exactly
the affected views.

**Phase 3 — only if Phase 1-2 are insufficient (L).**
- Shared projections: compute map-derived roadmap progress / scope status once per workflow
  generation (e.g. on the commit that changes relevant rows, or lazily keyed by a storage write
  generation counter) and let the worker and all readers share it, instead of each request
  re-evaluating the map (PERF-07/08). This must respect `docs/architecture.md:210-213` ("no snapshot
  survives a mutation"): key the cache by a generation that every write transaction increments, so
  a cached projection can never be served across a mutation; git- and clock-derived inputs stay out
  of it.
- SSE deltas for high-churn scalars (cycle status/step/reason, run status, roadmap entry status):
  patch view models directly from event payloads, revalidating in the background. This changes
  ADR-003's "event is never the model" rule for those kinds and needs an ADR; do it only if the
  measured revalidation latency after Phase 2 is still visible.

### Target design (end state)

```text
SSE event ──► eventInvalidations(event) ──► query store: mark keys stale (visible tab: debounce 400ms,
                                                           max-wait 2s; hidden: defer)
                                             └─► single-flight GET view(key) with If-None-Match
                                                    304 → no state change, no render
                                                    200 → structural share → re-render subscribers only
Pages = route components; each subscribes to 1-3 view-model keys; rows memoized.
Server: view endpoints = one readTransaction + one mapReadSnapshot; light list DTOs; gzip; ETag;
        git facts behind SHA-keyed TTL cache; no request > ~50 ms on the live dataset.
Budgets to verify: ≤ 1-2 requests per affected key per transition; 0 requests for unrelated pages;
        idle tab → 0 requests/min (plus 1 safety refresh/min for git-derived queries when visible).
```

Expected effect from the measured numbers: a work-item page drops from ~15 requests and ~0.9 s of
daemon CPU per round × 4-10 rounds per transition to ~1-3 small requests per transition, and an idle
Roadmaps tab from ~15 MB/min and ~7.7 % daemon CPU to near zero.
