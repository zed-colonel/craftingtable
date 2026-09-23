# CTRL — Controller / orchestration core review

Reviewer scope: `apps/server/src/services/work-cycle-service.ts`, `roadmap-service.ts`,
`execution-service.ts`, `agent-run-service.ts`, `finalization-service.ts`,
`cross-project-service.ts`, `host-scheduling-service.ts`, `execution-scope.ts`, `scope-*.ts`,
`*-policy.ts`, `operator-decisions.ts`, `architecture-decision-inbox.ts`, `workflow-policy.ts`,
`composition.ts`, plus `notification-service.ts` where it consumes controller state, and ADRs
025/029/030/033/037/045/046/056/057/062/063/064/065.

Method: full read of the controller files, targeted reads of the policies, import-graph and
function-length analysis (scripts in the scratchpad), read-only queries against the live DB
(`?mode=ro`), timing of pure projection functions against a private DB copy
((review-session analysis script, not retained), via `npx tsx`, no Git or agent effects), and a 20 s CPU
sample of the idle daemon process. Line numbers refer to the tree at commit `bf08c0b`.

## Summary

- **The cycle controller is one 656-line imperative function.** `WorkCycleService.reconcile`
  (`work-cycle-service.ts:1599-2254`) decides every automated transition through 65 `return`
  statements (29 `attention()` calls inside it; 44 in the file) and about 25 status-literal
  sites. There is no transition table. Cycle state spans `status` × `step` plus about 24 optional
  JSON sub-state fields, and each field has its own implicit sub-machine.
- **At least 10 separate places decide "does this need the operator?", and they disagree.**
  They are: cycle status writers, `PhaseGateError.waiting`, `scopeReviewWait`, `scopeMergeWait`,
  `automatedScopeRecoveryWait`, `RoadmapService.blocker().needsAttention`, `RoadmapService.view()`,
  `NotificationService.attention()`, the web `attentionCycles`, and the web `RoadmapAttention`.
  Some classify by typed kind and some by message-prefix string. The same blocker is a silent
  wait in one place, "needs attention" in another, and a Pushover alert in a third.
- **Notifications are pushed for states the controller is about to leave on its own.** This is
  confirmed in the DB: cycle `188747f3` was pushed "Needs attention" at 01:09:41.279Z, and the
  roadmap started its queued review at 01:09:42.321Z. Nothing tells the notification service
  "the controller still owns the next action", and delivery happens immediately with no settle
  delay.
- **Notification identity includes `cycle.version`.** Every version bump while a cycle stays in
  `needs-attention` or `awaiting-merge` creates a new alert. Operator "Resume" commands that
  achieve nothing produce repeat pushes: cycle `d148f0a4` was resumed 3 times and re-entered the
  same attention in 0.4–3 s each time, giving 4 notification records and 24 deliveries.
- **Resume is accepted when it cannot make progress.** The controller re-classifies the same
  finished run and returns to the same attention. A review-only parent-acceptance cycle
  (`10dbc912`) was resumed 14 times, 11 by the operator and 3 by the system. Each resume re-ran a
  roughly 15-minute review of the unchanged snapshot, and each returned the same "1 major"
  finding.
- **`awaiting-merge` is overloaded with six meanings**, only one of which is "operator merge
  approval". The live cycle `2f1ab211` is `awaiting-merge` while it waits on controller
  obligations: other slices must be verified. It has pushed "Needs attention" 4 times.
- **Latent bug: ADR-065 delegation grants are ignored by two consumers.** `refreshOwner`
  (integration refresh) and the notification service read automation from the frozen
  definition. The roadmap merge path uses `effectiveDelegation`. If a grant flips a merge to
  manual, the operator is never notified.
- **The controller polls, and the polling is expensive.** The idle daemon uses 15–20 % of a CPU
  core: 392 CPU ticks in 20 s, with no live runs and the roadmap paused. The cycle loop wakes at
  least every second and runs heavy synchronous projections, all blocking the event loop.
  Measured costs:

  | Projection | Cost per call |
  |---|---|
  | `workflowContext` | 54 ms |
  | `requireScope` | 44 ms |
  | `scopePhaseBlockers` | 37 ms |
  | notification `attention()`, roadmap running | 158 ms |
  | roadmap `view()` | 113 ms |
  | `crossProjectState` | 133 ms |

  The cycle loop is serial, so one launch preflight blocks supervision of every other cycle.
- **Layering is inverted.** `WorkCycleService` re-implements roadmap policy: scheduling mode,
  automation, entry holds, scope recovery, pause. `AgentRunService` holds about 90 lines of cycle
  prompt policy. `ExecutionService.mergeWorktree` knows cycle, finalization and security-workflow
  rules. Ownership of a cycle by a roadmap is resolved 11 different ways by scanning every
  roadmap's JSON; the cycle record has no owner reference.
- **String-typed control flow.** Automatic reassessment is triggered by a regex on
  human-readable `cycle.reason` text (`work-cycle-service.ts:1642`). "Waiting" is inferred from
  `message.startsWith('Resource ')` on the server and in the web. The web detects restart state
  with `reason.startsWith('Daemon restarted.')`.
- **Manual and automated gates diverge.** Whole-item predecessor gates exist in 4
  implementations. Resume is accepted and then fails at launch 0.5–1.6 s later (DB sequences
  2649–2657). Many operator decisions require pausing the whole roadmap, which halts all parallel
  work in order to answer one question.
- **Storage churn.** The roadmap control row embeds the full current definition: 230 KB for 171
  entries. It is rewritten on every change, including 79 flip-flop writes that just restore the
  "Parallel scheduling enabled…" reason. `roadmaps.history()` parses 2 MB (6–9 ms) and is called
  unmemoized on hot paths.
- **Dead or vestigial code.** The legacy finalization controller is still selectable in the UI;
  one historical legacy record exists and no staged finalization has ever run live. Also:
  `latestSliceMerge` is a pure alias, `RepositoryInspectorProvider` is constructed but not
  routed, several constructor dependencies are optional but always supplied, and the ADR-063
  reason-regex reassessment path exists only for older records.
- **Testing is integration-only.** The controller has no unit tests. It is exercised only
  through the 14,084-line `server-execution.test.ts`, which uses real loops and 3 s polling
  (`waitFor`). No transition table can be tested.

## Map

### Components and sizes (non-test lines)

| Module | Lines | Largest functions (lines) | Local imports (fan-out) | Responsibility |
|---|---|---|---|---|
| `work-cycle-service.ts` | 4029 | `reconcile` 656, `control` 330, `decideFinalizationStage` 227, `resolveIntegration` 218, `delegateScopeRepair` 154, `decideFinalizationFindings` 145, `advanceFinalizationStage` 134, `finalizeImplementation` 133, `performIntegrationRefresh` 116, `record` 113, `advanceWorkflow` 108, `reviewRemediation` 105, `next` 100 | 23 | Cycle aggregate: all commands, the automated loop, integration refresh, conflict resolution, checkpointing, legacy and staged finalization, workflow (ADR-063) reviews, design recovery, baseline prep, provider/continuation retries, audit |
| `roadmap-service.ts` | 2292 | `advanceEntry` 380, `advanceScopeRecovery` 265, `blocker` 177, `save` 167, `controlWithin` 144, `view` 133, `prepareDecision` 126, `advance` 122 | 24 | Roadmap aggregate: scheduler loop, admission/capacity, attempts, scope recovery (ADR-057), dependency-refresh dispatch, auto-merge/conflict delegation, decision preparation, delegation/agent grants, projection |
| `agent-run-service.ts` | 1860 | `launchAuthorized` **780**, `consume` 112, `startForCycle` 108 | 25 | Process supervision and journal. Also cycle launch authority, cycle brief composition, run-directory materialization, phase reservation at launch |
| `execution-service.ts` | 1711 | `mergeWorktree` 388, `recordScopeReceipt` 239, `createWorktree` 169 | 16 | Worktrees, merge gate (`mergeGateFor`), merges with recovery, scope receipts |
| `runtime-evidence-service.ts` | 2632 | — | 21 | Pinned environments, evidence, checkpoint acceptance (called by cycles) |
| `execution-scope.ts` | 736 | `scopePhaseBlockers` 259 | 8 | ADR-046 shared transition evaluator for scoped work |
| `notification-service.ts` | 673 | `attention` ~235 | 10 | Its own derivation of attention, outbox, delivery loop |
| `cross-project-service.ts` | 573 | `crossProjectState` 258 | 14 | Map preview/adoption, `milestoneSatisfied` (policy in a service file) |
| `finalization-service.ts` | 544 | `control` 152, `cleanupIntegration` 132 | 7 | Finalization record lifecycle; delegates rounds and stages to `WorkCycleService` |
| policies (`workflow-policy`, `scope-recovery-policy`, `scope-repair`, `design-dependency-policy`, `finalization-policy`, `finalization-stage-policy`, `phase-resources`, `roadmap-delegation-policy`, `agent-profile-policy`, `operator-decisions`, `architecture-decision-*`, …) | 40–643 each | — | — | Mostly pure functions over `StorageRepositories` |

