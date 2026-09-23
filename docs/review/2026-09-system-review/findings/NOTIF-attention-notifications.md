# NOTIF — Attention, notifications, event journals and wakeups

Reviewer scope: `apps/server/src/services/notification-service.ts` (673 lines),
`notification-transport.ts` (109), `workspace-event-notifier.ts` (73),
`workspace-event-stream-service.ts` (92), `run-event-stream-service.ts` (75),
`packages/domain/src/workspace-events.ts` (517), `packages/contracts/src/workspace-event.ts` (659),
`packages/storage/src/repositories/notifications.ts`, the attention derivations in
`work-cycle-service.ts` / `roadmap-service.ts` / web `AttentionStrip.tsx` / `RoadmapAttention.tsx`,
ADR-003, ADR-010, ADR-027, ADR-063, and `apps/server/src/notifications.test.ts` (911).

Live data: read-only queries against `~/.local/share/craftingtable/state/craftingtable.sqlite`
on 2026-09-22/23. Analysis scripts are in the scratchpad ((review-session analysis script, not retained)). Every
number below comes from those queries. Notifications span 2026-09-11 07:29Z → 2026-09-23 00:36Z (about 12 days).

## Summary

- **The false-alarm mechanism (CONFIRMED).** Nothing waits for the state to settle. A notification
  record is created with `nextAttemptAt = now` (`notification-service.ts:453`). The notification
  worker wakes on the same `workflow` notify that the controller's attention write fires
  (`work-cycle-service.ts:3913`, `notification-service.ts:186-197`). Its reconcile runs synchronously
  in one transaction. The follow-up automation that would resolve the state runs in the cycle
  worker's *next* pass, or in the roadmap worker, which has a separate loop and 1 s/5 s timers.
  So the push almost always wins that race. Measured over all 134 sent records: median 0.66 s from
  record creation to first push, and 127 of 134 went out in under 2 s.
- **Suppression works by prediction, not by declaration (CONFIRMED).** `NotificationService.attention()`
  re-derives whether some automation *will* act: roadmap auto-merge or conflict policy, automated
  scope recovery, scope-review waits, recovery commands in flight. Every automation the service
  does not mirror becomes a false alarm. Confirmed live instance: `cycle:188747f3…:2` was pushed
  1.6 s before the roadmap's queued dependency-refresh started "review-again" on its own. Near miss:
  `cycle:10dbc912…:18` was created 0.23 s after the needs-attention write, and the roadmap reserved
  scope recovery 0.69 s later. A send was attempted. It failed only because of a network error.
- **Cost of the prediction approach.** `notification-service.ts` has been changed in 12 commits
  over 12 days. Nearly every new automation feature needed its own suppression clause. This is the
  "fixing blockages one at a time" pattern the operator described.
- **Occurrence identity includes `cycle.version` (CONFIRMED).** Any version bump that leaves the
  blocker in place starts a new occurrence: a new push and a restarted reminder schedule. Examples:
  - The operator's own two-step baseline-preparation command paged them twice per cycle, 4 pushes
    in 3 minutes.
  - The same scope review produced 13 occurrences with identical text.
  - One cycle version produced two occurrences, `:merge-requirements` then `merge`, for 10 pushes.
  - Roadmap checkpoint alerts are keyed on a hash of the eligible set: 10 occurrences, 30 pushes.
- **No awareness that the operator is present (CONFIRMED).** 53 of 134 first pushes (40%) went out
  within 120 s of an operator action in the audit log.
- **Storage alerts flap (CONFIRMED).** There is no hysteresis. On 09-15, 01:45–02:20Z, three volume
  alerts resolved and reappeared every 10–25 s: 7 bursts of 3 pushes in 35 minutes.
- **Every daemon restart pages the operator (CONFIRMED)**, even when the operator restarted it:
  12 restart-induced needs-attention transitions and 8 pushes.
- **Reminders are 62% of pushes**: 222 of the 356 deliveries attributable to surviving records.
- **Notification history is overwritten (CONFIRMED).** `UNIQUE(workspace_id, source_key)` plus
  reactivation that reuses the old id means only the latest occurrence survives. 494 delivery
  journal rows exist, but only 356 deliveries are attributable to surviving records, so at least
  133 pushes can no longer be traced to what they said.
- **Attention is computed in at least four places, each with its own rules (CONFIRMED):**
  - `NotificationService.attention()`
  - `WorkCycleService.list()` plus the web `attentionCycles()`
  - `RoadmapService` entry progress plus `RoadmapAttention`
  - the dashboard "Needs attention" card, which actually counts plan-import problems

  They disagree. A queued dependency refresh shows as "queued" on the roadmap but as "Needs
  attention" in the push. The only persisted record of what paged the operator is shown on the
  Settings page.
- **Event noise drives UI churn (CONFIRMED).**
  - Notification bookkeeping is 24% of all workspace events (792 of 3,289).
  - 320 of 1,202 event bursts are notification-only. Each one triggers the browser's full
    refetch (snapshot, audit, workspace list, cycles, route detail).
  - The fixed 200 ms leading window splits multi-second automated cascades (up to 22 events over
    14 s) into several refreshes: 2,258 implied refresh cycles for 3,096 events.
- **Heavy projection under a write lock (CONFIRMED code path; cost is a HYPOTHESIS).** The
  whole-workspace attention projection runs inside an IMMEDIATE transaction, up to 2k+1 times per
  tick (k = records delivered in that tick), on every workflow wakeup and every 5 s. It includes
  `statfs`/`realpath` filesystem calls and cross-project map evaluation. better-sqlite3 is
  synchronous, so this blocks the daemon's event loop.

