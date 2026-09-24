# Remediation register

The consolidated backlog for the 2026-09 system review. Each remediation item (`R-…`) groups the findings it resolves; findings keep their full evidence in [`findings/`](findings/). Work items in phase order (see [program.md](program.md)); within a phase, workstreams can proceed in parallel unless an item lists a dependency in its text.

**Status values:** `open`, `in progress`, `partial (<commits>)`, `done (<commit>)`, `won't do (<reason>)`. Update the status here in the same commit that resolves an item, and note partial progress in the item. When a finding turns out to be wrong, mark it in the finding index below rather than deleting it.

## Summary by workstream

| Item | Phase | Effort | Status | Title |
|---|---|---|---|---|
| **A** | | | | **Attention, decisions and notifications (pain points 1 and 3)** |
| [R-A1](#r-a1) | P0 | S | done (012447b) | Stop notification noise without a redesign |
| [R-A2](#r-a2) | P0 | S | done (012447b, 67e2e9b) | Stop journaling notification delivery bookkeeping as workspace events |
| [R-A3](#r-a3) | P1 | M-L | done (eb757da) | Controller-declared, typed attention on every blocking transition |
| [R-A4](#r-a4) | P2 | M-L | open | Durable attention items, delivery log, quiescence and presence |
| [R-A5](#r-a5) | P2 | L | open | One "Needs you" inbox that every surface reads |
| [R-A6](#r-a6) | P3 | L | open | Consolidate decision and recovery components; delete per-page hosts |
| [R-A7](#r-a7) | P1 | M | partial (9339d01) | Offer only actions that can make progress; one transition gate for commands and launch |
| **B** | | | | **Controller core (pain point 3)** |
| [R-B1](#r-b1) | P0 | S | done (fd269b6, 012447b) | Controller quick fixes (no schema change) |
| [R-B2](#r-b2) | P1 | M | done (131a9de) | Characterization harness for the cycle controller |
| [R-B3](#r-b3) | P1 | M | open | Explicit cycle ownership; roadmap state references its definition |
| [R-B4](#r-b4) | P4 | L | open | Pure cycle decision core with an explicit state machine |
| [R-B5](#r-b5) | P4 | L | open | Event-driven controller kernel |
| [R-B6](#r-b6) | P4 | M-L | open | Scoped consistency instead of whole-roadmap pause |
| [R-B7](#r-b7) | P4 | L | open | Decompose the controller services along real boundaries |
| [R-B8](#r-b8) | P1 | M | open | Remove dead and vestigial paths |
| [R-B9](#r-b9) | P1 | M | done (4d81743) | Low-disruption restarts: bounded drain plus automatic resume of interrupted steps |
| **C** | | | | **Operator-wait reduction (the vision: minimum operator input)** |
| [R-C1](#r-c1) | P1 | S-M | open | Measure operator-wait as a first-class metric |
| [R-C2](#r-c2) | P1 | S-M | done (f049b3a) | Re-prompt the agent automatically on output-format validation failures |
| [R-C3](#r-c3) | P2 | M | open | Design stage: continue automatically and batch real decisions ahead of time |
| [R-C4](#r-c4) | P2 | M | open | Refresh and re-review automatically when only upstream integration advanced |
| [R-C5](#r-c5) | P2 | M | open | Converge the parent/slice repair loop |
| [R-C6](#r-c6) | P3 | M | open | Reduce the evidence-acceptance ceremony |
| [R-C7](#r-c7) | P3 | M | open | Revisit verification layering and finalization stops |
| [R-C8](#r-c8) | P1 | S | done (pending) | Schedule automatic retry for quota/session limits with a known reset time |
| **D** | | | | **Read side and browser performance (pain point 3)** |
| [R-D1](#r-d1) | P0 | S-M | done (67e2e9b) | Cheap server-side read fixes |
| [R-D2](#r-d2) | P0 | S-M | done, partial on "done when" (67e2e9b) | Cheap browser refresh fixes |
| [R-D3](#r-d3) | P0 | S | partial (67e2e9b) | Instrument read cost and event-loop delay |
| [R-D4](#r-d4) | P2 | M-L | open | Keyed query store and App.tsx split |
| [R-D5](#r-d5) | P2 | M-L | open | Server view models, compression and git-fact caching |
| [R-D6](#r-d6) | P4 | L | open | Shared projections keyed by write generation (only if still needed) |
| **E** | | | | **Progress view and navigation (pain points 2 and 1)** |
| [R-E1](#r-e1) | P2 | M | open | Real routes and one Link component |
| [R-E2](#r-e2) | P2 | M | open | Split the Roadmaps mega-page |
| [R-E3](#r-e3) | P3 | L | open | Roadmap board: progress and dependencies at a glance |
| [R-E4](#r-e4) | P3 | M | open | Work-item and run pages become drill-downs |
| [R-E5](#r-e5) | P3 | M | open | Consolidate settings and agent selection |
| [R-E6](#r-e6) | P1 | M | open | Operator vocabulary and copy |
| **F** | | | | **Plan and roadmap formats (ground truth; Studio readiness)** |
| [R-F1](#r-f1) | P1/P4 | S then L | partial (52c5c8b) | One compiled map model and one requirement evaluator |
| [R-F2](#r-f2) | P3 | M | open | Typed feature recognition instead of prose and magic identifiers |
| [R-F3](#r-f3) | P0/P1 | S-M | partial (7d44b42, 0ef1c95) | Format ingestion bugs and test honesty |
| [R-F4](#r-f4) | P0 | S | partial (9b4be64) | Commit the format specification and golden conformance tests |
| [R-F5](#r-f5) | P4 | M | open | Backward-compatible format additions before the Studio |
| [R-F6](#r-f6) | P5 | L | open | The Studio format family (first step of the Development Studio) |
| **G** | | | | **Agent execution integrity and security** |
| [R-G1](#r-g1) | P0 | S-M | done (3e34531, c57c51a) | Execution safety fixes that can lose or corrupt work |
| [R-G2](#r-g2) | P0 | S | done (d0f66ef) | Make automatic provider retry actually fire |
| [R-G3](#r-g3) | P0 | S-M | done (8c92c57) | Scope operator guidance to the step it was given for |
| [R-G4](#r-g4) | P2 | M-L | open | Daemon-owned verification receipts |
| [R-G5](#r-g5) | P2 | M | open | Agent environment and configuration isolation |
| [R-G6](#r-g6) | P2 | M | open | Redesign briefs around the task |
| [R-G7](#r-g7) | P1 | M | open | Stop cold-building Rust on every step |
| [R-G8](#r-g8) | P5 | M-L | open | Backend capability model and persistent-agent seam |
| [R-G9](#r-g9) | P2 | M | open | Authentication and authorization hardening |
| [R-G10](#r-g10) | P3 | M | open | Git adapter robustness and structure |
| [R-G11](#r-g11) | P3 | S-M | open | Supervisor loose ends |
| [R-G12](#r-g12) | P5 | L | open | (Future) agent runs that outlive the daemon |
| **H** | | | | **Data lifecycle and integrity** |
| [R-H1](#r-h1) | P0 | S | done (c8f58fc) | Fix the unreadable first run (live 500) |
| [R-H2](#r-h2) | P1 | M | open | Journal retention: stop storing raw vendor lines by default |
| [R-H3](#r-h3) | P1 | M | open | Read-side upcasters, write-side validation and db:verify |
| [R-H4](#r-h4) | P2 | M | open | Lighter evidence and definition storage |
| [R-H5](#r-h5) | P3 | M | open | Rationalize the route surface |
| **I** | | | | **Engineering hygiene (tests, docs, repository, deployment)** |
| [R-I1](#r-i1) | P0 | S | partial (4952821, 44a64bd) | Protect the work and stop repository bloat |
| [R-I2](#r-i2) | P1 | M | open | Split the 14k-line execution test file |
| [R-I3](#r-i3) | P1 | S-M | open | Systematic authorization tests |
| [R-I4](#r-i4) | P2 | M | open | Structural test/production and process-authority boundaries |
| [R-I5](#r-i5) | P1 | S-M | open | E2E and fixture reliability |
| [R-I6](#r-i6) | P1 | S-M | open | Gate on lint |
| [R-I7](#r-i7) | P1-P3 | M | open | Documentation reset to current state |
| [R-I8](#r-i8) | P1 | S-M | partial (943fb8d) | Deploy from a separate checkout; one daemon per data directory |

## Workstream A — Attention, decisions and notifications (pain points 1 and 3)

### R-A1

**Stop notification noise without a redesign** · Phase P0 · Effort S · Status: done (012447b)

- **Resolves:** [NOTIF-01](findings/NOTIF-attention-notifications.md#notif-01-no-settle-period--notifications-race-the-controllers-own-follow-up-transitions), [NOTIF-03](findings/NOTIF-attention-notifications.md#notif-03-occurrence-key-includes-cycleversion-and-content-hashes-so-unrelated-version-bumps-re-page), [NOTIF-05](findings/NOTIF-attention-notifications.md#notif-05-storage-alerts-flap-without-hysteresis-and-produce-bursts-of-pushes), [NOTIF-06](findings/NOTIF-attention-notifications.md#notif-06-daemon-restart-pages-the-operator-for-a-self-inflicted-known-state), [NOTIF-15](findings/NOTIF-attention-notifications.md#notif-15-tests-do-not-cover-the-race-and-churn-behaviours-that-cause-false-alarms), [NOTIF-16](findings/NOTIF-attention-notifications.md#notif-16-outbox-reliability--mostly-sound-with-coupled-cooldowns), [CTRL-02](findings/CTRL-controller.md#ctrl-02-notifications-fire-for-states-the-controller-is-about-to-leave-on-its-own), [CTRL-03](findings/CTRL-controller.md#ctrl-03-a-new-notification-per-cycle-version-produces-repeat-pushes-for-unchanged-situations), [HIST-05](findings/HIST-history-and-live-usage.md#hist-05-operator-facing-states-and-notifications-fire-during-automated-transitions-pain-point-3-confirmed-in-data), [DATA-06](findings/DATA-storage-domain-contracts.md#data-06-phone-notifications-are-delivered-for-attention-states-the-daemon-itself-resolves-seconds-later)
- **Change:** Give new non-test notification records a settle delay (nextAttemptAt = createdAt + ~30 s; the claim transaction already re-derives attention, so anything resolved in the window is never sent). Key occurrences by condition, not by cycle.version (e.g. cycle:<id>:<status>[:merge-requirements]); set-valued roadmap alerts re-page only when the set grows. Add hysteresis and coalescing to storage alerts. Collapse restart-induced attention into one message per boot. Keep the provider cooldown for 429/blocked only and use per-record backoff for transport errors.
- **Done when:** Deterministic notification tests (injectable now/transport) show: attention resolved by automation inside the settle window sends 0 pushes; a version bump with the same blocker sends 1 push and does not restart reminders; a flapping storage threshold sends at most 1 push per hysteresis window.
- **Progress:** Settle delay (30 s), condition-keyed occurrences with a 10-minute flap window, set-valued alerts re-page only on growth, storage hysteresis and coalescing (StorageAlertGate), one restart message per boot, provider cooldown only for 429. Trade-off: a genuinely new blocker on the same cycle within 10 minutes of the previous one resolving does not re-page; it follows the reminder schedule. Old versioned keys resolve and re-create once after deploy. Still open for R-A4: quiescence gate and presence (NOTIF-01 proper fix, NOTIF-04).

### R-A2

**Stop journaling notification delivery bookkeeping as workspace events** · Phase P0 · Effort S · Status: done (012447b, 67e2e9b)

- **Resolves:** [NOTIF-10](findings/NOTIF-attention-notifications.md#notif-10-notification-bookkeeping-floods-the-workspace-journal-and-the-browser), [HIST-17](findings/HIST-history-and-live-usage.md#hist-17-notification-delivery-volume-floods-the-workspace-event-stream), [DATA-08](findings/DATA-storage-domain-contracts.md#data-08-workspace-event-invalidation-is-coarse-and-every-invalidation-refetches-all-cycles-delivery-bookkeeping-is-journaled-as-a-workspace-event)
- **Change:** Delivery attempts, reminders and failed sends update the outbox row (and audit, if wanted) but no longer append a notifications-changed workspace event or wake SSE streams. Only changes to the operator-visible attention set emit an event. Remove "Notifications: delivery updated" lines from the Activity feed.
- **Done when:** A reminder delivery produces no workspace event; the browser performs no refetch for it; notifications tests assert the event count.
- **Progress:** Delivery bookkeeping no longer appends workspace events or wakes streams; one audit row per accepted push keeps pages attributable. The web routes notifications-changed only to the notification panel.

### R-A3

**Controller-declared, typed attention on every blocking transition** · Phase P1 · Effort M-L · Status: done (eb757da)

- **Resolves:** [CTRL-05](findings/CTRL-controller.md#ctrl-05-at-least-10-separate-places-decide-needs-the-operator-with-different-rules), [CTRL-10](findings/CTRL-controller.md#ctrl-10-awaiting-merge-is-overloaded-with-six-meanings), [CTRL-11](findings/CTRL-controller.md#ctrl-11-control-flow-depends-on-the-wording-of-human-readable-messages), [CTRL-22](findings/CTRL-controller.md#ctrl-22-the-api-returns-projection-fields-mixed-into-the-domain-workcycle), [NOTIF-02](findings/NOTIF-attention-notifications.md#notif-02-attention-is-inferred-by-predicting-automation-each-new-automation-needs-a-matching-suppression-clause), [DATA-05](findings/DATA-storage-domain-contracts.md#data-05-attention-and-operator-decisions-are-not-first-class-identity-is-keyed-on-versions-or-text-hashes-and-behavior-branches-on-english-reason-prefixes), [UI-02](findings/UI-information-architecture.md#ui-02-recovery-routing-depends-on-english-prose-reason-prefix-regexes-in-the-ui-and-navigation-prose-in-daemon-blocker-messages), [UI-09](findings/UI-information-architecture.md#ui-09-the-waiting-on-other-work-classification-hides-operator-owned-evidence), [UI-16](findings/UI-information-architecture.md#ui-16-attentionstrip-and-the-notification-service-disagree-about-merge-approvals)
- **Change:** Add an optional `attention {owner: operator|controller, code, subject refs, message, actions[]}` to cycles, roadmap entries/holds and roadmap status, written in the same transaction as the status change by the code that makes the decision. Add `code` and `owner` to PhaseBlocker; add a typed restart flag; add an `awaiting-merge` gate subtype (operator-merge, promotion, record-evidence, automatic-merge, controller-wait, scheduling-held). Map legacy reason strings to codes once, in one tested function. Replace every reason/message prefix match on the server and in the web with code switches, and remove navigation prose from daemon messages. NotificationService then selects owner=operator items and imports no policy modules.
- **Done when:** No `startsWith`/regex on reason or blocker message remains in apps/server or apps/web (grep test); every controller path that sets needs-attention or awaiting-merge sets attention.code (contract test); notification-service.ts no longer imports scope/roadmap policy modules.
- **Progress:** ADR-067. Domain vocabulary in `packages/domain/src/attention.ts`: 59 cycle codes (the 28 step-outcome codes from R-B2, controller stops, and the six `awaiting-merge` gates), 6 roadmap codes, 29 phase-blocker codes with owner and `waits`. Cycles, roadmaps and entry holds carry optional `attention` (wire schemas refine the owner). `CycleChanges`/`RoadmapChanges` make a stop without attention a compile error; `untypedStops` checks every test daemon's rows on cleanup (the whole server suite runs it). Automation claims (roadmap merge/verification/acceptance, conflict automation, scope recovery, prerequisite work) and merge requirements are declared with the transition by `cycle-attention-policy.ts` and refreshed in place when stored state changes. `PhaseGateError.waiting`, `scopeReviewWait`, host scheduling, the reassessment trigger and the roadmap progress view switch on codes; `phaseBlockerResourceKey` replaces a message substring match. Web: CyclePanel, WorkflowStatus, RoadmapAttention, RoadmapsPage, ExecutionScopesPanel, CheckpointRecoveryPanel (typed `prerequisiteCheckpoints`), AttentionStrip (UI-16) and Reasons (owner-based, UI-09) use codes. The scope check's rule 5 is the grep test. `NotificationService` reads declared attention and `RoadmapService.attentionAlerts`; it imports no policy module. Legacy rows map through `attention-legacy.ts` only. Behaviour changes, intended: roadmap-claimed merges, `scheduling-held` and `controller-wait` stops are not pushed; operator-owned evidence (decision checkpoints, dependency environments) shows as the operator's. Not in this change: navigation prose in daemon messages stays until the inbox renders destinations from codes (R-A5), the `actions[]` list is R-A7, and the CTRL-22 projection split moves to R-D5.

### R-A4

**Durable attention items, delivery log, quiescence and presence** · Phase P2 · Effort M-L · Status: open

- **Resolves:** [NOTIF-04](findings/NOTIF-attention-notifications.md#notif-04-no-operator-presence-awareness--pushes-arrive-while-the-operator-is-using-the-ui), [NOTIF-07](findings/NOTIF-attention-notifications.md#notif-07-notification-occurrence-history-is-overwritten-journals-carry-no-identity), [NOTIF-08](findings/NOTIF-attention-notifications.md#notif-08-the-attention-projection-is-heavy-and-runs-inside-an-immediate-write-transaction-many-times-per-tick), [NOTIF-09](findings/NOTIF-attention-notifications.md#notif-09-attention-has-no-single-source-of-truth-there-is-no-operator-inbox), [NOTIF-12](findings/NOTIF-attention-notifications.md#notif-12-reminder-content-is-frozen-and-often-misdirects-reminders-dominate-volume), [HIST-02](findings/HIST-history-and-live-usage.md#hist-02-wall-clock-throughput-is-dominated-by-waiting-for-the-operator-not-by-agent-work-or-controller-latency)
- **Change:** Persist attention as occurrence rows (`attention_items`: subject, owner, code, openedAt, settledAt, resolvedAt, resolvedBy) plus an append-only `notification_deliveries` log. Eligibility for a push = operator-owned AND settled AND every controller worker has completed a pass that began after the item opened AND the operator is not present (open SSE stream or recent command). Reminders render text from the current item; due reminders coalesce into a digest. The projection is maintained transactionally, so the per-tick whole-workspace re-derivation inside an IMMEDIATE transaction disappears.
- **Done when:** False alarms are directly measurable (resolvedBy=automation AND deliveredCount>0) and a test asserts 0 for the recorded live sequences; notification history is never overwritten; the notification tick does no filesystem or map evaluation.

### R-A5

**One "Needs you" inbox that every surface reads** · Phase P2 · Effort L · Status: open

- **Resolves:** [UI-01](findings/UI-information-architecture.md#ui-01-there-is-no-single-needs-the-operator-model-the-dashboard-misses-most-roadmap-level-decisions), [UI-03](findings/UI-information-architecture.md#ui-03-the-same-decision-concept-is-surfaced-in-several-places-with-different-names-and-forms), [UI-04](findings/UI-information-architecture.md#ui-04-shared-architecture-decisions-are-buried-inside-dependency-environments-and-evidence), [UI-08](findings/UI-information-architecture.md#ui-08-dead-ends-blockers-that-tell-the-operator-to-go-elsewhere-without-a-link-generic-landing-pages-and-deep-links-that-silently-do-nothing), [NOTIF-09](findings/NOTIF-attention-notifications.md#notif-09-attention-has-no-single-source-of-truth-there-is-no-operator-inbox)
- **Change:** Serve the attention items at GET /workspaces/:ws/attention with an attention-changed event. Build /inbox (list, sorted by downstream items blocked then age) and /inbox/:id (detail). First mount the existing decision/recovery forms inside the detail unchanged; replace AttentionStrip, the rail count, RoadmapAttention and the roadmap tone logic with the attention feed; point notification deep links at inbox items. Architecture decisions, plan acceptance, verification-environment approval, map adoption, amendments, dependency refresh and restart resume all appear as inbox items. Moved from R-A3: render each attention and blocker code's destination as a link in the UI, then remove the navigation prose ("Open Dependency environments and evidence → …") from daemon messages.
- **Done when:** For any seeded walkthrough state, the dashboard/rail count, the inbox, and the push log list the same items; every inbox item has a working action; every notification path opens /inbox/:id.

### R-A6

**Consolidate decision and recovery components; delete per-page hosts** · Phase P3 · Effort L · Status: open

- **Resolves:** [UI-03](findings/UI-information-architecture.md#ui-03-the-same-decision-concept-is-surfaced-in-several-places-with-different-names-and-forms), [UI-10](findings/UI-information-architecture.md#ui-10-recovery-panels-render-when-nothing-needs-recovering), [UI-17](findings/UI-information-architecture.md#ui-17-roadmap-supervision-panels-share-mutable-page-level-dirty-gates-that-disable-unrelated-decisions), [UI-18](findings/UI-information-architecture.md#ui-18-the-work-item-page-stacks-up-to-about-a-dozen-conditional-panels-in-one-automated-cycle-section-slice-gates-sit-at-the-bottom), [UI-19](findings/UI-information-architecture.md#ui-19-the-e2e-and-walkthrough-suites-are-coupled-to-current-accessible-names-so-an-ia-migration-needs-a-test-plan)
- **Change:** Replace the ~21 recovery/decision panels with one component per decision kind rendered only in the inbox detail: CycleContinuation (guidance, extra rounds, agent override, fresh-review semantics), DesignQuestions, ArchitectureDecision (prepare with agent / author manually / approve full or limited / clarify), EvidenceDecision (checkpoint and plan acceptance), EnvironmentApproval, IntegrationConflict, ScopeRepair, AmendmentDecision, FinalizationStep, FinalPromotion. Other pages show a one-line banner linking to the item. Delete the originals and their e2e specs in the same commit that adds the replacement specs.
- **Done when:** Each daemon decision command is posted from exactly one component; `apps/web/src/features` no longer contains the listed per-page recovery panels; walkthrough captures before/after are recorded.

### R-A7

**Offer only actions that can make progress; one transition gate for commands and launch** · Phase P1 · Effort M · Status: partial (9339d01)

- **Resolves:** [CTRL-04](findings/CTRL-controller.md#ctrl-04-resume-is-accepted-even-when-it-cannot-make-progress), [CTRL-12](findings/CTRL-controller.md#ctrl-12-manual-commands-accept-transitions-that-the-automated-launch-then-rejects)
- **Change:** Derive the valid operator actions from the attention code (in the same pure code that decides the transition) and return them with the cycle projection; reject Resume when the blocking fact is not transient, with the correct destination. Put whole-item and scoped start/advance gates, including predecessor ancestry, into one transitionGate() used by commands before acceptance and again at launch.
- **Done when:** Replaying the recorded live sequences (cycles d148f0a4, 10dbc912, 2f1ab211) no longer produces accepted-then-bounced resumes; the UI renders only returned actions.
- **Progress:** `cycleActions`/`resumeRedirect` (domain, `cycle-actions.ts`) derive the actions from the typed stop (R-A3). A plain resume is refused with the control to use when the controller would classify the same run's text the same way: design stops (d148f0a4's invalid classification), open questions, invalid workflow reports, an exhausted remediation limit, a detected integration conflict. A newer manual run is always adoptable. A plain resume of a scope review is refused while the integration branch still has the reviewed commit (10dbc912). Before accepting a resume that relaunches the step or an integration resolution, the command runs the launch's own gates, including predecessor ancestry (2f1ab211). Stops that depend on state changed elsewhere (shared decisions, reviewer grants, dependencies, scope recovery, finalization continuations) stay resumable. The browser shows Resume only when `cycleActions` offers it. Tests: `cycle-actions.test.ts` (domain and server), plus the unchanged-snapshot case in the scope repair test. Two tests that asserted the old accepted-then-bounced resume were updated. Remaining: other panels still decide their own visibility (R-A6 consolidates them onto `cycleActions`); one `transitionGate` shared by the roadmap scheduler's whole-item and scoped gates (`RoadmapService.blocker`, `requireReady`, `scopePhaseBlockers`) is not unified yet, and the duplicated remediation-grant validators (CTRL-12) remain for R-B7.

## Workstream B — Controller core (pain point 3)

### R-B1

**Controller quick fixes (no schema change)** · Phase P0 · Effort S · Status: done (fd269b6, 012447b)

- **Resolves:** [CTRL-06](findings/CTRL-controller.md#ctrl-06-delegation-grants-are-ignored-by-integration-refresh-and-by-notifications), [FMT-07](findings/FMT-plan-and-roadmap-formats.md#fmt-07-effective-roadmap-automation-is-resolved-three-different-ways), [CTRL-16](findings/CTRL-controller.md#ctrl-16-error-handling-can-leave-cycles-stuck-or-silently-retrying), [NOTIF-13](findings/NOTIF-attention-notifications.md#notif-13-transient-controller-errors-can-become-durable-roadmap-attention), [PERF-18](findings/PERF-browser-and-read-performance.md#perf-18-controller-emits-many-small-spread-out-commits-per-transition-browser-cannot-coalesce-them), [CTRL-09](findings/CTRL-controller.md#ctrl-09-the-roadmap-control-row-embeds-the-whole-definition-and-history-is-parsed-on-hot-paths)
- **Change:** Route every automation read (refreshOwner, notification suppression, conflict automation) through effectiveDelegation so ADR-065 grants apply everywhere. Give the first reassessment branch in reconcile its own catch and surface persistent failures. Treat optimistic-concurrency conflicts in the roadmap tick as retryable. Do not append a work-cycle-changed event when status/step/reason are unchanged, and drop the roadmap-wide "Parallel scheduling enabled" reason flip-flop. Compute workflowContext only when runnable and skip requireReady for idle awaiting-merge cycles.
- **Done when:** A test applies a delegation grant and checks refresh, merge and notification behave consistently; idle daemon CPU with one awaiting-merge cycle drops measurably (record before/after).
- **Progress:** attemptDelegation/attemptDefinition helpers; refresh and scheduler use them; notification suppression uses effectiveDelegation (could switch to attemptDelegation). Reassessment failures surface once; phase waits refresh on blocker change; ConcurrentModificationError retried by loops; no-op controller writes skipped (events still emitted for any stored change, since the browser renders the whole cycle); parallel reason flip-flop removed; idle awaiting-merge cycles skip gate/workflow projections (fixture: 1.7 ms -> 0.22 ms per reconcile). Live idle-CPU before/after not yet measured.

### R-B2

**Characterization harness for the cycle controller** · Phase P1 · Effort M · Status: done (131a9de)

- **Resolves:** [CTRL-18](findings/CTRL-controller.md#ctrl-18-the-controller-has-no-unit-testable-transition-core), [QA-02](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-02-orchestration-tests-poll-wall-clock-time-because-the-controller-has-no-deterministic-stepping-seam)
- **Change:** Extract reconcile's post-run classification (work-cycle-service.ts ~:1858-2254) verbatim into a pure function of (cycle, facts). Record golden decisions by replaying every cycle in a DB snapshot, and add decision-table tests. Add a deterministic stepping seam (tick once / wait-for-idle) so orchestration tests stop polling wall-clock time.
- **Done when:** Golden replay test over a fixture snapshot passes; at least the attention codes produced by the live data are covered by table tests; new orchestration tests use the stepping seam.
- **Progress:** Everything `reconcile` does once the current step has a run (live, drain-interrupted, waiting, provider failure, background-work exit, and the design/implement/review classification) is now `decideStepOutcome(cycle, facts)` in `services/step-outcome.ts`, same checks in the same order; `reconcile` applies the typed decision (`applyStepOutcome`, `approveReview`). Storage-derived facts stay lazy so each is read only on the branch that read it before. Each operator stop carries one of 28 `STEP_ATTENTION_CODES`. Table tests (`step-outcome.test.ts`, 47 rows) cover every code and decision kind. Golden replay: `step-outcome-replay.test.ts` drives eight scripted scenarios through the real controller, replays each snapshot with `replayStepOutcomes`, and compares with `fixtures/controller/step-outcome-replay.golden.json`. `pnpm controller:replay <snapshot> [--record|--check <golden>]` runs the same replay over a copy of a real database; the live baseline (51 cycles, taken 2026-09-23 18:41) and its golden file are kept outside the repository in `$XDG_DATA_HOME/craftingtable-review/replay/2026-09-23/`, because they hold real plans and agent output. Stepping seam: `WorkCycleService.tick()`, `AgentRunService.quiesce()`, `createTestContext({ workers: false })` and `stepController` in `cycle-test-support.ts`; the R-B9 and replay tests use it. Every attention reason in the live audit history that comes from this classification has a code and a table row. The rest come from other controller paths (review remediation limits and stalls, integration refresh and conflicts, clean-worktree and readiness errors, merges, restart) and get codes in R-A3. The 14k-line execution test still polls; moving it onto the seam is R-I2.

### R-B3

**Explicit cycle ownership; roadmap state references its definition** · Phase P1 · Effort M · Status: open

- **Resolves:** [CTRL-07](findings/CTRL-controller.md#ctrl-07-ownership-of-a-cycle-by-a-roadmap-is-resolved-11-ways-and-the-cycle-has-no-owner-field), [CTRL-09](findings/CTRL-controller.md#ctrl-09-the-roadmap-control-row-embeds-the-whole-definition-and-history-is-parsed-on-hot-paths), [HIST-12](findings/HIST-history-and-live-usage.md#hist-12-roadmap-state-rewrites-a-248-kb-json-blob-including-a-full-definition-copy-on-every-change), [DATA-07](findings/DATA-storage-domain-contracts.md#data-07-the-roadmap-state-blob-embeds-a-copy-of-the-immutable-definition-and-keeps-append-only-histories-inside-the-mutable-blob-revision-lookups-load-every-revision), [PERF-08](findings/PERF-browser-and-read-performance.md#perf-08-map-evaluation-hot-spots-in-roadmap-view-cycles-list-and-cross-project-preview)
- **Change:** Add optional WorkCycle.owner {roadmapId, attemptId, entryId, definitionRevision}, set on creation and backfilled on read; replace the 11 ownership scans with one memoized cycleOwnership(). Store only definitionRevision in roadmap control state, load definitions through a process-wide immutable cache, and add an indexed single-revision lookup instead of parsing all history.
- **Done when:** No call site scans roadmaps.list() for a cycleId; roadmap row size no longer scales with the definition; roadmaps.history() is not called on hot paths.

### R-B4

**Pure cycle decision core with an explicit state machine** · Phase P4 · Effort L · Status: open

- **Resolves:** [CTRL-01](findings/CTRL-controller.md#ctrl-01-the-cycle-controller-is-a-656-line-imperative-function-with-an-implicit-state-machine), [CTRL-10](findings/CTRL-controller.md#ctrl-10-awaiting-merge-is-overloaded-with-six-meanings), [CTRL-11](findings/CTRL-controller.md#ctrl-11-control-flow-depends-on-the-wording-of-human-readable-messages), [DATA-04](findings/DATA-storage-domain-contracts.md#data-04-workcycle-is-a-50-field-god-record-with-embedded-sub-state-machines-two-entity-kinds-and-projection-fields-mixed-in), [HIST-01](findings/HIST-history-and-live-usage.md#hist-01-development-proceeded-by-patching-each-live-blockage-with-new-state-panels-and-vocabulary-spaghetti-fication-measured), [HIST-18](findings/HIST-history-and-live-usage.md#hist-18-controller-services-grew-append-only-through-feature-by-feature-accretion)
- **Change:** CycleFacts (one snapshot, one open-questions parser, one report parser) -> decide(cycle, facts, now) -> Decision {launch | wait | attention | approve | effect | complete} with an ordered, named guard list. reconcile becomes a thin shell. Collapse the ~27 optional recovery fields into one stop record plus an append-only step history; keep old JSON readable through upcasters (R-H3).
- **Done when:** reconcile is under ~100 lines; the decision core has table tests for every attention and wait code; WorkCycle optional-field count falls instead of rising.

### R-B5

**Event-driven controller kernel** · Phase P4 · Effort L · Status: open

- **Resolves:** [CTRL-08](findings/CTRL-controller.md#ctrl-08-the-controller-polls-costs-1520--cpu-when-idle-and-blocks-the-event-loop), [CTRL-17](findings/CTRL-controller.md#ctrl-17-about-nine-uncoordinated-in-memory-locks-with-different-semantics), [PERF-07](findings/PERF-browser-and-read-performance.md#perf-07-browser-refetch-storms-run-on-the-controllers-event-loop-ui-load-slows-automation-and-vice-versa), [NOTIF-14](findings/NOTIF-attention-notifications.md#notif-14-sse-wakeups-are-unscoped), [AGT-15](findings/AGT-GIT-SEC-agents-git-security.md#agt-15-each-agent-event-is-a-separate-fsyncd-transaction-plus-a-notifier-broadcast-on-the-main-event-loop)
- **Change:** Replace the three polling loops and the nine in-memory lock sets with a dirty-set kernel: events mark aggregates dirty, deadlines and backoffs become precise timers, a 30-60 s safety sweep covers external Git changes, and a per-aggregate async mutex with bounded concurrency means one launch preflight never blocks another cycle. Move launch materialization to async FS. Scope notifier channels per workspace/run and batch agent-event writes.
- **Done when:** Idle daemon CPU near zero; one slow launch preflight does not delay deadline enforcement of another cycle (test); event-loop delay gauge (R-D3) shows no multi-100 ms stalls during transitions.

### R-B6

**Scoped consistency instead of whole-roadmap pause** · Phase P4 · Effort M-L · Status: open

- **Resolves:** [CTRL-19](findings/CTRL-controller.md#ctrl-19-many-operator-decisions-require-pausing-the-whole-roadmap)
- **Change:** Commands that change decisions, delegation, profiles, capacity or entries lock only the affected entries/bindings; running work pins its inputs (already true for grants). Where a global invariant is needed, use a drain state that stops admissions but lets running steps finish.
- **Done when:** Approving an architecture decision or changing a future agent profile no longer requires pausing the roadmap.

### R-B7

**Decompose the controller services along real boundaries** · Phase P4 · Effort L · Status: open

- **Resolves:** [CTRL-13](findings/CTRL-controller.md#ctrl-13-layering-is-inverted-and-responsibilities-are-misplaced-across-services), [CTRL-14](findings/CTRL-controller.md#ctrl-14-the-same-gates-and-validations-are-duplicated-with-drift), [AGT-12](findings/AGT-GIT-SEC-agents-git-security.md#agt-12-launchauthorized-is-a-780-line-mixed-responsibility-function-its-side-effects-precede-the-durable-record)
- **Change:** roadmap-scheduler (admission/attempts, hands the cycle an OwnerPolicy), cycle-core + cycle-effects, run-supervisor (launch/supervise/journal only), run-context (document materialization + brief composition), merge-gate (pure) + merge-executor. Move crossProjectState, milestoneSatisfied and mergeGateFor into policy modules (removes the type-only import cycles). Extract the duplicated authority, instruction-bound, extra-rounds and roadmap-editable validators. Make always-supplied constructor dependencies required.
- **Done when:** launchAuthorized is split; no service file exceeds ~1,200 lines; no import cycles; each duplicated validator exists once.

### R-B8

**Remove dead and vestigial paths** · Phase P1 · Effort M · Status: open

- **Resolves:** [CTRL-15](findings/CTRL-controller.md#ctrl-15-dead-and-vestigial-controller-paths), [GIT-04](findings/AGT-GIT-SEC-agents-git-security.md#git-04-the-ct-04a1-inspector-is-dead-code-about-78k-lines-but-is-still-composed-configured-and-tested), [DATA-09](findings/DATA-storage-domain-contracts.md#data-09-the-dead-ct-04a1a2-repository-inspector-and-registry-are-still-compiled-constructed-and-schema-resident), [QA-10](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-10-test-effort-is-weighted-toward-the-dormant-ct-04a-repository-inspection-feature)
- **Change:** Delete the CT-04A1/A2 repository inspector, registry, provider, config keys and tests (drop the three empty tables in a forward migration; CRAFTINGTABLE_GIT_BIN currently crashes startup). Stop offering legacy finalization rounds for new finalizations while keeping the completed legacy record readable, then remove the legacy branches. Split WorkCycleRepository.list() into listActive()/listForWorkspace().
- **Done when:** ~7-8k production and ~4.5k test lines removed; pnpm check green; the completed legacy finalization still renders.

### R-B9

**Low-disruption restarts: bounded drain plus automatic resume of interrupted steps** · Phase P1 · Effort M · Status: done (4d81743)

- **Resolves:** [HIST-06](findings/HIST-history-and-live-usage.md#hist-06-deploy--restart-and-every-restart-stops-running-roadmaps-and-live-runs), [CTRL-20](findings/CTRL-controller.md#ctrl-20-every-restart-stops-all-automation-and-kills-in-flight-agent-work), [HIST-13](findings/HIST-history-and-live-usage.md#hist-13-schema-and-adr-churn-rate-22-migrations-46-adrs-in-18-days-with-manual-pre-migration-backups)
- **Change:** Agents are child processes of the daemon, connected only by stdio pipes, so a restarted daemon cannot re-attach to a run that is still going. Combine two mechanisms (operator decision 2026-09-23). (1) Bounded drain: on stop or deploy, stop admitting new steps and wait up to a configurable bound (a few minutes) for live turns to finish; then interrupt what is left, recording which runs were interrupted by a controlled drain (as opposed to a crash). `pnpm deploy:daemon --when-idle` instead waits until nothing is live before switching and restarting. (2) Automatic resume: on a clean start, relaunch each step interrupted by the drain by resuming its vendor session (Claude `--resume <session>`, Codex app-server thread resume; both adapters already have resume paths) in the same worktree, with the original deadline and permissions, so conversation and worktree edits survive and only the in-flight tool call is redone; roadmaps and cycles that were running continue without an operator Resume. Unclean interruptions (crash, kill, lost session id) and failed resumes keep today's explicit-resume attention. Also take the pre-migration DB snapshot automatically in the migration runner. Truly surviving a restart (agents that outlive the daemon) is R-G12.
- **Done when:** A deploy while a long run is live either waits (`--when-idle`) or drains within the bound and, after restart, the interrupted step resumes its vendor session automatically with no operator action and no page; running roadmaps keep running; a crash or failed resume still requires explicit resume (tests with the fake backends for both paths).
- **Progress:** ADR-066. `DaemonDrain` holds roadmap admissions and refuses launches (`DaemonDrainingError`, 503), waits up to `CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS` (default 180) or until idle, stops the loops, ends waiting cycle turns normally, interrupts the rest with exit reason `daemon-drain`, and writes a `daemon_clean_stop` row (migration 27). The next start consumes it: cycles and roadmaps stay running and `reconcile` resumes a drain-interrupted step through the interrupted run's session (same backend, model, permissions, guidance, deadline; reviews keep their pinned baseline). Crash, no session id and failed resume keep the explicit resume. `pnpm deploy:daemon` requests the drain through `drain-request.json` in the data directory before switching releases (`--when-idle`, `--no-drain`; Ctrl-C withdraws it; a daemon that predates drain support is restarted the old way after 15 s). `SIGTERM` runs the same drain as a best effort; it needs `KillMode=mixed` and a longer `TimeoutStopSec` in the unit, which `--status` points out. Migrations copy a populated database to `state/pre-migration/` first (three kept). Tests: `apps/server/src/restart-drain.test.ts`, `scripts/deploy-daemon.test.mjs`, `packages/storage/src/migrations.test.ts`. Live verification waits for an operator-approved deploy.

## Workstream C — Operator-wait reduction (the vision: minimum operator input)

### R-C1

**Measure operator-wait as a first-class metric** · Phase P1 · Effort S-M · Status: open

- **Resolves:** [HIST-02](findings/HIST-history-and-live-usage.md#hist-02-wall-clock-throughput-is-dominated-by-waiting-for-the-operator-not-by-agent-work-or-controller-latency), [HIST-03](findings/HIST-history-and-live-usage.md#hist-03-ranked-operator-intervention-causes-the-highest-leverage-automation-fixes), [HIST-09](findings/HIST-history-and-live-usage.md#hist-09-agent-reliability-is-high-stops-are-controller-derived-prioritize-accordingly)
- **Change:** Record stop openedAt/resolvedAt/owner/kind (falls out of R-A3/R-A4) and show operator-wait hours and stops-by-kind on the dashboard. Use it to rank the remaining automation work.
- **Done when:** The dashboard shows operator-wait hours for the last 7 days and the top stop kinds; numbers reproduce the HIST baseline on a DB snapshot.

### R-C2

**Re-prompt the agent automatically on output-format validation failures** · Phase P1 · Effort S-M · Status: done (f049b3a)

- **Resolves:** [HIST-10](findings/HIST-history-and-live-usage.md#hist-10-agent-output-format-validation-becomes-operator-stops-instead-of-automatic-re-prompts), [HIST-03](findings/HIST-history-and-live-usage.md#hist-03-ranked-operator-intervention-causes-the-highest-leverage-automation-fixes)
- **Change:** When a design classification, structured review report or "## Open questions" section fails validation, send one bounded follow-up turn to the same session quoting the validator errors (up to 2 attempts) before stopping for the operator. Record the attempts in the stop record.
- **Done when:** Replaying the WI-09 and finalization invalid-output stops produces automatic repair turns, not needs-attention.
- **Progress:** `decideStepOutcome` returns `repair-output` instead of a stop when a finished run's final report fails a structural check: an invalid design classification, an invalid or missing workflow report, a review report that is unstructured or invalid (including a missing scope evidence entry), or an Open questions checkpoint that is missing, repeated, empty, not last in a design report, or "none" followed by more text (`openQuestionsCheckpoint`, domain). A checkpoint that lists questions still stops at once, as do findings, decisions and dependencies. The controller records `outputRepair { attempts, sourceRunId, code, issues }` on the cycle and relaunches the step resuming the run's vendor session (`sessionResumeSource`, the R-B9 path generalized) with a message quoting the validator issues and asking for the whole corrected report; reviews stay on their pinned baseline, guidance is kept, and the turn gets at least 20 minutes. After `OUTPUT_REPAIR_LIMIT` (2) failed repairs, or when the run has no session id, it stops with the same code as before and `attention.repairAttempts`. No new attention codes or operator surfaces. Live history (snapshot 2026-09-23): the two finalization review reports rejected on 09-13 (finding ids that break the id pattern; `exitGate.evidence` over 20,000 characters) now classify as repairs, with those issues quoted. The four WI-09 stops (cycle d148f0a4) came from a design validator that f574029 later relaxed. Today both runs parse as complete and end with a real ADR approval request, so they correctly stop for the operator. All 18 recorded design stops for open questions list real questions and still stop. Tests: `step-outcome.test.ts` (table rows and R-C2 block), `output-repair.test.ts` (resume and continue, exhaustion, real questions, review on pinned baseline).

### R-C3

**Design stage: continue automatically and batch real decisions ahead of time** · Phase P2 · Effort M · Status: open

- **Resolves:** [HIST-03](findings/HIST-history-and-live-usage.md#hist-03-ranked-operator-intervention-causes-the-highest-leverage-automation-fixes), [HIST-19](findings/HIST-history-and-live-usage.md#hist-19-real-cross-project-workload-is-10-the-scale-the-uis-lists-were-designed-for-progress-and-dependencies-are-hard-to-see)
- **Change:** When a design investigation finishes and every question has a cited answer with no operator-classified decision left, continue without a stop. Build the per-roadmap decision queue before dependent slices start (extend ADR-065 decision preparation) so shared architecture decisions are answered once, in a batch, in the inbox.
- **Done when:** On the cross-project roadmap, design stops per started slice fall well below the 10-of-11 baseline; decisions show "unblocks N slices".

### R-C4

**Refresh and re-review automatically when only upstream integration advanced** · Phase P2 · Effort M · Status: open

- **Resolves:** [HIST-03](findings/HIST-history-and-live-usage.md#hist-03-ranked-operator-intervention-causes-the-highest-leverage-automation-fixes)
- **Change:** Under automatic integration policy, an integration-advanced blocker triggers the existing refresh + fresh review without an operator request (33 manual update requests in the live data).
- **Done when:** No "Integration branch advanced; update the worktree" operator stop occurs under automatic policy.

### R-C5

**Converge the parent/slice repair loop** · Phase P2 · Effort M · Status: open

- **Resolves:** [HIST-04](findings/HIST-history-and-live-usage.md#hist-04-exo-01-parent-acceptance--owning-slice-repair-ping-pong-consumed-29-of-all-runs-without-convergence-detection), [HIST-08](findings/HIST-history-and-live-usage.md#hist-08-merge-approvals-and-record-scope-verification-still-require-manual-clicks-in-delegated-flows)
- **Change:** Track finding identity across parent-acceptance -> owning-slice repair -> re-review rounds; give repair briefs the cumulative remaining work for a finding; detect no-progress vs progress; escalate once with a progress summary; offer to split an oversized finding into a follow-up slice through the amendment path. Verify no repair path still needs manual merge or manual integration update.
- **Done when:** A replay of EXO-01 would escalate once instead of 13 rounds; repair cycles are always roadmap-owned.

### R-C6

**Reduce the evidence-acceptance ceremony** · Phase P3 · Effort M · Status: open

- **Resolves:** [HIST-07](findings/HIST-history-and-live-usage.md#hist-07-checkpoint-evidence-acceptance-is-a-self-attestation-ceremony-65-operator-actions-100-accepted), [FMT-17](findings/FMT-plan-and-roadmap-formats.md#fmt-17-stack-plan-accepted-evidence-is-bound-to-a-digest-of-the-whole-roadmap-definition)
- **Change:** Controller-verifiable checkpoints (generated plan acceptance, daemon-owned receipts from R-G4) are recorded automatically as audit facts; only checkpoints the map marks as human-required go to the inbox, batched ahead of need. Bind STACK-PLAN-ACCEPTED to the inputs it actually covers, so unrelated roadmap saves do not invalidate it.
- **Done when:** STACK-PLAN-ACCEPTED is not re-requested after a save that does not change its inputs; controller-verifiable checkpoints need no operator action.

### R-C7

**Revisit verification layering and finalization stops** · Phase P3 · Effort M · Status: open

- **Resolves:** [HIST-20](findings/HIST-history-and-live-usage.md#hist-20-the-first-automated-real-use-aq-went-smoothly-complexity-arrived-with-slicesverificationevidence-layers), [HIST-16](findings/HIST-history-and-live-usage.md#hist-16-plan-finalization-was-the-most-expensive-phase-of-the-only-completed-plan)
- **Change:** Evaluate folding slice verification into the slice's final review when the reviewer profile already satisfies the independent-reviewer role (must preserve the map's acceptance-coverage semantics). Do not stop finalization for nit-only remediation limits; defer nits automatically. Replay the AQ finalization stop sequence against the staged controller before the cross-project roadmap reaches finalization.
- **Done when:** A written decision (ADR) on slice-verification folding; a finalization scenario test built from the AQ sequence.

### R-C8

**Schedule automatic retry for quota/session limits with a known reset time** · Phase P1 · Effort S · Status: done (pending)

- **Resolves:** [AGT-60](findings/AGT-GIT-SEC-agents-git-security.md#agt-60-quota-and-session-limit-failures-with-a-known-reset-time-always-need-the-operator)
- **Change:** When the vendor reports a reset time, schedule the retry at that time within the step deadline instead of stopping for the operator.
- **Done when:** A recorded session-limit fixture produces a scheduled retry.
- **Progress:** `ProviderFailure.resetsAt` (optional). The Claude normalizer keeps the reset time from a `rejected` `rate_limit_event` (`rate_limit_info.resetsAt`) and attaches it to the next `quota` failure, which is then marked safe to retry, subject to the existing checks (no outstanding tools, interaction or background work). The reset time applies to one result, and an `allowed` report clears it. `decideStepOutcome` treats a quota failure with a reset time no more than 6 h away (`QUOTA_WAIT_LIMIT_MS`) as a service retry. The retry is scheduled 2 minutes after the reset, or after 1 minute if the reset has passed, on the same agent. It counts toward ADR-062's three retries, and roadmap pauses hold it. The step deadline moves by the time waited, as `phaseWait` already does, so the wait does not use up the step's time. Weekly allowances, billing failures and quota errors without a reset time still stop for the operator. Codex reports no reset time in its structured errors, so Codex quota failures are unchanged. Not in this change: ending the session promptly on a terminal quota error (run 736446e8 kept running background sub-agents for 31 minutes), and a single "paused until" notification. The wait is a running cycle and does not page. Tests: the recorded `claude-session-limit` fixture now schedules a retry at 14:52 for a 14:50 reset and relaunches the same model (`server-execution.test.ts`); normalizer and decision-table cases.

## Workstream D — Read side and browser performance (pain point 3)

### R-D1

**Cheap server-side read fixes** · Phase P0 · Effort S-M · Status: done (67e2e9b)

- **Resolves:** [PERF-04](findings/PERF-browser-and-read-performance.md#perf-04-execution-scopes-costs-405-ms-of-synchronous-cpu-and-is-fetched-twice-per-round), [PERF-05](findings/PERF-browser-and-read-performance.md#perf-05-cycles-sends-every-historical-cycle-with-its-design-recovery-blob-to-every-page-every-round), [PERF-08](findings/PERF-browser-and-read-performance.md#perf-08-map-evaluation-hot-spots-in-roadmap-view-cycles-list-and-cross-project-preview), [PERF-11](findings/PERF-browser-and-read-performance.md#perf-11-run-page-downloads-17-mb-for-a-large-run-55--unused-raw-and-renders-every-event-unvirtualised), [PERF-12](findings/PERF-browser-and-read-performance.md#perf-12-list-payloads-carry-data-the-pages-do-not-use), [PERF-15](findings/PERF-browser-and-read-performance.md#perf-15-non-owner-members-cannot-load-any-workspace-page-audit-load-is-owner-only-and-inside-the-snapshot-promiseall), [AGT-03](findings/AGT-GIT-SEC-agents-git-security.md#agt-03-raw-vendor-lines-take-about-half-the-database-and-are-shipped-to-the-browser-which-never-reads-them), [DATA-01](findings/DATA-storage-domain-contracts.md#data-01-agent_run_eventsraw_json-is-278-mb-of-never-read-data-that-is-also-shipped-to-the-browser)
- **Change:** execution-scopes through mapReadSnapshot (measured 402 -> 42 ms); one snapshot for the whole roadmap list; /cycles returns non-terminal cycles without designRecovery by default (full detail per work item); /runs omits outcomeSummary and supports ?status=live; run event pages and the run SSE omit `raw` (diagnostics endpoint keeps it); load the owner-only audit page separately so non-owners can use the app.
- **Done when:** Endpoint timings on a DB copy: execution-scopes <60 ms, /cycles <100 KB; a non-owner member can load every workspace page (test).
- **Progress:** Timing targets on a live-DB copy not yet re-measured. Journal reads still select raw_json from disk (R-H2).

### R-D2

**Cheap browser refresh fixes** · Phase P0 · Effort S-M · Status: done, partial on "done when" (67e2e9b)

- **Resolves:** [PERF-02](findings/PERF-browser-and-read-performance.md#perf-02-batching-does-not-coalesce-transitions-no-single-flight-so-rounds-overlap-and-queue-server-work), [PERF-03](findings/PERF-browser-and-read-performance.md#perf-03-invalidation-map-is-wrong-in-both-directions-notifications-storms-stale-roadmapevidence-panels), [PERF-06](findings/PERF-browser-and-read-performance.md#perf-06-roadmaps-page-polls-900-kb-every-3-5-s-forever-77--of-the-daemon-15-mbmin-per-tab), [PERF-17](findings/PERF-browser-and-read-performance.md#perf-17-polling-continues-in-hidden-tabs-no-visibility-or-focus-awareness), [NOTIF-11](findings/NOTIF-attention-notifications.md#notif-11-browser-invalidation-is-coarse-and-the-200-ms-leading-window-splits-automated-cascades)
- **Change:** Trailing debounce with max-wait (~400 ms / 2 s) and single-flight around the refresh; notifications-changed invalidates only the notification panel; roadmap-changed, runtime-evidence-changed and scope-evidence-recorded invalidate the roadmap/evidence panels (remove the 3 s and 5 s polls, keep a 60 s visible-tab safety refresh); pause polling and defer refetches on hidden tabs.
- **Done when:** A test replaying a recorded transition (live seq 3248-3254) shows one refresh round; an idle hidden Roadmaps tab makes no requests.
- **Progress:** Trailing debounce 400 ms / max 2 s, single-flight with one follow-up, hidden-tab deferral, event-driven panels with a 60 s visible-tab safety refresh. The seq 3248-3254 replay produces 6 rounds, not 1: its events span 11.4 s with gaps up to 6 s, so the remaining churn must be removed at the source (PERF-18 event coalescing in the controller).

### R-D3

**Instrument read cost and event-loop delay** · Phase P0 · Effort S · Status: partial (67e2e9b)

- **Resolves:** [PERF-07](findings/PERF-browser-and-read-performance.md#perf-07-browser-refetch-storms-run-on-the-controllers-event-loop-ui-load-slows-automation-and-vice-versa), [PERF-19](findings/PERF-browser-and-read-performance.md#perf-19-no-tests-or-instrumentation-guard-request-volume-or-read-cost)
- **Change:** Log route, duration and bytes per request; expose an event-loop-delay histogram on a diagnostics endpoint; add read-budget tests over a large generated fixture (171-entry roadmap, 150 KB evidence records).
- **Done when:** The operator can see p95 request time and event-loop delay for the live daemon.
- **Progress:** Per-request log line (route, status, duration, bytes) and owner-only GET /api/workspaces/:id/diagnostics (route p50/p95/max, event-loop delay). Read-budget tests over a large generated fixture remain open.

### R-D4

**Keyed query store and App.tsx split** · Phase P2 · Effort M-L · Status: open

- **Resolves:** [PERF-01](findings/PERF-browser-and-read-performance.md#perf-01-every-workspace-event-refetches-the-whole-page-computed-stale-scopes-are-ignored), [PERF-10](findings/PERF-browser-and-read-performance.md#perf-10-whole-tree-re-render-on-every-event-response-and-clock-tick-no-memoization-anywhere), [PERF-13](findings/PERF-browser-and-read-performance.md#perf-13-four-different-freshness-policies-on-one-page-produce-visibly-inconsistent-state-after-transitions), [UI-13](findings/UI-information-architecture.md#ui-13-apptsx-monolith-plus-a-second-self-fetching-architecture-ad-hoc-event-bus-and-stale-panels)
- **Change:** A small in-repo query store (~200-300 lines: per-key subscriptions, single-flight, stale-while-revalidate, structural sharing, visibility-aware, one tested event->keys invalidation table); App.tsx reduced to auth, shell and route dispatch with one component per page owning its queries; window CustomEvents and self-polling removed; memoized row components; a useNow() hook instead of the global 10 s re-render. Record the store semantics in an ADR amendment; ask before adopting TanStack Query.
- **Done when:** App.tsx under ~300 lines; no setInterval pollers other than the safety refresh; unrelated events cause 0 requests (test).

### R-D5

**Server view models, compression and git-fact caching** · Phase P2 · Effort M-L · Status: open

- **Resolves:** [CTRL-22](findings/CTRL-controller.md#ctrl-22-the-api-returns-projection-fields-mixed-into-the-domain-workcycle) (moved from R-A3), [PERF-09](findings/PERF-browser-and-read-performance.md#perf-09-git-subprocess-fan-out-on-refreshed-read-paths), [PERF-14](findings/PERF-browser-and-read-performance.md#perf-14-work-item-and-run-pages-are-assembled-from-15-independent-requests-with-duplicates-and-static-data), [PERF-16](findings/PERF-browser-and-read-performance.md#perf-16-no-compression-no-validators-etag-on-large-json-responses), [PERF-20](findings/PERF-browser-and-read-performance.md#perf-20-single-768-kb-bundle-no-code-splitting)
- **Change:** Return cycles as `{cycle, projection}` so `nextAgentSelections`, `scopeReviewWait`, `mergeRequirementsWait` and rewritten `workflow.questions` stop posing as stored state (CTRL-22). One endpoint per page region evaluated in one read transaction and one map snapshot (work-item view, run view, roadmap list + roadmap progress, definitions by revision); gzip above ~8 KB and weak ETags with 304s; git-derived facts behind a cache keyed by resolved SHA; branch status fetched lazily; per-route code splitting.
- **Done when:** A work-item page loads with <=3 requests and <100 ms server time on the live dataset.

### R-D6

**Shared projections keyed by write generation (only if still needed)** · Phase P4 · Effort L · Status: open

- **Resolves:** [PERF-07](findings/PERF-browser-and-read-performance.md#perf-07-browser-refetch-storms-run-on-the-controllers-event-loop-ui-load-slows-automation-and-vice-versa), [PERF-08](findings/PERF-browser-and-read-performance.md#perf-08-map-evaluation-hot-spots-in-roadmap-view-cycles-list-and-cross-project-preview)
- **Change:** Compute map-derived progress once per write generation and share it between workers and readers; SSE deltas only if revalidation latency is still visible (needs an ADR-003 change).
- **Done when:** Measured need from R-D3 before starting.

## Workstream E — Progress view and navigation (pain points 2 and 1)

### R-E1

**Real routes and one Link component** · Phase P2 · Effort M · Status: open

- **Resolves:** [UI-07](findings/UI-information-architecture.md#ui-07-navigation-bypasses-the-router-35-of-49-in-app-links-force-full-reloads-and-deep-link-state-lives-in-ad-hoc-hashquery-parsing), [UI-08](findings/UI-information-architecture.md#ui-08-dead-ends-blockers-that-tell-the-operator-to-go-elsewhere-without-a-link-generic-landing-pages-and-deep-links-that-silently-do-nothing)
- **Change:** Extend Route with sub-routes and typed focus parameters (inbox item, roadmap id/tab/focus, settings section); add <Link route=...> and replace the 35 raw in-app hrefs (which reload the page and drop drafts); remove per-component hash/query parsing and cross-page revealElement; a test that bans raw in-app hrefs.
- **Done when:** No in-app navigation causes a document reload; deep links survive without a specific panel being mounted.

### R-E2

**Split the Roadmaps mega-page** · Phase P2 · Effort M · Status: open

- **Resolves:** [UI-05](findings/UI-information-architecture.md#ui-05-the-roadmaps-page-is-an-ever-growing-single-document-with-duplicated-panels-and-no-per-roadmap-route), [UI-17](findings/UI-information-architecture.md#ui-17-roadmap-supervision-panels-share-mutable-page-level-dirty-gates-that-disable-unrelated-decisions)
- **Change:** /roadmaps lists roadmaps (active first, completed under History); /roadmaps/:id is the board and controls; /roadmaps/:id/setup is an ordered checklist (bindings, dependency environment, verification environments, reviewer responsibilities and delegation, automation and agents, plan acceptance); /roadmaps/:id/history holds revisions, amendments and decisions. Remove the duplicate CrossProjectPanel/RuntimeEvidencePanel mounts under ConcurrencyImports; namespace DOM ids.
- **Done when:** No roadmap page exceeds ~3 desktop screens; each concurrency definition is rendered once.

### R-E3

**Roadmap board: progress and dependencies at a glance** · Phase P3 · Effort L · Status: open

- **Resolves:** [UI-06](findings/UI-information-architecture.md#ui-06-there-is-no-high-level-progress-or-dependency-view-dependencies-appear-as-text-and-are-often-unlinked), [HIST-19](findings/HIST-history-and-live-usage.md#hist-19-real-cross-project-workload-is-10-the-scale-the-uis-lists-were-designed-for-progress-and-dependencies-are-hard-to-see), [DATA-12](findings/DATA-storage-domain-contracts.md#data-12-no-unified-dependency-and-progress-read-model-data-side-of-pain-point-2)
- **Change:** Daemon read models GET roadmaps/:id/board ({nodes, edges, gates, attention, summary}) and GET plan-versions/:id/graph (from work_item_dependencies). UI: project swimlanes with parent cards and slice chips (development -> merged -> verified -> accepted), one daemon-derived status vocabulary, a focused upstream/downstream neighbourhood graph with checkpoints as gate badges, live-run pulse, attention markers with "unblocks N", critical path to the selected target, and a phone list layout. Supersede ADR-015's "no graph canvas" clause with a short ADR (layout computed in TypeScript; ask before adding a layout dependency).
- **Done when:** The operator can answer "what is this item waiting on, and what does this decision unblock" from one screen for the live 171-entry roadmap.

### R-E4

**Work-item and run pages become drill-downs** · Phase P3 · Effort M · Status: open

- **Resolves:** [UI-18](findings/UI-information-architecture.md#ui-18-the-work-item-page-stacks-up-to-about-a-dozen-conditional-panels-in-one-automated-cycle-section-slice-gates-sit-at-the-bottom), [UI-08](findings/UI-information-architecture.md#ui-08-dead-ends-blockers-that-tell-the-operator-to-go-elsewhere-without-a-link-generic-landing-pages-and-deep-links-that-silently-do-nothing)
- **Change:** Header, attention banner (link to inbox), slice strip, tabs (Cycle, Runs, Branches and worktrees, Gates, Diff); predecessors, dependents and blockers are links; SectionNav includes slices; recovery forms live in the inbox (R-A6).
- **Done when:** Work-item page height on desktop under ~2 screens for the common states.

### R-E5

**Consolidate settings and agent selection** · Phase P3 · Effort M · Status: open

- **Resolves:** [UI-14](findings/UI-information-architecture.md#ui-14-settings-that-gate-progress-are-edited-in-many-places), [DATA-11](findings/DATA-storage-domain-contracts.md#data-11-agent-profile-and-selection-shapes-have-multiplied-and-are-stored-in-at-least-12-places)
- **Change:** Settings sub-routes (general, agents, capacity, notifications, storage); per-roadmap overrides, reviewer responsibilities, integration policy and delegation in roadmap setup with effective values shown; per-action pickers show the effective selection with a "change for this action" disclosure; converge the seven near-identical profile types.
- **Done when:** Agent selection is edited in two places (workspace defaults, roadmap setup) plus explicit per-action overrides.

### R-E6

**Operator vocabulary and copy** · Phase P1 · Effort M · Status: open

- **Resolves:** [UI-11](findings/UI-information-architecture.md#ui-11-walls-of-text-and-headings-written-as-sentences), [UI-12](findings/UI-information-architecture.md#ui-12-vocabulary-density-and-inconsistent-labels), [DOC-04](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-04-vocabulary-is-incoherent-around-blockers-decisions-and-recovery), [UI-10](findings/UI-information-architecture.md#ui-10-recovery-panels-render-when-nothing-needs-recovering)
- **Change:** A glossary of ~15 operator-facing terms in ui-principles; rename map "decisions" to scheduling proposals and finalization "decisions" to finding dispositions in labels only (wire and format names unchanged); align rail and page titles; hide panels that have nothing to recover (IntegrationResolutionPanel, ProviderRecovery after recovery); move explanatory prose into About; headings are short; remove stale copy.
- **Done when:** A lint/test enforces heading length and bans long unconditional prose outside About; the spurious panels no longer render.

## Workstream F — Plan and roadmap formats (ground truth; Studio readiness)

### R-F1

**One compiled map model and one requirement evaluator** · Phase P1/P4 · Effort S then L · Status: partial (52c5c8b)

- **Resolves:** [FMT-01](findings/FMT-plan-and-roadmap-formats.md#fmt-01-no-compiled-format-model--22-services-re-interpret-raw-map-json), [FMT-02](findings/FMT-plan-and-roadmap-formats.md#fmt-02-requirement-satisfaction-is-implemented-three-times-with-drift), [FMT-03](findings/FMT-plan-and-roadmap-formats.md#fmt-03-validator-milestone-graph-differs-from-the-domain-milestone-model-demonstrated), [FMT-09](findings/FMT-plan-and-roadmap-formats.md#fmt-09-required-dependency-depends_on-enforcement-is-duplicated-in-six-places), [FMT-10](findings/FMT-plan-and-roadmap-formats.md#fmt-10-producer-sets-and-scope-requirementcase-sets-are-re-derived-in-several-places), [CTRL-14](findings/CTRL-controller.md#ctrl-14-the-same-gates-and-validations-are-duplicated-with-drift)
- **Change:** Immediately: make the importer's cycle check use the same milestone graph as targetClosure (FMT-03 imports a map the supervisor then crashes on). Then: compile a map+binding once into an immutable model (nodes, edges, producer sets, requirement sets) cached by definition/binding revision, and implement requirement satisfaction and depends_on enforcement once; migrate the 22 services that read raw map JSON.
- **Done when:** FMT-03 reproduction is rejected at import; one satisfaction implementation; golden conformance fixtures (R-F4) pass unchanged.
- **Progress:** FMT-03 fixed: the import cycle check includes the implicit milestone edges targetClosure uses. The compiled map model and single evaluator remain.

### R-F2

**Typed feature recognition instead of prose and magic identifiers** · Phase P3 · Effort M · Status: open

- **Resolves:** [FMT-04](findings/FMT-plan-and-roadmap-formats.md#fmt-04-automation-features-are-enabled-by-matching-prose-and-magic-identifiers-in-the-map), [CTRL-21](findings/CTRL-controller.md#ctrl-21-map-specific-vocabulary-is-hard-coded-in-the-controller), [AGT-55](findings/AGT-GIT-SEC-agents-git-security.md#agt-55-rust--and-project-specific-text-is-hard-coded-into-generic-brief-paths)
- **Change:** Replace exact-English-string, role-name, resource-id and regex triggers with a typed recognition layer and explicit defaults; move role/resource/brief vocabulary into data keyed by map-declared ids; keep today's ids as defaults so the v0.3 map behaves identically.
- **Done when:** Rewording map prose does not change behaviour (test with a reworded copy of the fixture).

### R-F3

**Format ingestion bugs and test honesty** · Phase P0/P1 · Effort S-M · Status: partial (7d44b42, 0ef1c95)

- **Resolves:** [FMT-08](findings/FMT-plan-and-roadmap-formats.md#fmt-08-work-item-phase-is-unbounded-in-the-normalizer-but-64-in-the-database-and-wire-contract), [FMT-11](findings/FMT-plan-and-roadmap-formats.md#fmt-11-the-studio-seam-is-unused-and-produces-a-different-definition-digest), [FMT-13](findings/FMT-plan-and-roadmap-formats.md#fmt-13-the-same-plan-imported-by-discrete-upload-and-by-zip-gets-different-digests), [FMT-14](findings/FMT-plan-and-roadmap-formats.md#fmt-14-silent-truncation-of-plan-fields-that-agents-treat-as-the-contract), [FMT-15](findings/FMT-plan-and-roadmap-formats.md#fmt-15-execution-tests-bypass-the-importer-with-definitions-it-would-reject), [FMT-16](findings/FMT-plan-and-roadmap-formats.md#fmt-16-roadmap-entry-limits-are-inconsistent-and-settings-are-duplicated-in-every-entry-and-revision)
- **Change:** Diagnose over-long phase at import instead of failing in storage; one digest for the same content regardless of transport (discrete vs ZIP, Studio seam vs ZIP); make truncation of agent-contract fields explicit; make execution tests build maps through the importer; align roadmap entry limits.
- **Done when:** Each reproduction script from the FMT report fails before and passes after.
- **Progress:** FMT-08 and FMT-14 fixed. FMT-13 cannot be fixed without changing existing digests (the live AQ-CONT-1 identity); needs a dual digest / digest v2, which is a schema decision; current behaviour pinned by tests. FMT-11, FMT-15, FMT-16 open.

### R-F4

**Commit the format specification and golden conformance tests** · Phase P0 · Effort S · Status: partial (9b4be64)

- **Resolves:** [FMT-12](findings/FMT-plan-and-roadmap-formats.md#fmt-12-no-in-repo-format-specification-dead-and-misleading-format-codedocs), [FMT-18](findings/FMT-plan-and-roadmap-formats.md#fmt-18-canonical-json-for-source-record-fingerprints-is-an-undocumented-cross-language-contract)
- **Change:** Promote the "Format specification" section of findings/FMT-plan-and-roadmap-formats.md to docs/formats.md after operator review; document the canonical-JSON contract; add golden tests that import every fixture and assert the normalized model and digests, so refactors cannot silently change the ground truth.
- **Done when:** docs/formats.md exists and is referenced from AGENTS.md read order; golden tests run in pnpm check.
- **Progress:** Golden conformance tests over every fixture (plan bundles, invalid breakdowns, v0.3 map: digests, normalized models, 335 nodes / 1,221 edges, target closures); regenerate only with CRAFTINGTABLE_UPDATE_GOLDEN=1. Live plan and map digests equal the golden values. docs/formats.md awaits operator review of the specification.

### R-F5

**Backward-compatible format additions before the Studio** · Phase P4 · Effort M · Status: open

- **Resolves:** [FMT-19](findings/FMT-plan-and-roadmap-formats.md#fmt-19-operator-decision-points-are-implicit-in-the-formats), [FMT-04](findings/FMT-plan-and-roadmap-formats.md#fmt-04-automation-features-are-enabled-by-matching-prose-and-magic-identifiers-in-the-map), [FMT-05](findings/FMT-plan-and-roadmap-formats.md#fmt-05-the-concurrency-map-format-is-hard-wired-to-the-aqwiexo-stack-shape)
- **Change:** Operator-approved on 2026-09-23 (no longer a last resort). After the compiled map model (R-F1) exists, add optional, typed fields so maps declare what code currently infers (FMT report Appendix A #2, #3, #6, #7, #9): explicit operator decision points {id, question, options, authority, blocks, evidence_contract, default}; typed evidence review contracts, reviewer-role purposes, resource adapters, slice verification mode and repository build system instead of prose signatures and magic ids; relaxed cardinalities (no mandatory previous definition, zero resource locks, single-repository stacks); map ids that accept every valid plan id; bounded plan-bundle strings with explicit errors and recognized repository/baseline/integration-branch fields. Record it as a format ADR (v0.3 superset or v0.4); every v0.3 map and plan bundle keeps importing and executing unchanged, and a missing field falls back to today's inference in one place.
- **Done when:** Format ADR accepted; golden conformance tests (R-F4) unchanged for v0.3; a map using the new fields drives decision points, reviewer roles and resources without any prose matching; operator decision points feed the typed attention/inbox (R-A3/R-A5).

### R-F6

**The Studio format family (first step of the Development Studio)** · Phase P5 · Effort L · Status: open

- **Resolves:** [FMT-05](findings/FMT-plan-and-roadmap-formats.md#fmt-05-the-concurrency-map-format-is-hard-wired-to-the-aqwiexo-stack-shape), [FMT-06](findings/FMT-plan-and-roadmap-formats.md#fmt-06-runtime-pinning-is-cargo-only-and-forced-on-every-map), [FMT-11](findings/FMT-plan-and-roadmap-formats.md#fmt-11-the-studio-seam-is-unused-and-produces-a-different-definition-digest), [FMT-18](findings/FMT-plan-and-roadmap-formats.md#fmt-18-canonical-json-for-source-record-fingerprints-is-an-undocumented-cross-language-contract)
- **Change:** The opening design step of the Development Studio, since these define what the Studio produces (FMT report Appendix A #1, #4, #5, #8, #10): one format family (plan v2 with optional slices, checkpoints, evidence profiles and resources; a stack document that references plan versions by digest and adds only cross-plan edges, targets and upstream bindings; a roadmap = stack/plan + target + settings); structured planning feedback from agents mapped to amendment patches instead of re-imported ZIPs; a generic upstream/baseline model with pluggable runtime pinning instead of the AQ/Cargo-specific shape; machine-readable scheduling hints; RFC 8785 canonicalization with a second digest version so existing digests stay valid. The Studio and ZIP import feed the same validation and adoption path (fixes the FMT-11 seam divergence). v0.3 import stays supported forever through the compiled model.
- **Done when:** Studio format ADR accepted before Studio UI work begins; the Studio seam and ZIP import produce identical definitions for identical content; v0.3 fixtures still pass.

## Workstream G — Agent execution integrity and security

### R-G1

**Execution safety fixes that can lose or corrupt work** · Phase P0 · Effort S-M · Status: done (3e34531, c57c51a)

- **Resolves:** [AGT-01](findings/AGT-GIT-SEC-agents-git-security.md#agt-01-a-supervision-failure-leaves-the-agent-process-running-while-the-run-is-marked-failed), [GIT-02](findings/AGT-GIT-SEC-agents-git-security.md#git-02-one-click-worktree-remove-force-deletes-uncommitted-and-untracked-work), [GIT-01](findings/AGT-GIT-SEC-agents-git-security.md#git-01-a-merge-that-times-out-in-the-primary-checkout-is-never-aborted), [AGT-09](findings/AGT-GIT-SEC-agents-git-security.md#agt-09-a-ct-check-or-ct-act-timeout-kills-only-the-direct-child-not-its-process-tree), [AGT-13](findings/AGT-GIT-SEC-agents-git-security.md#agt-13-manual-launches-allow-two-live-agents-in-the-same-worktree), [GIT-09](findings/AGT-GIT-SEC-agents-git-security.md#git-09-merge-cleanup-deletes-the-branch-without-pinning-its-commit)
- **Change:** Kill the agent process group when the run consumer throws, and keep the worktree reserved until it exits. Worktree Remove defaults to non-force; the server refuses (409 with dirty paths) unless the operator explicitly discards changes. Abort a merge whose git process timed out (MERGE_HEAD present) and recover the primary checkout. ct-check/ct-act timeouts kill the process tree. Manual launches refuse a second live agent in the same worktree. Pin the branch tip before deleting a merged branch.
- **Done when:** Tests: throwing consumer -> process group gone and new launch refused until exit; dirty worktree removal refused; merge-hook timeout leaves no MERGE_HEAD.
- **Progress:** Follow-up: pinned-cargo.ts still uses spawnSync timeouts that kill only the direct child.

### R-G2

**Make automatic provider retry actually fire** · Phase P0 · Effort S · Status: done (d0f66ef)

- **Resolves:** [AGT-06](findings/AGT-GIT-SEC-agents-git-security.md#agt-06-codex-sleep-items-and-any-unknown-item-type-silently-disable-adr-062-automatic-provider-retries), [AGT-59](findings/AGT-GIT-SEC-agents-git-security.md#agt-59-claude-transient-service-failures-never-qualify-for-adr-062-automatic-retry), [AGT-61](findings/AGT-GIT-SEC-agents-git-security.md#agt-61-failure-data-is-sparse-and-the-adr-062-path-has-never-run-on-live-data), [AGT-07](findings/AGT-GIT-SEC-agents-git-security.md#agt-07-unknown-vendor-messages-become-journal-events-with-raw-payloads-thousands-of-noise-notices)
- **Change:** Codex `sleep` and other benign item types no longer mark a turn unsafe to continue; Claude results with is_error + an API error are classified as provider failures; unknown vendor messages stop producing raw notice events; add recorded vendor fixtures for each failure class.
- **Done when:** Fixture tests for both backends show a transient provider failure scheduling an ADR-062 retry.
- **Progress:** Decision: HTTP 429 from Claude is treated as quota (operator), consistent with ADR-062 and the Codex adapter, because a short rate limit cannot be told apart from a subscription session limit. Unknown Codex item types still block retry (conservative) but are reported once per type per run.

### R-G3

**Scope operator guidance to the step it was given for** · Phase P0 · Effort S-M · Status: done (8c92c57)

- **Resolves:** [AGT-52](findings/AGT-GIT-SEC-agents-git-security.md#agt-52-one-shot-operator-guidance-persists-into-every-later-cycle-step-and-contradicts-them), [AGT-51](findings/AGT-GIT-SEC-agents-git-security.md#agt-51-controller-authored-text-is-presented-to-agents-as--operator-instructions)
- **Change:** One-shot guidance applies to the next run only and is recorded on that run; it no longer accumulates in the cycle instructions that later implement and review steps inherit. Controller-authored text is labelled as controller instructions, not "Operator instructions".
- **Done when:** Test: guidance given on a review retry is absent from the following implement brief.
- **Progress:** New optional cycle field stepGuidance; legacy accumulated instructions are kept but no longer appended to. UI does not yet display pending step guidance; finalization operator text still sits in the controller rules section (R-G6).

### R-G4

**Daemon-owned verification receipts** · Phase P2 · Effort M-L · Status: open

- **Resolves:** [SEC-01](findings/AGT-GIT-SEC-agents-git-security.md#sec-01-agents-can-forge-the-buildcheckcinative-receipts-that-gate-integration), [AGT-08](findings/AGT-GIT-SEC-agents-git-security.md#agt-08-verification-exists-only-for-cargo-non-rust-repositories-get-no-controller-supplied-verification), [AGT-04](findings/AGT-GIT-SEC-agents-git-security.md#agt-04-the-adapters-hard-code-cargo-and-controller-build-concepts)
- **Change:** Check launchers become thin clients of a daemon-owned socket; the daemon runs the command in its own supervised process group outside the agent's writable roots and writes the receipt to SQLite. Generalize verification beyond Cargo (a declared check command per repository). Until then, label receipts as agent-reported in the UI.
- **Done when:** No gating receipt is read from an agent-writable path.

### R-G5

**Agent environment and configuration isolation** · Phase P2 · Effort M · Status: open

- **Resolves:** [SEC-02](findings/AGT-GIT-SEC-agents-git-security.md#sec-02-agent-confinement-is-cooperative-in-practice-inherited-desktop-environment-routine-sandbox-escalation-docker-socket), [SEC-03](findings/AGT-GIT-SEC-agents-git-security.md#sec-03-daemon-git-calls-execute-repository-controlled-hooks-and-config-the-existing-hardening-is-unused), [AGT-14](findings/AGT-GIT-SEC-agents-git-security.md#agt-14-supervised-agents-inherit-the-operators-personal-claudecodex-configuration-hooks-plugins-skills-memory-mcp), [GIT-08](findings/AGT-GIT-SEC-agents-git-security.md#git-08-daemon-authored-commits-and-merges-run-repository-hooks-outside-agent-supervision)
- **Change:** Build the child environment from an allowlist in one place; run agents with isolated Claude/Codex configuration (no operator hooks, plugins, skills, memory or MCP unless declared); lay out the sandbox so ordinary commits and loopback tests need no escalation; disable repository hooks/fsmonitor for daemon Git operations; snapshot protected refs before/after each run and flag unexpected moves.
- **Done when:** A run's environment contains only allowlisted variables; supervised Claude runs do not load the operator's skills.

### R-G6

**Redesign briefs around the task** · Phase P2 · Effort M · Status: open

- **Resolves:** [AGT-50](findings/AGT-GIT-SEC-agents-git-security.md#agt-50-briefs-are-mostly-controller-protocol-boilerplate-the-task-itself-is-a-small-fraction), [AGT-53](findings/AGT-GIT-SEC-agents-git-security.md#agt-53-the-parents-final-message-is-inlined-verbatim-duplicating-the-handoff-and-breaking-brief-structure), [AGT-54](findings/AGT-GIT-SEC-agents-git-security.md#agt-54-structured-output-instructions-are-scattered-across-6-modules-and-conflict-for-some-roles), [AGT-56](findings/AGT-GIT-SEC-agents-git-security.md#agt-56-per-run-context-artifacts-are-oversized-and-copied-on-every-run), [AGT-57](findings/AGT-GIT-SEC-agents-git-security.md#agt-57-briefs-inherit-links-into-other-runs-scratch-and-plan-paths-that-later-expire), [AGT-58](findings/AGT-GIT-SEC-agents-git-security.md#agt-58-the-scope-section-repeats-the-goal-three-times-and-dumps-internal-id-json)
- **Change:** Goal and acceptance criteria first; controller protocol in one module with role-specific structured-output instructions that do not conflict; reference the parent run via the handoff instead of inlining its final message; stop copying oversized context artifacts per run; no links into other runs' expiring scratch; scope section states the goal once.
- **Done when:** Median brief size and the goal's share of it are tracked; goal share rises substantially from <5%.

### R-G7

**Stop cold-building Rust on every step** · Phase P1 · Effort M · Status: open

- **Resolves:** [AGT-05](findings/AGT-GIT-SEC-agents-git-security.md#agt-05-per-run-cargo_target_dir-forces-a-cold-rust-build-on-every-step-768-gb-written-and-deleted-in-10-days)
- **Change:** Share a Cargo target directory per worktree (or per repository with a lock) across the steps of a cycle, with the ADR-039 cleanup applied when the worktree is merged/removed.
- **Done when:** Cache removal volume per day drops by an order of magnitude from the 768 GB/10-day baseline.

### R-G8

**Backend capability model and persistent-agent seam** · Phase P5 · Effort M-L · Status: open

- **Resolves:** [AGT-10](findings/AGT-GIT-SEC-agents-git-security.md#agt-10-backend-capabilities-are-expressed-as-backend--codex-checks-scattered-across-daemon-domain-contracts-and-web), [AGT-11](findings/AGT-GIT-SEC-agents-git-security.md#agt-11-the-seam-cannot-host-persistent-hermesopenclaw-style-agents-without-redesign)
- **Change:** Replace ~15 backend === "codex" checks (7 in the web) with declared capabilities; open the closed backend CHECK constraint; split transport from backend so a persistent (Hermes/OpenClaw-style) agent can host runs.
- **Done when:** Adding a third backend requires no web changes.

### R-G9

**Authentication and authorization hardening** · Phase P2 · Effort M · Status: open

- **Resolves:** [SEC-04](findings/AGT-GIT-SEC-agents-git-security.md#sec-04-authentication-hardening-is-weak-for-a-session-that-amounts-to-code-execution), [SEC-05](findings/AGT-GIT-SEC-agents-git-security.md#sec-05-route-authorization-depends-on-every-handler-remembering-to-call-it), [SEC-06](findings/AGT-GIT-SEC-agents-git-security.md#sec-06-the-browser-can-register-any-host-path-as-a-repository), [SEC-07](findings/AGT-GIT-SEC-agents-git-security.md#sec-07-missing-browser-security-headers-and-host-check), [SEC-08](findings/AGT-GIT-SEC-agents-git-security.md#sec-08-stored-credentials-are-readable-by-agents-and-old-db-copies-are-retained), [QA-03](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-03-the-authorization-surface-has-no-systematic-tests-and-the-no-approve-route-test-checks-spelling)
- **Change:** Login rate limiting, idle session expiry, step-up authentication for unrestricted runs and final promotion; a global route auth hook with an explicit public allowlist; repository registration limited to configured roots; security headers and Host check; credentials not readable from agent-writable locations; retire old DB copies.
- **Done when:** A route sweep test asserts 401/403/404 for every route and role.

### R-G10

**Git adapter robustness and structure** · Phase P3 · Effort M · Status: open

- **Resolves:** [GIT-03](findings/AGT-GIT-SEC-agents-git-security.md#git-03-large-diffs-fail-outright-instead-of-truncating-and-the-diff-limit-setting-is-partly-ignored), [GIT-05](findings/AGT-GIT-SEC-agents-git-security.md#git-05-scratch-worktree-merges-check-out-the-whole-target-every-time-and-the-target-check-is-not-atomic), [GIT-06](findings/AGT-GIT-SEC-agents-git-security.md#git-06-git-timeouts-and-output-limits-are-hard-coded), [GIT-07](findings/AGT-GIT-SEC-agents-git-security.md#git-07-promotions-into-the-primary-checkout-are-brittle), [GIT-10](findings/AGT-GIT-SEC-agents-git-security.md#git-10-operationsts-is-one-1754-line-factory-behind-a-24-method-interface), [GIT-11](findings/AGT-GIT-SEC-agents-git-security.md#git-11-the-risky-git-paths-lack-tests)
- **Change:** Large diffs truncate instead of failing; configurable timeouts and output limits; cheaper and atomic scratch merges; resilient promotions; split operations.ts by concern; tests for the risky paths.
- **Done when:** Tests cover merge timeout, large diff, scratch merge target race.

### R-G11

**Supervisor loose ends** · Phase P3 · Effort S-M · Status: open

- **Resolves:** [AGT-02](findings/AGT-GIT-SEC-agents-git-security.md#agt-02-restart-recovery-relies-entirely-on-systemd-no-process-identity-is-persisted), [AGT-16](findings/AGT-GIT-SEC-agents-git-security.md#agt-16-smaller-supervisor-defects), [AGT-17](findings/AGT-GIT-SEC-agents-git-security.md#agt-17-documentation-drift-in-the-agent-seam), [AGT-62](findings/AGT-GIT-SEC-agents-git-security.md#agt-62-claude-background-task-notifications-create-streams-of-invalid-review-turns-and-status-churn)
- **Change:** Persist process identity for restart recovery; fix the smaller supervisor defects; stop Claude background-task notifications from producing invalid review turns; update agent seam docs.
- **Done when:** See the AGT report entries.

### R-G12

**(Future) agent runs that outlive the daemon** · Phase P5 · Effort L · Status: open

- **Resolves:** [AGT-02](findings/AGT-GIT-SEC-agents-git-security.md#agt-02-restart-recovery-relies-entirely-on-systemd-no-process-identity-is-persisted), [AGT-11](findings/AGT-GIT-SEC-agents-git-security.md#agt-11-the-seam-cannot-host-persistent-hermesopenclaw-style-agents-without-redesign)
- **Change:** Recorded 2026-09-23 as a future item, to be designed together with persistent (Hermes/OpenClaw-style) agents (R-G8). Give each run a small supervisor in its own transient systemd user unit that owns the agent process and its stdio, persists process identity, and appends normalized events to a durable per-run file or socket; the daemon becomes a client that re-attaches to live supervisors on start and replays their events from its last journal cursor. This removes restart as a source of interruption entirely (R-B9 only shortens and repairs it) and is the same decoupling a persistent agent needs. Preserve today's authority boundaries: process spawning stays in the listed adapter modules, cancellation and deadlines stay daemon-owned.
- **Done when:** A daemon restart during a live run loses no events and needs no resume; the design ADR covers persistent agents as well.

## Workstream H — Data lifecycle and integrity

### R-H1

**Fix the unreadable first run (live 500)** · Phase P0 · Effort S · Status: done (c8f58fc)

- **Resolves:** [DATA-03](findings/DATA-storage-domain-contracts.md#data-03-a-strict-response-schema-combined-with-no-read-side-upgrade-makes-the-first-runs-events-unreadable-live-bug-and-all-persisted-json-is-read-with-bare-casts)
- **Change:** Make `billing` optional (or default it to unknown) in the run-event envelope so the 2026-09-04 run's events load again.
- **Done when:** All 46k live events validate against the response contract (verify script from R-H3).
- **Progress:** Missing billing reads as unknown. Validating all live events awaits the R-H3 verify script.

### R-H2

**Journal retention: stop storing raw vendor lines by default** · Phase P1 · Effort M · Status: open

- **Resolves:** [DATA-01](findings/DATA-storage-domain-contracts.md#data-01-agent_run_eventsraw_json-is-278-mb-of-never-read-data-that-is-also-shipped-to-the-browser), [DATA-02](findings/DATA-storage-domain-contracts.md#data-02-the-journal-can-never-be-pruned-growth-is-unbounded-and-every-byte-is-duplicated-about-8-by-backups), [AGT-03](findings/AGT-GIT-SEC-agents-git-security.md#agt-03-raw-vendor-lines-take-about-half-the-database-and-are-shipped-to-the-browser-which-never-reads-them), [HIST-11](findings/HIST-history-and-live-usage.md#hist-11-run-event-storage-is-dominated-by-duplicated-raw-vendor-json)
- **Change:** Store raw only when normalization fails (or for a bounded window); move large tool-result bodies to compressed per-run files with a digest and preview in SQLite; add an explicit, audited compaction command (the append-only trigger stays for normal writes) and a retention policy aligned with run-directory cleanup.
- **Done when:** DB growth per run drops by >50%; backups shrink accordingly.

### R-H3

**Read-side upcasters, write-side validation and db:verify** · Phase P1 · Effort M · Status: open

- **Resolves:** [DATA-03](findings/DATA-storage-domain-contracts.md#data-03-a-strict-response-schema-combined-with-no-read-side-upgrade-makes-the-first-runs-events-unreadable-live-bug-and-all-persisted-json-is-read-with-bare-casts), [DATA-10](findings/DATA-storage-domain-contracts.md#data-10-contracts-duplicate-domain-types-by-hand-with-no-compile-time-equivalence-check), [DATA-14](findings/DATA-storage-domain-contracts.md#data-14-table-rebuild-migrations-lack-preservation-tests-the-runners-fk-off-directive-contradicts-adr-002)
- **Change:** Upcast every JSON-bearing record at the storage read boundary to one current shape; validate with the contract schema at each aggregate's single save path; `pnpm db:verify <path>` validates every persisted aggregate and event against current contracts (run before deploying a contract change); compile-time equivalence checks between domain types and contract schemas; preservation tests for table-rebuild migrations.
- **Done when:** db:verify passes on a live snapshot and runs in CI against fixtures.

### R-H4

**Lighter evidence and definition storage** · Phase P2 · Effort M · Status: open

- **Resolves:** [PERF-08](findings/PERF-browser-and-read-performance.md#perf-08-map-evaluation-hot-spots-in-roadmap-view-cycles-list-and-cross-project-preview)
- **Change:** Evidence submissions become a light index row plus a lazily decoded body; persist canonical digests at write time instead of canonicalizing whole definitions at read time.
- **Done when:** roadmap view and cross-project preview no longer decode full submissions.

### R-H5

**Rationalize the route surface** · Phase P3 · Effort M · Status: open

- **Resolves:** [DATA-13](findings/DATA-storage-domain-contracts.md#data-13-the-route-surface-has-grown-by-accretion-121-routes-naming-is-inconsistent-endpoints-are-panel-specific-and-the-forbidden-fragment-guard-only-checks-names)
- **Change:** Consistent resource naming across the 121 routes; retire panel-specific endpoints as view models (R-D5) and the inbox (R-A5) replace them; make the forbidden-fragment guard check semantics, not names.
- **Done when:** Route inventory documented and shrinking.

## Workstream I — Engineering hygiene (tests, docs, repository, deployment)

### R-I1

**Protect the work and stop repository bloat** · Phase P0 · Effort S · Status: partial (4952821, 44a64bd)

- **Resolves:** [REPO-02](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-02-42-commits-six-days-of-work-exist-only-on-the-local-disk), [REPO-01](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-01-walkthrough-pngs-make-up-99-of-the-repository-and-grow-about-155-mibday), [HIST-14](findings/HIST-history-and-live-usage.md#hist-14-ui-walkthrough-captures-are-committed-on-nearly-every-commit-since-09-16-15-gb-4986-pngs), [DOC-06](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-06-agentsmd-mandates-repository-bloating-captures)
- **Change:** OPERATOR ACTION: push or back up the 42 local-only commits. Stop committing walkthrough PNGs: captures go to a directory outside the repository (structural boundary) with a small committed text index per capture; change the AGENTS.md capture rule accordingly. Optionally (operator decision) strip the PNGs from history before the first push, which is the cheapest moment to do it.
- **Done when:** origin/main contains the work; new captures add no binaries to Git.
- **Progress:** Done 2026-09-23 at the operator's request: walkthrough PNGs stripped from history with git filter-repo (only the 42 local commits after origin/main were rewritten, so the push is a fast-forward); .git went from 1.1 GB to 5.7 MB. All 56 earlier captures were preserved in the external store; the harness now writes to $CRAFTINGTABLE_WALKTHROUGH_DIR (default $XDG_DATA_HOME/craftingtable-walkthrough) and appends a row to the committed docs/ui-walkthrough/INDEX.md. Remaining: the operator pushes to origin.

### R-I2

**Split the 14k-line execution test file** · Phase P1 · Effort M · Status: open

- **Resolves:** [QA-01](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-01-server-executiontestts-is-the-whole-critical-path-of-the-unit-suite-and-should-be-split-by-aggregate), [QA-02](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-02-orchestration-tests-poll-wall-clock-time-because-the-controller-has-no-deterministic-stepping-seam)
- **Change:** Split server-execution.test.ts by aggregate (runs, merge gate, cycles, roadmaps, finalization, execution scopes) so files run in parallel; use the R-B2 stepping seam to remove wall-clock polling.
- **Done when:** pnpm test under ~90 s (from 5 min 46 s).

### R-I3

**Systematic authorization tests** · Phase P1 · Effort S-M · Status: open

- **Resolves:** [QA-03](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-03-the-authorization-surface-has-no-systematic-tests-and-the-no-approve-route-test-checks-spelling), [SEC-05](findings/AGT-GIT-SEC-agents-git-security.md#sec-05-route-authorization-depends-on-every-handler-remembering-to-call-it)
- **Change:** A table-driven sweep over every route asserting unauthenticated, wrong-workspace and insufficient-role responses; replace the "no route contains approve" spelling test with a semantic one.
- **Done when:** Adding a route without an auth decision fails the sweep.

### R-I4

**Structural test/production and process-authority boundaries** · Phase P2 · Effort M · Status: open

- **Resolves:** [QA-04](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-04-checkscope-exemptions-are-filename-patterns-and-several-bypasses-are-open), [QA-07](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-07-the-testproduction-boundary-is-structural-only-in-packagesgit-everywhere-else-tests-and-test-support-compile-into-dist)
- **Change:** Move test-support and fixtures out of compiled src trees everywhere (as packages/git already does); make check:scope reject builtin-module access via computed import/getBuiltinModule and stop exempting files by name pattern.
- **Done when:** No *.test.js or test-support in dist; the known bypasses fail check:scope.

### R-I5

**E2E and fixture reliability** · Phase P1 · Effort S-M · Status: open

- **Resolves:** [QA-05](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-05-e2e-gate-screenshots-are-unasserted-cause-the-known-flake-and-helpers-are-copied-into-8-specs), [QA-06](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-06-the-fixture-derives-expected-scope-evidence-from-the-production-resolver-tautological), [QA-08](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-08-unit-tests-depend-on-host-tool-paths-and-create-fixtures-inside-the-repository)
- **Change:** Assert or remove the unasserted gate screenshots (including the known amendment-panel flake); dedupe helpers copied into 8 specs; derive expected scope evidence independently of the production resolver; remove hard-coded host tool paths and in-repo temporary repositories.
- **Done when:** E2E passes 10 consecutive runs; unit tests pass on a host without ~/.cargo.

### R-I6

**Gate on lint** · Phase P1 · Effort S-M · Status: open

- **Resolves:** [QA-09](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-09-lint-warnings-do-not-gate-the-build-and-666-have-accumulated)
- **Change:** Burn down the 666 Biome warnings (mostly mechanical) and make warnings fail pnpm check.
- **Done when:** pnpm check fails on a new warning.

### R-I7

**Documentation reset to current state** · Phase P1-P3 · Effort M · Status: open

- **Resolves:** [DOC-01](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-01-the-readme-is-a-feature-changelog-not-an-operator-guide), [DOC-02](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-02-adr-sprawl--65-records-broken-index-inconsistent-status-metadata-long-refinement-chains), [DOC-03](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-03-doc-claims-out-of-sync-with-code-spot-check-of-14-claims-7-false-or-stale), [DOC-05](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-05-principles-security-and-operations-docs-have-become-per-feature-narratives), [UI-15](findings/UI-information-architecture.md#ui-15-docsui-principlesmd-has-become-a-per-slice-accretion-log-that-encourages-new-surfaces), [SEC-09](findings/AGT-GIT-SEC-agents-git-security.md#sec-09-docssecuritymd-is-an-accreted-per-slice-log-with-stale-claims), [HIST-13](findings/HIST-history-and-live-usage.md#hist-13-schema-and-adr-churn-rate-22-migrations-46-adrs-in-18-days-with-manual-pre-migration-backups), [HIST-15](findings/HIST-history-and-live-usage.md#hist-15-commit-messages-stopped-describing-changes-adr-numbering-is-inconsistent), [DATA-15](findings/DATA-storage-domain-contracts.md#data-15-documentation-and-vocabulary-drift-adrs-process-authority-branded-ids-exports-plan-specific-literals), [AGT-17](findings/AGT-GIT-SEC-agents-git-security.md#agt-17-documentation-drift-in-the-agent-seam)
- **Change:** README becomes an operator guide (what it is, run it, the main workflow) instead of a feature changelog; architecture.md describes the current design, not schema history; one ADR naming scheme, a complete index and correct statuses, superseded chains marked; ui-principles split into visual language, IA rules ("decisions are made only in the inbox; other pages link"), glossary and short per-surface specs; security.md and operations.md rewritten as current state; commit messages carry a body saying what stop or need motivated the change.
- **Done when:** Spot-checked claims all true; README under ~150 lines.

### R-I8

**Deploy from a separate checkout; one daemon per data directory** · Phase P1 · Effort S-M · Status: partial (943fb8d)

- **Resolves:** [REPO-04](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-04-the-production-daemon-runs-from-the-development-checkout-and-its-build-output), [SEC-10](findings/AGT-GIT-SEC-agents-git-security.md#sec-10-the-daemon-runs-straight-from-the-editable-development-checkout), [REPO-03](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-03-legacy-process-directories-and-branches-are-still-at-top-level)
- **Change:** Run the daemon from a separate deploy checkout updated by an explicit `pnpm deploy:daemon <ref>` command (fetch the exact ref from the dev repo, install, build, restart the single systemd user unit, record the deployed commit; rollback = deploy the previous commit; add the R-B9 drain when it exists), so editing or running tsc in the dev checkout never changes what production loads. Take an exclusive lock on the data directory at daemon start, before migrations and restart recovery: today a stray second daemon on the same data directory (e.g. `pnpm start` in another checkout) would mark live runs interrupted and roadmaps needs-attention before failing to bind the port. `pnpm dev` defaults to its own port and data directory. Archive the CT-01..03 process directories and merged CT-era branches.
- **Done when:** A tsc -b in the dev checkout cannot affect the running daemon; a second daemon on the same data directory exits before touching the database (test); deploy and rollback are one command each.
- **Progress:** Deployed 2026-09-23: the daemon runs from $XDG_DATA_HOME/craftingtable-deploy/current (systemd drop-in deploy-checkout.conf) via `pnpm deploy:daemon <ref>` (release per commit, atomic switch, health check with automatic rollback, `--rollback`, `--status`, deploys.jsonl). The data-directory lock was verified against the live daemon: a second daemon exits naming the holder. `pnpm dev` / `pnpm craftingtable:dev` use their own data directory and port 4601. Remaining: archive the CT-01..03 process directories and merged CT-era branches. Deploys drain through R-B9 once a release containing it is running.

## Finding index

All 202 findings, in report order. Severity and status are the reviewer's; "Item" is the remediation item that resolves it.

| Finding | Severity | Evidence | Effort | Item | Title |
|---|---|---|---|---|---|
| [AGT-01](findings/AGT-GIT-SEC-agents-git-security.md#agt-01-a-supervision-failure-leaves-the-agent-process-running-while-the-run-is-marked-failed) | high | CONFIRMED | S | [R-G1](#r-g1) | A supervision failure leaves the agent process running while the run is marked failed |
| [AGT-02](findings/AGT-GIT-SEC-agents-git-security.md#agt-02-restart-recovery-relies-entirely-on-systemd-no-process-identity-is-persisted) | medium | CONFIRMED | S–M | [R-G11](#r-g11), [R-G12](#r-g12) | Restart recovery relies entirely on systemd; no process identity is persisted |
| [AGT-03](findings/AGT-GIT-SEC-agents-git-security.md#agt-03-raw-vendor-lines-take-about-half-the-database-and-are-shipped-to-the-browser-which-never-reads-them) | high | CONFIRMED | S | [R-D1](#r-d1), [R-H2](#r-h2) | Raw vendor lines take about half the database and are shipped to the browser, which never reads them |
| [AGT-04](findings/AGT-GIT-SEC-agents-git-security.md#agt-04-the-adapters-hard-code-cargo-and-controller-build-concepts) | medium | CONFIRMED | S–M | [R-G4](#r-g4) | The adapters hard-code Cargo and controller build concepts |
| [AGT-05](findings/AGT-GIT-SEC-agents-git-security.md#agt-05-per-run-cargo_target_dir-forces-a-cold-rust-build-on-every-step-768-gb-written-and-deleted-in-10-days) | high | CONFIRMED | S–M | [R-G7](#r-g7) | Per-run `CARGO_TARGET_DIR` forces a cold Rust build on every step (768 GB written and deleted in 10 days) |
| [AGT-06](findings/AGT-GIT-SEC-agents-git-security.md#agt-06-codex-sleep-items-and-any-unknown-item-type-silently-disable-adr-062-automatic-provider-retries) | high | CONFIRMED | S | [R-G2](#r-g2) | Codex `sleep` items (and any unknown item type) silently disable ADR-062 automatic provider retries |
| [AGT-07](findings/AGT-GIT-SEC-agents-git-security.md#agt-07-unknown-vendor-messages-become-journal-events-with-raw-payloads-thousands-of-noise-notices) | low | CONFIRMED | S | [R-G2](#r-g2) | Unknown vendor messages become journal events with raw payloads (thousands of noise notices) |
| [AGT-08](findings/AGT-GIT-SEC-agents-git-security.md#agt-08-verification-exists-only-for-cargo-non-rust-repositories-get-no-controller-supplied-verification) | medium | CONFIRMED | L | [R-G4](#r-g4) | Verification exists only for Cargo; non-Rust repositories get no controller-supplied verification |
| [AGT-09](findings/AGT-GIT-SEC-agents-git-security.md#agt-09-a-ct-check-or-ct-act-timeout-kills-only-the-direct-child-not-its-process-tree) | medium | CONFIRMED | S | [R-G1](#r-g1) | A ct-check or ct-act timeout kills only the direct child, not its process tree |
| [AGT-10](findings/AGT-GIT-SEC-agents-git-security.md#agt-10-backend-capabilities-are-expressed-as-backend--codex-checks-scattered-across-daemon-domain-contracts-and-web) | medium | CONFIRMED | M | [R-G8](#r-g8) | Backend capabilities are expressed as `backend === 'codex'` checks scattered across daemon, domain, contracts and web |
| [AGT-11](findings/AGT-GIT-SEC-agents-git-security.md#agt-11-the-seam-cannot-host-persistent-hermesopenclaw-style-agents-without-redesign) | medium | CONFIRMED | M | [R-G8](#r-g8), [R-G12](#r-g12) | The seam cannot host persistent (Hermes/OpenClaw-style) agents without redesign |
| [AGT-12](findings/AGT-GIT-SEC-agents-git-security.md#agt-12-launchauthorized-is-a-780-line-mixed-responsibility-function-its-side-effects-precede-the-durable-record) | medium | CONFIRMED | M | [R-B7](#r-b7) | `launchAuthorized` is a ~780-line mixed-responsibility function; its side effects precede the durable record |
| [AGT-13](findings/AGT-GIT-SEC-agents-git-security.md#agt-13-manual-launches-allow-two-live-agents-in-the-same-worktree) | medium | CONFIRMED | S | [R-G1](#r-g1) | Manual launches allow two live agents in the same worktree |
| [AGT-14](findings/AGT-GIT-SEC-agents-git-security.md#agt-14-supervised-agents-inherit-the-operators-personal-claudecodex-configuration-hooks-plugins-skills-memory-mcp) | medium | CONFIRMED | S–M | [R-G5](#r-g5) | Supervised agents inherit the operator's personal Claude/Codex configuration (hooks, plugins, skills, memory, MCP) |
| [AGT-15](findings/AGT-GIT-SEC-agents-git-security.md#agt-15-each-agent-event-is-a-separate-fsyncd-transaction-plus-a-notifier-broadcast-on-the-main-event-loop) | medium | CONFIRMED | S–M | [R-B5](#r-b5) | Each agent event is a separate fsync'd transaction plus a notifier broadcast on the main event loop |
| [AGT-16](findings/AGT-GIT-SEC-agents-git-security.md#agt-16-smaller-supervisor-defects) | low | CONFIRMED | S | [R-G11](#r-g11) | Smaller supervisor defects |
| [AGT-17](findings/AGT-GIT-SEC-agents-git-security.md#agt-17-documentation-drift-in-the-agent-seam) | low | CONFIRMED | S | [R-G11](#r-g11), [R-I7](#r-i7) | Documentation drift in the agent seam |
| [AGT-50](findings/AGT-GIT-SEC-agents-git-security.md#agt-50-briefs-are-mostly-controller-protocol-boilerplate-the-task-itself-is-a-small-fraction) | medium | CONFIRMED | M | [R-G6](#r-g6) | Briefs are mostly controller-protocol boilerplate; the task itself is a small fraction |
| [AGT-51](findings/AGT-GIT-SEC-agents-git-security.md#agt-51-controller-authored-text-is-presented-to-agents-as--operator-instructions) | medium | CONFIRMED | S–M | [R-G3](#r-g3) | Controller-authored text is presented to agents as "## Operator instructions" |
| [AGT-52](findings/AGT-GIT-SEC-agents-git-security.md#agt-52-one-shot-operator-guidance-persists-into-every-later-cycle-step-and-contradicts-them) | high | CONFIRMED | M | [R-G3](#r-g3) | One-shot operator guidance persists into every later cycle step and contradicts them |
| [AGT-53](findings/AGT-GIT-SEC-agents-git-security.md#agt-53-the-parents-final-message-is-inlined-verbatim-duplicating-the-handoff-and-breaking-brief-structure) | medium | CONFIRMED | S–M | [R-G6](#r-g6) | The parent's final message is inlined verbatim, duplicating the handoff and breaking brief structure |
| [AGT-54](findings/AGT-GIT-SEC-agents-git-security.md#agt-54-structured-output-instructions-are-scattered-across-6-modules-and-conflict-for-some-roles) | medium | CONFIRMED | M | [R-G6](#r-g6) | Structured-output instructions are scattered across 6 modules and conflict for some roles |
| [AGT-55](findings/AGT-GIT-SEC-agents-git-security.md#agt-55-rust--and-project-specific-text-is-hard-coded-into-generic-brief-paths) | medium | CONFIRMED | M | [R-F2](#r-f2) | Rust- and project-specific text is hard-coded into generic brief paths |
| [AGT-56](findings/AGT-GIT-SEC-agents-git-security.md#agt-56-per-run-context-artifacts-are-oversized-and-copied-on-every-run) | medium | CONFIRMED | M | [R-G6](#r-g6) | Per-run context artifacts are oversized and copied on every run |
| [AGT-57](findings/AGT-GIT-SEC-agents-git-security.md#agt-57-briefs-inherit-links-into-other-runs-scratch-and-plan-paths-that-later-expire) | medium | CONFIRMED | S–M | [R-G6](#r-g6) | Briefs inherit links into other runs' scratch and plan paths that later expire |
| [AGT-58](findings/AGT-GIT-SEC-agents-git-security.md#agt-58-the-scope-section-repeats-the-goal-three-times-and-dumps-internal-id-json) | low | CONFIRMED | S | [R-G6](#r-g6) | The scope section repeats the goal three times and dumps internal-ID JSON |
| [AGT-59](findings/AGT-GIT-SEC-agents-git-security.md#agt-59-claude-transient-service-failures-never-qualify-for-adr-062-automatic-retry) | high | CONFIRMED | S | [R-G2](#r-g2) | Claude transient service failures never qualify for ADR-062 automatic retry |
| [AGT-60](findings/AGT-GIT-SEC-agents-git-security.md#agt-60-quota-and-session-limit-failures-with-a-known-reset-time-always-need-the-operator) | medium | CONFIRMED | M | [R-C8](#r-c8) | Quota and session-limit failures with a known reset time always need the operator |
| [AGT-61](findings/AGT-GIT-SEC-agents-git-security.md#agt-61-failure-data-is-sparse-and-the-adr-062-path-has-never-run-on-live-data) | low | CONFIRMED | S | [R-G2](#r-g2) | Failure data is sparse, and the ADR-062 path has never run on live data |
| [AGT-62](findings/AGT-GIT-SEC-agents-git-security.md#agt-62-claude-background-task-notifications-create-streams-of-invalid-review-turns-and-status-churn) | medium | CONFIRMED | S–M | [R-G11](#r-g11) | Claude background-task notifications create streams of invalid review turns and status churn |
| [GIT-01](findings/AGT-GIT-SEC-agents-git-security.md#git-01-a-merge-that-times-out-in-the-primary-checkout-is-never-aborted) | high | CONFIRMED | S–M | [R-G1](#r-g1) | A merge that times out in the primary checkout is never aborted |
| [GIT-02](findings/AGT-GIT-SEC-agents-git-security.md#git-02-one-click-worktree-remove-force-deletes-uncommitted-and-untracked-work) | high | CONFIRMED | S | [R-G1](#r-g1) | One-click worktree "Remove" force-deletes uncommitted and untracked work |
| [GIT-03](findings/AGT-GIT-SEC-agents-git-security.md#git-03-large-diffs-fail-outright-instead-of-truncating-and-the-diff-limit-setting-is-partly-ignored) | medium | CONFIRMED | M | [R-G10](#r-g10) | Large diffs fail outright instead of truncating, and the diff-limit setting is partly ignored |
| [GIT-04](findings/AGT-GIT-SEC-agents-git-security.md#git-04-the-ct-04a1-inspector-is-dead-code-about-78k-lines-but-is-still-composed-configured-and-tested) | medium | CONFIRMED | M | [R-B8](#r-b8) | The CT-04A1 inspector is dead code (about 7–8k lines) but is still composed, configured and tested |
| [GIT-05](findings/AGT-GIT-SEC-agents-git-security.md#git-05-scratch-worktree-merges-check-out-the-whole-target-every-time-and-the-target-check-is-not-atomic) | medium | CONFIRMED | M | [R-G10](#r-g10) | Scratch-worktree merges check out the whole target every time, and the target check is not atomic |
| [GIT-06](findings/AGT-GIT-SEC-agents-git-security.md#git-06-git-timeouts-and-output-limits-are-hard-coded) | low–medium | CONFIRMED | S | [R-G10](#r-g10) | Git timeouts and output limits are hard-coded |
| [GIT-07](findings/AGT-GIT-SEC-agents-git-security.md#git-07-promotions-into-the-primary-checkout-are-brittle) | low | CONFIRMED | S | [R-G10](#r-g10) | Promotions into the primary checkout are brittle |
| [GIT-08](findings/AGT-GIT-SEC-agents-git-security.md#git-08-daemon-authored-commits-and-merges-run-repository-hooks-outside-agent-supervision) | low | HYPOTHESIS | S | [R-G5](#r-g5) | Daemon-authored commits and merges run repository hooks outside agent supervision |
| [GIT-09](findings/AGT-GIT-SEC-agents-git-security.md#git-09-merge-cleanup-deletes-the-branch-without-pinning-its-commit) | low | CONFIRMED | S | [R-G1](#r-g1) | Merge cleanup deletes the branch without pinning its commit |
| [GIT-10](findings/AGT-GIT-SEC-agents-git-security.md#git-10-operationsts-is-one-1754-line-factory-behind-a-24-method-interface) | low | CONFIRMED | M | [R-G10](#r-g10) | `operations.ts` is one 1754-line factory behind a 24-method interface |
| [GIT-11](findings/AGT-GIT-SEC-agents-git-security.md#git-11-the-risky-git-paths-lack-tests) | medium | CONFIRMED | S–M | [R-G10](#r-g10) | The risky Git paths lack tests |
| [SEC-01](findings/AGT-GIT-SEC-agents-git-security.md#sec-01-agents-can-forge-the-buildcheckcinative-receipts-that-gate-integration) | high | CONFIRMED | M–L | [R-G4](#r-g4) | Agents can forge the build/check/CI/native receipts that gate integration |
| [SEC-02](findings/AGT-GIT-SEC-agents-git-security.md#sec-02-agent-confinement-is-cooperative-in-practice-inherited-desktop-environment-routine-sandbox-escalation-docker-socket) | high | CONFIRMED | M | [R-G5](#r-g5) | Agent confinement is cooperative in practice (inherited desktop environment, routine sandbox escalation, Docker socket) |
| [SEC-03](findings/AGT-GIT-SEC-agents-git-security.md#sec-03-daemon-git-calls-execute-repository-controlled-hooks-and-config-the-existing-hardening-is-unused) | medium | CONFIRMED | S–M | [R-G5](#r-g5) | Daemon Git calls execute repository-controlled hooks and config; the existing hardening is unused |
| [SEC-04](findings/AGT-GIT-SEC-agents-git-security.md#sec-04-authentication-hardening-is-weak-for-a-session-that-amounts-to-code-execution) | medium | CONFIRMED | S–M | [R-G9](#r-g9) | Authentication hardening is weak for a session that amounts to code execution |
| [SEC-05](findings/AGT-GIT-SEC-agents-git-security.md#sec-05-route-authorization-depends-on-every-handler-remembering-to-call-it) | medium | CONFIRMED | S | [R-G9](#r-g9), [R-I3](#r-i3) | Route authorization depends on every handler remembering to call it |
| [SEC-06](findings/AGT-GIT-SEC-agents-git-security.md#sec-06-the-browser-can-register-any-host-path-as-a-repository) | low | CONFIRMED | S | [R-G9](#r-g9) | The browser can register any host path as a repository |
| [SEC-07](findings/AGT-GIT-SEC-agents-git-security.md#sec-07-missing-browser-security-headers-and-host-check) | low | CONFIRMED | S | [R-G9](#r-g9) | Missing browser security headers and Host check |
| [SEC-08](findings/AGT-GIT-SEC-agents-git-security.md#sec-08-stored-credentials-are-readable-by-agents-and-old-db-copies-are-retained) | low | CONFIRMED | S | [R-G9](#r-g9) | Stored credentials are readable by agents, and old DB copies are retained |
| [SEC-09](findings/AGT-GIT-SEC-agents-git-security.md#sec-09-docssecuritymd-is-an-accreted-per-slice-log-with-stale-claims) | low | CONFIRMED | S–M | [R-I7](#r-i7) | `docs/security.md` is an accreted per-slice log with stale claims |
| [SEC-10](findings/AGT-GIT-SEC-agents-git-security.md#sec-10-the-daemon-runs-straight-from-the-editable-development-checkout) | low | CONFIRMED | S | [R-I8](#r-i8) | The daemon runs straight from the editable development checkout |
| [CTRL-01](findings/CTRL-controller.md#ctrl-01-the-cycle-controller-is-a-656-line-imperative-function-with-an-implicit-state-machine) | high | CONFIRMED | L | [R-B4](#r-b4) | The cycle controller is a 656-line imperative function with an implicit state machine |
| [CTRL-02](findings/CTRL-controller.md#ctrl-02-notifications-fire-for-states-the-controller-is-about-to-leave-on-its-own) | high | CONFIRMED | S for the patch plus sett | [R-A1](#r-a1) | Notifications fire for states the controller is about to leave on its own |
| [CTRL-03](findings/CTRL-controller.md#ctrl-03-a-new-notification-per-cycle-version-produces-repeat-pushes-for-unchanged-situations) | high | CONFIRMED | S | [R-A1](#r-a1) | A new notification per cycle version produces repeat pushes for unchanged situations |
| [CTRL-04](findings/CTRL-controller.md#ctrl-04-resume-is-accepted-even-when-it-cannot-make-progress) | high | CONFIRMED | M | [R-A7](#r-a7) | "Resume" is accepted even when it cannot make progress |
| [CTRL-05](findings/CTRL-controller.md#ctrl-05-at-least-10-separate-places-decide-needs-the-operator-with-different-rules) | high | CONFIRMED | L | [R-A3](#r-a3) | At least 10 separate places decide "needs the operator", with different rules |
| [CTRL-06](findings/CTRL-controller.md#ctrl-06-delegation-grants-are-ignored-by-integration-refresh-and-by-notifications) | high | CONFIRMED | S | [R-B1](#r-b1) | Delegation grants are ignored by integration refresh and by notifications |
| [CTRL-07](findings/CTRL-controller.md#ctrl-07-ownership-of-a-cycle-by-a-roadmap-is-resolved-11-ways-and-the-cycle-has-no-owner-field) | medium | CONFIRMED | M | [R-B3](#r-b3) | Ownership of a cycle by a roadmap is resolved 11 ways, and the cycle has no owner field |
| [CTRL-08](findings/CTRL-controller.md#ctrl-08-the-controller-polls-costs-1520--cpu-when-idle-and-blocks-the-event-loop) | high | CONFIRMED |  | [R-B5](#r-b5) | The controller polls, costs 15–20 % CPU when idle, and blocks the event loop |
| [CTRL-09](findings/CTRL-controller.md#ctrl-09-the-roadmap-control-row-embeds-the-whole-definition-and-history-is-parsed-on-hot-paths) | medium | CONFIRMED | M | [R-B1](#r-b1), [R-B3](#r-b3) | The roadmap control row embeds the whole definition, and history is parsed on hot paths |
| [CTRL-10](findings/CTRL-controller.md#ctrl-10-awaiting-merge-is-overloaded-with-six-meanings) | medium | CONFIRMED | M | [R-A3](#r-a3), [R-B4](#r-b4) | `awaiting-merge` is overloaded with six meanings |
| [CTRL-11](findings/CTRL-controller.md#ctrl-11-control-flow-depends-on-the-wording-of-human-readable-messages) | medium | CONFIRMED | M | [R-A3](#r-a3), [R-B4](#r-b4) | Control flow depends on the wording of human-readable messages |
| [CTRL-12](findings/CTRL-controller.md#ctrl-12-manual-commands-accept-transitions-that-the-automated-launch-then-rejects) | medium | CONFIRMED | M | [R-A7](#r-a7) | Manual commands accept transitions that the automated launch then rejects |
| [CTRL-13](findings/CTRL-controller.md#ctrl-13-layering-is-inverted-and-responsibilities-are-misplaced-across-services) | medium | CONFIRMED | L | [R-B7](#r-b7) | Layering is inverted and responsibilities are misplaced across services |
| [CTRL-14](findings/CTRL-controller.md#ctrl-14-the-same-gates-and-validations-are-duplicated-with-drift) | medium | CONFIRMED | S–M | [R-B7](#r-b7), [R-F1](#r-f1) | The same gates and validations are duplicated with drift |
| [CTRL-15](findings/CTRL-controller.md#ctrl-15-dead-and-vestigial-controller-paths) | low | CONFIRMED | M | [R-B8](#r-b8) | Dead and vestigial controller paths |
| [CTRL-16](findings/CTRL-controller.md#ctrl-16-error-handling-can-leave-cycles-stuck-or-silently-retrying) | medium | CONFIRMED | S–M | [R-B1](#r-b1) | Error handling can leave cycles stuck or silently retrying |
| [CTRL-17](findings/CTRL-controller.md#ctrl-17-about-nine-uncoordinated-in-memory-locks-with-different-semantics) | medium | CONFIRMED | M | [R-B5](#r-b5) | About nine uncoordinated in-memory locks with different semantics |
| [CTRL-18](findings/CTRL-controller.md#ctrl-18-the-controller-has-no-unit-testable-transition-core) | medium | CONFIRMED | M | [R-B2](#r-b2) | The controller has no unit-testable transition core |
| [CTRL-19](findings/CTRL-controller.md#ctrl-19-many-operator-decisions-require-pausing-the-whole-roadmap) | medium | CONFIRMED | M–L | [R-B6](#r-b6) | Many operator decisions require pausing the whole roadmap |
| [CTRL-20](findings/CTRL-controller.md#ctrl-20-every-restart-stops-all-automation-and-kills-in-flight-agent-work) | low | CONFIRMED | M | [R-B9](#r-b9) | Every restart stops all automation and kills in-flight agent work |
| [CTRL-21](findings/CTRL-controller.md#ctrl-21-map-specific-vocabulary-is-hard-coded-in-the-controller) | low | CONFIRMED | M | [R-F2](#r-f2) | Map-specific vocabulary is hard-coded in the controller |
| [CTRL-22](findings/CTRL-controller.md#ctrl-22-the-api-returns-projection-fields-mixed-into-the-domain-workcycle) | low | CONFIRMED | S–M | [R-A3](#r-a3) → [R-D5](#r-d5) | The API returns projection fields mixed into the domain `WorkCycle` |
| [DATA-01](findings/DATA-storage-domain-contracts.md#data-01-agent_run_eventsraw_json-is-278-mb-of-never-read-data-that-is-also-shipped-to-the-browser) | high | CONFIRMED |  | [R-D1](#r-d1), [R-H2](#r-h2) | `agent_run_events.raw_json` is 278 MB of never-read data that is also shipped to the browser |
| [DATA-02](findings/DATA-storage-domain-contracts.md#data-02-the-journal-can-never-be-pruned-growth-is-unbounded-and-every-byte-is-duplicated-about-8-by-backups) | high | CONFIRMED | M | [R-H2](#r-h2) | The journal can never be pruned; growth is unbounded and every byte is duplicated about 8× by backups |
| [DATA-03](findings/DATA-storage-domain-contracts.md#data-03-a-strict-response-schema-combined-with-no-read-side-upgrade-makes-the-first-runs-events-unreadable-live-bug-and-all-persisted-json-is-read-with-bare-casts) | high | CONFIRMED |  | [R-H1](#r-h1), [R-H3](#r-h3) | A strict response schema combined with no read-side upgrade makes the first run's events unreadable (live bug), and all persisted JSON is read with bare casts |
| [DATA-04](findings/DATA-storage-domain-contracts.md#data-04-workcycle-is-a-50-field-god-record-with-embedded-sub-state-machines-two-entity-kinds-and-projection-fields-mixed-in) | high | CONFIRMED |  | [R-B4](#r-b4) | `WorkCycle` is a 50-field god record with embedded sub-state-machines, two entity kinds and projection fields mixed in |
| [DATA-05](findings/DATA-storage-domain-contracts.md#data-05-attention-and-operator-decisions-are-not-first-class-identity-is-keyed-on-versions-or-text-hashes-and-behavior-branches-on-english-reason-prefixes) | high | CONFIRMED |  | [R-A3](#r-a3) | Attention and operator decisions are not first-class; identity is keyed on versions or text hashes, and behavior branches on English `reason` prefixes |
| [DATA-06](findings/DATA-storage-domain-contracts.md#data-06-phone-notifications-are-delivered-for-attention-states-the-daemon-itself-resolves-seconds-later) | high | CONFIRMED | S | [R-A1](#r-a1) | Phone notifications are delivered for attention states the daemon itself resolves seconds later |
| [DATA-07](findings/DATA-storage-domain-contracts.md#data-07-the-roadmap-state-blob-embeds-a-copy-of-the-immutable-definition-and-keeps-append-only-histories-inside-the-mutable-blob-revision-lookups-load-every-revision) | medium | CONFIRMED | S | [R-B3](#r-b3) | The roadmap state blob embeds a copy of the immutable definition and keeps append-only histories inside the mutable blob; revision lookups load every revision |
| [DATA-08](findings/DATA-storage-domain-contracts.md#data-08-workspace-event-invalidation-is-coarse-and-every-invalidation-refetches-all-cycles-delivery-bookkeeping-is-journaled-as-a-workspace-event) | medium | CONFIRMED | S | [R-A2](#r-a2) | Workspace-event invalidation is coarse, and every invalidation refetches all cycles; delivery bookkeeping is journaled as a workspace event |
| [DATA-09](findings/DATA-storage-domain-contracts.md#data-09-the-dead-ct-04a1a2-repository-inspector-and-registry-are-still-compiled-constructed-and-schema-resident) | medium | CONFIRMED |  | [R-B8](#r-b8) | The dead CT-04A1/A2 repository inspector and registry are still compiled, constructed and schema-resident |
| [DATA-10](findings/DATA-storage-domain-contracts.md#data-10-contracts-duplicate-domain-types-by-hand-with-no-compile-time-equivalence-check) | medium | CONFIRMED | S–M | [R-H3](#r-h3) | Contracts duplicate domain types by hand, with no compile-time equivalence check |
| [DATA-11](findings/DATA-storage-domain-contracts.md#data-11-agent-profile-and-selection-shapes-have-multiplied-and-are-stored-in-at-least-12-places) | medium | CONFIRMED | M | [R-E5](#r-e5) | Agent profile and selection shapes have multiplied and are stored in at least 12 places |
| [DATA-12](findings/DATA-storage-domain-contracts.md#data-12-no-unified-dependency-and-progress-read-model-data-side-of-pain-point-2) | medium | CONFIRMED | M | [R-E3](#r-e3) | No unified dependency and progress read model (data side of pain point #2) |
| [DATA-13](findings/DATA-storage-domain-contracts.md#data-13-the-route-surface-has-grown-by-accretion-121-routes-naming-is-inconsistent-endpoints-are-panel-specific-and-the-forbidden-fragment-guard-only-checks-names) | low | CONFIRMED | M | [R-H5](#r-h5) | The route surface has grown by accretion (121 routes); naming is inconsistent, endpoints are panel-specific, and the "forbidden fragment" guard only checks names |
| [DATA-14](findings/DATA-storage-domain-contracts.md#data-14-table-rebuild-migrations-lack-preservation-tests-the-runners-fk-off-directive-contradicts-adr-002) | low | CONFIRMED | S | [R-H3](#r-h3) | Table-rebuild migrations lack preservation tests; the runner's FK-off directive contradicts ADR-002 |
| [DATA-15](findings/DATA-storage-domain-contracts.md#data-15-documentation-and-vocabulary-drift-adrs-process-authority-branded-ids-exports-plan-specific-literals) | low | CONFIRMED | S | [R-I7](#r-i7) | Documentation and vocabulary drift (ADRs, process authority, branded IDs, exports, plan-specific literals) |
| [FMT-01](findings/FMT-plan-and-roadmap-formats.md#fmt-01-no-compiled-format-model--22-services-re-interpret-raw-map-json) | high | CONFIRMED | L | [R-F1](#r-f1) | No compiled format model — 22 services re-interpret raw map JSON |
| [FMT-02](findings/FMT-plan-and-roadmap-formats.md#fmt-02-requirement-satisfaction-is-implemented-three-times-with-drift) | high | CONFIRMED | M | [R-F1](#r-f1) | Requirement satisfaction is implemented three times, with drift |
| [FMT-03](findings/FMT-plan-and-roadmap-formats.md#fmt-03-validator-milestone-graph-differs-from-the-domain-milestone-model-demonstrated) | medium | CONFIRMED | S | [R-F1](#r-f1) | Validator milestone graph differs from the domain milestone model (demonstrated) |
| [FMT-04](findings/FMT-plan-and-roadmap-formats.md#fmt-04-automation-features-are-enabled-by-matching-prose-and-magic-identifiers-in-the-map) | high | CONFIRMED |  | [R-F2](#r-f2), [R-F5](#r-f5) | Automation features are enabled by matching prose and magic identifiers in the map |
| [FMT-05](findings/FMT-plan-and-roadmap-formats.md#fmt-05-the-concurrency-map-format-is-hard-wired-to-the-aqwiexo-stack-shape) | high | CONFIRMED | L | [R-F5](#r-f5), [R-F6](#r-f6) | The concurrency-map format is hard-wired to the AQ/WI/EXO stack shape |
| [FMT-06](findings/FMT-plan-and-roadmap-formats.md#fmt-06-runtime-pinning-is-cargo-only-and-forced-on-every-map) | medium | CONFIRMED | M | [R-F6](#r-f6) | Runtime pinning is Cargo-only and forced on every map |
| [FMT-07](findings/FMT-plan-and-roadmap-formats.md#fmt-07-effective-roadmap-automation-is-resolved-three-different-ways) | medium | CONFIRMED | S | [R-B1](#r-b1) | Effective roadmap automation is resolved three different ways |
| [FMT-08](findings/FMT-plan-and-roadmap-formats.md#fmt-08-work-item-phase-is-unbounded-in-the-normalizer-but-64-in-the-database-and-wire-contract) | medium | CONFIRMED | S | [R-F3](#r-f3) | Work-item `phase` is unbounded in the normalizer but ≤64 in the database and wire contract |
| [FMT-09](findings/FMT-plan-and-roadmap-formats.md#fmt-09-required-dependency-depends_on-enforcement-is-duplicated-in-six-places) | medium | CONFIRMED | M | [R-F1](#r-f1) | Required-dependency (`depends_on`) enforcement is duplicated in six places |
| [FMT-10](findings/FMT-plan-and-roadmap-formats.md#fmt-10-producer-sets-and-scope-requirementcase-sets-are-re-derived-in-several-places) | low | CONFIRMED | S | [R-F1](#r-f1) | Producer sets and scope requirement/case sets are re-derived in several places |
| [FMT-11](findings/FMT-plan-and-roadmap-formats.md#fmt-11-the-studio-seam-is-unused-and-produces-a-different-definition-digest) | medium | CONFIRMED | M | [R-F3](#r-f3), [R-F6](#r-f6) | The "Studio seam" is unused and produces a different definition digest |
| [FMT-12](findings/FMT-plan-and-roadmap-formats.md#fmt-12-no-in-repo-format-specification-dead-and-misleading-format-codedocs) | low | CONFIRMED | S | [R-F4](#r-f4) | No in-repo format specification; dead and misleading format code/docs |
| [FMT-13](findings/FMT-plan-and-roadmap-formats.md#fmt-13-the-same-plan-imported-by-discrete-upload-and-by-zip-gets-different-digests) | low | CONFIRMED | S | [R-F3](#r-f3) | The same plan imported by discrete upload and by ZIP gets different digests |
| [FMT-14](findings/FMT-plan-and-roadmap-formats.md#fmt-14-silent-truncation-of-plan-fields-that-agents-treat-as-the-contract) | low | CONFIRMED | S | [R-F3](#r-f3) | Silent truncation of plan fields that agents treat as the contract |
| [FMT-15](findings/FMT-plan-and-roadmap-formats.md#fmt-15-execution-tests-bypass-the-importer-with-definitions-it-would-reject) | medium | CONFIRMED | M | [R-F3](#r-f3) | Execution tests bypass the importer with definitions it would reject |
| [FMT-16](findings/FMT-plan-and-roadmap-formats.md#fmt-16-roadmap-entry-limits-are-inconsistent-and-settings-are-duplicated-in-every-entry-and-revision) | low | CONFIRMED | M | [R-F3](#r-f3) | Roadmap entry limits are inconsistent and settings are duplicated in every entry and revision |
| [FMT-17](findings/FMT-plan-and-roadmap-formats.md#fmt-17-stack-plan-accepted-evidence-is-bound-to-a-digest-of-the-whole-roadmap-definition) | medium | CONFIRMED | S | [R-C6](#r-c6) | STACK-PLAN-ACCEPTED evidence is bound to a digest of the whole roadmap definition |
| [FMT-18](findings/FMT-plan-and-roadmap-formats.md#fmt-18-canonical-json-for-source-record-fingerprints-is-an-undocumented-cross-language-contract) | low | CONFIRMED | S | [R-F4](#r-f4), [R-F6](#r-f6) | Canonical JSON for source-record fingerprints is an undocumented cross-language contract |
| [FMT-19](findings/FMT-plan-and-roadmap-formats.md#fmt-19-operator-decision-points-are-implicit-in-the-formats) | medium | CONFIRMED | M | [R-F5](#r-f5) | Operator decision points are implicit in the formats |
| [HIST-01](findings/HIST-history-and-live-usage.md#hist-01-development-proceeded-by-patching-each-live-blockage-with-new-state-panels-and-vocabulary-spaghetti-fication-measured) | high | CONFIRMED | L | [R-B4](#r-b4) | Development proceeded by patching each live blockage with new state, panels and vocabulary ("spaghetti-fication" measured) |
| [HIST-02](findings/HIST-history-and-live-usage.md#hist-02-wall-clock-throughput-is-dominated-by-waiting-for-the-operator-not-by-agent-work-or-controller-latency) | high | CONFIRMED | M | [R-A4](#r-a4), [R-C1](#r-c1) | Wall-clock throughput is dominated by waiting for the operator, not by agent work or controller latency |
| [HIST-03](findings/HIST-history-and-live-usage.md#hist-03-ranked-operator-intervention-causes-the-highest-leverage-automation-fixes) | high | CONFIRMED |  | [R-C1](#r-c1), [R-C2](#r-c2), [R-C3](#r-c3), [R-C4](#r-c4) | Ranked operator-intervention causes (the highest-leverage automation fixes) |
| [HIST-04](findings/HIST-history-and-live-usage.md#hist-04-exo-01-parent-acceptance--owning-slice-repair-ping-pong-consumed-29-of-all-runs-without-convergence-detection) | high | CONFIRMED | M | [R-C5](#r-c5) | EXO-01 parent-acceptance ↔ owning-slice repair ping-pong consumed 29% of all runs without convergence detection |
| [HIST-05](findings/HIST-history-and-live-usage.md#hist-05-operator-facing-states-and-notifications-fire-during-automated-transitions-pain-point-3-confirmed-in-data) | high | CONFIRMED | M | [R-A1](#r-a1) | Operator-facing states and notifications fire during automated transitions (pain point 3 confirmed in data) |
| [HIST-06](findings/HIST-history-and-live-usage.md#hist-06-deploy--restart-and-every-restart-stops-running-roadmaps-and-live-runs) | medium | CONFIRMED | M | [R-B9](#r-b9) | Deploy = restart, and every restart stops running roadmaps and live runs |
| [HIST-07](findings/HIST-history-and-live-usage.md#hist-07-checkpoint-evidence-acceptance-is-a-self-attestation-ceremony-65-operator-actions-100-accepted) | medium | CONFIRMED | M | [R-C6](#r-c6) | Checkpoint evidence acceptance is a self-attestation ceremony (65 operator actions, 100% accepted) |
| [HIST-08](findings/HIST-history-and-live-usage.md#hist-08-merge-approvals-and-record-scope-verification-still-require-manual-clicks-in-delegated-flows) | medium | CONFIRMED | S–M | [R-C5](#r-c5) | Merge approvals and "record scope verification" still require manual clicks in delegated flows |
| [HIST-09](findings/HIST-history-and-live-usage.md#hist-09-agent-reliability-is-high-stops-are-controller-derived-prioritize-accordingly) | medium | CONFIRMED | S | [R-C1](#r-c1) | Agent reliability is high; stops are controller-derived. Prioritize accordingly |
| [HIST-10](findings/HIST-history-and-live-usage.md#hist-10-agent-output-format-validation-becomes-operator-stops-instead-of-automatic-re-prompts) | medium | CONFIRMED | S–M | [R-C2](#r-c2) | Agent-output format validation becomes operator stops instead of automatic re-prompts |
| [HIST-11](findings/HIST-history-and-live-usage.md#hist-11-run-event-storage-is-dominated-by-duplicated-raw-vendor-json) | medium | CONFIRMED | M | [R-H2](#r-h2) | Run-event storage is dominated by duplicated raw vendor JSON |
| [HIST-12](findings/HIST-history-and-live-usage.md#hist-12-roadmap-state-rewrites-a-248-kb-json-blob-including-a-full-definition-copy-on-every-change) | medium | CONFIRMED | M | [R-B3](#r-b3) | Roadmap state rewrites a 248 KB JSON blob (including a full definition copy) on every change |
| [HIST-13](findings/HIST-history-and-live-usage.md#hist-13-schema-and-adr-churn-rate-22-migrations-46-adrs-in-18-days-with-manual-pre-migration-backups) | medium | CONFIRMED | M | [R-B9](#r-b9), [R-I7](#r-i7) | Schema and ADR churn rate (22 migrations, 46 ADRs in 18 days) with manual pre-migration backups |
| [HIST-14](findings/HIST-history-and-live-usage.md#hist-14-ui-walkthrough-captures-are-committed-on-nearly-every-commit-since-09-16-15-gb-4986-pngs) | medium | CONFIRMED | S | [R-I1](#r-i1) | UI walkthrough captures are committed on nearly every commit since 09-16 (1.5 GB, 4,986 PNGs) |
| [HIST-15](findings/HIST-history-and-live-usage.md#hist-15-commit-messages-stopped-describing-changes-adr-numbering-is-inconsistent) | low | CONFIRMED | S | [R-I7](#r-i7) | Commit messages stopped describing changes; ADR numbering is inconsistent |
| [HIST-16](findings/HIST-history-and-live-usage.md#hist-16-plan-finalization-was-the-most-expensive-phase-of-the-only-completed-plan) | medium | CONFIRMED | M | [R-C7](#r-c7) | Plan finalization was the most expensive phase of the only completed plan |
| [HIST-17](findings/HIST-history-and-live-usage.md#hist-17-notification-delivery-volume-floods-the-workspace-event-stream) | medium | CONFIRMED | S | [R-A2](#r-a2) | Notification delivery volume floods the workspace event stream |
| [HIST-18](findings/HIST-history-and-live-usage.md#hist-18-controller-services-grew-append-only-through-feature-by-feature-accretion) | high | CONFIRMED | L | [R-B4](#r-b4) | Controller services grew append-only through feature-by-feature accretion |
| [HIST-19](findings/HIST-history-and-live-usage.md#hist-19-real-cross-project-workload-is-10-the-scale-the-uis-lists-were-designed-for-progress-and-dependencies-are-hard-to-see) | high | CONFIRMED | L | [R-C3](#r-c3), [R-E3](#r-e3) | Real cross-project workload is ~10× the scale the UI's lists were designed for; progress and dependencies are hard to see |
| [HIST-20](findings/HIST-history-and-live-usage.md#hist-20-the-first-automated-real-use-aq-went-smoothly-complexity-arrived-with-slicesverificationevidence-layers) | medium | CONFIRMED | M | [R-C7](#r-c7) | The first automated real use (AQ) went smoothly; complexity arrived with slices/verification/evidence layers |
| [NOTIF-01](findings/NOTIF-attention-notifications.md#notif-01-no-settle-period--notifications-race-the-controllers-own-follow-up-transitions) | high | CONFIRMED |  | [R-A1](#r-a1) | No settle period — notifications race the controller's own follow-up transitions |
| [NOTIF-02](findings/NOTIF-attention-notifications.md#notif-02-attention-is-inferred-by-predicting-automation-each-new-automation-needs-a-matching-suppression-clause) | high | CONFIRMED | M | [R-A3](#r-a3) | Attention is inferred by predicting automation; each new automation needs a matching suppression clause |
| [NOTIF-03](findings/NOTIF-attention-notifications.md#notif-03-occurrence-key-includes-cycleversion-and-content-hashes-so-unrelated-version-bumps-re-page) | high | CONFIRMED | S–M | [R-A1](#r-a1) | Occurrence key includes `cycle.version` (and content hashes), so unrelated version bumps re-page |
| [NOTIF-04](findings/NOTIF-attention-notifications.md#notif-04-no-operator-presence-awareness--pushes-arrive-while-the-operator-is-using-the-ui) | medium | CONFIRMED | S–M | [R-A4](#r-a4) | No operator-presence awareness — pushes arrive while the operator is using the UI |
| [NOTIF-05](findings/NOTIF-attention-notifications.md#notif-05-storage-alerts-flap-without-hysteresis-and-produce-bursts-of-pushes) | medium | CONFIRMED | S | [R-A1](#r-a1) | Storage alerts flap without hysteresis and produce bursts of pushes |
| [NOTIF-06](findings/NOTIF-attention-notifications.md#notif-06-daemon-restart-pages-the-operator-for-a-self-inflicted-known-state) | low | CONFIRMED | S | [R-A1](#r-a1) | Daemon restart pages the operator for a self-inflicted, known state |
| [NOTIF-07](findings/NOTIF-attention-notifications.md#notif-07-notification-occurrence-history-is-overwritten-journals-carry-no-identity) | medium | CONFIRMED | M | [R-A4](#r-a4) | Notification occurrence history is overwritten; journals carry no identity |
| [NOTIF-08](findings/NOTIF-attention-notifications.md#notif-08-the-attention-projection-is-heavy-and-runs-inside-an-immediate-write-transaction-many-times-per-tick) | medium | CONFIRMED | S | [R-A4](#r-a4) | The attention projection is heavy and runs inside an IMMEDIATE write transaction many times per tick |
| [NOTIF-09](findings/NOTIF-attention-notifications.md#notif-09-attention-has-no-single-source-of-truth-there-is-no-operator-inbox) | high | CONFIRMED | L | [R-A4](#r-a4), [R-A5](#r-a5) | Attention has no single source of truth; there is no operator inbox |
| [NOTIF-10](findings/NOTIF-attention-notifications.md#notif-10-notification-bookkeeping-floods-the-workspace-journal-and-the-browser) | medium | CONFIRMED | S | [R-A2](#r-a2) | Notification bookkeeping floods the workspace journal and the browser |
| [NOTIF-11](findings/NOTIF-attention-notifications.md#notif-11-browser-invalidation-is-coarse-and-the-200-ms-leading-window-splits-automated-cascades) | medium | CONFIRMED | M | [R-D2](#r-d2) | Browser invalidation is coarse and the 200 ms leading window splits automated cascades |
| [NOTIF-12](findings/NOTIF-attention-notifications.md#notif-12-reminder-content-is-frozen-and-often-misdirects-reminders-dominate-volume) | medium | CONFIRMED | S–M | [R-A4](#r-a4) | Reminder content is frozen and often misdirects; reminders dominate volume |
| [NOTIF-13](findings/NOTIF-attention-notifications.md#notif-13-transient-controller-errors-can-become-durable-roadmap-attention) | low | CONFIRMED | S | [R-B1](#r-b1) | Transient controller errors can become durable roadmap attention |
| [NOTIF-14](findings/NOTIF-attention-notifications.md#notif-14-sse-wakeups-are-unscoped) | low | CONFIRMED | S | [R-B5](#r-b5) | SSE wakeups are unscoped |
| [NOTIF-15](findings/NOTIF-attention-notifications.md#notif-15-tests-do-not-cover-the-race-and-churn-behaviours-that-cause-false-alarms) | medium | CONFIRMED | S–M | [R-A1](#r-a1) | Tests do not cover the race and churn behaviours that cause false alarms |
| [NOTIF-16](findings/NOTIF-attention-notifications.md#notif-16-outbox-reliability--mostly-sound-with-coupled-cooldowns) | low | CONFIRMED | S | [R-A1](#r-a1) | Outbox reliability — mostly sound, with coupled cooldowns |
| [PERF-01](findings/PERF-browser-and-read-performance.md#perf-01-every-workspace-event-refetches-the-whole-page-computed-stale-scopes-are-ignored) | high | CONFIRMED | M | [R-D4](#r-d4) | Every workspace event refetches the whole page; computed stale scopes are ignored |
| [PERF-02](findings/PERF-browser-and-read-performance.md#perf-02-batching-does-not-coalesce-transitions-no-single-flight-so-rounds-overlap-and-queue-server-work) | high | CONFIRMED | S | [R-D2](#r-d2) | Batching does not coalesce transitions; no single-flight, so rounds overlap and queue server work |
| [PERF-03](findings/PERF-browser-and-read-performance.md#perf-03-invalidation-map-is-wrong-in-both-directions-notifications-storms-stale-roadmapevidence-panels) | high | CONFIRMED | S | [R-D2](#r-d2) | Invalidation map is wrong in both directions (notifications storms, stale roadmap/evidence panels) |
| [PERF-04](findings/PERF-browser-and-read-performance.md#perf-04-execution-scopes-costs-405-ms-of-synchronous-cpu-and-is-fetched-twice-per-round) | high | CONFIRMED | S | [R-D1](#r-d1) | `execution-scopes` costs ~405 ms of synchronous CPU and is fetched twice per round |
| [PERF-05](findings/PERF-browser-and-read-performance.md#perf-05-cycles-sends-every-historical-cycle-with-its-design-recovery-blob-to-every-page-every-round) | high | CONFIRMED | S-M | [R-D1](#r-d1) | `/cycles` sends every historical cycle with its design-recovery blob to every page, every round |
| [PERF-06](findings/PERF-browser-and-read-performance.md#perf-06-roadmaps-page-polls-900-kb-every-3-5-s-forever-77--of-the-daemon-15-mbmin-per-tab) | high | CONFIRMED | M | [R-D2](#r-d2) | Roadmaps page polls ~900 KB every 3-5 s forever (≈7.7 % of the daemon, ≈15 MB/min per tab) |
| [PERF-07](findings/PERF-browser-and-read-performance.md#perf-07-browser-refetch-storms-run-on-the-controllers-event-loop-ui-load-slows-automation-and-vice-versa) | high | CONFIRMED | S | [R-B5](#r-b5), [R-D3](#r-d3), [R-D6](#r-d6) | Browser refetch storms run on the controller's event loop (UI load slows automation and vice versa) |
| [PERF-08](findings/PERF-browser-and-read-performance.md#perf-08-map-evaluation-hot-spots-in-roadmap-view-cycles-list-and-cross-project-preview) | medium | CONFIRMED | M | [R-B3](#r-b3), [R-D1](#r-d1), [R-D6](#r-d6), [R-H4](#r-h4) | Map-evaluation hot spots in roadmap view, cycles list and cross-project preview |
| [PERF-09](findings/PERF-browser-and-read-performance.md#perf-09-git-subprocess-fan-out-on-refreshed-read-paths) | medium | CONFIRMED | M | [R-D5](#r-d5) | Git subprocess fan-out on refreshed read paths |
| [PERF-10](findings/PERF-browser-and-read-performance.md#perf-10-whole-tree-re-render-on-every-event-response-and-clock-tick-no-memoization-anywhere) | high | CONFIRMED | M-L | [R-D4](#r-d4) | Whole-tree re-render on every event, response and clock tick; no memoization anywhere |
| [PERF-11](findings/PERF-browser-and-read-performance.md#perf-11-run-page-downloads-17-mb-for-a-large-run-55--unused-raw-and-renders-every-event-unvirtualised) | high | CONFIRMED | M | [R-D1](#r-d1) | Run page downloads 17 MB for a large run (55 % unused `raw`) and renders every event unvirtualised |
| [PERF-12](findings/PERF-browser-and-read-performance.md#perf-12-list-payloads-carry-data-the-pages-do-not-use) | medium | CONFIRMED | S | [R-D1](#r-d1) | List payloads carry data the pages do not use |
| [PERF-13](findings/PERF-browser-and-read-performance.md#perf-13-four-different-freshness-policies-on-one-page-produce-visibly-inconsistent-state-after-transitions) | medium | CONFIRMED | M | [R-D4](#r-d4) | Four different freshness policies on one page produce visibly inconsistent state after transitions |
| [PERF-14](findings/PERF-browser-and-read-performance.md#perf-14-work-item-and-run-pages-are-assembled-from-15-independent-requests-with-duplicates-and-static-data) | medium | CONFIRMED | M-L | [R-D5](#r-d5) | Work-item and run pages are assembled from ~15 independent requests with duplicates and static data |
| [PERF-15](findings/PERF-browser-and-read-performance.md#perf-15-non-owner-members-cannot-load-any-workspace-page-audit-load-is-owner-only-and-inside-the-snapshot-promiseall) | low | CONFIRMED | S | [R-D1](#r-d1) | Non-owner members cannot load any workspace page (audit load is owner-only and inside the snapshot Promise.all) |
| [PERF-16](findings/PERF-browser-and-read-performance.md#perf-16-no-compression-no-validators-etag-on-large-json-responses) | medium | CONFIRMED | S-M | [R-D5](#r-d5) | No compression, no validators (ETag) on large JSON responses |
| [PERF-17](findings/PERF-browser-and-read-performance.md#perf-17-polling-continues-in-hidden-tabs-no-visibility-or-focus-awareness) | medium | CONFIRMED | S | [R-D2](#r-d2) | Polling continues in hidden tabs; no visibility or focus awareness |
| [PERF-18](findings/PERF-browser-and-read-performance.md#perf-18-controller-emits-many-small-spread-out-commits-per-transition-browser-cannot-coalesce-them) | medium | CONFIRMED | S | [R-B1](#r-b1) | Controller emits many small, spread-out commits per transition (browser cannot coalesce them) |
| [PERF-19](findings/PERF-browser-and-read-performance.md#perf-19-no-tests-or-instrumentation-guard-request-volume-or-read-cost) | low | CONFIRMED | M | [R-D3](#r-d3) | No tests or instrumentation guard request volume or read cost |
| [PERF-20](findings/PERF-browser-and-read-performance.md#perf-20-single-768-kb-bundle-no-code-splitting) | low | CONFIRMED | S | [R-D5](#r-d5) | Single 768 KB bundle, no code splitting |
| [REPO-01](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-01-walkthrough-pngs-make-up-99-of-the-repository-and-grow-about-155-mibday) | high | CONFIRMED |  | [R-I1](#r-i1) | Walkthrough PNGs make up 99% of the repository and grow about 155 MiB/day |
| [REPO-02](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-02-42-commits-six-days-of-work-exist-only-on-the-local-disk) | high | CONFIRMED | S | [R-I1](#r-i1) | 42 commits (six days of work) exist only on the local disk |
| [QA-01](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-01-server-executiontestts-is-the-whole-critical-path-of-the-unit-suite-and-should-be-split-by-aggregate) | high | CONFIRMED | M | [R-I2](#r-i2) | `server-execution.test.ts` is the whole critical path of the unit suite and should be split by aggregate |
| [QA-02](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-02-orchestration-tests-poll-wall-clock-time-because-the-controller-has-no-deterministic-stepping-seam) | medium | CONFIRMED | M | [R-B2](#r-b2), [R-I2](#r-i2) | Orchestration tests poll wall-clock time because the controller has no deterministic stepping seam |
| [QA-03](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-03-the-authorization-surface-has-no-systematic-tests-and-the-no-approve-route-test-checks-spelling) | high | CONFIRMED | S | [R-G9](#r-g9), [R-I3](#r-i3) | The authorization surface has no systematic tests, and the "no approve route" test checks spelling |
| [QA-04](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-04-checkscope-exemptions-are-filename-patterns-and-several-bypasses-are-open) | medium | CONFIRMED | S–M | [R-I4](#r-i4) | `check:scope` exemptions are filename patterns, and several bypasses are open |
| [QA-05](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-05-e2e-gate-screenshots-are-unasserted-cause-the-known-flake-and-helpers-are-copied-into-8-specs) | medium | CONFIRMED | S | [R-I5](#r-i5) | E2E gate screenshots are unasserted, cause the known flake, and helpers are copied into 8 specs |
| [QA-06](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-06-the-fixture-derives-expected-scope-evidence-from-the-production-resolver-tautological) | medium | CONFIRMED | S | [R-I5](#r-i5) | The fixture derives expected scope evidence from the production resolver (tautological) |
| [QA-07](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-07-the-testproduction-boundary-is-structural-only-in-packagesgit-everywhere-else-tests-and-test-support-compile-into-dist) | low | CONFIRMED | M | [R-I4](#r-i4) | The test/production boundary is structural only in `packages/git`; everywhere else tests and test-support compile into `dist` |
| [QA-08](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-08-unit-tests-depend-on-host-tool-paths-and-create-fixtures-inside-the-repository) | medium | CONFIRMED | S | [R-I5](#r-i5) | Unit tests depend on host tool paths and create fixtures inside the repository |
| [QA-09](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-09-lint-warnings-do-not-gate-the-build-and-666-have-accumulated) | low | CONFIRMED | S–M | [R-I6](#r-i6) | Lint warnings do not gate the build, and 666 have accumulated |
| [QA-10](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-10-test-effort-is-weighted-toward-the-dormant-ct-04a-repository-inspection-feature) | low | CONFIRMED | M | [R-B8](#r-b8) | Test effort is weighted toward the dormant CT-04A repository-inspection feature |
| [DOC-01](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-01-the-readme-is-a-feature-changelog-not-an-operator-guide) | medium | CONFIRMED | M | [R-I7](#r-i7) | The README is a feature changelog, not an operator guide |
| [DOC-02](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-02-adr-sprawl--65-records-broken-index-inconsistent-status-metadata-long-refinement-chains) | medium | CONFIRMED | M | [R-I7](#r-i7) | ADR sprawl — 65 records, broken index, inconsistent status metadata, long refinement chains |
| [DOC-03](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-03-doc-claims-out-of-sync-with-code-spot-check-of-14-claims-7-false-or-stale) | medium | CONFIRMED |  | [R-I7](#r-i7) | Doc claims out of sync with code (spot-check of 14 claims: 7 false or stale) |
| [DOC-04](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-04-vocabulary-is-incoherent-around-blockers-decisions-and-recovery) | medium | CONFIRMED | M | [R-E6](#r-e6) | Vocabulary is incoherent around blockers, decisions and recovery |
| [DOC-05](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-05-principles-security-and-operations-docs-have-become-per-feature-narratives) | low | CONFIRMED | M | [R-I7](#r-i7) | "Principles", security and operations docs have become per-feature narratives |
| [DOC-06](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-06-agentsmd-mandates-repository-bloating-captures) | low | CONFIRMED | S | [R-I1](#r-i1) | AGENTS.md mandates repository-bloating captures |
| [REPO-03](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-03-legacy-process-directories-and-branches-are-still-at-top-level) | low | CONFIRMED | S | [R-I8](#r-i8) | Legacy process directories and branches are still at top level |
| [REPO-04](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-04-the-production-daemon-runs-from-the-development-checkout-and-its-build-output) | medium | CONFIRMED | S | [R-I8](#r-i8) | The production daemon runs from the development checkout and its build output |
| [UI-01](findings/UI-information-architecture.md#ui-01-there-is-no-single-needs-the-operator-model-the-dashboard-misses-most-roadmap-level-decisions) | critical | CONFIRMED | L | [R-A5](#r-a5) | There is no single "needs the operator" model; the Dashboard misses most roadmap-level decisions |
| [UI-02](findings/UI-information-architecture.md#ui-02-recovery-routing-depends-on-english-prose-reason-prefix-regexes-in-the-ui-and-navigation-prose-in-daemon-blocker-messages) | high | CONFIRMED | M | [R-A3](#r-a3) | Recovery routing depends on English prose: reason-prefix regexes in the UI and navigation prose in daemon blocker messages |
| [UI-03](findings/UI-information-architecture.md#ui-03-the-same-decision-concept-is-surfaced-in-several-places-with-different-names-and-forms) | high | CONFIRMED | L | [R-A5](#r-a5), [R-A6](#r-a6) | The same decision concept is surfaced in several places with different names and forms |
| [UI-04](findings/UI-information-architecture.md#ui-04-shared-architecture-decisions-are-buried-inside-dependency-environments-and-evidence) | high | CONFIRMED | M | [R-A5](#r-a5) | Shared architecture decisions are buried inside "Dependency environments and evidence" |
| [UI-05](findings/UI-information-architecture.md#ui-05-the-roadmaps-page-is-an-ever-growing-single-document-with-duplicated-panels-and-no-per-roadmap-route) | high | CONFIRMED | M | [R-E2](#r-e2) | The Roadmaps page is an ever-growing single document with duplicated panels and no per-roadmap route |
| [UI-06](findings/UI-information-architecture.md#ui-06-there-is-no-high-level-progress-or-dependency-view-dependencies-appear-as-text-and-are-often-unlinked) | high | CONFIRMED | L | [R-E3](#r-e3) | There is no high-level progress or dependency view; dependencies appear as text and are often unlinked |
| [UI-07](findings/UI-information-architecture.md#ui-07-navigation-bypasses-the-router-35-of-49-in-app-links-force-full-reloads-and-deep-link-state-lives-in-ad-hoc-hashquery-parsing) | medium | CONFIRMED | M | [R-E1](#r-e1) | Navigation bypasses the router: 35 of 49 in-app links force full reloads, and deep-link state lives in ad hoc hash/query parsing |
| [UI-08](findings/UI-information-architecture.md#ui-08-dead-ends-blockers-that-tell-the-operator-to-go-elsewhere-without-a-link-generic-landing-pages-and-deep-links-that-silently-do-nothing) | medium | CONFIRMED | S | [R-A5](#r-a5), [R-E1](#r-e1), [R-E4](#r-e4) | Dead ends: blockers that tell the operator to go elsewhere without a link, generic landing pages, and deep links that silently do nothing |
| [UI-09](findings/UI-information-architecture.md#ui-09-the-waiting-on-other-work-classification-hides-operator-owned-evidence) | medium | CONFIRMED | S | [R-A3](#r-a3) | The "Waiting on other work" classification hides operator-owned evidence |
| [UI-10](findings/UI-information-architecture.md#ui-10-recovery-panels-render-when-nothing-needs-recovering) | medium | CONFIRMED | S | [R-A6](#r-a6), [R-E6](#r-e6) | Recovery panels render when nothing needs recovering |
| [UI-11](findings/UI-information-architecture.md#ui-11-walls-of-text-and-headings-written-as-sentences) | medium | CONFIRMED | M | [R-E6](#r-e6) | Walls of text and headings written as sentences |
| [UI-12](findings/UI-information-architecture.md#ui-12-vocabulary-density-and-inconsistent-labels) | medium | CONFIRMED | M | [R-E6](#r-e6) | Vocabulary density and inconsistent labels |
| [UI-13](findings/UI-information-architecture.md#ui-13-apptsx-monolith-plus-a-second-self-fetching-architecture-ad-hoc-event-bus-and-stale-panels) | medium | CONFIRMED | L | [R-D4](#r-d4) | App.tsx monolith plus a second self-fetching architecture, ad hoc event bus, and stale panels |
| [UI-14](findings/UI-information-architecture.md#ui-14-settings-that-gate-progress-are-edited-in-many-places) | medium | CONFIRMED | M | [R-E5](#r-e5) | Settings that gate progress are edited in many places |
| [UI-15](findings/UI-information-architecture.md#ui-15-docsui-principlesmd-has-become-a-per-slice-accretion-log-that-encourages-new-surfaces) | medium | CONFIRMED | S | [R-I7](#r-i7) | `docs/ui-principles.md` has become a per-slice accretion log that encourages new surfaces |
| [UI-16](findings/UI-information-architecture.md#ui-16-attentionstrip-and-the-notification-service-disagree-about-merge-approvals) | medium | CONFIRMED | S | [R-A3](#r-a3) | AttentionStrip and the notification service disagree about merge approvals |
| [UI-17](findings/UI-information-architecture.md#ui-17-roadmap-supervision-panels-share-mutable-page-level-dirty-gates-that-disable-unrelated-decisions) | low | CONFIRMED | S | [R-A6](#r-a6), [R-E2](#r-e2) | Roadmap supervision panels share mutable page-level "dirty" gates that disable unrelated decisions |
| [UI-18](findings/UI-information-architecture.md#ui-18-the-work-item-page-stacks-up-to-about-a-dozen-conditional-panels-in-one-automated-cycle-section-slice-gates-sit-at-the-bottom) | medium | CONFIRMED | M | [R-A6](#r-a6), [R-E4](#r-e4) | The work-item page stacks up to about a dozen conditional panels in one "Automated cycle" section; slice gates sit at the bottom |
| [UI-19](findings/UI-information-architecture.md#ui-19-the-e2e-and-walkthrough-suites-are-coupled-to-current-accessible-names-so-an-ia-migration-needs-a-test-plan) | low | CONFIRMED | M | [R-A6](#r-a6) | The e2e and walkthrough suites are coupled to current accessible names, so an IA migration needs a test plan |