Constructor width: `WorkCycleService` 11 dependencies (4 optional but always supplied),
`RoadmapService` 10, `AgentRunService` 12, `ExecutionService` 9. Import cycles (both type-only
in one direction): `roadmap-service` ↔ `cross-project-service`, and `execution-scope` ↔
`phase-resources`. Highest fan-in: `errors` 32, `auth-service` 20, `workspace-event-notifier`
18, `workspace-service` 18, `execution-scope` 14, `map-read-snapshot` 14,
`runtime-evidence-policy` 13.

### Wiring (`composition.ts`, `server.ts:115-126`)

`createServices` builds the services in dependency order. It calls
`agentRunService.recoverInterrupted()` (live runs become `interrupted`), then
`workCycleService.recoverInterrupted()` (`running` cycles become `needs-attention`, baseline
preparation becomes failed), then `roadmapService.recoverInterrupted()` (`running` roadmaps
become `needs-attention`, orphaned decision preparations become failed). This happens before
the HTTP server starts. The Fastify `onReady` hook starts four workers; `preClose` shuts them
down. `WorkCycleService.shutdown` kills every running cycle's session.

### Loops, workers, timers, wakeups

| Worker | Where | Wakes on | Timeout | Per-iteration work |
|---|---|---|---|---|
| Cycle loop | `work-cycle-service.ts:1541-1591` | every `notify('workflow')` | **1 s fixed** | `reconcile()` for every non-terminal cycle in the installation, **serially and awaited**. This can include Git probes, checkpoint commits, integration refresh, and a full agent launch preflight: Git, source export, `writeFileSync` of whole upstream trees. |
| Roadmap loop | `roadmap-service.ts:956-1007` | `notify('workflow')` | 1 s if a non-cross-project roadmap is running, else 5 s | `tick()` over every roadmap; `advance()` → `reconcileCompletedAttempts`, `deferredEntries` (83 ms measured), `advanceEntry` per entry. Can call cycle commands, create worktrees, merge, and record receipts. |
| Notification loop | `notification-service.ts:180-196` | `notify('workflow')` | 5 s | `deliverDue()`: `reconcile()` (re-derives all attention, 54–158 ms) before each claim and again after each send, up to 20 per workspace |
| Storage maintenance | `storage-service.ts:639-646` | `setInterval` | 60 s | Cache/scratch cleanup, daily backup |
| Per-run supervision | `agent-run-service.ts` `consume`, `launchCycleSession` timeout, decision-preparation timers (`:1253`), post-run cleanup (`finalize` → `cleanupAfterRun`, then notify) | process events | per run | Journal, transitions, `notify()` |
| Command handlers | HTTP routes → `control`, `resolveIntegration`, `decide*`, `mergeWorktree`, `recordScopeReceipt`, `acceptWorkflowCheckpoint`, … | request | — | Perform transitions directly, concurrently with the loops |

There is no single reconciler. One `WorkspaceEventNotifier` (`workspace-event-notifier.ts`)
carries two generation counters. Every `change()` in the cycle and roadmap services, and every
run status transition, calls `notify()` (the workflow channel), which wakes all three workflow
loops at once. Their own writes wake them again. Serialization mechanisms:

- optimistic version CAS on cycle and roadmap rows
- DB unique indexes: one active cycle per worktree and per item/scope; phase-reservation
  capacity trigger
- in-memory sets: `transitioning`, `refreshing`, `repairing`, `ending` (cycle);
  `controlling`, `ticking` (roadmap); `pendingCycleLaunches`, `live` (runs);
  `mergingRepositories` (branch); `WorktreeMutationGuard`; `runCleanups` (storage)
- injected `check` / `attach` callbacks threaded from `RoadmapService` into `WorkCycleService`
  commands

### State machines and where their transitions live

| Machine | States | Transition sites |
|---|---|---|
| Cycle `status` (`domain/work-cycle.ts:13-20`) | running, paused, needs-attention, awaiting-merge, stopped, completed | 44× `attention()` and about 25 literal assignments in `work-cycle-service.ts`, spread across `reconcile`, `advanceWorkflow`, `advanceFinalizationStage`, `completeFinalizationStage`, `performIntegrationRefresh`, `resolveIntegration`, `control`, `next`, `start*`, `retireForAmendment`, `recoverInterrupted`. Also indirectly by `RoadmapService` via `control()` and by `MapAmendmentService` via `retireForAmendment`. |
| Cycle `step` | design, implement, review, remediate | `next()` (`:3707`) and three direct writes (`control` `:1466-1478`, `resolveIntegration` `:3547`, `delegateScopeRepair` `:312`) |
| Run reservation (implicit) | reserved (`currentRunId` without a row) → launched → live → terminal → "settling" (cleanup) | `next()` reserves; `reconcile` `:1838-1851` launches; `AgentRunService.finalize` ends; `isCleaningRun` gate at `:1601` |
| Integration refresh (implicit) | idle → reserved (`status` forced to running, `integrationRefreshes++`) → Git → review, or needs-attention with `integrationResolution: detected` | `performIntegrationRefresh` `:3226-3341` |
| `integrationResolution.status` | detected → preparing → resolving → committing → completed \| abandoned | `resolveIntegration` `:3405-3622` (commands), `advanceResolution` `:3623-3705` (loop), `reconcile` `:1834-1837`, `:1992-2002` |
| `providerRecovery` (ADR-062) | none → backoff(nextRetryAt) → retrying(attempts n) → exhausted → attention | `reconcile` `:1793-1833`, `:1869-1932`; `control('retry-provider')` `:1241-1301`; cleared in `next()` `:3785` |
| `resultContinuations` (ADR-037) | 0..2 | `reconcile` `:1933-1978`, `next()` `:3784` |
| `designWait` / `designDependencyContinuations` | none → waiting(requirements) → recheck (≤2) → attention | `reconcile` `:1742-1772`, `:2068-2089` |
| `phaseWait` | none → waiting(blockers) → cleared (deadline extended) | loop catch `:1552-1564`, `reconcile` `:1716-1727`, `:1773-1784` |
| `workflow` (ADR-063) | questions / activeReview{reassessment, security, checkpoint} / waiting / securityReceipt | `reconcile` `:1619-1669`, `:2003-2042`; `startWorkflowReview` `:2256`; `advanceWorkflow` `:2323-2430` |
| `checkpoint` (ADR-031) | reserved → committed | `finalizeImplementation` `:3011-3143` |
| `baselinePreparation` | preparing → prepared \| failed | `prepareBaseline` `:383-450`, `recoverInterrupted` `:1509` |
| `designRecovery` | investigate \| continue run | `recoverDesign` `:452`, `reconcile` `:2056-2062` |
| Finalization, legacy | `polishPhase` assess → polish → verify → final-review, `polishRound` | `reconcile` `:2129`, `:2170-2177`, `:2237-2245`; `decideFinalizationFindings` `:885-902` |
| Finalization, staged (ADR-042) | stage status pending → reviewing → selecting → verifying → completed; stage reopen | `advanceFinalizationStage` `:2432`, `enterFinalizationStage` `:2593`, `completeFinalizationStage` `:2627`, `decideFinalizationStage` `:2662`, `change()` stage accounting `:3868-3894` |
| `Finalization.status` | preparing → active → stopped \| completed | `finalization-service.ts` |
| Roadmap `status` | draft, running, paused, needs-attention, stopped, completed | `roadmap-service.ts` `controlWithin` `:696-839`, `tick` `:996`, `advance`/`advanceEntry` `:1119-1134`, `:1420-1441`, `recoverInterrupted` `:945` |
| `RoadmapAttempt.status` | preparing → active → completed (reactivated by dependency refresh and recovery re-review) | `advanceEntry` `:1445-1517`, `:1281-1293`, `reconcileCompletedAttempts` `:1808`, `advance` `:1047-1057`, `advanceScopeRecovery` |
| `attempt.recovery.phase` (ADR-057) | repair → verification → parent-review → completed | `advanceScopeRecovery` `:1539-1803` |
| `attempt.dependencyRefresh` (ADR-058) | queued → dispatched | `runtime-evidence-service` (queue), `advanceEntry` `:1167-1231` (dispatch) |
| `entryHolds` | paused \| needs-attention per entry | `controlEntry` `:841-917`, `advance` `:1082-1087`, cleared on resume and merge |
| Merge operation | reserved → merged → cleaned \| failed | `execution-service.ts` `mergeWorktree` |
| Agent run | starting → running ⇄ waiting → finished \| failed \| cancelled \| interrupted | `agent-run-service.ts` `transition`/`finalize` (the only well-centralized machine: guarded expected-status sets) |
| Phase reservations | acquired → released | `phase-resources.ts` `reservePhase`, `finalize`, `withPhaseReservation` |
| Notification record | active ⇄ resolved (+ lease) | `notification-service.ts` `reconcile`/`deliverDue` |