## Map

### Components and responsibilities

| Component | File (lines) | Role |
|---|---|---|
| `WorkspaceEventNotifier` | `services/workspace-event-notifier.ts` (73) | In-memory wakeup only. Two counters: `generation` (all) and `workflowGeneration`. `notify('workflow')` (the default) bumps both; `notify('activity')` bumps only `generation`. Waiters resolve on generation change or timeout. Carries no data (ADR-010). |
| Workspace journal | `workspace_events` table (append-only, triggers), repo `repositories/workspace-events.ts`, domain `workspace-events.ts` (26 kinds), contracts `workspace-event.ts` (strict Zod per kind) | The browser's invalidation feed (ADR-003). Written in the same transaction as state and audit (ADR-010). |
| Run journal | `agent_run_events` (46,446 rows) | High-volume per-run events, streamed per run. |
| `WorkspaceEventStreamService` | (92) | SSE generator. Re-authenticates each iteration, lists up to 100 events after the cursor, then waits on **any** notifier generation (not only workflow) or 1,000 ms (`STREAM_REQUERY_INTERVAL_MS`). |
| `RunEventStreamService` | (75) | Same pattern for one run's events (limit 200). |
| `NotificationService` | (673) | Owner settings, test sends, and a background worker (`loop` → `tick` → `deliverDue`). `attention()` derives the desired set; `reconcile()` diffs it against `notification_records` (create, resolve, reactivate); the claim uses a 60 s lease; the send goes through the transport; a post-send transaction reconciles again and schedules the retry or reminder. `journal()` writes an audit row plus a `notifications-changed` workspace event for every settings, attention, delivery or test change. |
| `PushoverTransport` | (109) | Single fixed endpoint, 10 s timeout, priority 0. Maps 429 / 5xx / other statuses / throws to `retry` or `blocked`. |
| Reminder schedule | `packages/domain/src/notification.ts` `nextReminderAt` | +30 min, then +1…+6 h, then daily at the local time (21:00 America/Los_Angeles). |
| Storage | `notification_records(id PK, workspace_id, source_key, state, state_json, UNIQUE(workspace_id, source_key))`, `notification_settings` | Upsert on `id`. A reactivated occurrence reuses the id, so createdAt and counters are overwritten. |

### Attention sources in `NotificationService.attention()` (`notification-service.ts:208-443`)

1. **Storage alerts** (`storage:volume:<path>`, `storage:maintenance`). Computed live from
   `StorageService.alerts()` → `status()`, which calls `statfs`/`realpath` on every root and on
   worktree and run directories (`storage-service.ts:148-230`).
2. **Per active worktree:**
   - If a non-terminal cycle exists, only `awaiting-merge` and `needs-attention` qualify. These are
     then filtered by `cycleTransitioning`, `automatedScopeRecoveryWait`, `scopeReviewWait`, and a
     re-implementation of roadmap auto-merge and auto-conflict policy (lines 246-274).
   - Key: `cycle:<id>:<version>[:merge-requirements]`.
   - If there is no active cycle, a standalone run that is failed/interrupted, or a finished
     review/design turn, qualifies. Key: `run:<id>:<seq>[:status]`.
3. **Per running roadmap:**
   - Slice-verification environment waits: `roadmap:<id>:environments:<sha(list)>`.
   - Cross-project checkpoints that are eligible: `roadmap:<id>:checkpoints:<sha(list)>`.
   - Entry holds with status needs-attention: `roadmap:<id>:entry:<entry>:<sha(reason)>`.
4. **Roadmap status needs-attention:** `roadmap:<id>:<version>`.

### Timers and wakeups

| Worker | Wakes on | Timeout |
|---|---|---|
| Cycle worker (`work-cycle-service.ts:1541-1591`) | workflow | 1,000 ms |
| Roadmap worker (`roadmap-service.ts:956-972`) | workflow | 1,000 ms if any running non-cross-project roadmap, else 5,000 ms. The live roadmap is cross-project, so 5 s. |
| Notification worker (`notification-service.ts:184-199`) | workflow | 5,000 ms |
| SSE streams | any notify | 1,000 ms |

Run events notify as follows (`agent-run-service.ts:1667-1671`): `session-started`,
`turn-completed` and `run-finished` notify `workflow`; every other event notifies `activity`,
which wakes every SSE stream in every workspace.

### Sequence: run finishes inside an automated cycle → next run starts

| # | Transaction / step | Workspace events | Notify | What `attention()` sees |
|---|---|---|---|---|
| 1 | `appendEvent(turn-completed)` (`agent-run-service.ts:1651`) | – | workflow | cycle `running` → skipped (`notification-service.ts:243-244`) |
| 2 | `transition(running→waiting)` (1680-1722) | `agent-run-status-changed` | workflow | skipped |
| 3 | Cycle pass: `run.status==='waiting'` → `finishCycleTurn` ends the session (`work-cycle-service.ts:1859-1862`) | – | – | skipped |
| 4 | `finalize(finished)` (1724-1810): release reservation, run-finished event, audit | `agent-run-status-changed` | workflow ×2 (the second after async cleanup; the cycle pass skips while `isCleaningRun`) | skipped |
| 5a | Cycle pass: success → `finalizeImplementation` (git), `refreshIntegration`, `next()` → `cleanHead` (git) → `change()` → `running`, new `currentRunId` (3707-3806) | `work-cycle-changed` | workflow | skipped (still `running`) |
| 5b | **or** Cycle pass: questions / invalid report / failure → `attention()` → `change({status:'needs-attention'})` (3866-3868) | `work-cycle-changed` | workflow | **desired → record created (≈0.1-0.3 s later) → pushed (median 0.66 s after creation)** |
| 6 | Next cycle pass: `startForCycle` → run row `starting` → spawn → `session-started` → `running` | `agent-run-started`, `agent-run-status-changed` | workflow | skipped |
| 6' | After 5b, automation may still take over: reassessment on the **next** cycle pass (`work-cycle-service.ts:1615-1665`), roadmap scope recovery, a queued dependency refresh (`roadmap-service.ts:1164-1215`), automatic scope-evidence recording, or auto-merge | `work-cycle-changed`, `roadmap-changed` ×n | workflow | record resolved at the next reconcile, **after the push** |

