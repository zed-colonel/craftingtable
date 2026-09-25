# Remediation register

The consolidated backlog for the 2026-09 system review. Each remediation item (`R-…`) groups the findings it resolves; findings keep their full evidence in [`findings/`](findings/). Work items in phase order (see [program.md](program.md)); within a phase, workstreams can proceed in parallel unless an item lists a dependency in its text.

**Status values:** `open`, `in progress`, `partial (<commits>)`, `done (<commit>)`, `won't do (<reason>)`. Update the status here in the same commit that resolves an item, and note partial progress in the item. When a finding turns out to be wrong, mark it in the finding index below rather than deleting it.

## Summary by workstream

| Item | Phase | Effort | Status | Title |
|---|---|---|---|---|
| **A** | | | | **Attention, decisions and notifications (pain points 1 and 3)** |
| [R-A1](#r-a1) | P0 | S | done (012447b) | Stop notification noise without a redesign |
| [R-A2](#r-a2) | P0 | S | done (012447b, 67e2e9b) | Stop journaling notification delivery bookkeeping as workspace events |
| [R-A3](#r-a3) | P1 | M-L | done (eb757da, 57a3a16) | Controller-declared, typed attention on every blocking transition |
| [R-A4](#r-a4) | P2 | M-L | open | Durable attention items, delivery log, quiescence and presence |
| [R-A5](#r-a5) | P2 | L | open | One "Needs you" inbox that every surface reads |
| [R-A6](#r-a6) | P3 | L | open | Consolidate decision and recovery components; delete per-page hosts |
| [R-A7](#r-a7) | P1 | M | partial (9339d01, c6e4042, 27266c0, 9084e50) | Offer only actions that can make progress; one transition gate for commands and launch |
| **B** | | | | **Controller core (pain point 3)** |
| [R-B1](#r-b1) | P0 | S | done (fd269b6, 012447b) | Controller quick fixes (no schema change) |
| [R-B2](#r-b2) | P1 | M | done (131a9de) | Characterization harness for the cycle controller |
| [R-B3](#r-b3) | P1 | M | done (82ae8ab) | Explicit cycle ownership; roadmap state references its definition |
| [R-B4](#r-b4) | P4 | L | open | Pure cycle decision core with an explicit state machine |
| [R-B5](#r-b5) | P4 | L | open | Event-driven controller kernel |
| [R-B6](#r-b6) | P4 | M-L | open | Scoped consistency instead of whole-roadmap pause |
| [R-B7](#r-b7) | P4 | L | open | Decompose the controller services along real boundaries |
| [R-B8](#r-b8) | P1 | M | done (c0ccf3b, 9fe2152) | Remove dead and vestigial paths |
| [R-B9](#r-b9) | P1 | M | done (4d81743, efd7369) | Low-disruption restarts: bounded drain plus automatic resume of interrupted steps |
| [R-B10](#r-b10) | P1 | S-M | in progress (start form staged-only; legacy deletion waits on a live staged finalization) | Retire legacy finalization for new starts (split from R-B8, 2026-09-24) |
| **C** | | | | **Operator-wait reduction (the vision: minimum operator input)** |
| [R-C1](#r-c1) | P1 | S-M | done (7689200, ca489a9) | Measure operator-wait as a first-class metric |
| [R-C2](#r-c2) | P1 | S-M | done (f049b3a, 2d24969) | Re-prompt the agent automatically on output-format validation failures |
| [R-C3](#r-c3) | P2 | M | open | Design stage: continue automatically and batch real decisions ahead of time |
| [R-C4](#r-c4) | P2 | M | open | Refresh and re-review automatically when only upstream integration advanced |
| [R-C5](#r-c5) | P2 | M | open | Converge the parent/slice repair loop |
| [R-C6](#r-c6) | P3 | M | open | Reduce the evidence-acceptance ceremony |
| [R-C7](#r-c7) | P3 | M | open | Revisit verification layering and finalization stops |
| [R-C8](#r-c8) | P1 | S | done (5744289, 4abfec2) | Schedule automatic retry for quota/session limits with a known reset time |
| [R-C9](#r-c9) | P2 | S-M | open | End the session on a terminal quota error so the reset wait applies (added 2026-09-24) |
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
| [R-F3](#r-f3) | P0/P1 | S-M | partial (7d44b42, 0ef1c95; FMT-15 done 2026-09-25) | Format ingestion bugs and test honesty |
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
| [R-G7](#r-g7) | P1 | M | partial (0fc17d2; live measurement after deploy) | Stop cold-building Rust on every step |
| [R-G8](#r-g8) | P5 | M-L | open | Backend capability model and persistent-agent seam |
| [R-G9](#r-g9) | P2 | M | open | Authentication and authorization hardening |
| [R-G10](#r-g10) | P3 | M | open | Git adapter robustness and structure |
| [R-G11](#r-g11) | P3 | S-M | open | Supervisor loose ends |
| [R-G12](#r-g12) | P5 | L | open | (Future) agent runs that outlive the daemon |
| **H** | | | | **Data lifecycle and integrity** |
| [R-H1](#r-h1) | P0 | S | done (c8f58fc) | Fix the unreadable first run (live 500) |
| [R-H2](#r-h2) | P1 | M | partial (cae7827, d8cedea; live measurement after deploy) | Journal retention: stop storing raw vendor lines by default |
| [R-H3](#r-h3) | P1 | M | done (41a5a56, f63b908) | Read-side upcasters, write-side validation and db:verify |
| [R-H4](#r-h4) | P2 | M | open | Lighter evidence and definition storage |
| [R-H5](#r-h5) | P3 | M | open | Rationalize the route surface |
| [R-H6](#r-h6) | P3 | M | open | Journal cleanup: registry tables and `repository-*` vocabulary (added 2026-09-24) |
| **I** | | | | **Engineering hygiene (tests, docs, repository, deployment)** |
| [R-I1](#r-i1) | P0 | S | partial (4952821, 44a64bd) | Protect the work and stop repository bloat |
| [R-I2](#r-i2) | P1 | M | done (7bb4562, b0a0c0d, d08a143) | Split the 14k-line execution test file |
| [R-I3](#r-i3) | P1 | S-M | done (2531715) | Systematic authorization tests |
| [R-I4](#r-i4) | P2 | M | open | Structural test/production and process-authority boundaries |
| [R-I5](#r-i5) | P1 | S-M | done (b966dd7, 8d59ce2, cc08352, 06fdf7c, b5da9a0, b63295d, e16001d) | E2E and fixture reliability |
| [R-I6](#r-i6) | P1 | S-M | done (3ac6242, 1ff9785, a879d09, 1941a71) | Gate on lint |
| [R-I7](#r-i7) | P1-P3 | M | open | Documentation reset to current state |
| [R-I8](#r-i8) | P1 | S-M | partial (943fb8d) | Deploy from a separate checkout; one daemon per data directory |
| [R-I9](#r-i9) | P2 | S-M | open | Independent e2e specs: one workspace per spec (added 2026-09-24) |

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

**Controller-declared, typed attention on every blocking transition** · Phase P1 · Effort M-L · Status: done (eb757da, 57a3a16)

- **Resolves:** [CTRL-05](findings/CTRL-controller.md#ctrl-05-at-least-10-separate-places-decide-needs-the-operator-with-different-rules), [CTRL-10](findings/CTRL-controller.md#ctrl-10-awaiting-merge-is-overloaded-with-six-meanings), [CTRL-11](findings/CTRL-controller.md#ctrl-11-control-flow-depends-on-the-wording-of-human-readable-messages), [CTRL-22](findings/CTRL-controller.md#ctrl-22-the-api-returns-projection-fields-mixed-into-the-domain-workcycle), [NOTIF-02](findings/NOTIF-attention-notifications.md#notif-02-attention-is-inferred-by-predicting-automation-each-new-automation-needs-a-matching-suppression-clause), [DATA-05](findings/DATA-storage-domain-contracts.md#data-05-attention-and-operator-decisions-are-not-first-class-identity-is-keyed-on-versions-or-text-hashes-and-behavior-branches-on-english-reason-prefixes), [UI-02](findings/UI-information-architecture.md#ui-02-recovery-routing-depends-on-english-prose-reason-prefix-regexes-in-the-ui-and-navigation-prose-in-daemon-blocker-messages), [UI-09](findings/UI-information-architecture.md#ui-09-the-waiting-on-other-work-classification-hides-operator-owned-evidence), [UI-16](findings/UI-information-architecture.md#ui-16-attentionstrip-and-the-notification-service-disagree-about-merge-approvals)
- **Change:** Add an optional `attention {owner: operator|controller, code, subject refs, message, actions[]}` to cycles, roadmap entries/holds and roadmap status, written in the same transaction as the status change by the code that makes the decision. Add `code` and `owner` to PhaseBlocker; add a typed restart flag; add an `awaiting-merge` gate subtype (operator-merge, promotion, record-evidence, automatic-merge, controller-wait, scheduling-held). Map legacy reason strings to codes once, in one tested function. Replace every reason/message prefix match on the server and in the web with code switches, and remove navigation prose from daemon messages. NotificationService then selects owner=operator items and imports no policy modules.
- **Done when:** No `startsWith`/regex on reason or blocker message remains in apps/server or apps/web (grep test); every controller path that sets needs-attention or awaiting-merge sets attention.code (contract test); notification-service.ts no longer imports scope/roadmap policy modules.
- **Progress:** ADR-067. Domain vocabulary in `packages/domain/src/attention.ts`: 59 cycle codes (the 28 step-outcome codes from R-B2, controller stops, and the six `awaiting-merge` gates), 6 roadmap codes, 29 phase-blocker codes with owner and `waits`. Cycles, roadmaps and entry holds carry optional `attention` (wire schemas refine the owner). `CycleChanges`/`RoadmapChanges` make a stop without attention a compile error; `untypedStops` checks every test daemon's rows on cleanup (the whole server suite runs it). Automation claims (roadmap merge/verification/acceptance, conflict automation, scope recovery, prerequisite work) and merge requirements are declared with the transition by `cycle-attention-policy.ts` and refreshed in place when stored state changes. `PhaseGateError.waiting`, `scopeReviewWait`, host scheduling, the reassessment trigger and the roadmap progress view switch on codes; `phaseBlockerResourceKey` replaces a message substring match. Web: CyclePanel, WorkflowStatus, RoadmapAttention, RoadmapsPage, ExecutionScopesPanel, CheckpointRecoveryPanel (typed `prerequisiteCheckpoints`), AttentionStrip (UI-16) and Reasons (owner-based, UI-09) use codes. The scope check's rule 5 is the grep test. `NotificationService` reads declared attention and `RoadmapService.attentionAlerts`; it imports no policy module. Legacy rows map through `attention-legacy.ts` only. Behaviour changes, intended: roadmap-claimed merges, `scheduling-held` and `controller-wait` stops are not pushed; operator-owned evidence (decision checkpoints, dependency environments) shows as the operator's. Not in this change: navigation prose in daemon messages stays until the inbox renders destinations from codes (R-A5), the `actions[]` list is R-A7, and the CTRL-22 projection split moves to R-D5.
- **Amended 2026-09-24 (phase 1 review):**
  - **The grep test was narrower than its done-when.** Rule 5 caught only `reason`/`message` immediately followed by `.startsWith(`-style calls, and it scanned only the two apps. It missed these, among others:
    - `x.reason === 'Some sentence.'`
    - `.exec(reason)`
    - `/…/.test(reason ?? '')`
    - `blockerMessage.includes(`
    - anything in `packages/`

    One real hit had survived: `map-amendment-service.ts` filtered binding issues with `!m.startsWith('Make the bound ')`. That is now a typed option (`bindingIssues(…, { inactivePlans: false })`).

    Rule 5 now matches any identifier ending in `reason`/`message`, `.exec`/`.indexOf`, and equality with prose literals, while kebab-case codes stay allowed. It also covers `packages/contracts`, `domain`, `planning` and `storage`. As a boundary, it excludes the agent and Git adapters, which parse vendor and tool output, and `attention-legacy.ts`.

    A grep cannot see aliasing (`const r = x.reason; r.startsWith(…)`), so review still has to look for that.
  - **The contract test has gaps.** Cycles and roadmaps are compile-enforced. But:
    - entry holds and phase blockers carry an optional code;
    - `untypedStops` looks only at the rows present at cleanup;
    - daemons built without `createTestContext` skip it.

    A stop written without a code silently falls back to the legacy mapping.
  - **Stops that still have no code or owner** (P1 exit criterion "every stop has a code and owner"):
    - roadmaps paused to wait on the operator (a pending planning amendment, a dependency refresh);
    - reserved or failed merge operations;
    - failed baseline preparation;
    - merge cleanup errors;
    - blocked finalization removals;
    - failed or interrupted manual runs, whose attention the notification service still decides itself;
    - paused cycles, which are the operator's own hold.

    They move to R-A4, where attention becomes occurrence rows. The exit criterion is restated in program.md.
  - **Forward risk for R-H3.** The wire schemas validate `attention` against closed code enums, and they require the stored owner to equal the code's current owner. Renaming a code, changing its owner, or lowering `OUTPUT_REPAIR_LIMIT` would make stored rows fail response validation. Before the vocabulary changes, derive the owner on read or add an upcaster.

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
- **Amended 2026-09-24:** moved here from R-A7 by operator decision. Each decision and recovery component renders only the actions the daemon's `cycleActions` returns for the cycle.

### R-A7

**Offer only actions that can make progress; one transition gate for commands and launch** · Phase P1 · Effort M · Status: done (9339d01, c6e4042, 27266c0, 9084e50)

- **Resolves:** [CTRL-04](findings/CTRL-controller.md#ctrl-04-resume-is-accepted-even-when-it-cannot-make-progress), [CTRL-12](findings/CTRL-controller.md#ctrl-12-manual-commands-accept-transitions-that-the-automated-launch-then-rejects)
- **Change:** Derive the valid operator actions from the attention code (in the same pure code that decides the transition) and return them with the cycle projection; reject Resume when the blocking fact is not transient, with the correct destination. Put whole-item and scoped start/advance gates, including predecessor ancestry, into one transitionGate() used by commands before acceptance and again at launch.
- **Done when:** Replaying the recorded live sequences (cycles d148f0a4, 10dbc912, 2f1ab211) no longer produces accepted-then-bounced resumes; the UI renders only returned actions.
- **Progress:** `cycleActions`/`resumeRedirect` (domain, `cycle-actions.ts`) derive the actions from the typed stop (R-A3). A plain resume is refused with the control to use when the controller would classify the same run's text the same way: design stops (d148f0a4's invalid classification), open questions, invalid workflow reports, an exhausted remediation limit, a detected integration conflict. A newer manual run is always adoptable. A plain resume of a scope review is refused while the integration branch still has the reviewed commit (10dbc912). Before accepting a resume that relaunches the step or an integration resolution, the command runs the launch's own gates, including predecessor ancestry (2f1ab211). Stops that depend on state changed elsewhere (shared decisions, reviewer grants, dependencies, scope recovery, finalization continuations) stay resumable. The browser shows Resume only when `cycleActions` offers it. Tests: `cycle-actions.test.ts` (domain and server), plus the unchanged-snapshot case in the scope repair test. Two tests that asserted the old accepted-then-bounced resume were updated. Remaining: other panels still decide their own visibility (R-A6 consolidates them onto `cycleActions`); one `transitionGate` shared by the roadmap scheduler's whole-item and scoped gates (`RoadmapService.blocker`, `requireReady`, `scopePhaseBlockers`) is not unified yet, and the duplicated remediation-grant validators (CTRL-12) remain for R-B7.
- **Amended 2026-09-24 (phase 1 review):** Four defects fixed. The status stays partial.
  - **Pause then Resume reproduced the d148f0a4 bounce.** A pause cleared the stop, and `resumeRedirect` looked only at `needs-attention`. So Pause and then Resume, from the panel or through a roadmap item's pause/resume, relaunched a design the controller stopped again. A pause taken at a stop now keeps that stop's attention. Resume returns a stop that a plain resume would only reproduce to `needs-attention`, with the control to use in its reason, and relaunches nothing. Roadmap and item resumes leave such stops for their own control instead of failing on them.
  - **The integration-resolution command was not gated.** The recorded 2f1ab211 sequence went through `resolution-started`/`resolution-resumed`, which never ran the launch gates. `resolveIntegration` now checks them before accepting a start or a resume that launches an agent: predecessor ancestry at the pinned incoming commit, or the resolution launch's own checks once the merge is pending. The failed-step test models the same sequence through the resolution endpoint.
  - **"Continue with guidance" had no button for an invalid workflow report.** The server redirects it there, but the panel offered guidance only when the report raised questions. The panel now shows guidance whenever `cycleActions` names it.
  - **Adopting a newer manual run ran the launch gates.** It launches nothing, so it no longer does.
  - **Verdict on the done-when: not met.**
    - The tests replay the shapes of the three sequences, not the recorded rows.
    - The API does not return actions. The browser computes `cycleActions` itself, and only Resume and guidance follow it. Pause is still offered on `awaiting-merge`, and other panels decide their own visibility.
  - **Deferred, with reasons:**
    - A `remediation-exhausted` stop raised from housekeeping at an implement or remediate step can be resolved only with Stop. Resume redirects to Authorize, and Authorize requires a review step. It never happened in the live data (0 of 5 limit stops). Fixing it means authorizing remediation outside a review, which changes controller behaviour and belongs behind the R-B4 decision core.
    - A roadmap resume in sequential mode used to fail part-way on a refused cycle. It now skips such cycles, but it still throws on a cycle refused by the launch gates.
  - **Dependency mismatch.** The UI half of the done-when ("the UI renders only returned actions") cannot be met in P1. About 21 panels decide their own visibility until R-A6 (P3) consolidates them, and the API does not return actions yet. Proposal: restate R-A7's done-when to the server half plus the cycle panel, and move "each panel renders only returned actions" into R-A6's done-when.
- **Amended 2026-09-24 (operator decision): done-when restated.**
  - **New done-when:**
    - Tests that replay the shapes of the three recorded sequences (d148f0a4, 10dbc912, 2f1ab211) show no accepted-then-bounced resume, including through Pause/Resume and the integration-resolution command.
    - The cycle panel offers only the actions `cycleActions` returns: Resume, guidance, Pause and Stop.
  - "Every panel renders only returned actions" moves to R-A6.
  - **Met** (`cycle-actions.test.ts`, `execution-views.test.tsx`). To get there, `cycleActions` now offers Pause at the merge boundary, as the server always allowed, because a pause there holds a roadmap's automatic merge. The panel's Pause and Stop follow `cycleActions`.
  - **The status stays partial for the rest of the Change:**
    - one transition gate shared with the roadmap scheduler (`RoadmapService.blocker`, `requireReady`, `scopePhaseBlockers`);
    - the duplicated remediation-grant validators, which are R-B7's (CTRL-12).
- **Amended 2026-09-24: shared predecessor gate.**
  - **One rule in `services/transition-gate.ts`.** The whole-item predecessor rule, previously written three times, is now `predecessorGate()`: a required predecessor that is not completed blocks, unless the slice's early-start exception applies. Its callers:
    - commands (`requireReady`);
    - the launch (`BranchService.requirePredecessors`, which adds the Git ancestry check);
    - the roadmap scheduler (`RoadmapService.blocker`, which also counts its own unfinished attempts as in flight).

    Each keeps its wording and its outcome. The scoped gates were already shared through `scopePhaseBlockers`, and commands already run the launch gates, including ancestry, before accepting a resume (9339d01).
  - **Behaviour unchanged.** `controller:replay --check` (51) and `--every-run --check` (278) report 0 changed on the 2026-09-23 snapshot. Unit tests pass (`transition-gate.test.ts`, plus the existing 2f1ab211 command and scheduler tests).
  - **Stopped here, because the rest changes decisions that belong to R-B4:**
    - Running the launch's Git ancestry check in the scheduler before it creates an attempt. Today a missing predecessor merge stops the new cycle at launch as `needs-attention`. It would instead keep the roadmap entry waiting, which changes which stop the operator sees and when.
    - Aligning the item-status checks. Commands require an admitted item; the scheduler requires the bound plan item and refuses one completed without its merge. That moves stops between the cycle and the roadmap.

    Both belong in R-B4's decision core, behind the characterization harness. The duplicated remediation-grant validators stay with R-B7.
  - **Proposal:** mark R-A7 done and move these two to R-B4 (see the operator decisions in program.md). Until decided, the status stays partial.
- **Amended 2026-09-24 (operator decision): done.** The restated done-when is met. The shared predecessor gate is in place, and replays show no change. The two remaining gate differences move to R-B4: scheduler-side Git ancestry and item-status alignment. The duplicated remediation-grant validators stay with R-B7.

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
- **Amended 2026-09-24 (phase 1 review):** Verified: `controller:replay --check` against the live golden file reports "51 decisions replayed; 0 changed, 0 missing" at the head of the branch. The extraction is faithful to the pre-extraction `reconcile`. Two corrections:
  - The facts are not all lazy. `turn` and `ended` are read eagerly, which costs two indexed reads per reconcile of a live run. The claim above that "each is read only on the branch that read it before" does not hold for them.
  - The live golden covers only each cycle's current run, which is four decision kinds. `--every-run` (added with R-C2's amendment) classifies all 278 recorded runs.
  - The drain tests still sleep on the drain's fixed 250 ms poll.

### R-B3

**Explicit cycle ownership; roadmap state references its definition** · Phase P1 · Effort M · Status: done (82ae8ab)

- **Resolves:** [CTRL-07](findings/CTRL-controller.md#ctrl-07-ownership-of-a-cycle-by-a-roadmap-is-resolved-11-ways-and-the-cycle-has-no-owner-field), [CTRL-09](findings/CTRL-controller.md#ctrl-09-the-roadmap-control-row-embeds-the-whole-definition-and-history-is-parsed-on-hot-paths), [HIST-12](findings/HIST-history-and-live-usage.md#hist-12-roadmap-state-rewrites-a-248-kb-json-blob-including-a-full-definition-copy-on-every-change), [DATA-07](findings/DATA-storage-domain-contracts.md#data-07-the-roadmap-state-blob-embeds-a-copy-of-the-immutable-definition-and-keeps-append-only-histories-inside-the-mutable-blob-revision-lookups-load-every-revision), [PERF-08](findings/PERF-browser-and-read-performance.md#perf-08-map-evaluation-hot-spots-in-roadmap-view-cycles-list-and-cross-project-preview)
- **Change:** Add optional WorkCycle.owner {roadmapId, attemptId, entryId, definitionRevision}, set on creation and backfilled on read; replace the 11 ownership scans with one memoized cycleOwnership(). Store only definitionRevision in roadmap control state, load definitions through a process-wide immutable cache, and add an indexed single-revision lookup instead of parsing all history.
- **Done when:** No call site scans roadmaps.list() for a cycleId; roadmap row size no longer scales with the definition; roadmaps.history() is not called on hot paths.
- **Progress (2026-09-24):**
  - **Cycle owner.** `WorkCycle.owner` is optional: `{ roadmapId, attemptId, entryId, definitionRevision }`, or `null` when no roadmap owns the cycle.
    - Set on creation: the roadmap passes it when it starts an entry's cycle or a scope-recovery repair cycle. Manual starts and finalizations record `null`.
    - Backfilled by migration 0029 from the attempts. It refuses a database where one cycle is named by two attempts. Each attempt reserves a fresh cycle id, so none is.
    - A record still without it (a hand-built test record) is resolved from the attempts inside `cycleOwnership`. That is the only remaining search over roadmaps for a cycle.
  - **One ownership lookup.** `cycleOwnership(tx, cycle)` (`services/cycle-ownership.ts`) reads the owner by primary key and is memoized inside a read snapshot. It replaces the attempt scans in:
    - `workflowDelegation`, the two agent-profile resolutions and `roadmapClaim`;
    - cycle priority;
    - `providerRoadmapPaused`, the design-wait owner check and `refreshOwner`;
    - the agent-run service's provider-retry guard;
    - the runtime-evidence attempt lookup.

    Each site keeps its own conditions (running, cross-project, active attempt, holds) applied to the single owner. `scope-recovery-policy` and `map-adoption-policy` still list roadmaps, but they match entries by execution scope, not by cycle. The remaining `roadmaps.list()` calls iterate roadmaps for scheduling and views.
  - **Definition by revision.** A roadmap's control row stores `definitionRevision` instead of the definition. The repository rehydrates the definition from `roadmap_definitions` through a per-database `DefinitionCache`: deep-frozen, and discarded with a rolled-back transaction so a reused revision number cannot go stale.
    - `save` stores a revision not yet stored, and refuses one that differs from the stored revision. Definitions change only through a new revision.
    - `addDefinition` is idempotent for identical content.
    - `definition(ws, id, revision)` is the indexed lookup. `history()` is called only by the history route.
  - **Migration 0029.**
    - A roadmap whose embedded definition was never stored gets that revision stored. One that differs from its stored revision aborts the migration instead of losing a definition.
    - It recreates `work_items_admission_only`. That trigger read `$.definition.entries` from the control row, so after stripping it would silently have stopped refusing to return an admitted item to proposed. It now reads the stored revision.
    - Tests: `migration-0029.test.ts` (backfill, stored draft revision, abort on drift, the trigger still refusing).
  - **Evidence, on a copy of the 2026-09-23 snapshot:**
    - `controller:replay --check`: 51 decisions, 0 changed. `--every-run --check` against the golden taken before this work: 278 decisions, 0 changed.
    - `db:verify` on the migrated copy passes (54,152 records).
    - The cross-project roadmap's control row fell from 257,480 bytes to 26,686, which is now attempts and holds only. The other three fell from 3,912–5,262 bytes to 1,368–1,704.
    - All 35 attempt cycles got their owner; the 16 other cycles recorded `null`.
    - Two tests that rewrote a definition in place under the same revision now save a new revision.

### R-B4

**Pure cycle decision core with an explicit state machine** · Phase P4 · Effort L · Status: open

- **Resolves:** [CTRL-01](findings/CTRL-controller.md#ctrl-01-the-cycle-controller-is-a-656-line-imperative-function-with-an-implicit-state-machine), [CTRL-10](findings/CTRL-controller.md#ctrl-10-awaiting-merge-is-overloaded-with-six-meanings), [CTRL-11](findings/CTRL-controller.md#ctrl-11-control-flow-depends-on-the-wording-of-human-readable-messages), [DATA-04](findings/DATA-storage-domain-contracts.md#data-04-workcycle-is-a-50-field-god-record-with-embedded-sub-state-machines-two-entity-kinds-and-projection-fields-mixed-in), [HIST-01](findings/HIST-history-and-live-usage.md#hist-01-development-proceeded-by-patching-each-live-blockage-with-new-state-panels-and-vocabulary-spaghetti-fication-measured), [HIST-18](findings/HIST-history-and-live-usage.md#hist-18-controller-services-grew-append-only-through-feature-by-feature-accretion)
- **Change:** CycleFacts (one snapshot, one open-questions parser, one report parser) -> decide(cycle, facts, now) -> Decision {launch | wait | attention | approve | effect | complete} with an ordered, named guard list. reconcile becomes a thin shell. Collapse the ~27 optional recovery fields into one stop record plus an append-only step history; keep old JSON readable through upcasters (R-H3).
- **Done when:** reconcile is under ~100 lines; the decision core has table tests for every attention and wait code; WorkCycle optional-field count falls instead of rising.
- **Added 2026-09-24 (operator decision, from R-A7).** Two gate differences are left from R-A7's shared `predecessorGate()`, and the decision core should settle both. Each moves a stop between the cycle and the roadmap, so each needs a replay check.
  - **Scheduler-side Git ancestry.** Today a missing predecessor merge stops the new cycle at launch as `needs-attention`. The scheduler should check ancestry before it creates an attempt and keep the roadmap entry waiting instead.
  - **Item-status alignment.** Commands require an admitted item. The scheduler requires the bound plan item, and refuses an item completed without its merge. Both should use one rule.

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
- **Amended 2026-09-24 (operator decision, after R-I6):**
  - **Why.** R-I6 turned off Biome's `noNonNullAssertion`. In tests, `!` after a setup step is sound. In production, a violated `!` surfaces as an anonymous `TypeError` far from its cause.
  - **Where.** The 198 production sites are concentrated in the services this item rewrites: roadmap-service 45, runtime-evidence-service 37, work-cycle-service 23 and map-amendment-service 17. Doing it here avoids converting code that is about to be restructured.
  - **Added to the Change.** Replace production non-null assertions with a named invariant helper that throws with context, and re-enable `noNonNullAssertion` for production files in `biome.jsonc`, keeping it off only for tests.
  - **Added to the done-when:** `pnpm lint` passes with the rule on for every non-test source file.

### R-B8

**Remove dead and vestigial paths** · Phase P1 · Effort M · Status: done (c0ccf3b, 9fe2152)

- **Resolves:** [CTRL-15](findings/CTRL-controller.md#ctrl-15-dead-and-vestigial-controller-paths), [GIT-04](findings/AGT-GIT-SEC-agents-git-security.md#git-04-the-ct-04a1-inspector-is-dead-code-about-78k-lines-but-is-still-composed-configured-and-tested), [DATA-09](findings/DATA-storage-domain-contracts.md#data-09-the-dead-ct-04a1a2-repository-inspector-and-registry-are-still-compiled-constructed-and-schema-resident), [QA-10](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-10-test-effort-is-weighted-toward-the-dormant-ct-04a-repository-inspection-feature)
- **Change:** Delete the CT-04A1/A2 repository inspector, registry, provider, config keys and tests (drop the three empty tables in a forward migration; CRAFTINGTABLE_GIT_BIN currently crashes startup). Stop offering legacy finalization rounds for new finalizations while keeping the completed legacy record readable, then remove the legacy branches. Split WorkCycleRepository.list() into listActive()/listForWorkspace().
- **Done when:** ~7-8k production and ~4.5k test lines removed; pnpm check green; the completed legacy finalization still renders.
- **Progress:** The CT-04A1/A2 inspector is gone: `packages/git` keeps only `operations.ts`; the server observation port, adapter, policy and `RepositoryInspectorProvider` are removed; so are the storage registry repositories and write types, the domain and contract inspection model, and their tests. About 6.2k production and 5.9k test lines. `command-runner.ts` is off the process-authority list. The repository-feature configuration is removed, so `CRAFTINGTABLE_GIT_BIN` and the other inspector variables no longer enable a feature that crashes startup; they are ignored (config test). ADR-016, 017 and 019 are marked superseded and ADR-018 partly superseded. `WorkCycleRepository.list()` is split into `listActive()` and `listForWorkspace()`. **Not dropped:** the three empty tables. `workspace_events` has foreign keys into them, and SQLite refuses every insert into a child table whose parent table is missing, even with NULL keys (tried on a snapshot copy). Dropping them therefore needs the journal rebuild ADR-013 warns about. The journal keeps the `repository-*` kinds, correlation columns and checks, the status vocabulary they name (trimmed `domain/repository.ts`) and the display-name schema, and nothing writes them. Journal tests that used registry rows now use live kinds, or insert raw rows with foreign keys off. The 0004 migration tests keep schema preservation only. **Remaining:** stop offering legacy finalization rounds for new finalizations and remove the legacy branches. The legacy controller's execution tests (`beginFinalization` with rounds) must move to staged finalizations first; that also changes the finalization start form, so it needs walkthrough captures. The GIT-04 hardening harvest into the live runner is tracked under SEC-03.
- **Amended 2026-09-24 (phase 1 review), fixes:**
  - **Removed settings were ignored silently.** `CRAFTINGTABLE_GIT_BIN` differs from the live `CRAFTINGTABLE_GIT_EXECUTABLE` by one word, so setting it chose nothing, with no signal. Startup now logs a warning that names every removed inspector setting still set (`retiredSettings`, config test).
  - **Stale docs.** ADR-008 still named `command-runner.ts` as the only process authority, and `docs/architecture.md` said there were three modules. Both now point to `PROCESS_AUTHORITY`.
  - **Line counts against the done-when.** From `git show --numstat`: production −6.2k, tests −5.9k. The production target (~7–8k) is not reached without the legacy-finalization removal.
- **Amended 2026-09-24 (phase 1 review): split.** Two parts of the Change cannot be finished as written in this item, so they move to their own items. The inspector and registry removal is finished, and the item is closed on it.
  - **The three empty tables.** Dropping them in a forward migration is infeasible. `workspace_events` references them, and SQLite then rejects every insert into it: `no such table: main.project_repository_bindings`, checked again on a snapshot copy. Removing them means rebuilding the journal, which ADR-013 calls the riskiest migration. This moves to [R-H6](#r-h6), after R-H3's preservation tests and `db:verify`.
  - **Legacy finalization for new starts.** This moves to [R-B10](#r-b10). Its prerequisites are test migration and a UI change with walkthrough captures.
  - **Restated done-when:** the CT-04A1/A2 inspector, registry, provider, configuration and tests are removed, with a warning for settings that are still set; `pnpm check` is green. **Met:** production −6.2k and tests −5.9k lines.
  - The original targets (~7–8k production lines; the completed legacy finalization still renders) belong to R-B10.

### R-B9

**Low-disruption restarts: bounded drain plus automatic resume of interrupted steps** · Phase P1 · Effort M · Status: done (4d81743, efd7369)

- **Resolves:** [HIST-06](findings/HIST-history-and-live-usage.md#hist-06-deploy--restart-and-every-restart-stops-running-roadmaps-and-live-runs), [CTRL-20](findings/CTRL-controller.md#ctrl-20-every-restart-stops-all-automation-and-kills-in-flight-agent-work), [HIST-13](findings/HIST-history-and-live-usage.md#hist-13-schema-and-adr-churn-rate-22-migrations-46-adrs-in-18-days-with-manual-pre-migration-backups)
- **Change:** Agents are child processes of the daemon, connected only by stdio pipes, so a restarted daemon cannot re-attach to a run that is still going. Combine two mechanisms (operator decision 2026-09-23). (1) Bounded drain: on stop or deploy, stop admitting new steps and wait up to a configurable bound (a few minutes) for live turns to finish; then interrupt what is left, recording which runs were interrupted by a controlled drain (as opposed to a crash). `pnpm deploy:daemon --when-idle` instead waits until nothing is live before switching and restarting. (2) Automatic resume: on a clean start, relaunch each step interrupted by the drain by resuming its vendor session (Claude `--resume <session>`, Codex app-server thread resume; both adapters already have resume paths) in the same worktree, with the original deadline and permissions, so conversation and worktree edits survive and only the in-flight tool call is redone; roadmaps and cycles that were running continue without an operator Resume. Unclean interruptions (crash, kill, lost session id) and failed resumes keep today's explicit-resume attention. Also take the pre-migration DB snapshot automatically in the migration runner. Truly surviving a restart (agents that outlive the daemon) is R-G12.
- **Done when:** A deploy while a long run is live either waits (`--when-idle`) or drains within the bound and, after restart, the interrupted step resumes its vendor session automatically with no operator action and no page; running roadmaps keep running; a crash or failed resume still requires explicit resume (tests with the fake backends for both paths).
- **Progress:** ADR-066. `DaemonDrain` holds roadmap admissions and refuses launches (`DaemonDrainingError`, 503), waits up to `CRAFTINGTABLE_DRAIN_TIMEOUT_SECONDS` (default 180) or until idle, stops the loops, ends waiting cycle turns normally, interrupts the rest with exit reason `daemon-drain`, and writes a `daemon_clean_stop` row (migration 27). The next start consumes it: cycles and roadmaps stay running and `reconcile` resumes a drain-interrupted step through the interrupted run's session (same backend, model, permissions, guidance, deadline; reviews keep their pinned baseline). Crash, no session id and failed resume keep the explicit resume. `pnpm deploy:daemon` requests the drain through `drain-request.json` in the data directory before switching releases (`--when-idle`, `--no-drain`; Ctrl-C withdraws it; a daemon that predates drain support is restarted the old way after 15 s). `SIGTERM` runs the same drain as a best effort; it needs `KillMode=mixed` and a longer `TimeoutStopSec` in the unit, which `--status` points out. Migrations copy a populated database to `state/pre-migration/` first (three kept). Tests: `apps/server/src/restart-drain.test.ts`, `scripts/deploy-daemon.test.mjs`, `packages/storage/src/migrations.test.ts`. Live verification waits for an operator-approved deploy.
- **Amended 2026-09-24 (phase 1 review):** Two defects fixed; the done-when is unchanged and still met in tests only.
  - **A drain with no restart left the daemon inert.** After a deploy-requested drain reached its interrupt phase, the loops were stopped and launches refused, and nothing restarted the daemon if the deploy was interrupted after the drain. Causes include a late Ctrl-C, a closed terminal (only SIGINT withdrew the request), or a failure between the acknowledgement and `systemctl restart`. Automation stopped silently. Now a daemon drained for a deploy that is not restarted within two minutes exits with status 75, so `Restart=on-failure` brings it back and the clean stop resumes automation. The deploy script also withdraws its request on SIGHUP and SIGTERM, and says what a late withdrawal does.
  - **Signal-killed agents during a deploy drain.** The heuristic "during a drain, a signal the daemon did not send is the service manager" also applied to deploy drains, which can last for hours under `--when-idle`. So an agent killed by the OOM killer or a crash was recorded as `daemon-drain` and resumed automatically. It now applies only while the daemon itself is stopping on a signal.
  - Tests for both cases are in `restart-drain.test.ts`.
  - **Still open, and the operator's to decide (unit configuration):**
    - The live unit runs `ExecStart=/usr/bin/env pnpm start` with the default `KillMode=control-group` and `TimeoutStopSec=30`. A plain `systemctl restart` therefore signals the agents directly and kills everything at 30 s.
    - `KillMode=mixed` signals only the main process, which is `pnpm`, not node. Whether the nested `pnpm` wrappers forward SIGTERM is unverified. The drop-in should run node directly, or the forwarding must be verified before relying on it.
  - **Not fixed (low):**
    - A deadline that passes during a long `--when-idle` drain cancels the resumed turn at once, as a generic incomplete step.
    - The replay tool copies a migrated snapshot twice, because of the pre-migration copy.
- **Amended 2026-09-24 (operator decision: "your best recommendation"):**
  - **The unit should run node directly**, `ExecStart=/usr/bin/env node apps/server/dist/index.js`. This was verified: the built daemon starts, drains on SIGTERM and exits.
  - **It should also set** `KillMode=mixed` and `TimeoutStopSec=300`.
  - **Where it is recorded.** `docs/operations.md` has the unit and the `drain.conf` drop-in. `pnpm deploy:daemon --status` checks all three settings (`unitStopProblems`) and prints the drop-in.
  - **The live unit is unchanged**, because the operator deploys only after P1 lands. Apply the drop-in, then `systemctl --user daemon-reload`, together with that deploy.

### R-B10

**Retire legacy finalization for new starts** · Phase P1 · Effort S-M · Status: in progress

- **Added 2026-09-24:** split from [R-B8](#r-b8) in the phase 1 review. Its part of the R-B8 Change needs work R-B8 never scoped: moving tests first, and a UI change.
- **Resolves:** [CTRL-15](findings/CTRL-controller.md#ctrl-15-dead-and-vestigial-controller-paths) (the legacy-finalization part).
- **Change:**
  - Move the legacy controller's execution tests (`beginFinalization` with rounds) to staged finalizations first, so staged coverage does not shrink when the legacy branches go.
  - Stop offering "Legacy improvement rounds" in the finalization start form. Take walkthrough captures before and after this change.
  - Keep a completed legacy record readable.
  - Then remove the legacy branches: the `polishPhase` paths in `step-outcome.ts` and `reconcile`, `defer-nits` in `decideFinalizationFindings`, and the legacy parts of `finalizationInstructions`, `finalizationProfile` and `startFinalization`.
- **Done when:**
  - A new finalization cannot choose legacy rounds.
  - The completed legacy finalization (live DB, 2026-09-13) still renders, which a test asserts.
  - The legacy controller branches are gone.
  - The walkthrough captures are recorded.
  - `pnpm check` is green.
- **Note:** No staged finalization has run on live data yet (CTRL-15). Consider running one live finalization on the staged controller before the legacy branches are deleted.
- **Progress 2026-09-25:**
  - **Start form.** "Legacy improvement rounds" is gone from the finalization start form; a new finalization is always staged (`FinalizationPanel.tsx`). Walkthrough captures `2026-09-25-finalization-staged-before` and `-after` (scene 10, finalization setup). `FinalizationPanel.test.tsx` asserts the form offers only stages, and fails against the previous form.
  - **The completed legacy record renders.** The live 2026-09-13 finalization and its cycle are copied read-only into `fixtures/records/legacy-finalization-2026-09-13.json` (ids, SHAs and prose only). `legacy-finalization-record.test.ts` checks both still pass their persisted-record contracts and the view contract. `FinalizationPanel.test.tsx` renders them: "Promoted by operator", "final-review · 2 of 2 improvement rounds", and the removed integration branch.
  - **E2E.** The finalization spec's legacy variants are replaced: `remediate` now exhausts the correctness stage's budget and authorizes focused remediation on a staged finalization; `defer` (legacy defer-nits) is dropped, and its promotion-with-branch-removal check moved to `remediate`. The stand-in agents answer stage reviews through one helper (`e2e/fake-finalization.mjs`).
  - **Replay baseline.** On a private copy of the 2026-09-23 snapshot, `controller:replay --check` reports 51 decisions, 0 changed. A new `--every-run` baseline (278 decisions) is recorded from this head, where controller code equals 5e0c638. It is kept at `$XDG_DATA_HOME/craftingtable-review/replay/2026-09-23/every-run-golden-5e0c638.json` for the deletion's check.
  - **Deviation: the API still accepts legacy input.** The done-when "a new finalization cannot choose legacy rounds" is met in the UI. The contract refuses legacy starts only when the legacy branches are deleted, so the legacy controller tests keep driving it until then.
  - **Still to do:** move the legacy controller tests to staged finalizations; delete the legacy branches after a staged finalization completes on live data. On 2026-09-25 the operator reported no plan is ready to finalize, so the deletion is left as the last step.

## Workstream C — Operator-wait reduction (the vision: minimum operator input)

### R-C1

**Measure operator-wait as a first-class metric** · Phase P1 · Effort S-M · Status: done (7689200, ca489a9)

- **Resolves:** [HIST-02](findings/HIST-history-and-live-usage.md#hist-02-wall-clock-throughput-is-dominated-by-waiting-for-the-operator-not-by-agent-work-or-controller-latency), [HIST-03](findings/HIST-history-and-live-usage.md#hist-03-ranked-operator-intervention-causes-the-highest-leverage-automation-fixes), [HIST-09](findings/HIST-history-and-live-usage.md#hist-09-agent-reliability-is-high-stops-are-controller-derived-prioritize-accordingly)
- **Change:** Record stop openedAt/resolvedAt/owner/kind (falls out of R-A3/R-A4) and show operator-wait hours and stops-by-kind on the dashboard. Use it to rank the remaining automation work.
- **Done when:** The dashboard shows operator-wait hours for the last 7 days and the top stop kinds; numbers reproduce the HIST baseline on a DB snapshot.
- **Progress:** Each cycle transition's audit entry now records its attention `{ code, owner, claim }`. The pure function `summarizeOperatorWait` (domain, `operator-wait.ts`) turns cycle transitions and run intervals into four numbers: wall hours with work waiting on the operator, the part of those with no agent running (the HIST-02 headline), agent hours, and operator stop kinds ranked by cycle-hours. A cycle waits on the operator while it is paused or stopped at operator-owned attention; controller-owned stops do not count. Older audit entries recover their code through `effectiveCycleAttention`. `GET /api/workspaces/:id/operator-wait?days=7` (1–30) serves it, and the dashboard's "Operator wait" section shows the hours and the five costliest stop kinds. The section reloads only when a cycle's status changes. Against the 2026-09-23 snapshot, the daily no-agent waiting hours for 09-19..09-22 UTC are 17.3, 17.7, 23.8 and 20.8 (HIST-02: 17.3, 17.6, 23.8, 20.8). 09-17..09-23 Pacific gives 112.7 h waiting with no agent against 31.3 agent-hours (baseline: ~112 h vs ~30 h). The top kinds are design-decision-required (131 cycle-h), paused (75), unrecoverable legacy stops (62), scope-review-recovery (55) and design-investigation-finished (52). Walkthrough captures `2026-09-24-operator-wait-before`/`-after`. The walkthrough script also repeats the recovery guidance with the answered question: guidance is one-shot per step (R-G3), and the capture had been failing since then. Tests: `operator-wait.test.ts` (domain and server), `OperatorWaitSection.test.tsx`.
- **Amended 2026-09-24 (phase 1 review):** Fixes, with the done-when unchanged.
  - **Older `awaiting-merge` records.** They recovered their stop kind from `status` and `reason` alone. Recovery now also reads the cycle's `executionScope` and `finalizationId`, as `effectiveCycleAttention` does for live cycles. Before the fix, 30 of the 68 `awaiting-merge` transitions in the snapshot were scope-verification or parent-acceptance records counted as `merge-approval`. `workflow.waiting` was never recorded, so a historical `controller-wait` still counts as the operator's.
  - **Owner and code changes.** `refreshAttention` changes a stop's owner or code in place, for example when a roadmap claim lapses or is taken. Those changes are now audited as `attention-refreshed` transitions, so the wait starts and ends when the owner changes, not at the original transition.
  - **Windowed read.** The endpoint reads the transitions inside the window plus each cycle's last transition before it. It no longer parses the whole history.
  - **Other fixes:**
    - A stop whose first record lasted no time (two writes in the same millisecond) is now counted.
    - A stored code is checked with `Object.hasOwn`.
    - The dashboard reloads when a stop's code or owner changes, and when a hidden tab returns more than 5 minutes after the last measurement. It shows when the numbers were measured and never polls, so an idle tab stays silent.
  - **Correction to the Progress numbers above.** 112.7 h against 31.3 agent-hours is the window 09-17 00:00 to 09-23 00:00 Pacific, six days, which is how HIST-02 counts "09-17 → 09-23". The top kinds quoted above came from a different window, 09-17 to 09-24 UTC. For the HIST-02 window, after these fixes, the top kinds are:
    - design-decision-required: 131 h
    - legacy-attention: 62 h
    - scope-review-recovery: 55 h
    - paused: 41 h
    - design-open-questions: 38 h
  - **How HIST-02 compares.** The daily UTC figures and the 09-10..09-23 total still reproduce HIST-02: 160.1 h idle-waiting against 86.0 agent-hours. The definitions differ in one way: HIST-02 counted every `needs-attention`, `awaiting-merge` or `paused` interval, while R-C1 leaves out controller-owned stops. No historical record resolves to a controller owner, so the numbers agree on the snapshot, but they will diverge from now on.
  - **Deferred, with reasons:**
    - The `legacy-attention` hours (15 older stops the legacy map names no code for) are not mapped further. They leave the 7-day window a week after deploy.
    - Open manual sessions count as agent time, as in HIST-02. Counting turn intervals instead is left for R-A4's occurrence rows.

### R-C2

**Re-prompt the agent automatically on output-format validation failures** · Phase P1 · Effort S-M · Status: done (f049b3a, 2d24969)

- **Resolves:** [HIST-10](findings/HIST-history-and-live-usage.md#hist-10-agent-output-format-validation-becomes-operator-stops-instead-of-automatic-re-prompts), [HIST-03](findings/HIST-history-and-live-usage.md#hist-03-ranked-operator-intervention-causes-the-highest-leverage-automation-fixes)
- **Change:** When a design classification, structured review report or "## Open questions" section fails validation, send one bounded follow-up turn to the same session quoting the validator errors (up to 2 attempts) before stopping for the operator. Record the attempts in the stop record.
- **Done when:** Replaying the WI-09 and finalization invalid-output stops produces automatic repair turns, not needs-attention.
- **Progress:** `decideStepOutcome` returns `repair-output` instead of a stop when a finished run's final report fails a structural check: an invalid design classification, an invalid or missing workflow report, a review report that is unstructured or invalid (including a missing scope evidence entry), or an Open questions checkpoint that is missing, repeated, empty, not last in a design report, or "none" followed by more text (`openQuestionsCheckpoint`, domain). A checkpoint that lists questions still stops at once, as do findings, decisions and dependencies. The controller records `outputRepair { attempts, sourceRunId, code, issues }` on the cycle and relaunches the step resuming the run's vendor session (`sessionResumeSource`, the R-B9 path generalized) with a message quoting the validator issues and asking for the whole corrected report; reviews stay on their pinned baseline, guidance is kept, and the turn gets at least 20 minutes. After `OUTPUT_REPAIR_LIMIT` (2) failed repairs, or when the run has no session id, it stops with the same code as before and `attention.repairAttempts`. No new attention codes or operator surfaces. Live history (snapshot 2026-09-23): the two finalization review reports rejected on 09-13 (finding ids that break the id pattern; `exitGate.evidence` over 20,000 characters) now classify as repairs, with those issues quoted. The four WI-09 stops (cycle d148f0a4) came from a design validator that f574029 later relaxed. Today both runs parse as complete and end with a real ADR approval request, so they correctly stop for the operator. All 18 recorded design stops for open questions list real questions and still stop. Tests: `step-outcome.test.ts` (table rows and R-C2 block), `output-repair.test.ts` (resume and continue, exhaustion, real questions, review on pinned baseline).
- **Amended 2026-09-24 (phase 1 review): done-when restated.** The original done-when, "replaying the WI-09 and finalization invalid-output stops produces automatic repair turns", cannot be met as written, for two reasons:
  - f574029 relaxed the design validator, so WI-09's reports are now valid. Its runs correctly stop for the ADR decision.
  - `controller:replay` classified only each cycle's current run, so no recorded stop could be replayed.

  **Restated done-when:** `pnpm controller:replay <snapshot> --every-run` classifies every finished or failed run as if it were current, and every recorded report that still fails a structural check comes out as `repair-output`, not a stop. Stepped tests show that a repair turn resumes the session and that a corrected report continues.

  **Met.** On the 2026-09-23 snapshot, 278 runs were replayed:
  - The two 09-13 finalization review reports (cycle caf76f40: finding ids breaking the pattern; `exitGate.evidence` over 20,000 characters) and two finalization implement reports without an Open questions checkpoint classify as `repair-output`.
  - d148f0a4's two design runs classify as `design-decision-required` and `design-investigation-finished`.
  - Every run that lists real questions still stops.
  - `--check` against the live golden file still reports 0 changed.

  **Fixed:**
  - **Spent repairs carried into later runs.** A stop, a pause or any operator command left `outputRepair` on the cycle. After Resolve design questions or a manual resume, the next run's malformed report got fewer repairs, or none, and stopped with "2 automatic format repairs did not produce a valid report". The budget now ends with any stop, pause, end or operator command. The stop records the attempts in `attention.repairAttempts`.
  - **The repair prompt said only the format was wrong.** Some issues ask for evidence, such as a missing required check, a gate that needs passing checks, or a plan-change decision. The prompt now forbids filling those in from memory. It allows read-only verification and sends anything unestablished, or any operator decision, to Open questions.

  **Deferred, with reasons:**
  - A repair turn that hits a retryable provider failure gets an ADR-062 service retry. That retry reruns the whole step and starts a fresh repair budget: at most two repairs per retry, and three retries. Resuming the repair instead needs the service retry to carry the repair's session source and its review continuation, and that path should change behind the R-B4 decision core.
  - If a sibling merge moves the integration branch while a review repair is pending, the repair's continuation capture fails as `controller-error`, and the typed code is lost. That is also for R-B4.
  - Letting the agent repair evidence and completeness issues automatically is an operator policy question; see the phase 1 review's open decisions.
- **Amended 2026-09-24 (operator decisions, same day):**
  - **Keep** the 20-minute minimum for a repair turn.
  - **Repair only pure format faults.** Review assessments now carry a typed `fault`:
    - `format`: a missing, truncated, unparsable or schema-invalid report, or a verdict line that disagrees with its report.
    - `content`: a well-formed report that is missing something only more work or the operator can supply. That covers previously recorded findings left without a disposition, staged-finalization checks (required checks, gates, obligation dispositions, stage naming), a failed or unfinished review turn, and omitted scope evidence.
  - Design and workflow reports and the Open questions checkpoint have only structural faults, so they stay repairable.
  - A content fault stops for the operator at once, and after a repair it keeps `repairAttempts`.
  - The optional `fault` is set when an assessment is written. For older records the reader derives it from the report text: if the text alone is invalid, the fault is format; otherwise it is content (rule 2).
  - The repair prompt no longer needs the paragraph about evidence, so it was removed.
  - The restated done-when still holds: `--every-run` on the snapshot shows the same four finalization reports as repairs, and `--check` reports 0 changed.
  - Tests: `review-report.test.ts` and the `step-outcome.test.ts` rows.

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

**Schedule automatic retry for quota/session limits with a known reset time** · Phase P1 · Effort S · Status: done (5744289, 4abfec2)

- **Resolves:** [AGT-60](findings/AGT-GIT-SEC-agents-git-security.md#agt-60-quota-and-session-limit-failures-with-a-known-reset-time-always-need-the-operator)
- **Change:** When the vendor reports a reset time, schedule the retry at that time within the step deadline instead of stopping for the operator.
- **Done when:** A recorded session-limit fixture produces a scheduled retry.
- **Progress:** `ProviderFailure.resetsAt` (optional). The Claude normalizer keeps the reset time from a `rejected` `rate_limit_event` (`rate_limit_info.resetsAt`) and attaches it to the next `quota` failure, which is then marked safe to retry, subject to the existing checks (no outstanding tools, interaction or background work). The reset time applies to one result, and an `allowed` report clears it. `decideStepOutcome` treats a quota failure with a reset time no more than 6 h away (`QUOTA_WAIT_LIMIT_MS`) as a service retry. The retry is scheduled 2 minutes after the reset, or after 1 minute if the reset has passed, on the same agent. It counts toward ADR-062's three retries, and roadmap pauses hold it. The step deadline moves by the time waited, as `phaseWait` already does, so the wait does not use up the step's time. Weekly allowances, billing failures and quota errors without a reset time still stop for the operator. Codex reports no reset time in its structured errors, so Codex quota failures are unchanged. Not in this change: ending the session promptly on a terminal quota error (run 736446e8 kept running background sub-agents for 31 minutes), and a single "paused until" notification. The wait is a running cycle and does not page. Tests: the recorded `claude-session-limit` fixture now schedules a retry at 14:52 for a 14:50 reset and relaunches the same model (`server-execution.test.ts`); normalizer and decision-table cases.
- **Amended 2026-09-24 (phase 1 review):** The done-when is met on the fixture, but the incident that motivated AGT-60 would still stop. The `claude-session-limit` fixture is hand-written. Replaying the recorded stream of run 736446e8 through the normalizer marks every quota result unsafe to retry, because tools and background work were still outstanding. So that run would still be `service-failure-not-retryable`. Covering it depends on ending the session promptly on a terminal quota error, which was already out of scope above; it now has to happen before R-C8 helps in practice.

  **Fixed:**
  - A billing failure (402 or `billing_error`) that followed a reported reset was marked safe to retry and waited for the reset. It now stays with the operator.
  - A reset time already in the past was retried after 1 minute, so a stale reset could use up the three retries within minutes. ADR-062's 1/5/15-minute backoff is now the floor.
  - Reset values beyond epoch seconds (for example milliseconds) were turned into dates that could throw. They are now ignored.
  - The Provider recovery panel and the service-retry brief still said the original step deadline always applies. They now describe the reset wait.

  **Deadline policy.** The step deadline moves by each wait, at most 6 h per wait and 3 waits. That can extend the deadline by up to about 18 h without an operator decision. It is listed as an open operator decision in the phase 1 review, and the code is unchanged until the operator decides.
  - **Operator decision (2026-09-24):** keep it. A soft deadline that moves with quota waits suits how the operator works, so the extension is intended.

  Codex quota failures carry no reset time and are unchanged.

### R-C9

**End the session on a terminal quota error so the reset wait applies** · Phase P2 · Effort S-M · Status: open

- **Added 2026-09-24** in the phase 1 review of R-C8. The operator confirmed P2 the same day.
- **Resolves:** [AGT-60](findings/AGT-GIT-SEC-agents-git-security.md#agt-60-quota-and-session-limit-failures-with-a-known-reset-time-always-need-the-operator) (the part R-C8 left out).
- **Why:** R-C8 schedules the wait only when a quota failure is safe to retry. In the recorded incident (run 736446e8), the session kept background sub-agents and tool calls running for 31 minutes after the terminal quota error, so every quota result was unsafe and the step still stopped for the operator. Only 3 of about 12 quota results in that stream carried a reset time.
- **Change:** On a terminal quota error that has a reported reset, end the session promptly: stop background sub-agents and let outstanding tool calls settle or be cancelled. Keep the latest reported reset for the turn's final failure, rather than applying it to one result only. Add a recorded-stream fixture of the 736446e8 shape.
- **Done when:** Replaying the 736446e8 stream through the normalizer and the controller schedules a retry at the reset.

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

**Format ingestion bugs and test honesty** · Phase P0/P1 · Effort S-M · Status: partial (7d44b42, 0ef1c95; FMT-15 done 2026-09-25)

- **Resolves:** [FMT-08](findings/FMT-plan-and-roadmap-formats.md#fmt-08-work-item-phase-is-unbounded-in-the-normalizer-but-64-in-the-database-and-wire-contract), [FMT-11](findings/FMT-plan-and-roadmap-formats.md#fmt-11-the-studio-seam-is-unused-and-produces-a-different-definition-digest), [FMT-13](findings/FMT-plan-and-roadmap-formats.md#fmt-13-the-same-plan-imported-by-discrete-upload-and-by-zip-gets-different-digests), [FMT-14](findings/FMT-plan-and-roadmap-formats.md#fmt-14-silent-truncation-of-plan-fields-that-agents-treat-as-the-contract), [FMT-15](findings/FMT-plan-and-roadmap-formats.md#fmt-15-execution-tests-bypass-the-importer-with-definitions-it-would-reject), [FMT-16](findings/FMT-plan-and-roadmap-formats.md#fmt-16-roadmap-entry-limits-are-inconsistent-and-settings-are-duplicated-in-every-entry-and-revision)
- **Change:** Diagnose over-long phase at import instead of failing in storage; one digest for the same content regardless of transport (discrete vs ZIP, Studio seam vs ZIP); make truncation of agent-contract fields explicit; make execution tests build maps through the importer; align roadmap entry limits.
- **Done when:** Each reproduction script from the FMT report fails before and passes after.
- **Progress:** FMT-08 and FMT-14 fixed. FMT-13 cannot be fixed without changing existing digests (the live AQ-CONT-1 identity); needs a dual digest / digest v2, which is a schema decision; current behaviour pinned by tests. FMT-11, FMT-15, FMT-16 open.
- **Amended 2026-09-24 (R-H3 measured FMT-15).**
  - With the write guard applying the v0.3 source schema, 63 server tests failed: every one stored a definition built by `slicedFixture` or `supervisedMapFixture`. The sources carry local ids such as `AQ-01` without a repository prefix, and checkpoints with no requirement. The importer rejects both.
  - R-H3 therefore leaves the format check to the importer and to `db:verify`. The test-cleanup verification skips it; see R-H3's progress.
  - FMT-15's fix stands: build these fixtures through the importer, or with ids that conform. Then turn the format check on in `unverifiedRecords` (`apps/server/src/test-support.ts`).
- **Amended 2026-09-24 (operator decision): rebuild the scope fixtures through the importer.** `slicedFixture` and `supervisedMapFixture` will produce their definitions through the v0.3 importer, with repository-prefixed ids and checkpoints that carry requirements. Test cleanup then applies the map-format check too. This is scheduled with the rest of FMT-15 and is not yet done.
- **Amended 2026-09-25: FMT-15 done, with one deviation the operator chose.**
  - **What an importer-valid map needs.** Beyond prefixed ids, the v0.3 importer requires an implemented upstream with a baseline binding, lock document and previous definition, a second planned repository (two merge lanes), at least one source case, and source snapshots whose digests match. `apps/server/src/map-test-support.ts` builds this: tests describe the local map (`localScopeSource`: `local/AQ-01` with slices `local/AQ-01/a` and `/b` and case `CASE-PARENT`), and `sealLocalMap` adds the scaffolding and the digests. It never repairs what a test wrote: an unknown reference or an unprefixed id still fails the import.
  - **Every scope fixture map now passes the real importer.** `slicedFixture` and `supervisedMapFixture` upload the sealed ZIP through `packageImportService.importConcurrency` and fail with its diagnostics. The test maps the importer rejected were corrected without weakening them:
    - an unknown lowercase checkpoint became a declared `EXTERNAL-PROOF`;
    - a five-slice parent now requires all five slices;
    - wholesale checkpoint and case replacements now append, so the base case keeps its checkpoint;
    - an empty decision list became the base decision, which the test's adoption now approves;
    - a checkpoint owned by an undeclared `aq` now names the scaffolded upstream;
    - the whole-plan parent `local/AQ-02` got its own slice, since the format requires one.
  - **Deviation (operator decision 2026-09-25, "schema-valid fixtures").** An importable map has an implemented upstream, and the runtime then requires every consumer to pin it. A pinned run goes through the pinned Cargo build. Storing the imported map as-is would move about 70 scope tests onto that path and make them need Rust. So the fixtures store the imported map without the two scaffolding repositories (`withoutScaffolding`). The stored map conforms to the v0.3 schema, but not to the importer's cross-stack rules; those wait for R-F5's single-repository profile. Bindings are still written directly, and they bind only `local`.
  - **Behaviour the fixtures now carry that they skipped before:** slices declare the one resource the daemon manages (`isolated-development-workspace`) instead of none, so `withLocalPhaseResources` is gone; the parent's acceptance requires its verified slices; `CASE-PARENT` is a real case that slice a produces, so its scope evidence names it. The supervised maps keep no local case, as before. The sealed package gives the peer lane the one case the format requires.
  - **Test cleanup applies the format check.** `unverifiedRecords` calls `verifyRecords(storage)` with the v0.3 schema check on. A regression test stores a hand-built map with the old `AQ-01` id and asserts cleanup refuses it; it fails with the check off (`map-test-support.test.ts`).
  - **Gate:** 176 test files and 1,391 unit tests pass (1,386 before, plus 5 new tests).
  - **Follow-up 2026-09-25:** the whole-plan finalization test in `server-execution-supervised-maps.test.ts` timed out in every full-suite run. A valid map needs `local/AQ-02` to have its own slice, so its roadmap now runs eight cycles before finalization instead of five. It was still advancing when the 15 s wait ended. The wait is scaled to the added work (24 s; test 40 s), not raised to absorb load.

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
- **Amended 2026-09-24 (operator decision, after R-I5):**
  - **The tests.** 51 unit tests need a Rust toolchain because they exercise the Cargo-specific runtime pinning and historical baselines that today's AQ/WI/EXO roadmaps use:
    - 7 in `packages/agents` (`pinned-cargo`, `historical-cargo`);
    - 44 execution cases marked `itNeedsCargo`.
  - **Why they stay.** They test features the live roadmaps rely on, so they stay until pinning is generic (program rule 2).
  - **Added to the Change.** When runtime pinning becomes pluggable, Cargo becomes one adapter. Its Cargo-dependent tests move into that adapter's own suite, and the generic controller and scope tests use a toolchain-free fake adapter. R-G4 does the same for verification receipts, which are Cargo-only today (AGT-08).
  - **Added to the done-when:** outside the Cargo adapter's suite, no unit test needs Cargo or rustc.

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

**Stop cold-building Rust on every step** · Phase P1 · Effort M · Status: partial (0fc17d2; live measurement after deploy)

- **Resolves:** [AGT-05](findings/AGT-GIT-SEC-agents-git-security.md#agt-05-per-run-cargo_target_dir-forces-a-cold-rust-build-on-every-step-768-gb-written-and-deleted-in-10-days)
- **Change:** Share a Cargo target directory per worktree (or per repository with a lock) across the steps of a cycle, with the ADR-039 cleanup applied when the worktree is merged/removed.
- **Done when:** Cache removal volume per day drops by an order of magnitude from the 768 GB/10-day baseline. *(Restated 2026-09-24, see below.)*
- **Progress (2026-09-24):**
  - **One Cargo target per worktree.** Each worktree gets one Cargo target directory, `<runs root>/worktree-caches/<worktree id>`, registered in `worktree_build_caches` (migration 0030) at the worktree's first launch. Every run in the worktree gets it as `CARGO_TARGET_DIR`, through the launch request's new `buildCacheDirectory`, so later steps build incrementally.
    - Cargo creates the directory on its first build, so worktrees that never build Rust leave nothing.
    - The brief now names the shared cache and asks agents to keep builds there instead of making their own. Eight of the 101 removed caches had been agent-made target directories.
    - Pinned-evidence and historical-baseline builds keep per-run targets, because their provenance is per run.
  - **Cleanup (ADR-039, amended).** The shared cache is removed on the storage worker's tick once the worktree is merged or removed and no run in it is live.
    - Removal is under the worktree mutation guard, with the registered path and device checked and links never followed.
    - It is audited as `storage.cleaned` with the worktree id. The Storage page's scan counts shared caches.
  - **Tests:** launch sharing and brief text (`server-execution-runs.test.ts`), cleanup only after merge and never through a link (`storage-management.test.ts`), both adapters' `CARGO_TARGET_DIR`.
  - **Measured on the 2026-09-23 snapshot's cleanup audit (2026-09-13 to 2026-09-23):**
    - 101 caches removed from 99 runs in 25 worktrees: 825.1 GB. The review's 768 GB figure predates the last day.
    - About four cold builds per worktree; the largest single removal was about 131 GB.
  - **Projection with one cache per worktree.** Removal volume is bounded by each worktree's largest cache: at most 219.3 GB over the same period, a 3.8× reduction. Build writes fall further, because later steps recompile only what changed.
  - **This does not reach the order-of-magnitude target by itself.** Sharing per repository would, but it serializes parallel worktrees on Cargo's lock and never lets the cache be removed. That choice is raised as an operator decision.
  - **Status:** partial until removal volume is re-measured on live data after deploy.
- **Amended 2026-09-24 (operator decision): keep one cache per worktree; restate the done-when.** No per-repository cache: it would serialize parallel worktrees on Cargo's lock and never free disk.
  - **New done-when:** after deploy, cache removal volume over a comparable ten-day window is re-measured against the 825 GB audit baseline (2026-09-13 to 2026-09-23), and the measured reduction is recorded here. The projection is at least 3.8×.
  - It is met by the measurement, whatever the figure. A per-repository cache is reconsidered only if the measured cut falls well short of the projection.
- **Amendment (2026-09-24 review):** the shared cache sits outside the worktree and the run directory. It was missing from the launch request's `additionalDirectories`, so Codex in workspace-write mode could not write to it, and every Codex Cargo build would have failed. It is now listed, and the launch test asserts it.

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
- **Amended 2026-09-24 (operator decision, after R-I3):**
  - **Already done by R-I3 (2531715).** The route-guard part of the Change and the whole done-when:
    - every API route declares its access, and the daemon refuses to start without it;
    - one guard applies the declared checks before input validation;
    - `route-access.test.ts` asserts 401, 403 and 404 for every route and role.
  - **Added to the Change.** The guard attaches the authenticated context to the request, handlers read it, and the roughly 108 per-handler `authenticate`/`authorizeMutation` calls are deleted. QA-03 recommended this, and no item held it. The sweep is the safety net.
  - **Restated done-when:**
    - login is rate-limited;
    - sessions expire when idle;
    - unrestricted runs and final promotion require step-up authentication;
    - repository registration is limited to the configured roots;
    - security headers and a Host check are sent;
    - credentials are not readable from agent-writable locations, and old database copies are retired;
    - no route handler calls `authenticate` or `authorizeMutation`, and the route sweep still passes.

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
- **Amended 2026-09-24 (R-H3):** Done-when verified. `pnpm db:verify` on a copy of the 2026-09-23 snapshot validates all 46,713 run events against the response contract. One is upcast: the missing billing, now handled in `packages/storage/src/records.ts`.

### R-H2

**Journal retention: stop storing raw vendor lines by default** · Phase P1 · Effort M · Status: partial (cae7827, d8cedea; live measurement after deploy)

- **Resolves:** [DATA-01](findings/DATA-storage-domain-contracts.md#data-01-agent_run_eventsraw_json-is-278-mb-of-never-read-data-that-is-also-shipped-to-the-browser), [DATA-02](findings/DATA-storage-domain-contracts.md#data-02-the-journal-can-never-be-pruned-growth-is-unbounded-and-every-byte-is-duplicated-about-8-by-backups), [AGT-03](findings/AGT-GIT-SEC-agents-git-security.md#agt-03-raw-vendor-lines-take-about-half-the-database-and-are-shipped-to-the-browser-which-never-reads-them), [HIST-11](findings/HIST-history-and-live-usage.md#hist-11-run-event-storage-is-dominated-by-duplicated-raw-vendor-json)
- **Change:** Store raw only when normalization fails (or for a bounded window); move large tool-result bodies to compressed per-run files with a digest and preview in SQLite; add an explicit, audited compaction command (the append-only trigger stays for normal writes) and a retention policy aligned with run-directory cleanup.
- **Done when:** DB growth per run drops by >50%; backups shrink accordingly.
- **Progress (2026-09-24), new writes:**
  - **Raw lines only when normalization fails.** Both adapters attach the bounded vendor line only to an event they cannot represent: an unparseable line, or an unknown message or item kind. Every normalized event carries its whole meaning in its payload. Codex no longer re-serializes each notification. The Claude adapter bounds a line only when it keeps it.
  - **Large tool-result bodies leave the journal.** A tool result over `TOOL_RESULT_PREVIEW_BYTES` (4 KiB) is journaled as a preview plus `body: { digest, bytes }`. The full output is gzipped under `<run directory>/tool-results/<sha256>.txt.gz`, written then renamed.
    - The agent can reach its run directory, so a body is checked against its digest when read, and the daemon refuses to write through a linked directory.
    - Without a registered run directory, or when the write fails, the whole output is journaled as before. The field is optional, so older events keep their full `content`.
  - **Reading a body.** `GET …/runs/:runId/tool-results/:digest` (member access) serves the body as plain text, with 404 once it has expired or no longer matches. The run page's tool result links to it as "Full output (N KB)".
  - **Retention.** Bodies expire with the run's scratch retention: `cleanupCandidates` offers `tool-results` as expired run files once the run is eligible and past `scratchRetentionDays`, and never through a link.
  - **Tests:** adapter tests (raw only on failures), server offload/route/tamper test, retention test, run-page link test.
  - **Remaining:** the audited compaction command for stored rows, and the before/after measurement.
- **Amended 2026-09-24: compaction and measurement (ADR-068).**
  - **Command.** `craftingtable db compact-journal [--apply [--vacuum]] [--bodies <dir>]` applies the new-write rules to ended runs. It is a dry run unless given `--apply`. It takes the data-directory lock, so the daemon must be stopped.
    - Each run is one transaction with a `storage.journal-compacted` audit record. The action is registered by migration 0028.
    - Bodies are written before the rows that point at them. A body whose run directory is gone stays in the journal.
    - The rows are rewritten through `AgentRunEventRepository.compact`. It lifts `agent_run_events_no_update` for its own statements, restores it byte-identical, verifies it, and passes every rewritten event through the R-H3 record guard. Normal writes never lift the trigger.
    - Tests: `journal-compaction.test.ts` (dry run, apply, audit, restored trigger, idempotence, missing run directory) and the CLI parser.
  - **Measured on a copy of the 2026-09-23 snapshot.** Bodies were written to a scratch directory with `--bodies`, never to the live run directories.

    | | Before | After |
    |---|---|---|
    | Journal bytes, 310 ended runs | 473.3 MB | 85.5 MB (−82%) |
    | Per run, median | 1.3 MB | 0.2 MB |
    | Per run, mean | 1.53 MB | 0.28 MB |
    | File size | 546.7 MB | 137.2 MB after VACUUM (−75%) |
    | Compressed bodies in run directories | — | 54 MB (8,602 files) |

    41,352 raw lines were dropped and 8,645 bodies moved; 2.7 MB of raw remains, on failure notices and the two live runs. The operation took 7.6 s.
  - **Checks on the compacted copy.**
    - `pnpm db:verify` passes (54,462 records).
    - `controller:replay --check` reports 51 decisions, 0 changed.
    - `--every-run --check` against the pre-change golden reports 278 decisions, 0 changed.
  - **Projection for the done-when.** New runs are journaled under these rules, so their bytes per run match the compacted figure: about −82% against the >50% target. Daily backups shrink with the file. The done-when counts growth per run on the live database, which can only be measured after the branch is deployed and runs accumulate. The status therefore stays partial until that measurement.
  - **Operator action.** Compact the live journal as documented in `docs/operations.md` ("Checking and compacting the database"). It was not run here.
- **Amendment (2026-09-24 review):**
  - **Dry run migrated the database.** The compaction command opened storage, which migrates the file and writes a pre-migration snapshot. It now refuses a database with pending migrations, dry run or not, and changes nothing (CLI test).
  - **Compacted bodies expired within a minute.** Body expiry checked only the run's `retainedSince`. So bodies that compaction wrote into runs already past retention would have been removed on the next maintenance tick, leaving only previews. Bodies now also wait out the scratch quiet period: they are kept until nothing in them has changed for a full retention window. For compacted history that means 30 days after compaction, then previews only. ADR-068 and `docs/operations.md` now say so, and the retention decision for the operator names this consequence.
  - **Body files were trusted.** A read followed links, blocked on a FIFO and decompressed without a bound. A file already at a digest's path was kept without being checked. Reads now open with `O_NOFOLLOW`, accept only regular files, cap at 8 MiB and treat any decode error as absent. Writes replace a file that does not hold the output (`tool-result-store.test.ts`).
- **Amended 2026-09-24 (operator decision): retention confirmed.**
  - Tool-result previews are 4 KiB.
  - Full bodies expire with the run's scratch retention: 30 days after the work merges, and not before 30 days pass without a change.
  - Raw lines on failure notices are kept indefinitely.
  - Compacting the live journal therefore keeps historical runs' full tool output for 30 days after compaction, then previews only. That is accepted.
  - The status stays partial until growth per run is measured after deploy.

### R-H3

**Read-side upcasters, write-side validation and db:verify** · Phase P1 · Effort M · Status: done (41a5a56, f63b908)

- **Resolves:** [DATA-03](findings/DATA-storage-domain-contracts.md#data-03-a-strict-response-schema-combined-with-no-read-side-upgrade-makes-the-first-runs-events-unreadable-live-bug-and-all-persisted-json-is-read-with-bare-casts), [DATA-10](findings/DATA-storage-domain-contracts.md#data-10-contracts-duplicate-domain-types-by-hand-with-no-compile-time-equivalence-check), [DATA-14](findings/DATA-storage-domain-contracts.md#data-14-table-rebuild-migrations-lack-preservation-tests-the-runners-fk-off-directive-contradicts-adr-002)
- **Change:** Upcast every JSON-bearing record at the storage read boundary to one current shape; validate with the contract schema at each aggregate's single save path; `pnpm db:verify <path>` validates every persisted aggregate and event against current contracts (run before deploying a contract change); compile-time equivalence checks between domain types and contract schemas; preservation tests for table-rebuild migrations.
- **Done when:** db:verify passes on a live snapshot and runs in CI against fixtures.
- **Progress (2026-09-24):**
  - **Record registry.** `packages/storage/src/records.ts` names 31 record kinds, one for each shape the storage boundary hands out: cycles, roadmaps, definitions, runs, worktrees, the three journals, evidence, imports, maps, plan versions and work items.
  - **Reads upcast.** Every repository mapper ends in `readRecord`, which applies the kind's upcasters. There are two:
    - `session-started` without billing, moved here from the event mapper;
    - `work-item-admitted` carrying the retired `workContractDraftId`, one live event. The contract no longer lists the field.
  - **Writes are guarded.** Storage must be opened with a `RecordGuard`, and every record write passes through it inside the write's transaction. The daemon (`openDaemonStorage`) checks each record against its contract schema (`apps/server/src/persisted-records.ts`), so an out-of-bounds record fails where it is written.
  - **New contract schemas.** Records with no wire schema got one in `packages/contracts/src/persisted-records.ts`: merge operations, run environments and builds, scope receipts, stored import attempts, map definitions and bindings, archive links, map adoptions, integration reuse, plan versions, work items, notification records and settings, storage settings, and stored runs and worktrees.
  - **Domain/contract equivalence.** Every kind's schema is pinned to the type storage reads with `equivalentSchema` (`type-equivalence.ts`). A missing, extra or differently typed field fails `pnpm typecheck` with a report of the drift. Pinning found and fixed:
    - branded IDs typed as plain strings in the runtime-evidence and map-amendment schemas;
    - `jsonValueSchema` typed `unknown`;
    - `RoadmapAttempt.dependencyRefresh.sourceRunId` typed as a plain string.
  - **`pnpm db:verify <path>`.** It copies the file with SQLite's backup API, migrates the copy and scans every record through the repositories' own mappers. It checks:
    - each record against its contract;
    - saved v0.3 map sources against the planning package's reviewed JSON Schema;
    - SQLite's quick check and foreign-key check, and that the retired registry tables are empty.

    It reports counts per kind, upcasts per upcaster, and violations grouped by field.
  - **Coverage is structural.** A storage test fails on any table that is neither a record source nor listed as relational with a reason. A second test fails on any `_json` column in a relational table.
  - **In `pnpm check`.** Every test daemon runs the verification on its database at cleanup, the same way the R-A3 typed-stop check runs. `db-verify.test.ts` covers the command on a real cycle's database: it passes, leaves the input byte-identical, and reports planted legacy and invalid rows. Four test fixtures that stored non-UUID ids were corrected.
  - **Table rebuilds.**
    - `migration-preservation.ts` compares a database image before and after a migration: rows in rowid order, values, indexes, triggers and sequences.
    - `migration-0014.test.ts` proves the unguarded 0014 rebuild on seeded schema-13 rows, and that the chain to schema 27 preserves them.
    - `migrations.test.ts` fails on a rebuild migration without a preservation test, and on one after schema 27 without a count guard.
    - ADR-002 is amended to document the `foreign_keys=off` directive.
  - **Snapshot result (copy of the 2026-09-23 snapshot, schema 26 to 27).** 54,152 records read in 3.7 s. Two upcasts, as above. One invalid record: agent run `73a606f5` has a 4,014-byte `outcomeSummary`, written before the byte bound. It is fixed in the next commit.
  - **Amended 2026-09-24: the invalid record is fixed. The done-when is met.**
    - **Upcaster.** Run `73a606f5`'s summary came from a build that bounded it in characters. A third upcaster now brings such summaries within the byte bound at the read boundary.
    - **Shared bound.** The bound is `OUTCOME_SUMMARY_LIMIT_BYTES` in the domain, next to `truncateUtf8Bytes` (moved from the server). The writer, the contract and the upcaster all use it.
    - **Route patch removed.** The run-summary route's re-bound only covered HTTP responses; handoffs and design recovery read the raw value.
    - **Snapshot result.** `pnpm db:verify` on a copy of the 2026-09-23 snapshot reads 54,152 records: 0 invalid, 0 unreadable, integrity ok. Three records were upcast, one per upcaster (billing, retired draft id, summary bound).
    - **Invalid records found:** 1, which was this summary.
  - **Known gap, recorded under R-F3.** The scope fixtures (`slicedFixture`, `supervisedMapFixture`; about 70 uses in 9 files) store hand-built v0.3 sources that the importer would reject, such as work item ids without a repository prefix. The write guard therefore leaves the format check to the importer, the only production writer of map definitions, and the test-cleanup verification skips it. `db:verify` applies it. **Closed 2026-09-25 (R-F3):** the fixtures pass the importer and test cleanup applies the format check.
- **Amendment (2026-09-24 review):** three gaps in the write guard.
  - **Upcasters hid writer defects.** Runs, worktrees, run events, workspace events, audit records, plan versions and work items are guarded on the record read back after the write. That read passes through the upcasters. So a writer that regressed to an upcast shape, such as an over-long run summary, would have passed the guard. The CHECK counts characters, so it would not catch it either. Read-backs now go through `readWritten`, which refuses any record an upcaster changes (`HistoricalRecordWriteError`). Journal compaction rewrites historical rows on purpose and keeps the plain read-back.
  - **Work-item status writes skipped the guard.** Admission, agenda removal and completion now read back and guard the item.
  - **Audit appends outside a transaction.** Storage cleanup appends audit records outside a transaction, so a refused record would have stayed committed. `audit.append` now runs in its own transaction, which is a savepoint inside a caller's.
  - Tests are in `records.test.ts`. The retired-draft upcaster now checks for the key rather than its truthiness.
- **Amended 2026-09-24 (operator decision): the guard stays fail-closed.** A record that breaks its contract, or that comes back from its own write in a historical shape, fails the write. There is no log-and-allow period.

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

### R-H6

**Journal cleanup: registry tables and `repository-*` vocabulary** · Phase P3 · Effort M · Status: open

- **Added 2026-09-24:** split from [R-B8](#r-b8) in the phase 1 review. The operator confirmed P3 the same day.
- **Resolves:** [DATA-09](findings/DATA-storage-domain-contracts.md#data-09-the-dead-ct-04a1a2-repository-inspector-and-registry-are-still-compiled-constructed-and-schema-resident) (the schema residue).
- **Why not in R-B8:** `workspace_events.repository_inspection_id` and `repository_binding_id` are foreign keys into `repository_inspections` and `project_repository_bindings`. With either parent table missing, SQLite rejects every insert into `workspace_events`, even when the keys are NULL (checked on a copy of the 2026-09-23 snapshot). The tables can only go when `workspace_events` is rebuilt without those columns, which is the operation ADR-013 took once and called the riskiest.
- **Change:**
  - Rebuild `workspace_events` with ADR-013's procedure, without the two correlation columns and their checks, and drop the three empty registry tables.
  - The kind and action catalogs are append-only by trigger, so the `repository-*` event kinds and `repository.*` audit actions stay registered. Remove them from the contracts, the web activity rendering and `domain/repository.ts` once `db:verify` shows that no stored row uses them. The 2026-09-23 snapshot has none.
  - Do this together with any other journal rebuild (for example R-H2's), so the risk is taken once.
- **Depends on:** R-H3 (table-rebuild preservation tests and `db:verify`).
- **Done when:** The three tables and the correlation columns are gone. A preservation test proves sequence, trigger and index continuity on a snapshot copy. `db:verify` passes on a live snapshot.

## Workstream I — Engineering hygiene (tests, docs, repository, deployment)

### R-I1

**Protect the work and stop repository bloat** · Phase P0 · Effort S · Status: partial (4952821, 44a64bd)

- **Resolves:** [REPO-02](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-02-42-commits-six-days-of-work-exist-only-on-the-local-disk), [REPO-01](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-01-walkthrough-pngs-make-up-99-of-the-repository-and-grow-about-155-mibday), [HIST-14](findings/HIST-history-and-live-usage.md#hist-14-ui-walkthrough-captures-are-committed-on-nearly-every-commit-since-09-16-15-gb-4986-pngs), [DOC-06](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-06-agentsmd-mandates-repository-bloating-captures)
- **Change:** OPERATOR ACTION: push or back up the 42 local-only commits. Stop committing walkthrough PNGs: captures go to a directory outside the repository (structural boundary) with a small committed text index per capture; change the AGENTS.md capture rule accordingly. Optionally (operator decision) strip the PNGs from history before the first push, which is the cheapest moment to do it.
- **Done when:** origin/main contains the work; new captures add no binaries to Git.
- **Progress:** Done 2026-09-23 at the operator's request: walkthrough PNGs stripped from history with git filter-repo (only the 42 local commits after origin/main were rewritten, so the push is a fast-forward); .git went from 1.1 GB to 5.7 MB. All 56 earlier captures were preserved in the external store; the harness now writes to $CRAFTINGTABLE_WALKTHROUGH_DIR (default $XDG_DATA_HOME/craftingtable-walkthrough) and appends a row to the committed docs/ui-walkthrough/INDEX.md. Remaining: the operator pushes to origin.

### R-I2

**Split the 14k-line execution test file** · Phase P1 · Effort M · Status: done (7bb4562, b0a0c0d, d08a143)

- **Resolves:** [QA-01](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-01-server-executiontestts-is-the-whole-critical-path-of-the-unit-suite-and-should-be-split-by-aggregate), [QA-02](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-02-orchestration-tests-poll-wall-clock-time-because-the-controller-has-no-deterministic-stepping-seam)
- **Change:** Split server-execution.test.ts by aggregate (runs, merge gate, cycles, roadmaps, finalization, execution scopes) so files run in parallel; use the R-B2 stepping seam to remove wall-clock polling.
- **Done when:** pnpm test under ~90 s (from 5 min 46 s).
- **Progress:** Split mechanically, one step. `server-execution.test.ts` (14,792 lines, 293 tests) is now 15 files by aggregate: runs, merge gate, cycles, cycle recovery, sequential and parallel roadmaps, integration resolution and delegation, finalization, staged finalization, execution scopes, scope evidence, supervised maps, plan evidence, scope verification, and reviews and decisions. Helpers used by more than one file are in `execution-test-support.ts`; helpers used by one file stay in it. Test bodies are unchanged, apart from `export` and rewrapped signatures, and all 293 tests remain; none were dropped as duplicates. Timings on a 16-core workstation with the live daemon running (load average 1–8):
  - Before: `pnpm test` 426 s. The execution file alone took 423 s; the next slowest file took 11 s.
  - After: 104 s. The slowest files are scope verification (101 s, 12 tests) and supervised maps (86 s).
  - Not yet under the ~90 s target. The remaining work is rebalancing the slow files and moving the controller-transition tests from wall-clock polling onto the R-B2 stepping seam.
- **Amended 2026-09-24: rebalanced.** Three groups moved to their own files, making 18: bounded scope recovery, delegated scope findings and supervised-map amendments. They were regenerated from the original file by the same mechanical split, so test bodies are unchanged. `pnpm test`: 89 s by Vitest's clock (about 92 s wall), still with no margin.
- **Amended 2026-09-24: stepping seam; done.**
  - **Stepping.** Every execution test daemon now starts with `workers: false`. The shared `waitFor` steps each open daemon until the predicate holds, using `stepDaemons()` in `execution-test-support.ts`. Each step quiesces runs, then ticks the roadmap scheduler, the cycle controller and notification delivery. It sleeps 10 ms between steps only for sessions that answer on a timer.
  - **Why stepping.** The free-running loops woke on every journaled write and re-inspected repositories each time; one amendment test made 844 Git calls.
  - **Opt-in `workers: true`.** Ten test cases (eight tests) race operator commands against a controller pass held inside a Git operation or a launch. The live loop is what they race, so they keep it. A stepped `tick()` would wait on the held operation and deadlock.
  - **Sleeps replaced.** Five fixed sleeps (100 ms to 2.5 s) let the loops run before asserting that nothing changed. They are now `stepDaemons(3)`, which provably runs the passes.
  - **Implicit pass made explicit.** One notification assertion relied on an implicit pass between HTTP calls; it now steps first.
  - **Timeout.** The node project's default test timeout is 15 s. `recovers parent review with durable guidance…` took 4.7 s against the 5 s default before this change, and it timed out once under load average 20. Several other tests take 4–5 s under load.
  - **Result.** `pnpm test`: 72, 74, 74, 71, 72 and 76 s in six readings. The live daemon and back-to-back runs loaded the machine (load average 6–20). The third reading, before the timeout change, failed only that test on the 5 s timeout. The fourth to sixth readings ran with the new timeout. All 1,341 tests passed in every reading except the third.
  - **CPU.** Total CPU is unchanged, about 940–970 s of user and system time. Most of it is real Git process spawns. The gain is no longer idling on loop timeouts and polls. The floor is about 60 s on 16 cores unless the controller makes fewer Git calls per pass (R-B5).

### R-I3

**Systematic authorization tests** · Phase P1 · Effort S-M · Status: done (2531715)

- **Resolves:** [QA-03](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-03-the-authorization-surface-has-no-systematic-tests-and-the-no-approve-route-test-checks-spelling), [SEC-05](findings/AGT-GIT-SEC-agents-git-security.md#sec-05-route-authorization-depends-on-every-handler-remembering-to-call-it)
- **Change:** A table-driven sweep over every route asserting unauthenticated, wrong-workspace and insufficient-role responses; replace the "no route contains approve" spelling test with a semantic one.
- **Done when:** Adding a route without an auth decision fails the sweep.
- **Progress:**
  - **Declarations.** All 123 API routes declare their access where they are registered (`config.access`, `routes/route-access.ts`): public 2, session 8, member 42, editor 61, owner 6, installation 7. `installation` covers storage and host scheduling, whose services also require the user to own every active workspace.
  - **Startup refusal.** An `onRoute` check refuses to start the daemon when a route has no declaration, when a workspace mutation admits viewers, when a mutation other than login is public, or when a workspace route declares a non-workspace access (or the reverse). A route added without an auth decision therefore fails at registration, in every test.
  - **One guard.** A `preHandler` runs the declared check before the handler validates input: authentication, CSRF and origin for mutations, then `requireRole` for workspace routes (it also records the denied-access audit), then installation ownership. Handlers and services keep their own checks.
  - **The sweep.** `route-access.test.ts` requests every route in the live table (the printed route tree, compared with the declarations) as each kind of caller. It expects:
    - no session: 401;
    - a mutation without CSRF, or from another origin: 403;
    - a non-member: 404;
    - each role below the declaration: 403;
    - the declared role: not refused.
  - **Spelling test replaced.** The "no route contains approve" test is gone. Its replacement is semantic: every approving, merging or deciding route is a declared editor or owner mutation, which the sweep exercises.
  - **Operator wait.** `GET …/operator-wait` has its own test: 401 without a session, 200 for a viewer, 404 for an outsider.
  - **What the probe found.** No route was unprotected: every non-public route already returned 401 without a session, and every mutation returned 403 without CSRF. But 57 workspace mutations validated the body before checking membership or role, so a non-member or a viewer got 400 with an invalid body. The guard now answers 404 or 403 first.
  - **Two behaviour changes.**
    - A non-owner member reading the audit log gets 403 instead of 404, matching `requireRole`'s documented posture (non-members 404, members 403). `server-reads.test.ts` is updated.
    - Denied reads by non-members are now always audited, including reads whose service used `findAuthorized` and did not record them.
- **Amendment (2026-09-24 review):** the guard ran as a `preHandler`, after Fastify had parsed the body.
  - An anonymous caller or a non-member who sent malformed JSON got a 500 instead of a 401 or 404. The daemon also buffered up to the route's body limit (2 MB on roadmaps) before refusing them.
  - The guard now runs in `preParsing`, after the cookie parser and before the body is read. JSON parse errors answer 400.
  - The sweep's outsider probes now send a body that is not JSON.
  - One change the batch did not list: `POST …/amendments/preview` is declared `editor`, so viewers now get 403 there, although `MapAmendmentService.preview` admits any member. Viewers cannot propose amendments either. R-G9 removes the per-handler checks, and the declaration then becomes the single rule.
  - **Verified.** `pnpm test` 1,345 → 1,344 tests (the spelling test removed, four sweep tests added); `pnpm test:e2e` 22 passed plus the walkthrough rehearsal. `docs/security.md` has a "Route access" section.

### R-I4

**Structural test/production and process-authority boundaries** · Phase P2 · Effort M · Status: open

- **Resolves:** [QA-04](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-04-checkscope-exemptions-are-filename-patterns-and-several-bypasses-are-open), [QA-07](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-07-the-testproduction-boundary-is-structural-only-in-packagesgit-everywhere-else-tests-and-test-support-compile-into-dist)
- **Change:** Move test-support and fixtures out of compiled src trees everywhere (as packages/git already does); make check:scope reject builtin-module access via computed import/getBuiltinModule and stop exempting files by name pattern.
- **Done when:** No *.test.js or test-support in dist; the known bypasses fail check:scope.

### R-I5

**E2E and fixture reliability** · Phase P1 · Effort S-M · Status: done (b966dd7, 8d59ce2, cc08352, 06fdf7c, b5da9a0, b63295d, e16001d)

- **Resolves:** [QA-05](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-05-e2e-gate-screenshots-are-unasserted-cause-the-known-flake-and-helpers-are-copied-into-8-specs), [QA-06](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-06-the-fixture-derives-expected-scope-evidence-from-the-production-resolver-tautological), [QA-08](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-08-unit-tests-depend-on-host-tool-paths-and-create-fixtures-inside-the-repository)
- **Change:** Assert or remove the unasserted gate screenshots (including the known amendment-panel flake); dedupe helpers copied into 8 specs; derive expected scope evidence independently of the production resolver; remove hard-coded host tool paths and in-repo temporary repositories.
- **Done when:** E2E passes 10 consecutive runs; unit tests pass on a host without ~/.cargo.
- **Amended 2026-09-24 (phase 1 review):**
  - **The problem.** The UI walkthrough was never part of the gate. Its seeding drives real controller flows, and it failed unnoticed from R-G3 until 2026-09-24: guidance became one-shot per step, and the walkthrough script still relied on the old behaviour.
  - **The fix.** `pnpm test:e2e` now rehearses the walkthrough (`CRAFTINGTABLE_WALKTHROUGH=rehearse`) in its own Playwright run on a fresh daemon. The rehearsal does the same seeding and navigation on both viewports, but takes no screenshots, writes no images and adds no INDEX row. It adds about 1.8 minutes to `pnpm check`.
  - **Why not something cheaper.** A page-visit smoke test would not have caught the R-G3 breakage, which was in the seeding flow.
  - **Capture.** `2026-09-24-p1-review-after` records the UI after the phase 1 review fixes.
- **Amended 2026-09-24: gate screenshots and copied helpers.**
  - **Screenshots.** The 35 unasserted gate screenshots are gone. The 14 full-page ones assert nothing and are removed. The 21 element screenshots also implied that the element was visible; they became `await expect(element).toBeVisible()`, which retries instead of failing when a panel re-renders. That was the package-imports amendment-panel flake ("Element is not attached to the DOM"). The 3 s roadmap poll that remounted the panel is already gone; panels refresh from workspace events, with a 15 s safety check. The walkthrough stays the only capture mechanism.
  - **Helpers.** `e2e/support.ts` now holds the admin sign-in (`submitSignIn`, `signIn`) and the fixture `git()` helper. They were copied into 10 specs (sign-in) and 5 specs (`git`). Each spec keeps its own wait after signing in.
  - **Verified.** `pnpm test:e2e`: 22 passed, plus the walkthrough rehearsal.
- **Amended 2026-09-24: host tools and in-repo fixtures (QA-08).**
  - **Host paths.** Tests no longer name `/usr/bin/git` or `~/.cargo/bin/cargo`. They resolve Git and Cargo the way the daemon does: on PATH, then rustup's default directory for Cargo. The server tests use the production `resolveExecutable` (`HOST_GIT`, `HOST_CARGO` in `execution-test-support.ts`); the agents package uses `host-tools-test-support.ts`.
  - **Cargo tests.** Tests that build real crates, or that exercise the pinned build path (which the daemon refuses without Cargo), run through `itNeedsCargo`, or `cargoIt` in the agents package. They run wherever Cargo is installed and are skipped elsewhere:
    - 7 in the agents package;
    - 44 cases across 29 declarations in the execution tests.
  - **Verified without Rust.** With PATH stripped of Cargo and HOME pointed at an empty directory, `pnpm test` gives 1,293 passed, 51 skipped, 0 failed. On this workstation it gives 1,344 passed, 0 skipped.
  - **In-repo fixtures.** The Git package's fixture root moved from the checkout to `os.tmpdir()`, and the obsolete `.gitignore` entry is removed.
  - **Leaked fixture.** `.ct04a-git-test-iJlU8M/`, from 2026-09-09, had been committed by accident in c0ccf3b and is removed. Its nested `.git` was broken, so `git log` inside it printed CraftingTable's own history. That is the hazard the finding describes.
- **Amended 2026-09-24: scope evidence written out (QA-06).**
  - **Literals.** `scopeReport`, which the scenario tests use to write a reviewer's scope evidence, no longer calls `resolveScope`, `scopeRequirements` or `scopeCases`; `execution-test-support.ts` no longer imports the resolver at all. Requirements come from a literal table keyed by scope kind and source (`SCOPE_REQUIREMENTS`). Case IDs are declared by each fixture from its own map (`expectScopeCases`):
    - `CASE-PARENT` for the sliced fixture's parent;
    - none for supervised maps;
    - `BASE-A` and `BASE-B` for the checkpoint fixture's slices.
  - **Agreement tests.** Two focused tests, one per fixture file, check that the resolver derives exactly those literals from the fixture maps. If the resolver drops or renames a requirement, those tests fail, and so does every scenario whose review evidence no longer matches.
  - **Left as they are.** The remaining `resolveScope` calls in scenario tests either build a resolved scope to set up a phase reservation, or assert on production output; neither is expected evidence.
  - **Verified.** 295 execution tests pass, including the two new ones.
- **Amended 2026-09-24: defect found by the e2e repetition.** Runs 3 and 4 of ten consecutive `pnpm test:e2e` runs failed in `package-imports.spec.ts`; the load average was 8–13, because unit suites were running at the same time.
  - **The defect.** One failure ("Supplied crates: aq_e2e_pin" never appeared after Inspect) is a product race. Saving plan bindings makes `RuntimeEvidencePanel` reload, and that reload replaced the whole setup form when it answered. When it answered after the operator's Inspect, the inspected dependency was discarded.
  - **The fix.** The panel's automation refresh already keeps an unsaved draft and replaces only the view under it; the explicit reload now does the same. A stale revision still fails the save through the existing optimistic check.
  - **Test.** A jsdom test holds the reload until after Inspect; it failed before the fix and passes after.
  - **Correction.** The Inspect failure was run 4, not run 3 as b5da9a0's message says.
  - **The other failure (run 3).** "Execution held:" did not appear within 5 s after "Propose and hold roadmap". The cause is not proven.
    - **A second window.** `MapAmendmentPanel` discarded refreshes that started before a command, but not ones that started while it ran. A jsdom test shows such a refresh, answering after the command, replacing the recorded proposal with the view from before it. The panel now also discards refreshes started during a command.
    - **Probably not the run 3 cause.** The server records the proposal and bumps the roadmap version in one transaction before notifying, so a refresh triggered by that bump reads the proposal. The likelier cause is that proposing pauses the affected cycles serially before it answers, which under load can take more than 5 s.
    - **The spec now waits for the proposal's answer**, as it already did for Inspect, and then expects the notice. A slow command and a UI that fails to show a recorded proposal are no longer the same failure.
- **Amended 2026-09-24: done.** Both done-when conditions hold:
  - **10 consecutive e2e runs pass.** At e16001d, `pnpm test:e2e` passed ten times in a row, from a separate worktree on an otherwise idle machine (load average 2.0–4.6, 238–258 s each). Every run was 22 tests plus the walkthrough rehearsal.
  - **Unit tests pass without Cargo.** With PATH stripped of Cargo and an empty HOME: 1,293 passed, 51 skipped, 0 failed.
  - **Under heavy load** (8–13, from concurrent suites), the earlier commit failed 2 of 5 runs, which led to the two fixes above.
  - **Not changed.** Specs still share one daemon and one admin account (QA-05's "give each spec its own workspace"). The ten runs show that this is not currently a source of flakes.

### R-I6

**Gate on lint** · Phase P1 · Effort S-M · Status: done (3ac6242, 1ff9785, a879d09, 1941a71)

- **Resolves:** [QA-09](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-09-lint-warnings-do-not-gate-the-build-and-666-have-accumulated)
- **Change:** Burn down the 666 Biome warnings (mostly mechanical) and make warnings fail pnpm check.
- **Done when:** pnpm check fails on a new warning.
- **Progress:**
  - **Measured 2026-09-24:** 671 warnings and 11 infos (666 at review). `noNonNullAssertion` accounts for 646 of them (448 in tests, 198 in production).
  - **Rule turned off.** `noNonNullAssertion` is off in `biome.jsonc`; the config file is renamed from `biome.json` so it can carry the one-line reason. With `strict` and `noUncheckedIndexedAccess`, `!` is how this codebase marks an invariant the compiler cannot prove: index access after a length check, or `Map.get` after `has`. Replacing each one with a runtime check would change behaviour, which is not a mechanical fix.
  - **Remaining:** 25 warnings and 11 infos.
- **Amended 2026-09-24: mechanical fixes.** Biome's own fixes, applied one rule at a time and reviewed:
  - `noUnusedImports`: 5.
  - `useImportType`: 1.
  - `useConst`: 1.
  - `useTemplate`: 9 infos.
  - Not applied: the two `useLiteralKeys` fixes. They would turn `service['deferredEntries']`, a test's deliberate reach into a private method, into a type error. They stay as infos, which do not gate.
  - **Remaining:** 18 warnings: 16 `useOptionalChain`, 1 `noBannedTypes`, 1 `noDescendingSpecificity`.
- **Amended 2026-09-24: optional chains.** The 16 `useOptionalChain` sites were reviewed one by one. Each tested value is an object or `undefined`, where `!x || x.p` and `x?.p` agree. Two exceptions:
  - Two `ancestor` checks cover `'' | false | GitResult`, where TypeScript refuses `?.`. They became `typeof ancestor !== 'object' || …`, which is equivalent, and the compiler confirms `null` is not possible.
  - `repo?.defaultBranch` differs from `repo && repo.defaultBranch` only for an empty repository id, which validation never admits.
- **Amended 2026-09-24: gated; done.**
  - `noBannedTypes`: `{}`, used as "no fields yet", is now `Record<string, never>`.
  - `noDescendingSpecificity`: the general `.section-body` rule moves above the two more specific `.section-body` rules. Specificity decides between them either way, so rendering is unchanged.
  - **The gate.** `pnpm lint` (part of `pnpm check`) now runs `biome lint --error-on-warnings`. The count is 0 warnings and 2 infos (the `useLiteralKeys` private reach above). Adding an unused import made the command exit 1.

### R-I7

**Documentation reset to current state** · Phase P1-P3 · Effort M · Status: open

- **Resolves:** [DOC-01](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-01-the-readme-is-a-feature-changelog-not-an-operator-guide), [DOC-02](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-02-adr-sprawl--65-records-broken-index-inconsistent-status-metadata-long-refinement-chains), [DOC-03](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-03-doc-claims-out-of-sync-with-code-spot-check-of-14-claims-7-false-or-stale), [DOC-05](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-05-principles-security-and-operations-docs-have-become-per-feature-narratives), [UI-15](findings/UI-information-architecture.md#ui-15-docsui-principlesmd-has-become-a-per-slice-accretion-log-that-encourages-new-surfaces), [SEC-09](findings/AGT-GIT-SEC-agents-git-security.md#sec-09-docssecuritymd-is-an-accreted-per-slice-log-with-stale-claims), [HIST-13](findings/HIST-history-and-live-usage.md#hist-13-schema-and-adr-churn-rate-22-migrations-46-adrs-in-18-days-with-manual-pre-migration-backups), [HIST-15](findings/HIST-history-and-live-usage.md#hist-15-commit-messages-stopped-describing-changes-adr-numbering-is-inconsistent), [DATA-15](findings/DATA-storage-domain-contracts.md#data-15-documentation-and-vocabulary-drift-adrs-process-authority-branded-ids-exports-plan-specific-literals), [AGT-17](findings/AGT-GIT-SEC-agents-git-security.md#agt-17-documentation-drift-in-the-agent-seam)
- **Change:** README becomes an operator guide (what it is, run it, the main workflow) instead of a feature changelog; architecture.md describes the current design, not schema history; one ADR naming scheme, a complete index and correct statuses, superseded chains marked; ui-principles split into visual language, IA rules ("decisions are made only in the inbox; other pages link"), glossary and short per-surface specs; security.md and operations.md rewritten as current state; commit messages carry a body saying what stop or need motivated the change.
- **Done when:** Spot-checked claims all true; README under ~150 lines.

### R-I8

**Deploy from a separate checkout; one daemon per data directory** · Phase P1 · Effort S-M · Status: done (943fb8d, 6729d6e; the operator deletes one remote branch)

- **Resolves:** [REPO-04](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-04-the-production-daemon-runs-from-the-development-checkout-and-its-build-output), [SEC-10](findings/AGT-GIT-SEC-agents-git-security.md#sec-10-the-daemon-runs-straight-from-the-editable-development-checkout), [REPO-03](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-03-legacy-process-directories-and-branches-are-still-at-top-level)
- **Change:** Run the daemon from a separate deploy checkout updated by an explicit `pnpm deploy:daemon <ref>` command (fetch the exact ref from the dev repo, install, build, restart the single systemd user unit, record the deployed commit; rollback = deploy the previous commit; add the R-B9 drain when it exists), so editing or running tsc in the dev checkout never changes what production loads. Take an exclusive lock on the data directory at daemon start, before migrations and restart recovery: today a stray second daemon on the same data directory (e.g. `pnpm start` in another checkout) would mark live runs interrupted and roadmaps needs-attention before failing to bind the port. `pnpm dev` defaults to its own port and data directory. Archive the CT-01..03 process directories and merged CT-era branches.
- **Done when:** A tsc -b in the dev checkout cannot affect the running daemon; a second daemon on the same data directory exits before touching the database (test); deploy and rollback are one command each.
- **Progress:** Deployed 2026-09-23: the daemon runs from $XDG_DATA_HOME/craftingtable-deploy/current (systemd drop-in deploy-checkout.conf) via `pnpm deploy:daemon <ref>` (release per commit, atomic switch, health check with automatic rollback, `--rollback`, `--status`, deploys.jsonl). The data-directory lock was verified against the live daemon: a second daemon exits naming the holder. `pnpm dev` / `pnpm craftingtable:dev` use their own data directory and port 4601. Remaining: archive the CT-01..03 process directories and merged CT-era branches. Deploys drain through R-B9 once a release containing it is running.
- **Amendment (2026-09-24 review):** the CT-01..03 process directories (`work-items/`, `implementation-reports/`, `review-findings/`) moved to `archive/CT-01..03/`. The AQ fixture's expectations moved to `fixtures/plan-bundles/`, and code comments now cite the archived CT-03 spec. Still remaining, as an operator action: delete the seven merged CT-era branches (`ct-02-persistent-daemon`, `ct-03-plan-dashboard`, `ct-04`, `ct-04a-git-foundation`, `ct-04a2a-repository-model`, `ct=04a2b1-repository-journal`, `ct-04a2b2a-repository-evidence-boundary`), locally and on `origin`. All seven are ancestors of `main`.
- **Amended 2026-09-24 (operator decision): the branches are deleted.** The operator approved deleting the seven merged CT-era branches. All seven are deleted locally, after checking that each is an ancestor of `main`. Of the seven, only `ct-04a-git-foundation` exists on `origin`, and it too is an ancestor of `main`. The agent's shell cannot push, so the operator deletes it: `git push origin --delete ct-04a-git-foundation`. With that, the item is done.

### R-I9

**Independent e2e specs: one workspace per spec** · Phase P2 · Effort S-M · Status: open

- **Added 2026-09-24** after R-I5 closed. It holds the part of QA-05 that R-I5 did not do; the operator agreed to proceed with it.
- **Resolves:** [QA-05](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-05-e2e-gate-screenshots-are-unasserted-cause-the-known-flake-and-helpers-are-copied-into-8-specs) (the rest: "give each spec its own workspace so specs are independent").
- **Why:** All specs share one daemon, one admin account and the default workspace. R-I5's ten consecutive passes show this is not a current source of flakes. But specs can see each other's roadmaps, runs and notifications, which is why Playwright is held to `workers: 2` with `fullyParallel: false`, and the gate takes about 4 minutes.
- **Change:**
  - `e2e/support.ts` gains a helper that creates a workspace for the calling spec (`POST /api/workspaces`) and opens it. Specs use it instead of waiting on "Default workspace".
  - Once specs are independent, raise the Playwright worker count.
  - Storage and host scheduling are installation-wide, so the specs that change them stay serialized.
  - The walkthrough keeps its own daemon.
- **Done when:** Every gate spec runs in its own workspace; the gate runs with more than 2 workers; `pnpm test:e2e` passes 10 consecutive runs.

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
| [AGT-60](findings/AGT-GIT-SEC-agents-git-security.md#agt-60-quota-and-session-limit-failures-with-a-known-reset-time-always-need-the-operator) | medium | CONFIRMED | M | [R-C8](#r-c8), [R-C9](#r-c9) | Quota and session-limit failures with a known reset time always need the operator |
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
| [DATA-09](findings/DATA-storage-domain-contracts.md#data-09-the-dead-ct-04a1a2-repository-inspector-and-registry-are-still-compiled-constructed-and-schema-resident) | medium | CONFIRMED; remedy amended 2026-09-24 |  | [R-B8](#r-b8), [R-H6](#r-h6) | The dead CT-04A1/A2 repository inspector and registry are still compiled, constructed and schema-resident |
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
| [QA-05](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-05-e2e-gate-screenshots-are-unasserted-cause-the-known-flake-and-helpers-are-copied-into-8-specs) | medium | CONFIRMED | S | [R-I5](#r-i5), [R-I9](#r-i9) | E2E gate screenshots are unasserted, cause the known flake, and helpers are copied into 8 specs |
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

**Finding-index amendments (2026-09-24, phase 1 review).**
- **DATA-09.** Its remedy, dropping the three empty registry tables in a forward migration, is infeasible. `workspace_events` has foreign keys into them, and SQLite rejects inserts into it once they are missing. The finding stands. The code and configuration part is resolved by R-B8. The schema part needs a journal rebuild and moved to R-H6.
- **AGT-60.** The finding stands. R-C8 covers failures that are safe to retry, but the recorded incident was not safe to retry, so the rest is R-C9.