### Transient states between automated steps (what other components see)

- **T1. Run finished, not yet reconciled.** The cycle stays `running` while the run is terminal
  and post-run cleanup is pending (`isCleaningRun` early return at `:1601`), plus up to 1 s.
  Notifications skip `running` cycles, so this is not pushed. The UI shows a `running` cycle
  with no live run.
- **T2. Reserved, not launched.** `next()` writes `currentRunId` (a new UUID) with no run row.
  The next loop iteration launches after Git preflight and runtime source export, which can
  take seconds to minutes. A restart in this window becomes attention.
- **T3. `needs-attention` that the controller itself will leave:**
  - shared-decision reassessment (`:1619-1637`)
  - slice reason-regex reassessment (`:1638-1669`)
  - roadmap automatic conflict resolution of `integrationResolution: detected` (`roadmap-service.ts:1344-1366`)
  - roadmap scope-recovery takeover of a review-only cycle (`:1539+`)
  - queued dependency-refresh review (`:1167-1231`)
  - roadmap recovery `control('resume')` (`:1782`)

  Notification suppression covers only some of these (see CTRL-02).
- **T4. `awaiting-merge` that the controller will leave:** automatic merge, automatic
  verification or parent-acceptance record, queued security or checkpoint reviews, integration
  refresh after a sibling merges. The dashboard `attentionCycles` counts all of them as
  operator attention.
- **T5. Integration-refresh flip.** `awaiting-merge` → `running` (reserve) → back to
  `awaiting-merge` with a rewritten reason when the repository is busy (`:3258-3314`). That is
  two version bumps and two events.
- **T6. Roadmap resume ordering.** Cycles are resumed one at a time *before* the roadmap is
  marked `running` (`roadmap-service.ts:770-814`). The comment at `:759-761` acknowledges that
  the cycle worker can observe the gap.
- **T7. Roadmap attempt `preparing`.** Reserved IDs exist before the worktree does
  (`:1445-1459`).

## Findings

### CTRL-01: The cycle controller is a 656-line imperative function with an implicit state machine
- Severity: high
- Category: architecture
- Status: CONFIRMED
- Evidence: `work-cycle-service.ts:1599-2254` (`reconcile`). The function measures 656 lines
  with 65 `return` statements (29 `attention()` calls inside it). The file contains 44 `this.attention(` call sites and about 25
  `status:` literal assignments. `control()` is 330 lines (`:1176-1505`) and re-derives much of
  the same logic for the resume path.

  State is `status` × `step` plus these optional fields (`domain/work-cycle.ts:105-205`):
  `designWait`, `designDependencyContinuations`, `phaseWait`, `resultContinuations`,
  `providerRecovery`, `integrationResolution`, `integrationRefreshes`, `checkpoint`,
  `baselinePreparation`, `designRecovery`, `scopeRepair`, `workflow{questions, activeReview,
  waiting, securityReceipt, securityRequired, reassessments}`, `finalizationProgress`,
  `polishPhase`, `polishRound`, `deferredNits`, `findingFocus`, `stalledReviews`,
  `previousFindingFingerprint`, `reviewHeadSha`, `housekeepingInstructions`,
  `additionalRemediationRounds`, `finalizationAgentOverride`.

  Precedence between these sub-states comes only from the order of `if` blocks in `reconcile`.
  For example, `phaseWait` is cleared before the deadline check (`:1773-1792`), and the
  provider retry is checked before `ownsIntegrationResolution` (`:1793-1837`). Stored cycle JSON
  reaches 65 KB in the live DB.
- Impact: No one can tell which states are reachable or what an event does in a given state
  without reading the whole function. Each ADR (025, 031, 032, 037, 051, 056, 062, 063) added a
  new optional field plus another `if` block. This is the "spaghetti-fication" the operator
  describes. Changes interact through ordering that nobody wrote down, and review and test effort
  grows with every addition.
- Recommendation: Extract a pure decision core in three steps.
  1. Add `cycle-facts.ts`. It builds an immutable `CycleFacts` from one read snapshot: latest
     run, latest turn, parsed design/workflow/review reports, open-questions result (one
     parser), scope gates, ownership, deadlines, and budgets.
  2. Add `cycle-machine.ts` exporting `decide(cycle, facts, now): Decision`. A `Decision` is a
     tagged union: `launch{step, changes}`, `wait{code, until?}`, `attention{code, message,
     actions}`, `approve{kind}`, `complete`, `effect{kind: checkpoint | refresh |
     resolution-step | merge | record-evidence}`.
  3. Keep `reconcile` as a thin shell that gathers facts, calls `decide`, and runs the effect.

  Encode precedence as an explicit ordered list of guards with names. Start by moving
  `:1858-2254` (post-run classification) verbatim into `decide`, and cover it with
  decision-table unit tests.
- Effort: L
- Related: CTRL-05, CTRL-11, CTRL-17, CTRL-18
- Plan/roadmap format impact: none. Cycle JSON is unchanged; decisions are recomputed from the
  existing fields.

### CTRL-02: Notifications fire for states the controller is about to leave on its own
- Severity: high
- Category: bug
- Status: CONFIRMED (code and DB)
- Evidence:
  - `notification-service.ts:204-440` derives attention independently of the controller. New
    records get `nextAttemptAt: now` (`:453`), so delivery is immediate with no settle window.
  - The only transition guard is `cycleTransitioning` (`:238`, `:462-472`). It reflects
    `WorkCycleService.transitioning`, which is set **only** by explicit operator commands
    through `duringTransition` (`work-cycle-service.ts:106-119`), never by automated
    transitions.
  - Suppressions that do exist are ad hoc: `automatedScopeRecoveryWait`, `scopeReviewWait`, and
    "owner roadmap running and automation automatic" (`:245-274`). Nothing covers queued
    `attempt.dependencyRefresh` reviews, the ADR-063 reassessment paths
    (`work-cycle-service.ts:1619-1669`), or roadmap recovery `control('resume')`
    (`roadmap-service.ts:1782`).
  - DB evidence. Cycle `188747f3` entered `needs-attention` at v2 on 2026-09-20T11:52:27Z with
    "wi integration changed. Preview dependency refresh…". `scopeReviewWait` suppressed it until
    another item's evidence was recorded. At 2026-09-22T01:09:40.758Z its notification was
    created and delivered at 01:09:41.279Z. At 01:09:42.321Z the roadmap (system actor)
    dispatched the queued `review-again` (audit sequences 2583–2589).
- Impact: The operator gets a Pushover "Needs attention" about a step the controller starts one
  second later. This is the reported symptom "notifications sent while the controller is
  transitioning between automated runs". It trains the operator to ignore alerts.
- Recommendation:
  - Make the controller the only producer of attention (see CTRL-05). Every automated decision
    records an explicit `nextActor: 'controller' | 'operator'`. Controller-owned waits, including
    queued dependency refreshes, pending reassessments and pending recovery rounds, are never
    notifiable.
  - Add a settle delay to operator attention: deliver only if the same attention identity has
    persisted for at least N seconds (for example 60 s, configurable) and no automated
    transition is scheduled for it.
  - Short-term patch: in `NotificationService.attention` skip cycles whose owning attempt has
    `dependencyRefresh`, and cycles that match the reassessment predicates. The better fix is to
    expose `WorkCycleService.pendingAutomation(cycle)` from the same predicates used by
    `reconcile`.
- Effort: S for the patch plus settle delay; M for the full attention model
- Related: CTRL-03, CTRL-05, CTRL-10
- Plan/roadmap format impact: none

### CTRL-03: A new notification per cycle version produces repeat pushes for unchanged situations
- Severity: high
- Category: bug
- Status: CONFIRMED (code and DB)
- Evidence:
  - `notification-service.ts:283`:
    `sourceKey = \`cycle:${cycle.id}:${cycle.version}…\``. Any `change()` bumps the version.
  - Version bumps that keep the status the same include:
    - `workflow.waiting` text updates (`work-cycle-service.ts:2414-2423`)
    - the refresh-busy revert (`:3309-3313`)
    - `phaseWait` writes (`:1559`)
    - no-op resumes (CTRL-04)
  - DB: 13 cycles have more than 2 notification records. Cycle `10dbc912` has 14 records and 11
    deliveries. `caf76f40` has 11 records and 48 deliveries. `2f1ab211` has 8 records and 30
    deliveries. `d148f0a4` has 5 records and 24 deliveries (query over `notification_records`
    grouped by `substr(source_key, 7, 36)`).