The plain run → run path (5a) never notifies: the cycle stays `running`, and `attention()` ignores
running cycles. False alarms come from path 5b followed by 6', and from version churn and presence
(below). A simple automated step emits 5 workspace events (measured 2026-09-15 00:56:46). A
roadmap cascade emitted 22 events over 14 s (2026-09-21 23:56:27): 8 `roadmap-changed`,
5 `work-cycle-changed`, 4 `notifications-changed`, and others.

### Live volumes

- `workspace_events`, 3,289 total:
  | Kind | Count |
  |---|---|
  | agent-run-status-changed | 1,017 |
  | **notifications-changed** | **792** |
  | work-cycle-changed | 558 |
  | agent-run-started | 308 |
  | roadmap-changed | 252 |
  | branches-changed | 104 |
  | runtime-evidence-changed | 73 |
  | worktree-created | 55 |
  | worktree-merged | 39 |
  | scope-evidence-recorded | 30 |
  | (rest) | small |

  About 250 events/day, with a peak of 590 on 09-18.
- `audit_events` action `notifications.updated`: 790 system rows (494 delivery, 296 attention) plus 2 user rows.
- `notification_records`: 139 (2 active, 137 resolved).
  | Source prefix | Records |
  |---|---|
  | cycle | 115 |
  | roadmap | 19 |
  | storage | 4 |
  | test | 1 |

  By kind: attention 114 records / 329 deliveries; merge 24 / 26; test 1 / 1.

## Findings