- Impact: Reminder scheduling resets and alerts repeat for the same underlying situation.
  Notifications become noise, and the audit log is dominated by bookkeeping: 792
  `notifications.updated` rows against 558 cycle updates.
- Recommendation: Key attention by *identity of the condition*, not by row version. Use
  `cycle:{id}:{attentionCode}:{blockingRunId|conditionDigest}`, where `attentionCode` is a
  typed code from CTRL-05 and the digest covers only the facts that require operator action. A
  wording change or unrelated field update then keeps the same record and reminder cadence.
- Effort: S
- Related: CTRL-02, CTRL-04, CTRL-05
- Plan/roadmap format impact: none. Existing records resolve naturally once keys change; the
  first deploy may resolve and re-create each active alert once.

### CTRL-04: "Resume" is accepted even when it cannot make progress
- Severity: high
- Category: ux
- Status: CONFIRMED (code and DB)
- Evidence:
  - `control()` falls through to
    `change(cycle, {status: 'running', reason: 'Automation resumed by operator.'})`
    (`work-cycle-service.ts:1494-1504`) when the current run is finished and the step is not
    `review`. The next `reconcile` re-classifies the **same** finished run and re-enters the
    same attention.
  - DB, cycle `d148f0a4` (design): resume at 07:32:38.324Z became needs-attention at
    07:32:41.075Z. Resume at 08:06:07.719Z became needs-attention at 08:06:08.168Z. Resume at
    00:06:11.523Z became needs-attention at 00:06:12.800Z. The reason was the same every time:
    "Design classifications require valid kinds…".
  - DB, cycle `d91e6c71`: resume at 07:32:38.192Z became needs-attention at 07:32:38.328Z.
  - DB, cycle `10dbc912` (parent-acceptance, review-only): resumed 11 times by the operator and
    3 times by the roadmap between 09-18 and 09-20. Each resume re-ran a 10–20-minute
    independent review of the unchanged integration snapshot and produced
    "Scope review requires recovery: … 1 major" (v3–v28). The fix eventually came through
    owning-slice repair.
- Impact: The operator's main recovery button often does nothing, or repeats expensive agent
  work. Each no-op generates a new alert (CTRL-03). The operator spends time working out which
  of the many recovery controls is the right one (pain point 1).
- Recommendation: Compute "available actions" in the same pure decision core that will evaluate
  the result. Each attention code maps to a small set of actions that can resolve it: resume is
  valid only when the blocking fact is transient, such as an interrupted, failed or timed-out
  run, a cleared gate, or a paused cycle. Reject resume with a precise message and the correct
  destination otherwise, for example "Use Resolve design questions" or "Fix in owning slice".
  Return the action list with the cycle projection so the UI renders only valid actions.
- Effort: M
- Related: CTRL-01, CTRL-05, CTRL-12; UI reviewer (single recovery surface)
- Plan/roadmap format impact: none

### CTRL-05: At least 10 separate places decide "needs the operator", with different rules
- Severity: high
- Category: architecture
- Status: CONFIRMED
- Evidence:
  1. Cycle status writers: 44 `attention()` plus direct sets at `work-cycle-service.ts:2533`,
     `:3322`, `:3491`.
  2. `PhaseGateError.waiting` (`phase-resources.ts:12-18`): waiting unless the kind is
     authorization or review, *except* when the message starts with `'Resource '`.
  3. `scopeReviewWait` (`scope-repair.ts:33-64`): a wait only if every blocker is `dependency`,
     or `evidence` matching `/^(Required slice |Checkpoint )/`.
  4. `scopeMergeWait` (`scope-repair.ts:13-31`).
  5. `automatedScopeRecoveryWait` (`scope-recovery-policy.ts:132-172`).
  6. `RoadmapService.blocker().needsAttention` (`roadmap-service.ts:1892-2068`).
  7. `RoadmapService.view()` (`:2152-2163`): **any** `authorization` or `review` blocker is
     `needs-attention`, including `Resource …` messages that (2) treats as a wait.
  8. `NotificationService.attention()` (`notification-service.ts:204-440`), including an
     "environment waits" classifier on `startsWith('Resource ')` (`:356-359`).
  9. Web `attentionCycles` (`apps/web/src/components/AttentionStrip.tsx:6-12`) counts every
     `awaiting-merge` as attention, including auto-merge items that (8) suppresses.
  10. Web `RoadmapAttention` / `RoadmapsPage` (`RoadmapAttention.tsx:18-31`,
      `RoadmapsPage.tsx:677`, `:951`) with a further `startsWith('Resource ')` classification.

  The notification text for the same cycle can differ from its reason. Live cycle `2f1ab211`
  has reason "WI-WORKER-G1: Slice wi/WI-09/domain must be verified…" (from
  `workflow.waiting`), while its push says "Merge blocked: Checkpoint WI-WORKER-G1 must pass…"
  (from `scopeMergeWait`).
- Impact: The dashboard, roadmap page, work-item page and Pushover disagree about what needs
  the operator. Fixing one blockage in one place does not fix the others. This is the root
  cause of pain points 1 and 3. Every new ADR adds another special case to several of these
  sites.
- Recommendation: Introduce one `Attention` value object, produced in exactly one place per
  aggregate: the cycle decision core, the roadmap scheduler, and finalization. Suggested shape:
  `{subject, owner: 'operator' | 'controller', code, severity, message, since, actions[],
  blockers[]}`.
  - Persist it in the aggregate JSON as an additive optional field `attention`, written in the
    same transaction as the transition, or derive it on read from the same pure function.
  - The notification service, dashboard strip, roadmap view and work-item pages all consume
    `attention` and never re-derive.
  - `PhaseBlocker` gains a typed `code` and `owner` (see CTRL-11); `waiting` becomes
    `owner === 'controller'`.
  - Migration: compute `attention` lazily for records that lack it.
- Effort: L
- Related: CTRL-02, CTRL-03, CTRL-10, CTRL-11; UI reviewer
- Plan/roadmap format impact: none

### CTRL-06: Delegation grants are ignored by integration refresh and by notifications
- Severity: high
- Category: bug
- Status: CONFIRMED (code), latent in live data (no `delegationAssignments` exist yet)
- Evidence:
  - `RoadmapService` resolves automation through `effectiveDelegation(roadmap, entry,
    definition)` (`roadmap-delegation-policy.ts:10-27`; used at `roadmap-service.ts:1309-1313`
    and `:2192`), which includes `roadmap.delegationAssignments` (ADR-065).
  - `WorkCycleService.refreshOwner` reads `definition?.entries…automation ??
    definition?.automation ?? DEFAULT` (`work-cycle-service.ts:3191-3194`).
  - `NotificationService.attention` does the same (`notification-service.ts:256-258`).
  - Neither consults grants.
- Impact:
  - If a grant switches an entry's `integrationMerge` from automatic to manual, the roadmap stops
    merging. The notification service still believes the merge is automatic and suppresses the
    "Ready for merge" push. The item waits silently.
  - If a grant switches a sequential entry to automatic, `refreshOwner` returns `undefined`, so
    no integration refresh happens. If integration has advanced, the roadmap's `mergeWorktree`
    then fails `BranchService.assertReview`, which rejects a changed `targetSha`
    (`branch-service.ts:582-594`). The sequential roadmap, or the parallel entry hold, stops
    for attention instead of refreshing.
  - Conflict automation (`integrationConflicts`) has the same split.
- Recommendation: Route every automation read through one `ownershipAndAuthority(cycle)`
  policy (CTRL-07) that returns `{roadmap, attempt, definition, effectiveDelegation}`. Add a
  test that applies a grant and checks refresh, merge and notification behaviour.
- Effort: S
- Related: CTRL-07, CTRL-05
- Plan/roadmap format impact: none

### CTRL-07: Ownership of a cycle by a roadmap is resolved 11 ways, and the cycle has no owner field
- Severity: medium
- Category: architecture
- Status: CONFIRMED
- Evidence: Each of the following scans `roadmaps.list()` and `attempts` looking for
  `a.cycleId === cycle.id`:
  - `workflow-policy.ts:22-38` (`workflowDelegation`): cross-project roadmaps only, first match,
    `runnable = running && !hold`
  - `agent-profile-policy.ts:33`, `:80`
  - `work-cycle-service.ts:1596` (`providerRoadmapPaused`: any non-running owner)
  - `:1751` (designWait: owner not running)
  - `:3164` (`refreshOwner`: requires `attempt.status === 'active'`, running, no hold, recovery
    enabled)
  - `agent-run-service.ts:321-330` (duplicates `providerRoadmapPaused`)
  - `notification-service.ts:246-248` (running owner only)
  - `runtime-evidence-service.ts:1264`
  - `cycle-priority.ts:14`
  - `scope-recovery-policy.ts:132+`, which matches by **entry scope**, not by attempt

  Each scan parses the 248 KB roadmap JSON. Some also parse the 2 MB definition history (see
  CTRL-09).
- Impact: The rules for "is this cycle's roadmap paused, held, recovering, delegated" differ by
  call site, so behaviour diverges (CTRL-06 is one example). Every new roadmap feature has to
  update about 10 sites. The coupling is invisible in the type system.
- Recommendation:
  - Add an additive optional field `owner?: {roadmapId, attemptId, entryId,
    definitionRevision}` on `WorkCycle`. Set it when a roadmap creates the cycle
    (`advanceEntry` `:1497-1517`, `advanceScopeRecovery` via `delegateScopeRepair`). Backfill
    on read from attempts when absent, and persist on the next change.
  - Add one pure `cycleOwnership(tx, cycle)` that returns `{roadmap, attempt, entry,
    frozenDefinition, effectiveDelegation, runnable, recoveryActive}`, memoized per snapshot.
    Replace all 11 sites with it.
- Effort: M
- Related: CTRL-06, CTRL-09, CTRL-13
- Plan/roadmap format impact: none. Cycle JSON gains an optional field; roadmap definitions are
  unchanged.

### CTRL-08: The controller polls, costs 15–20 % CPU when idle, and blocks the event loop
- Severity: high
- Category: performance
- Status: CONFIRMED (measured). Attribution to specific call chains is HYPOTHESIS but is
  consistent with the measurements.
- Evidence:
  - The cycle loop re-reconciles every non-terminal cycle at least every second
    (`work-cycle-service.ts:1584-1589`, `timeoutMs: 1000`) and on every workflow notification.
  - An `awaiting-merge` cycle pays for these on each iteration:
    - `requireReady` → `requireScope` → `scopePhaseBlockers` (`:1691-1698`): 43.7 ms measured
    - `advanceWorkflow` → `workflowContext` (`:2326`, computed *before* the `runnable` check at
      `:2329`; called a second time at `:2374`): 54 ms each
    - `workflowDelegation`: 9.8 ms
    - `refreshIntegration`: three Git subprocesses (`branch-service.ts:850-868`) whenever the
      owner roadmap is running in parallel or automatic mode
  - Other measured costs (private DB copy, same data): notification `attention()` 54 ms with
    the roadmap paused and 158 ms with it running; `RoadmapService.view` 113 ms (171 entries);
    `crossProjectState` 133 ms; `deferredEntries` 83 ms; `WorkCycleService.list` 76 ms.
  - Live daemon (pid 1117545): 392 CPU ticks in about 20 s, which is roughly 20 % of one core.
    Lifetime average is 14.3 %. There were no live runs, the roadmap was paused, and no browser
    connection was open on :4600. The only active cycle is the `awaiting-merge` cycle
    `2f1ab211`, and its per-iteration cost of roughly 110 ms/s matches the observed load.
  - The loop is serial: `await this.reconcile(cycle)` (`:1550`). A launch preflight in
    `launchAuthorized` does Git checks, `runtimeEvidence.prepare` with `exportCommit` of whole
    upstream trees, and synchronous `writeFileSync` per file
    (`runtime-evidence-service.ts:2094-2200`). That delays deadline enforcement, turn-ending and
    launches for every other cycle, and synchronous FS work also stalls HTTP.
- Impact: UI slowness (pain point 3). Every HTTP request competes with 100–300 ms synchronous
  projection bursts on each workflow wakeup. Supervision latency depends on other cycles'
  launches. Power and CPU are wasted around the clock.
- Recommendation:
  - Replace polling with dirty-set scheduling. Events (run status change, command, evidence
    change, merge) mark specific aggregates dirty. Deadlines and backoffs become precise
    timers (`setTimeout` to `min(runDeadlineAt, providerRecovery.nextRetryAt, …)`). A periodic
    safety sweep every 30–60 s covers external Git changes.
  - Process dirty aggregates with bounded concurrency and a per-aggregate mutex, so one launch
    never blocks another cycle.
  - Move `exportCommit` and file materialization to async FS, off the loop.
  - Skip the expensive projections in states that cannot use them: compute `workflowContext`
    only when `runnable`, and skip `requireReady` for idle `awaiting-merge` cycles.
  - Cache immutable inputs (definitions by revision, parsed map sources) across snapshots.
- Effort: L for the kernel; S for the quick skips
- Related: CTRL-09, CTRL-01, CTRL-17; UI reviewer (refetch cost)
- Plan/roadmap format impact: none

### CTRL-09: The roadmap control row embeds the whole definition, and history is parsed on hot paths
- Severity: medium
- Category: performance
- Status: CONFIRMED
- Evidence:
  - Live roadmap `b81d5f92`: `state_json` is 248 KB, of which `definition` is 230 KB (171
    entries, each duplicating profiles, policy and instructions).
  - `roadmap_definitions` holds 14 revisions totalling 2.0 MB. `history()` parses all of them:
    `packages/storage/src/repositories/roadmaps.ts:67-79`, measured at 6–9 ms per call. It is
    called unmemoized from `workflowDelegation` (`workflow-policy.ts:26-28`), `refreshOwner`
    (`work-cycle-service.ts:3184-3189`) and several `RoadmapService` sites
    (`:1244`, `:1306`, `:1654`, `:1742`).
  - Every `RoadmapService.change` rewrites the 248 KB row, appends audit, and emits
    `roadmap-changed` (`:2211-2291`). The audit log shows 79 system writes whose only effect is
    to restore the reason "Parallel scheduling enabled…" (`this.reason(...)` at `:1126-1129`)
    after per-entry writes set "Running X" or "Preparing X".
  - The cycle `change()` also records large audit metadata (`work-cycle-service.ts:3916-4027`).
- Impact: Write amplification, WAL growth, event-loop time, and a `roadmap-changed` event per
  write that invalidates the browser's workspace summary (`apps/web/src/lib/workspace-projection.ts:175-178`),
  which triggers a 113 ms roadmap view recomputation per refetch.
- Recommendation:
  - Store only `definitionRevision` in the control state. Load definitions through a
    process-wide cache keyed by `(roadmapId, revision)`; definitions are immutable, so the cache
    is always valid. For DB compatibility, keep writing `definition` for one release while
    readers switch to the cache, then drop it.
  - Add `history.find(revision)` as an indexed single-row query.
  - Remove the roadmap-wide reason flip-flop: per-entry progress already carries entry reasons.
- Effort: M
- Related: CTRL-07, CTRL-08
- Plan/roadmap format impact: none. `RoadmapDefinition` is unchanged and still stored
  immutably; only the redundant embedded copy goes away.

### CTRL-10: `awaiting-merge` is overloaded with six meanings
- Severity: medium
- Category: architecture
- Status: CONFIRMED (code and live state)
- Evidence: `status: 'awaiting-merge'` is written for:
  1. standalone operator merge approval (`work-cycle-service.ts:2246-2253`)
  2. review-only scope "ready to record evidence" (`:2248-2249`)
  3. finalization promotion approval (`:2250-2251`, `:2644-2653`)
  4. controller-obligation wait for checkpoints and other slices (`advanceWorkflow`
     `:2414-2423`, action `workflow-wait`)
  5. "technical review finished, controller reviews held until scheduling resumes" (`:2330-2336`)
  6. automatic merge, verification or acceptance pending (roadmap automation)

  The status is also a gate: `ExecutionService.mergeWorktree` requires `cycle.status ===
  'awaiting-merge'` (`execution-service.ts:1332-1343`), and `requireManualControl` treats it as
  automation-owned (`agent-run-service.ts:495`).

  Live: cycle `2f1ab211` is `awaiting-merge` with reason "WI-WORKER-G1: Slice wi/WI-09/domain
  must be verified. Checkpoint WI-ADR-016 must pass…". Its notification
  `cycle:2f1ab211…:28:merge-requirements` ("Needs attention", 4 deliveries, still active) asks
  the operator to act on what ADR-063 calls a controller-owned obligation.
- Impact: The UI shows "Awaiting merge" for items that are neither mergeable nor waiting on the
  operator, and the dashboard counts them as attention. Notifications must re-derive which
  meaning applies (CTRL-05). Operators cannot tell "your approval" apart from "the controller is
  waiting on prerequisites".
- Recommendation: Keep the DB `status` enum for compatibility, but add a typed sub-state
  `gate?: {kind: 'operator-merge' | 'promotion' | 'record-evidence' | 'automatic-merge' |
  'controller-wait' | 'scheduling-held', blockers?}`. Only the decision core sets it. Consumers
  switch on `gate.kind`. Later, optionally migrate `controller-wait` and `scheduling-held` to
  `running` + `waiting`, with the DB CHECK constraint updated in a schema migration.
- Effort: M
- Related: CTRL-05, CTRL-02
- Plan/roadmap format impact: none