### NOTIF-01: No settle period — notifications race the controller's own follow-up transitions
- Severity: high
- Category: bug
- Status: CONFIRMED (mechanism, plus one live false alarm and one live near miss)
- Evidence:
  - **No delay on new records.** `record()` sets `nextAttemptAt: this.now()` (`notification-service.ts:453`).
    The claim picks any record with `nextAttemptAt <= now` in the same transaction that created it
    (`:532-563`).
  - **Same wakeup as the controller.** `WorkCycleService.change()` fires `notifier.notify()`, which
    defaults to `workflow` (`work-cycle-service.ts:3913`; `workspace-event-notifier.ts:30`). The
    notification loop waits on the `workflow` channel (`notification-service.ts:192-197`). So the
    worker wakes on the attention write itself.
  - **Takeovers happen later.** The takeover paths run afterwards:
    - reassessment of unclassified questions, on the cycle loop's next pass (`work-cycle-service.ts:1615-1665`);
    - roadmap scope recovery, dependency-refresh review-again and scope-evidence recording, in the
      roadmap loop, which has a separate 1 s/5 s cadence and serialized async `advance`
      (`roadmap-service.ts:956-1000`, `1164-1215`).
  - **Latency.** Median 0.66 s from record creation to push; p90 1.6 s; 127 of 134 under 2 s.
  - **False alarm, `cycle:188747f3-…:2`** ("EXO-02 · Needs attention: wi integration changed.
    Preview dependency refresh…"):
    - 01:09:40.758Z: record created, when the automatic scope evidence at 01:09:40.602 lifted `scopeReviewWait`.
    - 01:09:41.279Z: pushed.
    - 01:09:42.321Z: the roadmap (actor `system`) ran `review-again`.
    - No operator action in between.
  - **Near miss, `cycle:10dbc912-…:18`:**
    - 02:55:36.356Z: cycle set to needs-attention.
    - 02:55:36.581Z: record created.
    - 02:55:37.269Z: roadmap `reserve-scope-recovery`.
    - 02:55:39.449Z: send failed with "could not be confirmed"; the record then resolved.

    The alert was only avoided because Pushover was unreachable.
  - `NotificationService` has no notion of "the controller is mid-pass". The only transient guard,
    `cycleTransitioning`, covers operator recovery commands only (`work-cycle-service.ts:97-118`,
    `composition.ts:300-309`).
- Impact: The operator is paged for states the controller resolves itself within about a second.
  This is the "notifications while transitioning" complaint. Newly enabled delegation will make
  the reassessment path frequent (commits bfdd295, bf08c0b; ADR-063: "at most two read-only
  reassessments under a running roadmap"). The pattern: a slice turn ends with open questions and
  no workflow report → needs-attention → push → reassessment on the next pass.
- Recommendation:
  1. **Immediate (S).** Give new non-test records `nextAttemptAt = createdAt + settle`, around
     30 s, and keep the existing re-check at claim time (reconcile runs inside the claim
     transaction). Resolution before the settle time means no push.
  2. **Proper fix (M).** Use a quiescence gate. Each controller worker (cycle and roadmap) records
     the `workflowGeneration` at which its last *complete* pass started. A record is eligible only
     when every worker has completed a pass that started after the record's opening generation,
     and a minimum settle time (for example 10 s) has passed. Then every automation has had one
     full chance to take over. Add in-memory "pass in progress" ownership for cycles that the
     controller is actively handling (`ending`, `refreshing`, `isCleaningRun`, mutation guard) and
     treat those like `cycleTransitioning`.
- Effort: S (settle) / M (quiescence gate)
- Related: NOTIF-02, NOTIF-03, NOTIF-04
- Plan/roadmap format impact: none

### NOTIF-02: Attention is inferred by predicting automation; each new automation needs a matching suppression clause
- Severity: high
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - **Mirrored policies.** `attention()` duplicates each automation's policy by hand:
    - roadmap integration merge / parent acceptance / conflict automation (`notification-service.ts:246-274`);
    - `automatedScopeRecoveryWait`, which predicts "the roadmap will delegate…" by calling
      `scopeRecoveryDecision` (`scope-recovery-policy.ts:127-167`);
    - `scopeReviewWait` / `scopeMergeWait` (`scope-repair.ts:13-63`);
    - entry-hold takeover (`:399-414`);
    - `scopeComplete` (`:461-481`);
    - `cycleTransitioning` (`:238`, `:482-492`).
  - **Churn.** 12 commits in 12 days changed `notification-service.ts`, usually alongside a new
    automation (d9fd1d2 … 027ee49). c48acbc "quiet scheduler transitions" added
    `cycleTransitioning` and `scopeComplete`.
  - **Missing mirrors (CONFIRMED):**
    - `attempt.dependencyRefresh` (queued automatic review-again): not consulted. The roadmap's own
      progress view knows it ("Fresh independent review queued…", `roadmap-service.ts:~2136`). Hence
      NOTIF-01's false alarm.
    - The workflow reassessment conditions (`work-cycle-service.ts:1615-1665`) are not consulted.
  - **Possible duplication (HYPOTHESIS).** `roadmap:<id>:checkpoints:*` alerts ("eligible for
    independent evidence review") may duplicate automated checkpoint reviews introduced by
    ADR-063/060 (`startWorkflowReview(…,'checkpoint')`). The alert does not check whether a
    delegated reviewer is assigned.
- Impact: Every automation feature can create false alarms until someone writes a matching
  predicate. The predicates drift from the real scheduling code. The service needs knowledge of
  every policy module (it imports 5 policy modules plus the cross-project service).
- Recommendation: Invert responsibility. Whenever the controller writes a blocking state
  (`attention()` in `WorkCycleService`, entry holds, roadmap needs-attention, awaiting-merge,
  workflow waits), it also writes a structured `blocker`:
  `{ owner: 'operator' | 'controller', kind: 'decision' | 'merge-approval' | 'recovery' | 'setup' | 'failure' | 'restart', subjectKey, destination, message }`.
  - Automation that intends to act next marks `owner: 'controller'`. Examples: reassessment pending,
    dependency refresh queued, scope recovery pending, auto-merge pending.
  - When automation gives up, it flips the owner to `'operator'` in the same transaction.
  - `NotificationService` then only selects `owner === 'operator'` blockers and imports no policy
    modules.
- Effort: M
- Related: NOTIF-01, NOTIF-09
- Plan/roadmap format impact: none. Blockers are derived runtime state; roadmap definitions are unchanged.

### NOTIF-03: Occurrence key includes `cycle.version` (and content hashes), so unrelated version bumps re-page
- Severity: high
- Category: ux
- Status: CONFIRMED
- Evidence:
  - **Key shape.** `sourceKey = cycle:${id}:${version}` (`notification-service.ts:283`). Roadmap
    alerts use `roadmap:<id>:<version>`, `…:entry:<sha(reason)>`, `…:checkpoints:<sha(set)>`.
    A new key means a new record with `nextAttemptAt = now` and a fresh reminder schedule
    (`:513-525`).
  - **Operator's own command paged them.** The operator ran baseline preparation on cycles
    ac9b0f0f and 23e2a661 (09-17). `baseline-preparation-reserved` (v3) and `-completed` (v4)
    left the status at needs-attention, and each produced a new push: 07:35:31.871 and
    07:35:32.670 for ac9b0f0f, 07:32:58.663 and 07:32:59.455 for 23e2a661. The operator then
    started design recovery 6 s later.
  - **Scope review 10dbc912.** It received 13 occurrences (v4, 6, …, 28), all with the identical
    message "Scope review requires recovery: … 1 major …". The owning-slice repair loop bumped the
    version each time.
  - **One state, two occurrences.** `cycle:6f1dfb47:30:merge-requirements` produced 9 pushes, then
    `cycle:6f1dfb47:30` (merge) produced 1 more. Same cycle version, 10 pushes total.
  - **Checkpoint sets.** Checkpoint alerts produced 10 occurrences and 30 pushes. The set shrinks as
    checkpoints are satisfied, and each shrink makes a new hash and an immediate push.
- Impact: Duplicate pushes. Reminder schedules restart. The operator is paged by their own clicks.
- Recommendation: Key occurrences by blocker identity:
  `subjectKey = cycle:<id>:<blocker.kind>[:<question-set digest>]`.
  - Version and wording changes update the record's message without re-paging.
  - For set-valued alerts (checkpoints, environments), key by roadmap plus alert class. Re-page only
    when the set **grows**; when it shrinks, update the text silently.
  - Keep "resolved then reopened within N minutes" as the same occurrence (flap suppression).
- Effort: S–M
- Related: NOTIF-05, NOTIF-07
- Plan/roadmap format impact: none

### NOTIF-04: No operator-presence awareness — pushes arrive while the operator is using the UI
- Severity: medium
- Category: ux
- Status: CONFIRMED
- Evidence:
  - 53 of 134 first sends came within 120 s after an operator (`actor_kind='user'`) audit row.
  - Typical sequence: the operator records scope evidence or resumes a cycle. The controller's next
    transition raises the next blocker, which is pushed about 1 s later. Examples: 2026-09-18
    14:07:53 → 14:07:54.7, and 09-22 08:06:07.758 → 08:06:08.851.
  - `NotificationService` never consults sessions or SSE connections.
- Impact: The phone buzzes for things already on screen. This trains the operator to ignore pushes.
- Recommendation:
  - Track presence in memory: an open workspace SSE stream (`WorkspaceEventStreamService` already
    authenticates per iteration) plus a recent command from that owner.
  - While present, hold pushes for new blockers for a longer grace, around 3–5 min, and show them
    in the in-app inbox (NOTIF-09).
  - If the operator acts on the subject within the grace, resolve without sending.
  - Reminders continue to apply only when absent.
- Effort: S–M
- Related: NOTIF-01, NOTIF-09
- Plan/roadmap format impact: none

### NOTIF-05: Storage alerts flap without hysteresis and produce bursts of pushes
- Severity: medium
- Category: bug
- Status: CONFIRMED
- Evidence:
  - `alerts()` is a live threshold test with no hysteresis: `bavail*bsize < minimumFreeGiB`
    (`storage-service.ts:148-160`, `:207-213`).
  - Resolution happens as soon as an alert is absent (`notification-service.ts:497-511`).
    Reappearance reactivates the record and sends immediately (`:518-523`).
  - On 2026-09-15 between 01:45:16 and 02:20:36Z there were 15 attention changes and 23
    deliveries, including 7 bursts of 3 pushes (the state, worktrees and runs volumes), about 10–30 s apart.
  - 09-22 19:55: "Database backups: Volume unavailable" was pushed and resolved 70 s later.
- Impact: 20+ pushes in half an hour for one condition.
- Recommendation:
  - Raise when free space < reserve. Clear only when free space ≥ reserve + margin (for example
    +10% or +2 GiB) continuously for 5 min.
  - Treat mount-unavailable as sticky for 1–2 min before raising.
  - Coalesce all volumes into one `storage` alert whose message lists them.
  - Cache the `status()` result for the tick (also see NOTIF-08).
- Effort: S
- Related: NOTIF-03, NOTIF-08
- Plan/roadmap format impact: none

### NOTIF-06: Daemon restart pages the operator for a self-inflicted, known state
- Severity: low
- Category: ux
- Status: CONFIRMED
- Evidence:
  - `RoadmapService.recoverInterrupted` sets every running roadmap to needs-attention "Daemon
    restarted…" (`roadmap-service.ts:941-946`).
  - `WorkCycleService.recoverInterrupted` does the same for running cycles (`work-cycle-service.ts:1522-1526`).
  - The DB has 12 such transitions, 7 surviving records and 8 pushes. The web already special-cases
    this reason (`RoadmapAttention.tsx:4-8`: "Resume required after restart").
- Impact: Every deploy or restart buzzes the phone. Restarts are almost always operator-initiated.
- Recommendation: Classify restart blockers as `kind: 'restart'`.
  - Send at most one coalesced message per boot ("Daemon restarted; N roadmaps/cycles await Resume"),
    and only after the settle and presence rules.
  - Or suppress entirely if an owner session issues a command within the grace.
- Effort: S
- Related: NOTIF-02, NOTIF-04
- Plan/roadmap format impact: none

### NOTIF-07: Notification occurrence history is overwritten; journals carry no identity
- Severity: medium
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - Schema `UNIQUE (workspace_id, source_key)`.
  - Reactivation writes `{...this.record(...), id: existing.id}` (`notification-service.ts:518-523`),
    and the upsert is `ON CONFLICT(id) DO UPDATE` (`repositories/notifications.ts:59`). This
    overwrites createdAt, firstSentAt and deliveredCount of the earlier occurrence.
  - The journal payload is only `{action}` (`:643-672`).
  - 494 delivery journal rows versus 356 deliveries in surviving records: at least 133 pushes
    cannot be attributed to any content. There is no resolution timestamp or resolution cause.
  - `records()` orders by `rowid DESC` (`repositories/notifications.ts:39-44`), and `get()` shows
    the first 50. A reactivated old record keeps its original rowid, so it can fall out of the
    Settings list while it is active.
- Impact: False alarms cannot be audited, measured or regression-tested against real history.
  This review had to reconstruct them from indirect evidence. A current alert can be hidden in the UI.
- Recommendation:
  - Split the model into `attention_items` (one row per occurrence, with openedAt, settledAt,
    resolvedAt, resolvedBy = operator | automation | superseded) and `notification_deliveries`
    (append-only: item id, attempt, sentAt, result).
  - Include the item id and occurrence id in the journal payload.
  - Order the UI by last activity.
- Effort: M
- Related: NOTIF-03, NOTIF-09
- Plan/roadmap format impact: none

### NOTIF-08: The attention projection is heavy and runs inside an IMMEDIATE write transaction many times per tick
- Severity: medium
- Category: performance
- Status: CONFIRMED (structure); HYPOTHESIS (magnitude, not profiled)
- Evidence:
  - `deliverDue` calls `reconcile → attention()` inside `storage.transaction` (IMMEDIATE,
    `storage.ts:89`). It does so once per claim iteration (up to 20) and again after each send
    (`notification-service.ts:531-639`). That is 2k+1 full projections per tick with k deliveries.
  - `attention()` does all of the following:
    - lists all cycles and active worktrees;
    - per worktree, reads runs, the latest turn and roadmap history (`tx.roadmaps.history(...)`
      inside the per-cycle loop, `:252-255`);
    - per running roadmap, runs `scopePhaseBlockers` for every unattempted slice-verification entry
      (`:346-364`);
    - computes `crossProjectState` (`:377`);
    - through `storageAttention`, calls `statfs`/`realpath`/`stat` on every volume, worktree and
      retained run directory (`storage-service.ts:162-230`).
  - The tick runs on every workflow wake and every 5 s.
  - better-sqlite3 is synchronous, so all of this blocks the Node event loop, including SSE and
    HTTP handling.
- Impact: Likely contributes to UI latency during automated activity, when workflow wakes are
  frequent. It also adds contention with CLI or bootstrap writers.
- Recommendation:
  - Compute the desired set once per tick in a read transaction (with the storage alert status
    cached, for example for 30 s). Pass it into the short write transactions.
  - Once NOTIF-02/09 land, the projection becomes a cheap `SELECT` over `attention_items` where
    `owner='operator'`.
  - Profile first: time `attention()` against a copy of the live DB.
- Effort: S (hoist and cache) / M (after the blocker table)
- Related: NOTIF-02, NOTIF-11
- Plan/roadmap format impact: none

### NOTIF-09: Attention has no single source of truth; there is no operator inbox
- Severity: high
- Category: architecture
- Status: CONFIRMED
- Evidence: Independent derivations:
  1. `NotificationService.attention()` (push).
  2. `WorkCycleService.list()` adds `scopeReviewWait` / `mergeRequirementsWait`
     (`work-cycle-service.ts:135-164`). The web `attentionCycles()` then takes any
     `needs-attention`/`awaiting-merge` without `scopeReviewWait` (`AttentionStrip.tsx:5-12`). It
     does **not** exclude awaiting-merge cycles that roadmap policy will auto-merge, which the push
     path does exclude (`notification-service.ts:259-274`).
  3. `RoadmapService` entry progress status 'needs-attention' (`roadmap-service.ts:2075-2181`,
     `blocker().needsAttention` at `:1890-1908`) feeds `RoadmapAttention.tsx`. It has its own
     filters (`!p.blockers?.length`) and its own restart special case.
  4. The dashboard `statusSummary.needsAttention` is actually `planning.importAttentionCount`
     (`workspace-service.ts:208`), shown as "Needs attention: Imports that failed or carry
     warnings" (`StatusCards.tsx:71-80`). The same name means a different thing.
  5. `crossProjectState` node blockers drive both the checkpoint push and the cross-project panel.

  Observed divergence: for 188747f3 the roadmap view said "queued (fresh independent review
  queued)" while the push said "Needs attention". Persisted notification records (the only record
  of what paged the operator) appear only in Settings → "Recent notification activity"
  (`NotificationPanel.tsx:278-300`).
- Impact: The UI and the phone disagree. The operator hunts across the dashboard, roadmap, work
  item and settings pages to find what is actually blocked (pain point 1). Each derivation needs
  its own fixes.
- Recommendation: Create one durable attention projection (`attention_items`, NOTIF-07), maintained
  in the same transaction as the state change that opens or closes a blocker (ADR-010 already
  guarantees atomic writes).
  - Fields: subject (cycle / roadmap entry / checkpoint / decision / storage / restart), owner,
    kind, destination route, message, and plan/roadmap node ids for the future dependency graph.
  - Consumers: a single Inbox page, `AttentionStrip`, `RoadmapAttention` and the push outbox all
    read it.
  - Rename the import card to "Import problems".
- Effort: L
- Related: NOTIF-02, NOTIF-04, NOTIF-07; UI-unification reviewers
- Plan/roadmap format impact: none. Items reference existing plan/roadmap ids.

### NOTIF-10: Notification bookkeeping floods the workspace journal and the browser
- Severity: medium
- Category: performance
- Status: CONFIRMED
- Evidence:
  - Every reconcile change and every delivery (including reminders and failures) appends an audit
    row and a `notifications-changed` workspace event (`notification-service.ts:526`, `:637`, `:643-672`).
  - Live: 792 of 3,289 workspace events (24%); 320 of 1,202 event bursts contain only
    `notifications-changed`.
  - The web reducer marks `workspaceSummary` stale for this kind (`workspace-projection.ts:174-177`).
    That bumps `refreshToken` and refetches the snapshot, the audit page, the workspace list, the
    work cycles and the route's detail (`App.tsx:380-520`), even though only the Settings panel
    shows notification records.
  - The Activity feed renders "Notifications: delivery updated" lines (`ActivityPanel.tsx:13-14`),
    which fill the 50-event recent-activity window.
  - `deliverDue` also calls `notifier.notify('activity')` after every send (`:639`), which wakes
    every SSE stream.
- Impact: Page refreshes and re-renders at every reminder, including overnight. Activity-feed noise.
  Added query load.
- Recommendation:
  - Do not emit workspace events for delivery bookkeeping (audit rows are enough). Emit
    `attention-changed` only when the operator-visible attention set changes.
  - In the web reducer, route `notifications-changed` only to the notification settings panel.
  - Stop listing notification events in the Activity feed.
- Effort: S
- Related: NOTIF-11
- Plan/roadmap format impact: none

### NOTIF-11: Browser invalidation is coarse and the 200 ms leading window splits automated cascades
- Severity: medium
- Category: performance
- Status: CONFIRMED
- Evidence:
  - Every event kind except repository ones sets `workspaceSummary: true` (`workspace-projection.ts:118-209`).
  - The app refreshes all top-level queries on each `refreshToken`.
  - `scheduleRefresh` uses a fixed 200 ms window that starts at the first event (`App.tsx:201-211`).
  - Measured bursts (events ≤2 s apart): mean 2.58, p90 5, max 22 events spanning 14 s. With the
    200 ms window that implies 2,258 refresh cycles for 3,096 events: the window coalesces only 27%.
  - `roadmap-changed` is emitted for bookkeeping updates whose reason does not change: 82 identical
    "Parallel scheduling enabled…" rows in `roadmap.updated` audits.
- Impact: The UI slows as page elements react to automated transitions (pain point 3). Multiple
  full refetches per automated step, each hitting heavy endpoints (for example `WorkCycleService.list`
  runs scope-wait and question-route derivations for every cycle).
- Recommendation:
  - Use trailing debounce with a max-wait (for example 400 ms trailing, 1.5 s max).
  - Make scope-specific invalidation: cycle events → cycles plus the specific work item; roadmap
    events → roadmap views; do not refetch audit and workspace lists on execution events.
  - On the server, skip `roadmap-changed` when only internal attempt bookkeeping changed. Or add an
    `internal: true` payload flag that the browser ignores.
  - A controller "transition settled" marker (NOTIF-01's quiescence generation) could let the
    browser refresh once per settled transition.
- Effort: M
- Related: NOTIF-10; UI/performance reviewers
- Plan/roadmap format impact: none

### NOTIF-12: Reminder content is frozen and often misdirects; reminders dominate volume
- Severity: medium
- Category: ux
- Status: CONFIRMED
- Evidence:
  - **Volume.** Reminders are 222 of the 356 deliveries attributable to surviving records (62%).
    Schedule: +30 m, +1…+6 h, then daily at 21:00 (`domain/notification.ts:28-…`).
  - **Frozen text.** The message is captured at occurrence creation and resent with a
    "Reminder: " prefix (`notification-service.ts:574`).
  - **Misdirection example.** Three cycles (2f1ab211, 0a201222, d91e6c71, 09-22) each got 8 pushes
    telling the operator "Answer the Open questions using Continue with guidance". They were
    actually resolved by the controller's reassessment once delegation was configured and the
    roadmap resumed: run-profiles updated 00:01:54Z, then `workflow-review` by system at 00:06:12–14Z.
  - **Stale text.** For scope review 10dbc912, reminders and new occurrences kept quoting a failed
    review ("1 major") after the owning-slice repair had already finished.
- Impact: Pushes tell the operator to do the wrong thing, or repeat outdated reasons.
- Recommendation:
  - Build each reminder's text from the current blocker at send time (it is recomputed anyway).
  - Name the real destination and action from `blocker.destination` (for example "Resume roadmap
    X — 3 items wait on scheduling", not "answer questions").
  - Coalesce all due reminders for a workspace into one digest push.
- Effort: S–M
- Related: NOTIF-02, NOTIF-09
- Plan/roadmap format impact: none

### NOTIF-13: Transient controller errors can become durable roadmap attention
- Severity: low
- Category: reliability
- Status: HYPOTHESIS (code path confirmed; no live instance found)
- Evidence:
  - `RoadmapService.tick` converts any `ExecutionRequestError` from `advance()` into roadmap
    `needs-attention` (`roadmap-service.ts:990-1000`).
  - The parallel path converts it into an entry hold (`:1073-1087`).
  - `WorkCycleService.change` throws `ExecutionRequestError('conflict', 'Cycle changed while this
    operation was in progress')` on an optimistic-concurrency miss (`work-cycle-service.ts:3900-3904`).
    That miss can happen when the cycle worker and roadmap worker touch the same cycle concurrently.
  - The cycle loop guards this case by comparing versions (`:1570-1582`). The roadmap loop does not.
  - Search of audit metadata found no "changed while" reasons, so this has not been observed yet.
- Impact: A race between two workers could halt a roadmap and page the operator.
- Recommendation: In the roadmap loop, treat version-conflict errors as retryable (like
  `RepositoryMutationBusyError`). Use a dedicated `ConcurrentModificationError` class instead of a
  generic conflict.
- Effort: S
- Related: NOTIF-01
- Plan/roadmap format impact: none

### NOTIF-14: SSE wakeups are unscoped
- Severity: low
- Category: performance
- Status: CONFIRMED (behaviour); HYPOTHESIS (impact)
- Evidence:
  - Both stream services wait on the global `generation` (`workspace-event-stream-service.ts:45-68`,
    `run-event-stream-service.ts:40-64`).
  - Every agent `assistant-message`/`tool-call` calls `notify('activity')`
    (`agent-run-service.ts:1667-1671`). That wakes every workspace stream and every run stream in
    every workspace. Each one re-authenticates (DB read) and queries.
  - Idle streams also re-query every 1,000 ms (ADR-003 notes this caveat).
- Impact: Small at one user, but it is wasted work proportional to open tabs × agent output rate.
- Recommendation: Add per-workspace and per-run channels to the notifier (a keyed generation map).
  Workspace streams would wake only on workspace-event commits for their workspace; run streams
  only on their run.
- Effort: S
- Related: NOTIF-10
- Plan/roadmap format impact: none

### NOTIF-15: Tests do not cover the race and churn behaviours that cause false alarms
- Severity: medium
- Category: testing
- Status: CONFIRMED
- Evidence: `notifications.test.ts` covers the schedule, leases, retries, credentials, recovery
  holds, and roadmap preparation and hold alerts (test names at `:200-802`). No test covers:
  - an automation takeover shortly after needs-attention (reassessment, dependency refresh, scope recovery);
  - version bumps that leave the blocker in place;
  - storage threshold oscillation;
  - operator presence;
  - restart alerts.
- Impact: Regressions of this operator complaint are undetectable.
- Recommendation: Add deterministic tests using the injectable `now` and transport:
  - (a) attention followed by automated takeover within the settle window → 0 sends;
  - (b) version bump with the same blocker → 1 send, reminders not restarted;
  - (c) flapping storage alert → ≤1 send per hysteresis window;
  - (d) a present operator → send deferred.
- Effort: S–M
- Related: NOTIF-01, NOTIF-03, NOTIF-04, NOTIF-05
- Plan/roadmap format impact: none

### NOTIF-16: Outbox reliability — mostly sound, with coupled cooldowns
- Severity: low
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - **Sound:**
    - Claims use durable 60 s leases in an immediate transaction (`:556-562`).
    - A single worker serializes `tick()` (`:177-183`).
    - Shutdown leaves the lease for recovery (`:585`).
    - The post-send reconcile preserves counts even if the record resolved mid-flight (`:607-636`).
  - **Coupling:** any non-accepted result, including a transient network throw, sets the
    workspace-wide `settings.retryAt` (`:600-606`). That blocks all other alerts for 30 s–1 h
    (backoff indexed by that one record's failure count). The live DB has 5 records ending with
    "could not be confirmed", all 1–3 s network errors.
  - At-least-once delivery with possible duplicates after an ambiguous failure is documented in ADR-027.
- Impact: One flaky send delays unrelated first alerts. This is acceptable today, but it interacts
  badly with settle and presence gating if those are added naïvely.
- Recommendation:
  - Keep the provider cooldown only for 429 and blocked results.
  - Keep per-record backoff for transport errors.
  - When coalescing into digests (NOTIF-12), deliveries become per digest, which simplifies this.
- Effort: S
- Related: NOTIF-12
- Plan/roadmap format impact: none

## Remediation direction

### Sequencing

1. **Stop the bleeding (1–2 days, all S).**
   - NOTIF-01 step 1: 30 s settle on new records, re-checked at claim.
   - NOTIF-05: storage hysteresis and coalescing.
   - NOTIF-06: one restart digest.
   - NOTIF-10: no workspace events for delivery bookkeeping; web routes `notifications-changed`
     to Settings only.
   - NOTIF-03 partial: drop `version` from `cycle:` keys and key on `cycle:<id>:<status>:<blocker-kind>`.
   - Add the NOTIF-15 tests for these.

   Against live history, this removes the confirmed false alarm (1.6 s), the near miss (0.7 s),
   all storage bursts, the baseline-command double pages, and all bookkeeping refreshes.
2. **Controller-declared blockers (≈3 days, M).** NOTIF-02:
   - Add `blocker {owner, kind, subjectKey, destination, message}` to `WorkCycle` and to roadmap
     entry holds and roadmap status, written by the controller in the same transaction as the
     status change.
   - Automation that will act next (reassessment, dependency refresh, scope recovery, auto-merge,
     auto scope-evidence) writes `owner:'controller'`.
   - Delete the predicate logic from `NotificationService`.
   - Also add the NOTIF-01 quiescence gate (per-worker completed-pass generation) and NOTIF-04 presence.
3. **Single attention model and inbox (≈1 week, L).** NOTIF-07 + NOTIF-09:
   - Tables: `attention_items` (occurrence rows) and `notification_deliveries` (append-only).
   - One Inbox page replaces the Settings-only list, `AttentionStrip`, and `RoadmapAttention`'s
     recovery list.
   - Pushes become deliveries of settled, operator-owned, absent-operator items, coalesced into
     digests, with reminder text built from the current item state (NOTIF-12).
   - Items carry plan/roadmap node ids, so the future dependency-graph view (pain point 2) can
     overlay blockers.
4. **Event and wakeup hygiene (2–3 days, M).** NOTIF-11 (trailing debounce, scoped invalidation,
   no-op `roadmap-changed` suppression), NOTIF-14 (scoped notifier channels), NOTIF-08 (hoist and
   cache the projection, or remove it via step 3), NOTIF-13.

### Target design

```text
controller transaction (cycle/roadmap/storage/finalization)
  ├─ writes state + audit + workspace event (ADR-010, unchanged)
  └─ upserts attention_item(subjectKey) { owner, kind, destination, message, planRefs,
                                          openedAt, openedGeneration } or closes it
                                          { resolvedAt, resolvedBy }

AttentionService (read side, single source of truth)
  ├─ Inbox API  → web Inbox page, AttentionStrip, roadmap/plan graph overlays
  └─ eligibility(item) = owner==='operator'
                         ∧ open ≥ settle (10–30 s)
                         ∧ every controller worker completed a pass started after openedGeneration
                         ∧ ¬(operator present ∧ age < presence grace)
                         ∧ subject not owned by an in-flight command/mutation

NotificationOutbox (delivery only)
  ├─ one digest per workspace per wake: new eligible items + due reminders
  ├─ append-only notification_deliveries(itemIds, attempt, result)
  └─ reminder schedule per item occurrence; text rendered from the current item
```

Properties this gives the operator:

- **One definition of "needs you".** The phone, dashboard, roadmap page and inbox show the same
  list, because they read the same rows.
- **No page for controller-owned or transitional states.** Automation declares ownership before
  releasing control, and eligibility waits for the controller to go quiet.
- **Stable occurrences.** A blocker keeps its identity across version bumps and rewording. A new
  page means a genuinely new blocker.
- **Auditable history.** It becomes possible to measure false alarms directly:
  `resolvedBy='automation' ∧ deliveredCount>0`.

Plan and roadmap formats are unaffected by every step. Attention items reference existing plan,
work-item, roadmap-entry and checkpoint ids.