### CTRL-11: Control flow depends on the wording of human-readable messages
- Severity: medium
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - `work-cycle-service.ts:1642`: `/needs your input|Workflow report/.test(cycle.reason)`
    decides whether the ADR-063 automatic reassessment runs. It matches only some attention
    messages: "Implementation needs your input", "Review needs your input", "Workflow report
    needs correction". It does not match "Operator input required…" (`:2037`).
  - `phase-resources.ts:16`: `b.message.startsWith('Resource ')` decides wait versus attention.
  - `scope-repair.ts:56`: `/^(Required slice |Checkpoint )/.test(b.message)`.
  - `notification-service.ts:358` and web `RoadmapsPage.tsx:677`, `:951`,
    `RoadmapAttention.tsx:27`: `startsWith('Resource ')`.
  - `RoadmapAttention.tsx:5`, `:31`: `roadmap.reason.startsWith('Daemon restarted.')`. That
    reason survives unrelated writes; the audit log shows `save` and `apply-agent-profiles`
    actions still carrying it.
  - `/^## Open questions[ \t]*$/m` is inlined 6 times (`:956`, `:1332`, `:1883`, `:1937`,
    `:2112`, `:2144`). It ignores code fences, unlike `finalizationHasNoQuestions`
    (`finalization-policy.ts:27-44`) and `designHasNoOpenQuestions` (`domain/work-cycle.ts:252`),
    which use two different section-boundary rules (next heading versus end of text). Two more
    slicers exist at `workflow-policy.ts:176` and `architecture-decision-inbox.ts:111`.
- Impact: Rewording a user-facing message silently changes controller behaviour, with no type
  error and probably no failing test. The same "open questions" concept is parsed five
  different ways, so agent output can be classified inconsistently between the resume path and
  the reconcile path.
- Recommendation:
  - Add typed `code` fields: `attention.code`, `PhaseBlocker.code`, and a roadmap
    `restartRecovery: true` flag. Branch on codes, never on messages.
  - Provide one `openQuestions(text): {present, none, body}` parser in `contracts` next to
    `parseWorkflowReport`, and replace all inline regexes and variants with it.
  - For existing records without codes, map legacy messages to codes once in the decision
    core's fact builder. The mapping is isolated and tested.
- Effort: M
- Related: CTRL-01, CTRL-05
- Plan/roadmap format impact: none. The agent-output contract (`## Open questions`, workflow
  JSON) is unchanged; only its parsing is unified.

### CTRL-12: Manual commands accept transitions that the automated launch then rejects
- Severity: medium
- Category: bug
- Status: CONFIRMED (code and DB)
- Evidence: Whole-item predecessor gates have 4 implementations:
  - `WorkCycleService.requireReady`: DB status only (`work-cycle-service.ts:3821-3856`)
  - `BranchService.requirePredecessors`: DB status **and Git ancestry** of the predecessor merge
    in the integration target, used only at launch (`branch-service.ts:386-416`, from
    `validateLaunch` and `validateResolutionLaunch`)
  - `RoadmapService.blocker`: DB status plus in-flight attempts (`roadmap-service.ts:1941-1962`)
  - `scopePhaseBlockers`: scoped work only (`execution-scope.ts:131-151`)

  DB, cycle `2f1ab211`:

  | Seq | Actor | Action / result | Time |
  |---|---|---|---|
  | 2649 | user | `resolution-started` | 07:33:40.190Z |
  | 2651 | system | prepared | — |
  | 2652 | system | needs-attention: "Required predecessor WI-02's merge is absent from the integration branch" | 07:33:42.321Z |
  | 2655 | user | `resolution-resumed` | — |
  | 2657 | system | needs-attention: same message | 1.6 s later |

  Other divergences:
  - Roadmap `controlWithin` resume skips cycles with a merged worktree or a reserved merge
    (`:786-799`); `controlEntry` resume does not (`:888-898`).
  - The two remediation-grant validators use different error kinds for the same rule:
    `'invalid-request'` at `:838-843` and `:2851-2860`, `'conflict'` at `:994-1003` and
    `:1029-1038`.
- Impact: Operator commands appear to succeed and then bounce within seconds, creating
  attention churn (CTRL-03). The UI cannot show the real blocker before the operator acts.
- Recommendation: Put all start and advance gates, including predecessor ancestry, into one
  `transitionGate(facts, phase)` returning typed blockers. Commands evaluate it before
  accepting (the Git ancestry check can run in the command, since commands are already async)
  and launch evaluates it again at the mutation boundary. Expose the result on the cycle
  projection so the UI disables or explains actions.
- Effort: M
- Related: CTRL-04, CTRL-05
- Plan/roadmap format impact: none

### CTRL-13: Layering is inverted and responsibilities are misplaced across services
- Severity: medium
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - `WorkCycleService` re-implements roadmap policy:
    - `refreshOwner` computes scheduling mode, automation, entry holds, scope-recovery state and
      the frozen definition (`work-cycle-service.ts:3146-3214`)
    - `providerRoadmapPaused` (`:1593-1597`)
    - designWait roadmap-running check (`:1749-1752`)
    - roadmap-specific prompts via `workflowPrompt`
  - `AgentRunService.startForCycle` holds about 90 lines of cycle, finalization, recovery,
    resolution and continuation prompt policy (`agent-run-service.ts:363-445`) and roadmap pause
    rules (`:316-330`). `launchAuthorized` is a single 780-line method (`:503-1282`) that mixes
    authority, Git preflight, runtime prep, 9 kinds of plan-document materialization, brief
    composition, phase reservation, the DB insert, backend launch and supervision.
  - `ExecutionService.mergeWorktree` (388 lines) checks cycle status, finalization stage policy,
    the security-workflow receipt and scope review (`execution-service.ts:1284-1380`).
  - `RoadmapService` drives cycle commands with injected `check` and `attach` closures
    (`control(..., delegationCheck, onReviewReserved)` `:1176-1185`; `repeatScopeReview`;
    `delegateScopeRepair(…, delegation)`; `resolveIntegration(…, delegatedCheck)`).
  - Pure policies live in service files: `crossProjectState` and `milestoneSatisfied` in
    `cross-project-service.ts`, `mergeGateFor` in `execution-service.ts`. This causes the
    type-only import cycles `roadmap-service` ↔ `cross-project-service` and
    `execution-scope` ↔ `phase-resources`.
- Impact: No module can be understood or changed alone. A roadmap feature touches cycle,
  run-launch, merge and notification code. The 780-line launch method is the most critical path
  and the hardest to review.
- Recommendation: Target boundaries (see Remediation direction):
  - `roadmap-scheduler` owns admission and attempts and hands the cycle an `OwnerPolicy`
    snapshot (runnable, automation, refresh limits).
  - `cycle-core` (pure) plus `cycle-effects`.
  - `run-supervisor` (`AgentRunService` reduced to launch, supervise and journal).
  - `run-context` (materialize documents and compose briefs; move `startForCycle` prompt text
    and `launchAuthorized` document writing here).
  - `merge-gate` (pure) and `merge-executor`.
  - Move `crossProjectState`, `milestoneSatisfied` and `mergeGateFor` into policy modules.
- Effort: L
- Related: CTRL-01, CTRL-07, CTRL-14
- Plan/roadmap format impact: none

### CTRL-14: The same gates and validations are duplicated with drift
- Severity: medium
- Category: simplification
- Status: CONFIRMED
- Evidence:
  - Slice requirement satisfaction (started, merged, verified) is implemented twice: in
    `execution-scope.ts:237-266` (inside `scopePhaseBlockers`) and in `milestoneSatisfied`
    (`cross-project-service.ts:48-90`). `latestSliceMerge` (`execution-scope.ts`) is a pure
    alias of `integratedSlice`.
  - The "initiating user active and owner/editor" authority check is inlined at
    `work-cycle-service.ts:1675-1688`, `:2282-2285`, `:3025-3037`, `:3149-3156`, `:3201-3212`,
    `:3275-3288`, `:3372-3383`, `agent-run-service.ts:297-315`, `:703-713`, and as
    `RoadmapService.authority`.
  - The 16,000-character instruction bound is checked 7 times in `work-cycle-service.ts`, with
    different error kinds.
  - The "extra remediation rounds 1–20" validation appears 4 times.
  - The "roadmap must be paused / no pending amendment / not controlling" preconditions are
    copied in 6 `RoadmapService` commands (`:133-140`, `:215-220`, `:338-343`, `:434-439`,
    `:484-492`, `:518-529`).
  - Roadmap resume logic is duplicated between `controlWithin` and `controlEntry` with
    divergent conditions (CTRL-12).
- Impact: Fixes land in one copy. For example, the two remediation-grant validators already
  disagree on error kind. The review surface grows.
- Recommendation: Extract `requireDelegatedAuthority(tx, userId, workspaceId)`,
  `boundedInstructions(parts)`, `validateExtraRounds(n)`, and `requireRoadmapEditable(roadmap,
  op)`. Delete `milestoneSatisfied`'s slice branch in favour of the shared evaluator used by
  `scopePhaseBlockers`, or make both call one `sliceRequirementSatisfied`.
- Effort: S–M
- Related: CTRL-12, CTRL-13
- Plan/roadmap format impact: none

### CTRL-15: Dead and vestigial controller paths
- Severity: low
- Category: dead-code
- Status: CONFIRMED
- Evidence:
  - **Legacy finalization.** The rounds/`polishPhase` controller coexists with staged
    finalization (ADR-042: "absence selects the legacy controller"). Its branches are spread
    through `reconcile` (`:2129`, `:2170-2177`, `:2237-2245`), `decideFinalizationFindings`
    (`defer-nits` is legacy-only, `:797-798`), `finalizationInstructions`
    (`finalization-policy.ts:45-80`), `finalizationProfile` (`domain/finalization.ts:67-90`),
    `startFinalization` (`:609-643`) and the web `FinalizationPanel.tsx:275-293`, which still
    offers "Legacy improvement rounds". Live DB: 1 finalization, legacy, completed 2026-09-13;
    zero staged finalizations have run.
  - **`RepositoryInspectorProvider`.** Constructed in `composition.ts:122-133` and returned in
    `ServiceSet`, but not passed to `buildServer`. `docs/architecture.md:189-191` says it is
    uncomposed, which is not accurate.
  - **Always-supplied optionals.** `WorkCycleService` takes `branches?`, `baselines?`,
    `execution?` and `runtimeEvidence?`, all always supplied, so `unavailable` branches exist
    only for test seams (e.g. `:240`, `:372`, `:1145`, `:2343`).
  - **ADR-063 legacy reassessment.** The reason-regex path (`:1638-1669`) exists for "older
    unclassified stopped runs".
  - **`WorkCycleRepository.list(workspaceId?)` means two different things.** Without an
    argument it returns only non-terminal cycles; with an argument it returns all cycles
    (`packages/storage/src/repositories/execution/work-cycles.ts:43-56`).
- Impact: Every controller change has to preserve two finalization controllers and legacy
  classification paths, and the list trap invites bugs.
- Recommendation:
  - Remove "Legacy improvement rounds" from the start UI and the contract for new
    finalizations. Keep read-only rendering of the completed legacy record. Then remove the
    legacy branches from `reconcile`, `next` and the policies, keeping domain fields optional
    for old JSON.
  - Delete or route `RepositoryInspectorProvider`.
  - Make constructor dependencies required and use test doubles.
  - Once CTRL-11 codes exist, mark the reason-regex path for removal after existing cycles
    finish.
  - Split `list()` into `listActive()` and `listForWorkspace(ws)`.
- Effort: M
- Related: CTRL-01
- Plan/roadmap format impact: none for plans and roadmaps. The finalization start request loses
  `rounds` for new starts; existing records stay readable.

### CTRL-16: Error handling can leave cycles stuck or silently retrying
- Severity: medium
- Category: reliability
- Status: CONFIRMED (code); HYPOTHESIS (frequency)
- Evidence:
  - The cycle loop's catch (`work-cycle-service.ts:1565-1582`) records attention only when the
    cycle is `running` or `awaiting-merge` at an unchanged version. Errors from the
    needs-attention reassessment branch are dropped. Branch 1 (`:1619-1637`) calls
    `startWorkflowReview` → `next` → `cleanHead` without its own catch, unlike branch 2 at
    `:1661-1666`. A persistent failure (dirty worktree, gate error) is retried every loop
    iteration with a Git call and never shown to the operator.
  - A `PhaseGateError` wait writes `phaseWait` only if none exists (`:1557-1562`). Changed
    blockers are never refreshed, so the UI shows stale wait reasons.
  - The `RepositoryMutationBusyError` path in refresh rewrites status and reason
    (`:3309-3313`), losing the previous `awaiting-merge` reason (for example the workflow
    waiting text) and bumping the version twice (CTRL-03).
  - In sequential mode, any unexpected `advanceEntry` error sets the whole roadmap
    `needs-attention` with a generic message (`roadmap-service.ts:1000-1009`).
- Impact: Invisible busy loops, stale explanations, and a whole-roadmap stop for one item's
  problem.
- Recommendation: In the decision-core model, every effect failure maps to an explicit
  `attention` or `wait` decision with a code. The loop never swallows errors for non-running
  states. The busy path becomes a controller-owned `wait{code: 'repository-busy'}` without
  rewriting the reason or status. `phaseWait` is updated whenever the blocker set digest
  changes.
- Effort: S–M
- Related: CTRL-01, CTRL-03, CTRL-08
- Plan/roadmap format impact: none

### CTRL-17: About nine uncoordinated in-memory locks with different semantics
- Severity: medium
- Category: reliability
- Status: CONFIRMED (inventory); HYPOTHESIS (specific race)
- Evidence:
  - `WorkCycleService.transitioning`: throws conflict; also hides cycles from notifications and
    views
  - `refreshing`: `reconcile` returns early; `refreshIntegration` returns `true`, meaning
    "handled"
  - `repairing`, `ending`
  - `RoadmapService.controlling`: commands throw; `tick` skips; `view` shows an edit blocker
  - `ticking`
  - `AgentRunService.pendingCycleLaunches`
  - `BranchService.mergingRepositories`: throw busy, or return `undefined` = "wait"
  - `WorktreeMutationGuard`
  - `StorageService.runCleanups`

  These are combined with version CAS and threaded `check()` closures. The order of resume
  operations (T6 in the Map) is protected only by a comment (`roadmap-service.ts:759-761`).
  HYPOTHESIS: during roadmap resume, cycles resumed before the roadmap flips to `running` can
  be evaluated with `workflowDelegation(...).runnable === false`. `advanceWorkflow` then writes
  `awaiting-merge` "held until scheduling resumes" (`:2329-2336`), a durable status the
  notification service may push.
- Impact: Correctness depends on subtle combinations of lock semantics. Adding a new
  asynchronous command needs knowledge of all nine mechanisms.
- Recommendation: One per-aggregate serial executor in the controller kernel (CTRL-08): a keyed
  async mutex for cycle ID, roadmap ID and repository path. Every command and loop step for an
  aggregate runs through it. Keep the DB CAS as the durable safety net. In roadmap
  resume, persist `running` first (or in the same transaction as the cycle resumes) and then
  wake the cycles.
- Effort: M (as part of the kernel)
- Related: CTRL-08, CTRL-01
- Plan/roadmap format impact: none

### CTRL-18: The controller has no unit-testable transition core
- Severity: medium
- Category: testing
- Status: CONFIRMED
- Evidence: There is no `work-cycle-service.test.ts` or `roadmap-service.test.ts`. Controller
  behaviour is tested only through `apps/server/src/server-execution.test.ts`: 14,084 lines,
  184 tests, real loops, and `waitFor(predicate, label, 3000)` polling (`:498`). Only the pure
  helpers have unit tests (`cycle-priority`, `design-recovery`, `agent-profile-policy`, …).
- Impact: Transition behaviour can only be checked in slow, timing-sensitive end-to-end
  scenarios. Precedence bugs like CTRL-04 and CTRL-16 are not practical to enumerate.
  Refactoring the controller is high-risk without a characterization layer.
- Recommendation: Before refactoring, add a replay/characterization harness. For every cycle
  in a DB snapshot (a copy of the live DB works: 51 cycles, 308 runs), compute the decision
  with the current code (the `reconcile` classification section, extracted but unchanged) and
  record it as golden output. Then add table-driven tests for `decide(cycle, facts)` covering
  every `attention` code, wait code and launch path.
- Effort: M
- Related: CTRL-01
- Plan/roadmap format impact: none

### CTRL-19: Many operator decisions require pausing the whole roadmap
- Severity: medium
- Category: ux
- Status: CONFIRMED
- Evidence: A whole-roadmap pause (or no running roadmap) is required for:
  - approving architecture decisions (`architecture-decision-inbox.ts:34-39`;
    `runtime-evidence-service.ts:1686`), plus "Wait for live runs on this map to finish"
    (`:40-49`)
  - preparing a decision (`roadmap-service.ts:217-218`)
  - applying delegation, which also requires **no live runs and no running cycles anywhere in
    the workspace** (`:340-348`, ADR-065)
  - agent profiles (`:137-138`)
  - capacity (`:436-437`)
  - scope-recovery policy (`:486-490`)
  - editing entries (`:526-529`)
  - dependency refresh (`runtime-evidence-service.ts:398`)
  - host capacity: every workspace (`host-scheduling-service.ts:133`)

  Pausing pauses every running owned cycle (`roadmap-service.ts:828-836`). Resuming re-resumes
  each one through `control()`, with the ordering hazard T6.
- Impact: Answering one ADR question on one slice stops all parallel development and requires
  a full resume, with its own failure modes and re-notifications. This is a major source of the
  "many paths to the same places" friction in pain point 1.
- Recommendation: Replace the global pause with scoped consistency. Commands lock only the
  affected entries, decisions or bindings, using the per-aggregate mutex (CTRL-17), and
  in-flight runs pin their inputs (ADR-064/065 already pin grants to launch time). Where a
  global invariant is required (host capacity), use an explicit "drain" state that stops new
  admissions but lets running steps finish, instead of pausing cycles.
- Effort: M–L
- Related: CTRL-17, CTRL-04; UI reviewer
- Plan/roadmap format impact: none

### CTRL-20: Every restart stops all automation and kills in-flight agent work
- Severity: low
- Category: reliability
- Status: CONFIRMED (by design; ADR-025/029/062)
- Evidence:
  - `WorkCycleService.shutdown` kills every running cycle's session (`:1534-1540`).
    `AgentRunService.shutdown` kills all live runs (`agent-run-service.ts:1507-1518`).
  - On start, running cycles and roadmaps become `needs-attention` and require explicit resume
    (`work-cycle-service.ts:1507-1528`, `roadmap-service.ts:942-947`). Each triggers operator
    alerts.
  - The audit log has 13 "Daemon restarted" roadmap and cycle writes since 2026-09-12. The
    reason text persists through later `save` and `apply-agent-profiles` actions.
- Impact: Deploys and restarts (frequent while CraftingTable develops itself) cost agent time,
  and each one requires a manual resume sweep.
- Recommendation: Add a "drain then restart" operator action: stop admitting new steps, let live
  runs finish, and restart when idle. After a clean drain, restart can auto-resume roadmaps
  whose durable state is consistent: no reserved-but-unlaunched runs and no Git operations in
  flight. Keep explicit resume for unclean shutdowns. Replace the `'Daemon restarted.'` reason
  sniffing with a typed flag (CTRL-11).
- Effort: M
- Related: CTRL-11, CTRL-19
- Plan/roadmap format impact: none

### CTRL-21: Map-specific vocabulary is hard-coded in the controller
- Severity: low
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - Reviewer role `'independent-security-reviewer-if-required-by-source'`
    (`work-cycle-service.ts:2274`, `:2307`)
  - `'repository-maintainer'` (`:2308`; `architecture-decision-policy.ts:27`)
  - Resource IDs `'isolated-development-workspace'` and `'controlled-native-test-host'`
    (`phase-resources.ts:28-45`)
  - Kata/AQ-specific prompt and brief text, including "The image includes Rust 1.89"
    (`agent-run-service.ts:1042-1066`)
  - Security-review focus text (`workflow-policy.ts:181`)
- Impact: The generic controller carries assumptions from the reference WI/EXO map. The future
  Studio's plans will need these as declared data, not code.
- Recommendation: Move role, resource-adapter and brief-fragment vocabulary into a
  controller-configuration module keyed by map-declared IDs, or into map `evidence_profiles`
  and `resource_profiles` metadata that already exists in the format. Keep today's IDs as
  defaults.
- Effort: M
- Related: CTRL-13
- Plan/roadmap format impact: none required. The existing v0.3 fields (`reviewer_roles`,
  `resource_profiles`) already carry the IDs; the change moves behaviour lookup to data.

### CTRL-22: The API returns projection fields mixed into the domain `WorkCycle`
- Severity: low
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - `WorkCycleService.list` (`:135-164`) returns cycles with `nextAgentSelections`,
    `scopeReviewWait` and `mergeRequirementsWait`, and **overwrites `workflow.questions`** with
    `operatorQuestionRoutes(...)` derived from free text (`:147-158`, `workflow-policy.ts:167-196`).
  - The domain type documents these as "Read projection only"
    (`domain/work-cycle.ts:106-118`), but they share the persisted type.
- Impact: Clients cannot distinguish stored state from projection. A fabricated
  `workflow.questions` looks like a controller classification, and projections compete with
  CTRL-05's single attention model.
- Recommendation: Return `{cycle, projection: {attention, actions, nextAgentSelections,
  waits}}` from a `CycleView` contract type, and remove projection fields from the domain type.
- Effort: S–M
- Related: CTRL-05, CTRL-10
- Plan/roadmap format impact: none (a wire contract change to coordinate with the web)

## Remediation direction

### Target design

```text
                 events (run status, command, evidence/merge change, timer due)
                                     │
                             ControllerKernel
         dirty set + precise timers + per-aggregate async mutex + bounded pool
            │                         │                            │
   CycleReconciler           RoadmapScheduler           FinalizationCoordinator
   facts ← snapshot          admission/attempts only    stage ledger + promotion
   decide(state, facts)      (pure selection policy)    (pure stage policy)
     → Decision {launch | wait | attention | approve | effect | complete}
            │
   Effects: RunSupervisor (launch/supervise only) · RunContext (docs+brief)
            GitEffects (checkpoint/refresh/resolution) · MergeExecutor · EvidenceRecorder
            │
   Same transaction: aggregate state + Attention{owner, code, actions} + audit + event
            │
   Consumers read Attention only: NotificationService (settled, operator-owned),
   Dashboard strip, Roadmap view, Work-item page, Decision inbox
```

Module boundaries:

- **`controller/cycle/`**
  - `facts.ts`: snapshot to `CycleFacts`, with one open-questions parser and one report parser
  - `machine.ts`: pure `decide`, with an explicit ordered guard list and transition table
  - `actions.ts`: valid operator actions per attention code
  - `effects.ts`
  - `reconciler.ts`
- **`controller/roadmap/`**
  - `selection.ts`: pure; today's `blocker`, `deferredEntries`, `complete`
  - `ownership.ts`: `cycleOwnership` and `effectiveDelegation`
  - `recovery.ts`: scope recovery as a pure decision plus effects
  - `scheduler.ts`
- **`controller/gates/`**
  - `transition-gate.ts`: one evaluator for whole-item and scoped work, including predecessor
    ancestry; the command variant and the launch variant share code
  - `attention.ts`: the `Attention` and `PhaseBlocker` codes, plus owner classification
- **`controller/kernel.ts`**: replaces the three polling loops and the in-memory lock sets.
- **`runs/`**
  - `supervisor.ts`: today's `AgentRunService` minus the brief and cycle logic
  - `context.ts`: document materialization and brief composition, async FS
- `NotificationService` becomes an outbox of **operator-owned, settled** attention keyed by
  attention identity.

### Sequencing (each step keeps existing DB records, plans and roadmaps valid)

1. **Stop the noise** (S, about 1 day):
   - CTRL-03: attention-identity source keys
   - CTRL-02: settle delay, plus skipping queued dependency-refresh and reassessment-eligible
     cycles
   - CTRL-06: `effectiveDelegation` in `refreshOwner` and notifications
   - CTRL-08 quick skips: compute `workflowContext` only when runnable; skip `requireReady` for
     idle `awaiting-merge` cycles; memoize definition-by-revision
   - CTRL-16: a proper catch for reassessment branch 1

   No schema change.
2. **Characterization harness** (CTRL-18, M). Extract `reconcile`'s post-run classification
   (`:1858-2254`) into a pure function **without behaviour change**. Record golden decisions
   over a DB-copy replay and add table tests.
3. **Typed codes** (CTRL-11). Add optional `code` to `PhaseBlocker` and attention, plus a
   `restartRecovery` flag. Map legacy reason and message strings to codes in one fact builder.
   Replace string checks on the server and the web.
4. **Attention model and actions** (CTRL-05, CTRL-04, CTRL-10, CTRL-22).
   - Persist `attention` and `gate` as additive optional JSON on cycles, and `entryAttention` on
     roadmaps; derive them when absent.
   - Switch the notification service, dashboard, roadmap view and work-item page to read them.
   - Gate the resume command on `actions`.
5. **Ownership and definition pointer** (CTRL-07, CTRL-09). Add a `WorkCycle.owner` optional
   field, backfilled on read. Roadmap control state reads its definition through the
   revision cache. Remove the reason flip-flop.
6. **Kernel** (CTRL-08, CTRL-17, CTRL-19).
   - Dirty-set scheduling, precise timers, per-aggregate mutex, async launch preparation.
   - Retire the 1 s loops.
   - Replace global-pause preconditions with scoped locks and a drain state.
7. **Decomposition and cleanup** (CTRL-13, CTRL-14, CTRL-15, CTRL-21).
   - Move roadmap knowledge out of the cycle service.
   - Split `launchAuthorized`.
   - Merge the duplicated gates.
   - Retire legacy finalization for new starts.
   - Make constructor dependencies required.

Across all steps: DB status enums, cycle and roadmap JSON, and plan/roadmap definitions stay
backward-compatible. New fields are optional and derived when absent. The v0.3 map and
plan-bundle formats are untouched.
