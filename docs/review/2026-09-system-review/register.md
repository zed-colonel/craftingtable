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
| [R-A4](#r-a4) | P2 | M-L | done (16d94de, see review) | Durable attention items, delivery log, quiescence and presence |
| [R-A5](#r-a5) | P2 | L | done (a4635c7, see review) | One "Needs you" inbox that every surface reads |
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
| [R-B10](#r-b10) | P1 | S-M | done (0e4eb04, adeb4cf, f32b407, 6ea1fae, 2bd6e40) | Retire legacy finalization for new starts (split from R-B8, 2026-09-24) |
| **C** | | | | **Operator-wait reduction (the vision: minimum operator input)** |
| [R-C1](#r-c1) | P1 | S-M | done (7689200, ca489a9) | Measure operator-wait as a first-class metric |
| [R-C2](#r-c2) | P1 | S-M | done (f049b3a, 2d24969) | Re-prompt the agent automatically on output-format validation failures |
| [R-C3](#r-c3) | P2 | M (split: a S, b M-L) | R-C3a done; R-C3b preparation works live, done-when not yet met (2026-09-29, see entry) | Design stage: continue automatically and batch real decisions ahead of time |
| [R-C4](#r-c4) | P2 | M | done (see Progress) | Refresh and re-review automatically when only upstream integration advanced |
| [R-C5](#r-c5) | P2 | M | done (2026-09-28, see entry) | Converge the parent/slice repair loop |
| [R-C6](#r-c6) | P3 | M | open | Reduce the evidence-acceptance ceremony |
| [R-C7](#r-c7) | P3 | M | open | Revisit verification layering and finalization stops |
| [R-C8](#r-c8) | P1 | S | done (5744289, 4abfec2) | Schedule automatic retry for quota/session limits with a known reset time |
| [R-C9](#r-c9) | P2 | S-M | done (see Progress) | End the session on a terminal quota error so the reset wait applies (added 2026-09-24) |
| [R-C10](#r-c10) | P2 | S-M | done (see entry) | Re-verify a roadmap item whose evidence is no longer current, without stopping the roadmap (added 2026-09-25) |
| [R-C11](#r-c11) | P2 | S-M | done (see Progress) | Classify a provider-side credential rejection as its own stop, with a bounded scheduled retry (added 2026-09-25) |
| [R-C12](#r-c12) | P2 | S-M | done (2026-09-27) | Automatic recovery records why it did not start a round (added 2026-09-27) |
| [R-C13](#r-c13) | P2 | S-M | done (2026-09-27) | Checkpoint readiness agrees with what the attestation needs; no resume that repeats a failed attestation (added 2026-09-27) |
| [R-C14](#r-c14) | P2 | S-M | done (2026-09-28) | Attention says only what needs the operator now, and what the operator can act on (added 2026-09-28) |
| [R-C15](#r-c15) | P2 | S | done (2026-09-28) | A checkpoint review is given the decisions its checkpoint requires (added 2026-09-28) |
| **D** | | | | **Read side and browser performance (pain point 3)** |
| [R-D1](#r-d1) | P0 | S-M | done (67e2e9b) | Cheap server-side read fixes |
| [R-D2](#r-d2) | P0 | S-M | done, partial on "done when" (67e2e9b) | Cheap browser refresh fixes |
| [R-D3](#r-d3) | P0 | S | partial (67e2e9b) | Instrument read cost and event-loop delay |
| [R-D4](#r-d4) | P2 | M-L | open | Keyed query store and App.tsx split |
| [R-D5](#r-d5) | P2 | M-L | open | Server view models, compression and git-fact caching |
| [R-D6](#r-d6) | P4 | L | open | Shared projections keyed by write generation (only if still needed) |
| **E** | | | | **Progress view and navigation (pain points 2 and 1)** |
| [R-E1](#r-e1) | P2 | M | done (a07dbfe, 4102517) | Real routes and one Link component |
| [R-E2](#r-e2) | P2 | M | partial (3feb310; setup and map pages still long, see entry) | Split the Roadmaps mega-page |
| [R-E3](#r-e3) | P2 (a) / P3 (b) | split: a S-M, b L | R-E3a done (2026-09-27); R-E3b open | Roadmap status list now (a); the board and graph later (b) (split 2026-09-27) |
| [R-E4](#r-e4) | P3 | M | open | Work-item and run pages become drill-downs |
| [R-E5](#r-e5) | P3 | M | open | Consolidate settings and agent selection |
| [R-E6](#r-e6) | P1 | M | done (4c77665, a7d1b19) | Operator vocabulary and copy |
| **F** | | | | **Plan and roadmap formats (ground truth; Studio readiness)** |
| [R-F1](#r-f1) | P1/P4 | S then L | partial (52c5c8b) | One compiled map model and one requirement evaluator |
| [R-F2](#r-f2) | P3 | M | open | Typed feature recognition instead of prose and magic identifiers |
| [R-F3](#r-f3) | P0/P1 | S-M | partial (7d44b42, 0ef1c95; FMT-15 done in 432bb00, 0ef20b1) | Format ingestion bugs and test honesty |
| [R-F4](#r-f4) | P0 | S | partial (9b4be64) | Commit the format specification and golden conformance tests |
| [R-F5](#r-f5) | P4 | M | open | Backward-compatible format additions before the Studio |
| [R-F6](#r-f6) | P5 | L | open | The Studio format family (first step of the Development Studio) |
| [R-F7](#r-f7) | P2 | M | done (2713a6a to 9c1904c; live 2026-09-29, see entry) | Map-declared upstream pin transitions for each consumer link (added 2026-09-25) |
| **G** | | | | **Agent execution integrity and security** |
| [R-G1](#r-g1) | P0 | S-M | done (3e34531, c57c51a) | Execution safety fixes that can lose or corrupt work |
| [R-G2](#r-g2) | P0 | S | done (d0f66ef) | Make automatic provider retry actually fire |
| [R-G3](#r-g3) | P0 | S-M | done (8c92c57) | Scope operator guidance to the step it was given for |
| [R-G4](#r-g4) | P2 | M-L | done (95c4a17 to 6bb668a, see review) | Daemon-owned verification receipts |
| [R-G5](#r-g5) | P2 | M | done (7b5751a to 29d3524, see review) | Agent environment and configuration isolation |
| [R-G6](#r-g6) | P2 | M | open | Redesign briefs around the task |
| [R-G7](#r-g7) | P1 | M | partial (0fc17d2; live measurement after deploy) | Stop cold-building Rust on every step |
| [R-G8](#r-g8) | P5 | M-L | open | Backend capability model and persistent-agent seam |
| [R-G9](#r-g9) | P2 | M | open | Authentication and authorization hardening |
| [R-G10](#r-g10) | P3 | M | open | Git adapter robustness and structure |
| [R-G11](#r-g11) | P3 | S-M | open | Supervisor loose ends |
| [R-G12](#r-g12) | P5 | L | open | (Future) agent runs that outlive the daemon |
| [R-G13](#r-g13) | P2 | M | partial (increment 1, 2026-09-29; increments 2 to 5 open) | Declared per-repository checks |
| [R-G14](#r-g14) | P3 | S-M | open | Operator-configured outside sources for agent sandboxes |
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
| [R-I7](#r-i7) | P1-P3 | M | partial (P1 start: e317636, 61e41cb) | Documentation reset to current state |
| [R-I8](#r-i8) | P1 | S-M | partial (943fb8d) | Deploy from a separate checkout; one daemon per data directory |
| [R-I9](#r-i9) | P2 | S-M | in progress (code 2026-09-29; 10-run check) | Independent e2e specs: one workspace per spec (added 2026-09-24) |
| [R-I10](#r-i10) | P2 | M | done (2026-09-27) | Live plan data as the test corpus: record live stops, replay scheduler decisions (added 2026-09-27) |
| [R-I11](#r-i11) | P2 | S | done (2026-09-27, see entry) | Independent review of the live-run fixes made on `main` (added 2026-09-27) |

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

**Durable attention items, delivery log, quiescence and presence** · Phase P2 · Effort M-L · Status: done (16d94de, see review)

- **Resolves:** [NOTIF-04](findings/NOTIF-attention-notifications.md#notif-04-no-operator-presence-awareness--pushes-arrive-while-the-operator-is-using-the-ui), [NOTIF-07](findings/NOTIF-attention-notifications.md#notif-07-notification-occurrence-history-is-overwritten-journals-carry-no-identity), [NOTIF-08](findings/NOTIF-attention-notifications.md#notif-08-the-attention-projection-is-heavy-and-runs-inside-an-immediate-write-transaction-many-times-per-tick), [NOTIF-09](findings/NOTIF-attention-notifications.md#notif-09-attention-has-no-single-source-of-truth-there-is-no-operator-inbox), [NOTIF-12](findings/NOTIF-attention-notifications.md#notif-12-reminder-content-is-frozen-and-often-misdirects-reminders-dominate-volume), [HIST-02](findings/HIST-history-and-live-usage.md#hist-02-wall-clock-throughput-is-dominated-by-waiting-for-the-operator-not-by-agent-work-or-controller-latency)
- **Change:** Persist attention as occurrence rows (`attention_items`: subject, owner, code, openedAt, settledAt, resolvedAt, resolvedBy) plus an append-only `notification_deliveries` log. Eligibility for a push = operator-owned AND settled AND every controller worker has completed a pass that began after the item opened AND the operator is not present (open SSE stream or recent command). Reminders render text from the current item; due reminders coalesce into a digest. The projection is maintained transactionally, so the per-tick whole-workspace re-derivation inside an IMMEDIATE transaction disappears.
- **Done when:** False alarms are directly measurable (resolvedBy=automation AND deliveredCount>0) and a test asserts 0 for the recorded live sequences; notification history is never overwritten; the notification tick does no filesystem or map evaluation.
- **Progress 2026-09-25: done** (ADR-070, schema 32).
  - **Items.** `attention_items` holds one row per occurrence of an operator-owned stop (`packages/domain/src/attention-item.ts`). The storage reports every write to `AttentionProjector` (`services/attention-projector.ts`), which re-derives only the affected worktree, roadmap or finalization before the transaction commits. The roadmap scheduler syncs the map-derived sets after each pass (`RoadmapService.syncAttention`), and the storage monitor syncs capacity alerts on a 30 s timer. `RoadmapService.attentionAlerts` and the notification service's own derivation are gone.
  - **History.** Resolved items are immutable and deletes are refused (triggers). An item records `resolvedBy`: `operator` (a command was recorded in the workspace after it opened), `automation` or `superseded`. A reopen within ten minutes is a new row that `continues` the old one's reminder schedule. `notification_deliveries` is append-only and records every attempt, including tests.
  - **Gates.** A first push waits for the 30 s settle, for every running controller worker (cycles, roadmaps) to complete a pass that began after the item opened (`ControllerPasses`, at most 2 minutes), and for a 5-minute grace while the operator watches (an open event stream, `OperatorPresence`) or issued a command in the last 5 minutes (the audit log). Reminders wait while commands are recent.
  - **Digest.** All items due in one wake go out as one push, rendered from the items' current text.
  - **Codes for the stops R-A3 left uncoded:** `merge-recovery-required`, `merge-cleanup-failed`, `finalization-cleanup-blocked`, `amendment-decision`, `dependency-refresh-resume`, `manual-run-failed`, `manual-run-interrupted`, `manual-review-mergeable`, `manual-review-needs-attention`, `manual-design-questions`, `decision-preparation-questions`, `verification-setup`, `checkpoint-evidence`, `storage-pressure`, `storage-maintenance-failed`. A failed baseline preparation stays on its cycle's stop. A paused cycle or roadmap is the operator's own hold and opens no item.
  - **Done-when:**
    - *False alarms measurable, 0 for the recorded sequences:* `AttentionRepository.falseAlarms` (resolved by automation and listed in an accepted delivery). `notifications.test.ts` replays NOTIF-01's EXO-02 false alarm (188747f3), the 10dbc912 near miss, the same shape with the takeover after the settle window, and NOTIF-03's baseline double page (ac9b0f0f) with the default gates, and asserts no push and `falseAlarms() = []`. A positive control shows a pushed stop resolved by automation is counted and one resolved after an operator command is not.
    - *History never overwritten:* the storage triggers, tested against a raw connection.
    - *No filesystem or map evaluation in the tick:* `NotificationService` takes storage narrowed to notifications, attention, audit, events, workspaces, users and installation ownership; a test runs a full delivery through a proxy that throws on any other repository.
  - **Found on live data and fixed.** A `.backup` copy of the live database (2026-09-25 17:27 local) projects 4 items in 20 ms, and `db:verify` passes. The old notifier had dropped the WI-02/domain `service-failure-not-retryable` stop, one of the 2026-09-25 stops, because it filtered out completed work items before looking at the cycle; a stopped cycle is now an item whatever its item's status. Decision-preparation runs were labelled "Finalization" and linked to a broken work-item path; they are now `decision-preparation-questions` on the roadmap page. Both have regression tests.
  - **Regression tests fail without their fix:** the quiescence gate (recorded sequences and the per-worker test), presence, the history triggers, the narrowed storage, and the two live-data fixes, each checked by reverting only that fix.
  - **Replays** on a copy of the 2026-09-23 snapshot: every-run 278 and current-run 51 decisions, 0 changed.
  - **Trade-offs recorded in ADR-070.** `resolvedBy = operator` means any command in the workspace after the item opened, so the metric counts only stops nobody touched. Reminders never fire while the operator keeps issuing commands; an open browser tab only delays first pushes by the grace. Pre-schema-32 outbox rows are folded into the matching items at the first tick, so a deploy does not re-page.
- **Independent review of 16d94de (2026-09-25).** Nine findings; all were confirmed and fixed, each with a test that fails without its fix.
  - **HIGH: one long agent message with emoji could stop every write in the daemon.** Item and delivery text was bounded in code points, but the contracts count UTF-16 units. A cycle reason with 30 emoji and 3,900 other characters made its item too long; the guard threw inside the writer's transaction, the unit stayed dirty, every later transaction failed, and the boot rebuild would fail too. An accepted push whose delivery row failed kept its lease and was re-sent every minute.
    - Fixes: text is bounded in UTF-16 units without splitting surrogate pairs (`truncateUtf16`); each unit is projected in its own savepoint, so a unit that fails is reported once and retried by later writes but never fails the writer; the delivery row is logged in its own savepoint after an accepted send.
  - **MEDIUM: a stop that resolved while its push was in flight, then reopened within ten minutes, paged again.** A new occurrence now takes "already sent" from the delivery log, not only from the resolved item.
  - **MEDIUM: a set that gained a member paged at once, past the presence and quiescence gates.** The item now records when its paging restarted (`delivery.since`), and the gates measure from there.
  - **MEDIUM: pre-schema-32 outbox rows were folded before the items they belong to existed**, so storage, hold and checkpoint alerts would have paged again after a deploy. The projector now folds a row when the item for its subject first opens; rows that no item takes over are resolved ten minutes after boot.
  - **LOW:** the in-memory quiescence marks now change only when their transaction commits; a cycle item that opens or resolves through a worktree or merge write re-derives its roadmap's own stop in the same commit; a roadmap stop or entry hold replaced by its cycle's item resolves as `superseded`, not `automation`, and the hold no longer shares a digest with the cycle item; storage items of an archived workspace resolve; merge items carry the worktree's active cycle, so a command in flight holds them too; a controller pass that throws still counts as completed.
  - **Checked and found sound by the reviewer:** nested transactions and rollback re-marking, no cross-scope unique conflicts, all writes reach the observer, `resolvedBy` timing, `ControllerPasses`, leases and backoff, the replacement for `attentionAlerts`.
  - **Live copy after the fixes** (18:00 local): 5 items in 36 ms, `db:verify` passes, including the EXO-04 merge approval that appeared since the first check.
- **Second independent review (2026-09-27, the P2 review with R-I11), against the live fixes merged in f471830:**
  - *HIGH, fixed in 49686f6 (R-C5):* an operator-requested or adopted round's repair opened an operator `merge-approval` item that the roadmap then merged itself: a measured false alarm, and a push once 18f0bb8's checkpoint-review wait passed the settle window. The claim now follows the roadmap's own rule.
  - *LOW-MEDIUM, open:* every merge opens `merge-recovery-required` while its reservation is in flight and resolves it by automation about 30 ms later. That costs two `attention-changed` events and one permanent history row per merge. A push would need a reservation held past the settle and quiescence window (about 2.5 minutes), and merges are Git-only. Fixing it needs the projector to see in-process merges *and* a re-derive when a failed merge keeps its reservation; without the second part a stranded reservation could go unannounced, which is worse. Left for the attention follow-up with R-E3a.
  - *LOW, accepted:* an entry hold released by a command on a running roadmap resolves at the next pass's `syncAttention`, so the inbox can be one pass stale.
  - *Checked and sound:* schema 32 only adds tables, indexes, triggers and one event kind, touches no existing rows, and moves forward only. 18f0bb8's writes all go through observed repositories, with no raw SQL. `resolvedBy` is right for command-created rounds (`operator`) and adoption (`system`). Spot-checked regression tests fail without their fixes: the completed-item filter, the quiescence gate and inbox-host's subject rule.

### R-A5

**One "Needs you" inbox that every surface reads** · Phase P2 · Effort L · Status: done (a4635c7, see review)

- **Resolves:** [UI-01](findings/UI-information-architecture.md#ui-01-there-is-no-single-needs-the-operator-model-the-dashboard-misses-most-roadmap-level-decisions), [UI-03](findings/UI-information-architecture.md#ui-03-the-same-decision-concept-is-surfaced-in-several-places-with-different-names-and-forms), [UI-04](findings/UI-information-architecture.md#ui-04-shared-architecture-decisions-are-buried-inside-dependency-environments-and-evidence), [UI-08](findings/UI-information-architecture.md#ui-08-dead-ends-blockers-that-tell-the-operator-to-go-elsewhere-without-a-link-generic-landing-pages-and-deep-links-that-silently-do-nothing), [NOTIF-09](findings/NOTIF-attention-notifications.md#notif-09-attention-has-no-single-source-of-truth-there-is-no-operator-inbox)
- **Change:** Serve the attention items at GET /workspaces/:ws/attention with an attention-changed event. Build /inbox (list, sorted by downstream items blocked then age) and /inbox/:id (detail). First mount the existing decision/recovery forms inside the detail unchanged; replace AttentionStrip, the rail count, RoadmapAttention and the roadmap tone logic with the attention feed; point notification deep links at inbox items. Architecture decisions, plan acceptance, verification-environment approval, map adoption, amendments, dependency refresh and restart resume all appear as inbox items. Moved from R-A3: render each attention and blocker code's destination as a link in the UI, then remove the navigation prose ("Open Dependency environments and evidence → …") from daemon messages.
- **Done when:** For any seeded walkthrough state, the dashboard/rail count, the inbox, and the push log list the same items; every inbox item has a working action; every notification path opens /inbox/:id.
- **Progress 2026-09-25: done.**
  - **Feed.** `GET /api/workspaces/:id/attention` serves the open attention items (R-A4), most blocking first, then oldest (`AttentionService`). "Blocks" counts the dependent plan items still open for a work item's stop, the unfinished entries for a roadmap's own stop, and the map milestones waiting on a checkpoint. Viewers see the feed; host alerts (storage) only the installation owner. An `attention-changed` event with the open count replaces the `notifications-changed` "attention" journal entry.
  - **Inbox.** `/workspaces/:id/inbox` lists the items; `/inbox/:itemId` shows the stop, what waits on it, and hosts the existing controls unchanged (`lib/inbox-host.ts` decides which from the code and refs): the work item's cycle panel (resume, guidance, provider, design and scope-review recovery), its delegation panel (merge form, runs), the plan's finalization panel, the storage settings, or the roadmap's own controls (`RoadmapsPage` in a single-roadmap mode, open for roadmap stops, shared decisions and undeclared upstream transitions, and scrolled to a held entry's Re-verify).
  - **Every surface reads it.** The rail has a **Needs you** link with the count (the Dashboard link no longer counts cycles); the dashboard's first section and the strip on every other page list the items; each roadmap lists its own and takes its attention tone from them. `AttentionStrip`, `attentionCycles` and `RoadmapAttention` are deleted.
  - **Pushes open the inbox:** one item opens `/inbox/:itemId`, a digest opens `/inbox`; the Settings push log links there too.
  - **The 2026-09-25 stops**, each with its resolving controls (`inbox-host.test.ts`, and the server feed test): `shared-decision-required` and `upstream-transition-undeclared` (the cycle's resume plus the roadmap's decision and upstream-transition controls), `service-failure-not-retryable` and `service-retries-exhausted` (the cycle panel's provider recovery and resume), `work-item-questions`, `scope-review-open-questions` and `scope-review-recovery` (guidance and scope-review recovery), and a held entry with stale evidence, now its own code `evidence-not-current` with the `reverify` action (the roadmap's Re-verify control, brought into view).
  - **More stops as items:** each map checkpoint ready for acceptance is its own item, `architecture-decision`, `plan-acceptance` or `checkpoint-evidence` by the checkpoint's kind (they were one set before); verification setup, amendments, dependency refresh and restart resume were already items (R-A4).
  - **Navigation prose removed** from daemon messages: the native-environment blocker, the resource-without-adapter blocker, the ambiguous finding owner, and the stale-evidence hold ("Use Re-verify on this item…"). The inbox renders the destination.
  - **Done-when:**
    - *Same items everywhere:* the walkthrough checks, at two seeded states (one merge approval; a running roadmap), that the rail count, the inbox rows, the dashboard's Needs you section and the push log's open records agree. They all read the same feed, and the push log reads the same rows.
    - *Every inbox item has a working action:* `inbox-host.ts` maps every code to existing controls, tested for each 2026-09-25 stop. The walkthrough answers the implementation questions from the inbox item itself and shows the merge form on the merge-approval item.
    - *Every notification path opens the inbox:* single-item pushes open `/inbox/:itemId`, digests `/inbox` (the list); server tests assert the links.
  - **Walkthroughs:** `2026-09-26-inbox-before` and `2026-09-26-inbox-after` (three new captures: the inbox, an item with its cycle controls, the inbox with a roadmap running).
  - **Checks:** replays on a copy of the 2026-09-23 snapshot report 0 changed (278 every-run, 51 current-run); the stale-evidence hold code and the blocker texts are not part of step decisions. `pnpm check` passes: 187 test files and 1,455 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check.
  - **Not done here, with reasons:**
    - A running roadmap held because a checkpoint needs a map or decision adoption is not an item: the map evaluation reports those blockers as text, and branching on it would break program rule 4. It needs typed map blockers (R-F1/R-F2).
    - The hosted controls are the old panels, so a roadmap item shows the whole roadmap card. R-A6 replaces them with one component per kind.
    - In-app links outside the inbox still reload the page (R-E1).
- **Independent review of a4635c7 (2026-09-25).** Nine findings; all fixed except where noted, each with a test that fails without its fix.
  - **HIGH: the stale-evidence item opened the completed cycle instead of Re-verify.** A held entry names its attempt's cycle, so the host chose the cycle panel and left the roadmap collapsed. The host now follows the item's subject: a roadmap's own stop or held entry is resolved on the roadmap, with the entry's Re-verify brought into view; only a cycle's stop hosts the cycle. The host test now uses the refs the daemon actually serves.
  - **HIGH: an item could show another slice's cycle.** The cycle panel fell back to the first worktree needing attention. The inbox now selects the item's own worktree, and each item's host is keyed by the item.
  - **MEDIUM: `record-scope-evidence` had no working control in the inbox**; the work item's execution slices (where evidence is recorded) are now hosted for it.
  - **MEDIUM: Edit queued entries inside the inbox disabled the roadmap controls** (the editor lives only on the Roadmaps page); it is hidden there.
  - **MEDIUM: removing the navigation prose left blockers without a destination.** Phase blockers shown on the work item now carry a link from their code (`lib/blocker-destinations.ts`): verification environments and reviewer responsibilities to the roadmap page, decision evidence and amendments to Needs you. Map-node blockers in the cross-project panel are still plain text without codes (R-F1/R-F2).
  - **MEDIUM: entries blocked only by setup lost their roadmap-level listing.** The setup item now covers every entry whose blockers are all reviewer or environment setup, as the deleted panel listed them. Not restored: the restart note that plan acceptance does not resume scheduling (the item's own label says "Resume after restart"), and paused entries (the operator's own holds, deliberately not items).
  - **LOW-MEDIUM: splitting checkpoint sets would re-page and count a false alarm on deploy.** The old set item is superseded and hands its push schedule to the per-checkpoint items.
  - **LOW:** "blocks" counts only required successors and never the item itself, and a checkpoint that blocks nothing reports 0; in-place refreshes (text, counts, members) now emit `attention-changed`; a failed feed load shows a warning instead of an empty inbox; the activity line no longer shows a count that could disagree with the rail; resolved push-log rows link to their subject. Not changed: `attention-changed` shares schema 32 with R-A4, which was never deployed, so there is no rollback to guard.
  - **Walkthrough:** the agreement check now compares item titles between the inbox, the dashboard section and the push log, not only counts.
- **Second independent review (2026-09-27):** no new R-A5 defect. An operator round's repair stop is a `cycle:` item and gets the cycle panel. The one wrong control, a merge form for a merge the roadmap performs itself, came from the attention claim, fixed in 49686f6. The stranded-round and refused-request stops of 18f0bb8 now keep a typed hold, which the inbox shows (31afe57, c5d4078).

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
- **LIVE-18, 2026-09-29 (operator decision: option B).** A shared-decision stop names every decision the slice's merge still needs, has a card with Prepare decision brief for each, links to them, and offers only the action that can progress while any is unsettled. Nothing persisted changes. The operator chose B over A (the same without the typed action) and C (park at the merge gate, which changes persisted status and controller behaviour).
  - **Increment 1 (server): done.**
    - The workflow gate's stop now lists every unsettled merge decision in its reason and `workflow.questions`, rather than the first. Its refs still name the first.
    - `unsettledMergeDecisions` (`workflow-policy.ts`) uses the merge gate's rule: settled means accepted in full on the binding, or by an approved clause-level decision naming this slice. `unsettledDecisionsAt` returns them only for a cycle at this stop, including a pause taken there.
    - Plain and guided resume are refused with the remaining list while any is unsettled (`assertDecisionsSettled`). A roadmap resume skips the cycle (`resumable`), so a sequential roadmap's resume no longer fails on it.
    - Tests (`server-execution-shared-decision-stop.test.ts`): a parallel cross-project roadmap stops once naming both of two decisions; plain and guided resumes get 409 naming both; a roadmap pause and resume launches nothing; one approval leaves the other named; after both, resume is accepted. A sequential slice roadmap, where the reviewer raised the stop, resumes past the paused stop without failing. Mutations: naming only the first, dropping the guard, and dropping the roadmap skip each fail a test.
    - Replay case: on a copy of the 2026-09-29 snapshot, EXO-18/instance-design's cycle 2c9ead5d has EXO-ADR-022, 030, 037 and 038 unsettled, so a resume is refused naming all four.
  - **Increment 2 (cards): done.** A decision that a slice is stopped on now has a card in Shared architecture decisions even before any brief or proposal exists, with "Needed now by <slices>" (`stoppedSlices`, a computed field on the inbox view, never stored). A card with no brief offers Prepare decision brief on a roadmap's page: one click prepares it with the roadmap's preparation profile for that decision (the existing `prepare-decision` command and its checks); the roadmap's preparation panel still chooses other agents and limits.
    - Tests: the server test now requires a card for both decisions, with the stopped slice and no recommendation, before any preparation (it got none); `SharedDecisionInbox.test.tsx` shows the card, its "Needed now by", and a Prepare that posts the decision's own profile. Mutations: the old "no brief, no card" rule, and a card without the action, each fail.
  - **Increment 3 (the link): done.** The stop's inbox item opens the owning roadmap's setup at the decision cards (`…/roadmaps/<id>/setup#runtime-evidence-roadmap-<id>-decisions`), and inside the inbox the roadmap's controls open there too. The cycle's question links already went there (R-E2). Tests: the server test pins the item's path (it opened the work item before); `inbox-host.test.ts` the focus.
  - **Increment 4 (the typed action): done.** Cycles as read carry `unsettledDecisions`, computed from the same rule as the refusal, never stored (an optional read-projection field on the wire). While it is non-empty, `cycleActions` offers `open-shared-decisions` and Stop instead of Resume, paused or not, and the cycle panel shows "Open shared decisions (N)" linked to the cards, with no Resume and no guidance form. Once every decision is settled, Resume is offered again, and one resume runs one review. Tests: `cycle-actions.test.ts`, the cycle panel in `execution-views.test.tsx`, and the server test (the list carries both decisions, and none once both are approved); each failed before its change.
  - **Done when (restated from the design):** a shared-decision stop names every unsettled merge decision of its slice; its inbox item and cycle panel link to them; each has a card with Prepare decision brief, brief or not; plain, guided and roadmap resumes are refused or skipped until each is settled; replays report 0 changed. Met on `remediation/p2`, not deployed.
  - **Independent review of f4a238c, e687e6a and d08b7c7 (2026-09-29, isolated worktree).** The reviewer ran probe tests, mutations and the three 2026-09-29 replays (365/416/65, 0 changed). Every finding below has a test that fails without its fix.
    - *HIGH, fixed:* a new deadlock. A decision whose prerequisite is a checkpoint only this slice's own review produces cannot be approved, and the guard refused every resume until it was, leaving only Stop. `unsettledMergeDecisions` now leaves out a decision whose pending prerequisite (a typed `checkpointId` gap) is one of this slice's own unaccepted merge checkpoints; the stop still names it. Test: a decision that requires a profile checkpoint which requires another decision resumes once the first is approved.
    - *MEDIUM, fixed:* EXO-ADR-037's card read "Accepted" from EXO-03/domain's clause approval, and hid "Needed now by" and Prepare. A card that slices are stopped on is settled only by a record covering each of them, in full or by name.
    - *MEDIUM, fixed:* Prepare decision brief sent the roadmap version read when its card loaded; after another card prepared, every retry failed until a reload. It reads the version when clicked, and reloads after a failure.
    - *MEDIUM, fixed:* for a roadmap that is not cross-project, the link went to a setup page with no decision cards. A single-project roadmap whose slices come from one map revision now shows that map's dependency and decision panel on its setup; otherwise the stop links to the map's page.
    - *MEDIUM, fixed:* once decisions were settled, a stop the reviewer raised still has open questions, so a plain resume is refused, and a sequential roadmap's resume failed again. The roadmap now skips any cycle whose plain resume would be refused for open questions (`resumeNeedsGuidance`, shared with the refusal); the cycle panel already offers Continue with guidance there.
    - *LOW, fixed:* `unsettledDecisionsAt` returns none when the scope no longer resolves, rather than failing every reader of the list; the helper's comment no longer claims it cannot disagree with the merge gate (the gate also checks start requirements and staged prerequisites).
    - *LOW, fixed:* Prepare was hidden whenever a recommendation existed, including a reviewer's question with no brief; it shows whenever there is no brief. Tests now cover the in-flight state, and the inbox-host assertion for undeclared transitions is exact again.
    - *LOW, disposition:* a cycle on an older binding revision is not shown on the current revision's cards, and its approvals would go to the current revision. Stop is its exit, as for any attempt on a superseded binding.
    - *NIT, disposition:* the one-click brief uses the roadmap's default preparation time (30 minutes); the preparation panel still sets other limits.


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
- **Added 2026-09-25 (operator decision): first step.** Before changing any controller code, re-record the `--every-run` replay baseline from the current head. Use a copy of the 2026-09-23 snapshot, and keep the result beside it in `$XDG_DATA_HOME/craftingtable-review/replay/2026-09-23/`. The saved `every-run-golden-5e0c638.json` predates R-B10's deletion and differs from the current controller by 109 explained decisions: 81 differ only in shape, and 28 are the retired legacy cycle. Checking against it would hide real changes. This applies to R-B5 and R-B7 too, whichever starts first.

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

**Retire legacy finalization for new starts** · Phase P1 · Effort S-M · Status: done (6ea1fae, 2bd6e40)

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
  - **Legacy tests moved to stages (adeb4cf).**
    - `finalizationFixture` starts staged finalizations by default; the old settings remain as `legacyInput`.
    - Every legacy test asserts the same behaviour on stages: questions, exhausted remediation, integration drift, preparation recovery, integration holds, finding compaction, report retries, bounded authorization with replay refusal, CSRF and authority, recovery agent selection, completion and branch cleanup, incomplete reviews, interrupted continuations. A new test runs all five stages clean to exact-commit promotion.
    - Legacy-only behaviour (improvement rounds and `polishPhase`, `defer-nits`) is in `server-execution-finalization-legacy.test.ts`, which is deleted with the legacy branches.
    - Where staged differs by design, the tests assert the staged behaviour: a reopened correctness finding returns to the correctness stage, a staged report retry never reuses verification, and a finding focus ends with its stage.
  - **Defect found by the migration (adeb4cf).** A staged review with no structured report stopped for the operator at once, while legacy reviews got R-C2's two format repairs. `decideStepOutcome` now repairs it under `finalization-report-rejected`. The staged invalid-report test gets 0 repairs without the fix and 2 with it. This changes controller decisions for staged cycles only. On the 2026-09-23 snapshot copy, `controller:replay --check` reports 51 decisions, 0 changed, and `--every-run --check` against the 5e0c638 baseline reports 278 decisions, 0 changed.
  - **Deviation: the register update follows in a separate commit.** adeb4cf was cherry-picked from a delegated worktree that had no register access. Rewriting it would rewrite history.
  - **Review 2026-09-25 (independent reviewer; no correctness or safety defects):**
    - **The legacy record test now goes through the real read path.** It seeds the 2026-09-13 records into a test daemon and reads them back through `GET …/finalizations`, which runs `FinalizationService.view()`. Before, both tests parsed the schema directly, so a `view()` helper that failed on a stage-less record would have gone unnoticed.
    - **The focused-attempts test checks the focus again.** The selected finding must be the cycle's `findingFocus` while its stage implements it.
    - **Table row.** `step-outcome.test.ts` has a row for a staged review with no structured report: repair, not a stop. It fails on the code before adeb4cf.
    - A redundant ternary is removed. Not changed: the web test does not click Start, because the e2e spec covers the whole start flow.
  - **Operator decision 2026-09-25: the deletion gate is a dev-daemon run.** No plan was ready to finalize live. The operator chose a staged finalization run end to end with real agents on an isolated scratch daemon (its own data directory and port), then the deletion.
  - **Gate run (scratch daemon, Claude Sonnet 5, a one-item plan implemented on its integration branch):**
    - All five stages completed, followed by the operator-approved promotion; `main` advanced to the reviewed candidate and the exit-gate obligation is `met`.
    - The run exercised the automatic report repair, one operator batch selection (a polish nit kept as follow-up), and the final review.
    - A first attempt had given reviewers `edit-only` permission, so they could not run the required check. The controller stopped on that question instead of approving, which is correct. The attempt was stopped and restarted with `auto` reviewers.
  - **Deleted (this commit):**
    - the round-based transitions in `step-outcome.ts` (the `assess` and `polish` phases, `finalizationRounds` on approval, the `reviewChanges` field);
    - round advancement and the round start in `WorkCycleService` (`startFinalization` now requires stages);
    - `defer-nits` (command, contract action, web option, and the completion check's deferred-nit exemption);
    - the legacy parts of `finalizationInstructions` and `finalizationProfile`;
    - the legacy-only test file.
  - **What remains, and why.** The contracts keep `rounds`, `polishPhase`, `polishRound` and `deferredNits` so the completed 2026-09-13 record reads. Staged cycles also set `polishPhase` to `verify` and `final-review`, which the merge gate reads.
  - **New refusals, with tests (`legacy-finalization-record.test.ts`):**
    - A start must carry stages; a start with `rounds` gets a 400.
    - An open stage-less finalization cannot resume, remediate or take stage decisions; Stop, promotion and cleanup remain. The controller stops its cycle with the new code `legacy-finalization-retired`.
    - Both tests fail without the change. ADR-038 is amended.
  - **Replay on a copy of the 2026-09-23 snapshot.** `--check`: 51 decisions, 0 changed. `--every-run --check` against the 5e0c638 baseline: 278 decisions, 109 changed, all explained:
    - 81 differ only in shape: `finalize-implementation` no longer carries the always-empty `reviewChanges: {}`, so behaviour is identical.
    - 28 are every run of cycle `caf76f40`, the completed 2026-09-13 legacy finalization. They now classify as `legacy-finalization-retired`, as intended.
    - No other cycle's decision changed.
  - **Done-when:** met. A new finalization cannot choose legacy rounds (UI and API); the completed record renders; the legacy controller branches are gone; walkthroughs are recorded; `pnpm check` is green.
  - **Review 2026-09-25 (independent reviewer; no defect on any staged path):**
    - **Two more ways to relaunch a run on an open stage-less cycle.** The generic cycle control (`POST /cycles/:id/control`, resume and service retry), and service retries or continuations the controller decides before its legacy check. A run launched that way would have had an empty finalization brief and the reviewer's profile. Both are closed: `WorkCycleService.control` refuses resume and retry-provider, and `AgentRunService.startForCycle` refuses any finalization run without stages. Tests cover the route and the direct launch, and fail without the guards.
    - The "only Stop" wording is corrected (promotion and cleanup still apply).
    - Leftovers removed: a stale test header, a dead stand-in branch, and the `polishRound: 0` write on staged starts. The unused `_context` parameter of `evaluateCycleCompletion` stays, documented, so seven callers keep their signature.

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

**Design stage: continue automatically and batch real decisions ahead of time** · Phase P2 · Effort M (larger: split into R-C3a, S, and R-C3b, M-L) · Status: R-C3a done; R-C3b code done and preparing live since 2026-09-29, done-when not yet met

- **Resolves:** [HIST-03](findings/HIST-history-and-live-usage.md#hist-03-ranked-operator-intervention-causes-the-highest-leverage-automation-fixes), [HIST-19](findings/HIST-history-and-live-usage.md#hist-19-real-cross-project-workload-is-10-the-scale-the-uis-lists-were-designed-for-progress-and-dependencies-are-hard-to-see)
- **Change:** When a design investigation finishes and every question has a cited answer with no operator-classified decision left, continue without a stop. Build the per-roadmap decision queue before dependent slices start (extend ADR-065 decision preparation) so shared architecture decisions are answered once, in a batch, in the inbox.
- **Done when:** On the cross-project roadmap, design stops per started slice fall well below the 10-of-11 baseline; decisions show "unblocks N slices".
- **Scoping 2026-09-25 (larger than M; split with the operator's approval the same day):**
  - **Live data** (read-only): 12 cross-project slices have started, and 10 hit at least one design stop across 15 distinct runs:
    - `design-decision-required`: 5
    - `design-investigation-finished`: 5
    - `design-open-questions`: 4
    - `design-report-invalid`: 1 (now parsed as a decision, after R-C2)
  - **What each part removes:**
    - The 5 investigations each still had ADR or administrative questions, so auto-continue alone (R-C3a) removes none of the historical stops. It pays off once decisions exist before designs run.
    - Deciding shared ADRs ahead of time (R-C3b) would remove up to 11 of the 15. WI-ADR-016 alone was asked for in 4 stops across 3 slices.
    - The other 4 stops are administrative or evidence questions (branch protection, benchmarks, CI runners, the AQ pin), which belong with R-C1 and controller obligations.
  - **The split, decided by the operator:** do R-C3a now and defer R-C3b. R-C3b changes ADR-065's boundaries, so its grant design is the operator's to decide:
    - preparation runs start from a standing, revocable grant instead of a per-run command;
    - they run while the roadmap runs;
    - `prepareDecision`'s check binds to the map, binding revision and digest rather than the roadmap version.
- **R-C3a, done 2026-09-25** (ADR-059 amended): an operator-started investigation whose design classification is complete and all `resolved` (answers with cited sources, Open questions `none`) now continues the design automatically, once.
  - The run is the same one Resolve design questions would start: the investigation's evidence, the operator's guidance and attachments, the design agent and an ordinary deadline, recorded as `designRecovery.automatic`. It is judged as an ordinary design.
  - Anything else still stops as `design-investigation-finished`: an unclassified report, an empty classification, an operator decision or planning conflict, or listed open questions.
  - The investigation brief, the Resolve design questions hint and the recovery reason now say so. The UI change is text only, so no walkthrough captures were needed.
  - **Tests:** decision-table cases and an end-to-end cycle (investigate, then an automatic continue on the design agent, then implementation). Both fail without the change.
  - **Replays:** 278 and 51 decisions, 0 changed. The one recorded investigation (run 117cd918) still stops: it left an operator decision.
  - **Gate:** `pnpm check` stages all pass: 187 test files and 1,487 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check. Under load average 20, 10 controller tests timed out in waitFor; the 6 files passed rerun serially.
- **Independent review of bf329f6 (2026-09-25), and what changed:** no loop, and eligibility is stricter than an ordinary design advance. The launch goes through the cycle creator's authority.
  - *MEDIUM, fixed:* the automatic continue inherited the investigation's service-retry state, so it got a "service retry" brief, a smaller retry budget and the investigation's agent for retries. It is now a new step: service retry, output repair and step guidance are cleared. `recoverDesign` had the same gap for a stop reached after a retry, and is fixed too.
  - *MEDIUM, fixed:* an investigation could label as `resolved` a decision that the stop it came from had left to the operator. Nothing then asked the operator, which conflicts with ADR-059. If the source stop named an operator decision or planning conflict, the investigation now always stops. This also covers the "Clarify checkpoint" flow, whose source is a decision stop.
  - *LOW, fixed:* a failure while preparing the continue (for example an unavailable design backend) became a generic controller error. It now falls back to the investigation stop, with the reason, and the backend is checked first.
  - *LOW, accepted:*
    - `designRecovery.automatic` is recorded but not yet shown; the audit entry is a system `design-continue`.
    - After an automatic continue, the Resolve panel defaults to the design agent.
    - Replay covers only one recorded investigation (117cd918), because older investigation runs replay as ordinary designs.
  - Regression tests (the source-decision rule, a service retry inside the investigation, and the unavailable-backend fallback) each fail without the fix. Replays: 278 and 51, 0 changed.
  - Gate: `pnpm check` stages all pass: 187 test files and 1,494 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check. One scope-recovery test timed out in waitFor under load; its file and the other scope suites passed rerun serially.
- **Second independent review of R-C3a (2026-09-27):** no defects. The automatic continue cannot fire twice: it needs `designRecovery.mode === 'investigate'` for the finished run, `continueDesign` persists `mode: 'continue'` through the version-checked write, and a restart after it resumes rather than continues again. *LOW, accepted:* the test named "continues the design once" does not assert the absence of a second continue. All three R-C3a cycle tests fail with the condition disabled.
- **R-C3b (in progress):** prepare the roadmap's shared architecture decisions before the slices that need them start, so they are answered once, in a batch; count "unblocks N slices" as slices, not graph nodes; and add batch approval (still operator-only and paused). It needs an ADR-065 amendment for the grant. The done-when metric belongs to R-C3b.
- **R-C3b design, decided by the operator 2026-09-28 (option A, a standing grant).** Options put to the operator: (A) a standing, revocable per-roadmap grant under which the controller prepares needed decisions while the roadmap runs; (B) one batch command, no grant; (C) no grant change, only slice counts and batch approval. Every option keeps approval operator-only and paused, and preparation runs read-only. The operator chose A, in five steps:
  1. the preparation check binds to the map, binding revision and digest, not the roadmap version; preparation may run while the roadmap runs; a live preparation no longer blocks approval;
  2. the grant: a persisted roadmap field, a route and an audit record, revoked when an amendment applies;
  3. the scheduler prepares, under the grant, each unaccepted supported decision an unfinished selected slice needs, most slices unblocked first, within a concurrency bound;
  4. "unblocks N" on decision items counts slices;
  5. batch approval.
  - **Limit found in the design:** an accepted decision reaches a slice's design only if the slice's map requirements reference it, directly or as a prerequisite of a checkpoint it needs. So "up to 11 of 15 stops" is an upper bound: WI-ADR-016 was asked about by slices that do not reference it.
- **R-C3b step 1, done 2026-09-28** (ADR-065 amended):
  - `prepareDecision` accepts a running roadmap. It checks the preparation's own record, its exact map binding and digest, and its deadline instead of the roadmap version, which every pass changes. The manual form no longer locks while the roadmap runs.
  - Approval still needs a paused roadmap with no live work on the map, but a live preparation run no longer counts (it only proposes; a proposal is checked against its binding when saved, and the operator reviews its text). The shared decision inbox shows the same rule.
  - **Tests:** `server-execution-decision-preparation.test.ts`: a preparation started on a running roadmap survives a roadmap write during its launch; one decision is approved while another is being prepared. `DecisionPreparationPanel.test.tsx`: the form is usable on a running or paused roadmap and locked on a stopped one. Each fails without its change.
- **R-C3b step 2, done 2026-09-28: the standing grant** (ADR-065 amended; operator decision 2026-09-28: a new persisted roadmap field).
  - `Roadmap.decisionPreparationGrant`: enabled, minutes per preparation (5 to 60) and preparations at once (1 to 3), with who granted it and when. Each run uses its owning entry's investigation profile, as the manual form's default does.
  - `POST …/roadmaps/:id/decision-preparation-grant` (editor). Like recovery delegation, it is refused unless the roadmap is draft, paused or needs attention, or while an amendment is pending. It is audited as `configure-decision-preparation`, and an applied amendment revokes it.
  - The decision preparation panel shows the grant's state and saves it while paused.
  - Nothing acts on the grant yet; step 3 does.
  - **Tests:** `server-execution-decision-preparation.test.ts` (refused to a non-editor, while running and out of range; saved, audited and revoked by the operator; revoked by an applied amendment) and `DecisionPreparationPanel.test.tsx` (saved while paused, shown and locked while running). Each fails without the change.
- **R-C3b step 3, done 2026-09-28: the scheduler prepares under the grant** (ADR-065 amended).
  - Each pass of a running roadmap with an enabled grant starts, as the grantor, preparations for the decisions `neededDecisions` lists (`services/decision-demand.ts`): supported architecture decisions that are selected, not yet accepted, and waited on by at least one unfinished selected slice, those that unblock the most slices first.
  - At most the granted number are in flight. A decision is prepared once per binding revision and digest, and a failed one waits for the operator's retry. Launches stop once the grant is revoked or the grantor loses an editor role.
  - `prepareDecision` and the scheduler share one launch path. Its reservation re-checks, after the branch lookup, that no preparation of the checkpoint is already in flight, which closes a window where two requests could both start one.
  - **Tests:** `server-execution-decision-preparation.test.ts`. With no grant, nothing is prepared. Under a grant with a bound of one, LOCAL-ADR-01 (both slices wait on it) is prepared first and alone while its run works, then LOCAL-ADR-02, and neither again. Nothing is proposed or approved by itself. A decision accepted by hand is skipped, and a revoked grant prepares nothing. Removing the bound, reversing the order or preparing again each fails the test.
- **R-C3b step 4, done 2026-09-28: "unblocks N" counts slices.** A checkpoint item's `blocks` was the number of unfinished map milestones waiting on it (three per slice, plus work items and checkpoints). It is now the number of distinct unfinished, selected slices that wait on it, directly or through other milestones (`slicesWaitingOn`, shared with step 3's ordering). The inbox's "unblocks N" and its ordering read it.
  - **Tests:** `decision-demand.test.ts` (distinct slices, not milestones; finished and unselected slices excluded) and `server-execution-decision-preparation.test.ts` (LOCAL-ADR-01 unblocks 2 slices, LOCAL-ADR-02 one; it counted 8 milestones before).
  - **Test fix:** two step 1 tests waited for a held launch with the stepping `waitFor`, whose step waits for launches to settle; under load that could fail as "Agent runs did not become quiet". They now poll without stepping.
  - **Replays:** 0 changed on all four snapshots (none projects a checkpoint item).
- **R-C3b step 5, done 2026-09-28: batch approval** (ADR-065 amended).
  - With two or more saved proposals awaiting approval, the shared decision inbox lists them together. The operator ticks each as reviewed and writes one rationale; each is then approved through the same `decide` command and checks as a single approval, in turn, stopping at the first refusal and saying which were approved. The batch is locked while scheduling runs, like single approval.
  - **Tests:** `SharedDecisionInbox.test.tsx` (two proposals approved with one rationale, each ticked; locked while scheduling runs). Both fail without the change.
- **Independent review of R-C3b (2026-09-28).** An adversarial reviewer in an isolated worktree checked that the grant and the scheduler reach only the read-only preparation path, re-ran the tests with mutations, and replayed the 2026-09-28b snapshot (0 changed; it has no grant). No HIGH finding; nothing lets the grant start work, approve a decision or act for a viewer.
  - *MEDIUM, fixed:* a busy repository (a slice merge holding it) or a draining daemon during a standing launch was recorded as the preparation's failure, and a failed preparation is never prepared again automatically, so the decision that unblocks most could stay unprepared with nothing in the inbox. Before anything is created, such an error now drops the reservation and ends the pass; the next pass resumes in order. Test: a busy first worktree creation, then LOCAL-ADR-01 prepared on a later pass with no failed record.
  - *MEDIUM, fixed:* a decision whose launch failed before its reservation (its owner's branch gone, say) took the only slot every pass, was retried every pass and starved the others. It now gives its slot to the next decision and waits ten minutes before a retry. Test: LOCAL-ADR-01 cannot be reserved; LOCAL-ADR-02 is prepared, and LOCAL-ADR-01 is tried once over three more passes.
  - *LOW, fixed:* `advance` re-read the roadmap after the new await without re-checking it, so a sequential roadmap paused during a preparation launch could still be written by the pass. It now returns unless the roadmap is still running, uncontrolled and has no pending amendment. Fixed by reading; the timing needs a pause mid-launch.
  - *LOW, fixed:* the launch check re-derived a grantor but did not require the one the preparation acts as, so a re-grant by another editor during a launch passed. It now requires the same user.
  - *MEDIUM (test gap), closed:* nothing tested that batch approval sends only the proposals ticked as reviewed: approving every saved proposal passed all tests. `SharedDecisionInbox.test.tsx` now ticks two of three, lists none with issues, and stops at a refusal saying what it approved; approving the unticked one fails it.
  - *LOW-MEDIUM (test gaps), closed:* two step 3 claims had no test. A decision accepted with no preparation on the binding (as from a design stop's proposal) is now skipped by test, which fails without `neededDecisions`'s accepted filter. A grant naming a non-member prepares nothing, and a launch whose grant is revoked mid-flight ends without a recommendation; removing either check fails the test. (A launch refused by its own last check ends its run as failed rather than recording a failure on the preparation, as the manual path always has.)
  - *LOW, fixed:* a standing preparation was audited as a system action by the user running the roadmap, not the grantor. The `prepare-decision` audit entry now names who prepared it (`preparedByUserId`), and the test checks it. `docs/security.md` gains a "Decision preparation" section covering the grant and the controller path.
  - *LOW, fixed (rollback note):* a release before ec35ead cannot read a roadmap carrying `decisionPreparationGrant` (the strict schema refuses unknown fields), even a disabled one. Rolling back past it needs the field removed from the stored roadmap; turning the grant off is not enough.
  - *NIT, fixed:* the ADR, code comments and this entry said a proposal is checked against the decisions current when saved. It is checked against its binding; the operator's review of its text is what catches a stale recommendation.
  - *NIT, fixed:* batch approval showed only the proposal text; it now shows full or limited coverage too. The full decision stays on each card.
  - *NIT, fixed:* the panel's grant form kept its first values, so after an amendment revoked the grant it could still show it on and re-enable it by saving. It now follows the saved grant (test fails without it).
  - *LOW, disposition:* a manual form opened before an amendment is accepted while the roadmap runs, since a running roadmap's version changes every pass. The preparation still binds to the current binding and only proposes; the operator sees the checkpoint they chose.
  - *LOW, disposition:* a standing preparation stays live up to its time limit (5 to 60 minutes), and changing delegation waits for live runs, so a pause to change delegation can wait for it. Revoke the grant or choose a short limit; the wait is bounded.
  - *NIT, disposition:* two roadmaps on one map, both granted, could each prepare the same checkpoint. Both only propose; one grant per map is the expected use.
- **R-C3b status (2026-09-28):** code complete (steps 1 to 5 and the review fixes). The done-when is a live measurement: on the cross-project roadmap, design stops per started slice well below the 10-of-11 baseline, with standing preparation granted. Measure it a few days after the deploy. Decision items already show "unblocks N" as slices.
- **Live measurement, first attempt (2026-09-28c snapshot, three hours after the c547ede deploy):** nothing to measure yet. No slice started after the deploy; the running cycles were reviews already under way. No standing preparation grant is set on roadmap b81d5f92. Measure again once slices start with the grant enabled.
- **LIVE-16 fixed (2026-09-28, operator request): a decision preparation takes no slice capacity, and its worktree goes once its decision is accepted.**
  - **Capacity.** The roadmap's capacity check skips the worktrees of decision preparations. They are read-only and never merge.
  - **Cleanup.** Each pass removes the worktree of a preparation whose run has ended and whose decision is accepted on its binding. It is audited as the system's `worktree.remove` with the reason `decision-accepted` (`ExecutionService.releaseDecisionWorktree`). A worktree with a live run or with changes is left alone.
    - The brief stays on the run.
    - A preparation still open for the operator keeps its worktree, and with it its questions item.
    - After a deploy, the two stale WorldInterface worktrees are removed on the roadmap's first pass.
  - **Shared check.** The projector and the scheduler share `preparedDecisionAccepted`.
  - **Test:** `server-execution-decision-preparation.test.ts` (LIVE-16). Two preparations finish and one is accepted. With the cleanup held back, the unblocked slice starts and no entry is capacity-blocked; then the accepted preparation's worktree is removed and the open one kept.
  - **Mutations:** without the capacity change, no slice starts. Without the cleanup, the worktree stays.
  - **Replays**, against the current goldens:
    - 2026-09-23 and 2026-09-28b: 0 changed. 2026-09-28: 0 changed, because the roadmap was paused at that snapshot.
    - **2026-09-27: 10 changed, all intended.** Five WorldInterface slices, entry and status records, now wait on "All 4 in-flight slots are occupied" instead of repository capacity.
    - **2026-09-28c: 13 changed, all intended.**
      - WI-03/integration and WI-04/integration now start, and their status becomes `queued`.
      - WI-05, WI-07, WI-11 and WI-12 wait on the roadmap's in-flight limit of 4.
      - EXO-03/integration's status now names that limit too, as the first binding limit.
    - The replay harness leaves the cleanup out (`scheduler-replay.ts`). Its Git call would otherwise be charged to the first entry of the pass, which showed as a false `replay-stopped-at-git` on EXO-01/domain in four snapshots.
    - New scheduler goldens at the fix: `scheduler-golden-<fix>.json` for 2026-09-27 and 2026-09-28c.
- **Live measurement (2026-09-29 snapshot, 10.5 hours after the fccce06 deploy): preparation works; the done-when is not met yet.** Corrected after the independent review the same day. The first version called the done-when met, from 1 design stop in 3 started slices, but that compared unlike cases.
  - **Grant and preparation.** The roadmap was already running at boot. The operator paused it at 06:49:55, set the standing grant at 06:50:33 (30 minutes, one at a time) and resumed at 06:50:55. The scheduler then prepared 35 decisions between 06:50:57 and 08:14 (7 WI, 28 EXO), most slices first, including all four of EXO-18's merge decisions (LIVE-18). Each ended with a recommendation. 26 of the 35 preparation items are open for the operator.
  - **Batch approval.** With the roadmap paused, the operator approved nine prepared decisions in full between 16:04 and 17:16: WI-ADR-009, 011, 014, 015, 018, 019 and 020, and EXO-ADR-009 and 010.
  - **Design stops.**
    - WI-03/integration and WI-04/integration started at 06:48:53, before the grant was set, with no design stop. Every decision they need was accepted on 2026-09-20 or 09-21, so neither tests the grant. WI-03/integration was merged and verified by 12:30.
    - WI-05/domain is the one started slice whose decision was still undecided: WI-ADR-009, the kind of case behind the 10-of-11 baseline. Its brief had been ready since 06:53, but the slice started at 12:09 and stopped at `design-decision-required` at 12:15. The operator approved WI-ADR-009 at 16:04, in the batch.
    - So the grant turned 0 of 1 decision-dependent starts into a design without a stop. It moved the stop's work earlier (a recommendation ready when asked), not the stop itself.
  - **What would close it.** Either the operator approves prepared decisions before their slices start, which the batch now makes practical, or the scheduler holds a slice whose start needs a decision that has a brief but no approval, rather than starting its design into a stop. The second is a scheduling change for the operator to decide. Measure again after more slices start with decisions approved ahead.
- **LIVE-16's cleanup** removed both stale worktrees on the first pass (06:48:52). Accepted preparations' worktrees are removed on the next running pass; the roadmap was paused at the snapshot, so the nine accepted today are still there, holding no capacity.

### R-C4

**Refresh and re-review automatically when only upstream integration advanced** · Phase P2 · Effort M · Status: done (see Progress)

- **Resolves:** [HIST-03](findings/HIST-history-and-live-usage.md#hist-03-ranked-operator-intervention-causes-the-highest-leverage-automation-fixes)
- **Change:** Under automatic integration policy, an integration-advanced blocker triggers the existing refresh + fresh review without an operator request (33 manual update requests in the live data).
- **Done when:** No "Integration branch advanced; update the worktree" operator stop occurs under automatic policy.
- **Progress 2026-09-25: done** (effort S in the end).
  - **What the live data shows** (read-only audit query, and an independent trace of the code paths):
    - Only one "Integration branch advanced" stop ever occurred: cycle 6f1dfb47 on 2026-09-20T20:17. Roadmap b81d5f92 had been paused since 17:29. The operator resumed the stopped slice with guidance, and the review launch met the advanced branch.
    - The "33 manual update requests" were almost all not integration stops.
      - 31 were the fast-forward that an operator resume or review-again of a scope review performs as part of the command. Those stops were scope-review recovery (HIST-04, R-C5), and from 2026-09-19 the same loop ran as system updates.
      - 1 was the operator's update after the 6f1dfb47 stop.
      - 1 was a retry after a refresh hit conflicts (2026-09-12).
  - **The one remaining gap:** `refreshOwner` required the roadmap to be `running` and the entry unheld, including just before a review launched or was approved.
    - Now a running cycle refreshes from integration just before a review launches (the pending launch, after implementation) or is approved, under its delegation, binding and authority checks. This applies while its roadmap is paused or needs attention, or while the operator has paused its entry.
    - A stopped or completed roadmap, or a hold the system placed, still prevents it.
    - Awaiting-merge refreshes and merges keep the full gate, so a paused roadmap still does not merge. Finalization already refreshed regardless.
    - `docs/security.md` records the rule.
  - **Other paths checked, no change needed:** a scope review's resume and review-again fast-forward themselves; automatic scope recovery refreshes; refresh conflicts under automatic conflict policy start resolution; finalization always refreshes. The refresh limit and manual conflict policy stop by design, with their own codes.
  - **Done-when:** `server-execution-integration.test.ts` exercises the 6f1dfb47 code path with a non-conflicting advance. The roadmap is paused, integration advances, and the operator resumes the stopped slice with guidance.
    - The cycle refreshes once and reviews against the new target. It then waits for merge approval with no integration stop and no merge.
    - A variant where integration advances again during the review refreshes again at approval.
    - Variants with a stopped roadmap and with a system-placed hold do not refresh.
    - Each fails without its fix. The existing test that a paused awaiting-merge cycle is not refreshed still passes.
    - The real 6f1dfb47 update conflicted in 7 files under a manual conflict policy, so today it would stop as `integration-conflict`: earlier and better labelled, but still the operator's.
  - **Replays:** 278 and 51 decisions, 0 changed (refresh happens after the decision is applied).
  - **Gate:** `pnpm check` passes in one run: 187 test files and 1,481 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check.
  - **Independent review of 9c41c1a (2026-09-25), and what changed:** no path lets a paused or held roadmap merge, and an in-flight refresh is still superseded by a pause.
    - *MEDIUM, fixed:* the pre-review refresh also ran under a stopped roadmap and under system-placed holds. A stop pauses an integration resolution rather than stopping it, so an operator resuming the resolution could refresh under an ended delegation. Both are now refused.
    - *MEDIUM, fixed:* approving a review still used the full gate. If integration advanced during the review of an operator-resumed cycle, the same "Integration branch advanced" stop returned. Approval now refreshes the same way.
    - *LOW-MEDIUM, fixed:* the test and entry claimed to reproduce 6f1dfb47. That update actually conflicted, so the entry now says so.
    - *LOW, fixed:* the 33 manual updates are broken down exactly.
    - *LOW, fixed:* security.md and the code comment now describe the rule as the code applies it.
    - *Nits, fixed:* a no-op flag at the finalization stage, and a duplicate doc comment.
    - Replays: not affected (refresh runs after the decision). Gate: `pnpm check` stages all pass: 187 test files and 1,490 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check.
  - **Second independent review (2026-09-27), with the live fixes:**
    - *HIGH, fixed in 49686f6:* `refreshOwner` still required automatic recovery for a recovery round, so an operator-requested round (18f0bb8) never refreshed before its review or at merge, and "Integration branch advanced" came back. Its test advances integration during an operator round's repair.
    - *Checked and sound:* no refresh can race the roadmap merge (the launch refresh needs a running cycle, the merge an awaiting-merge one under a running roadmap, and both are serialized and version-checked); 18f0bb8 releases only `needs-attention` holds, so R-C4's refusal of system holds is unchanged; each R-C4 test fails without its change.
- **LIVE-15 fixed (2026-09-28, operator decision after the R-G4/R-G5 batch: a typed stop with the refresh as its action).**
  - `RuntimeEvidenceService.assertFreshTree` throws `UpstreamPinMovedError` when a pin among its issues moved past the saved generation. The error carries the definition and each moved pin (alias, pinned commit, current commit). Any other staleness stays a plain conflict.
  - The controller stops the cycle as `upstream-pin-moved` (operator-owned), with those as structured refs, instead of `controller-error`.
  - The inbox item of a roadmap-owned cycle opens the roadmap's dependency environment on the Roadmaps page. An unowned cycle's item opens its own page (after the review). In the inbox, the item hosts the cycle's controls and the roadmap's controls, open at that panel (`inbox-host.test.ts`).
  - A Resume, plain or guided, is refused while a recorded pin still differs from the current generation's pin. It names the pin and the refresh. Once a saved refresh pins the new commit, Resume goes ahead.
  - ADR-058 is amended.
  - **Test:** `server-execution-upstream-transitions.test.ts` (LIVE-15), on a real pinned Cargo provider that advances after its pin was saved. It covers:
    - the typed error;
    - the cycle's code and refs, with no launch;
    - the item's path;
    - the refused resume;
    - the resume after the refresh saves.
  - **Mutations:** without the resume guard, the resume is accepted (200); without the typed throw, the error is a plain conflict. Both fail the test.
  - **Follow-up, for automation (open):** start the refresh preview automatically on this stop, leaving only the decision to the operator. The refs carry what that needs.
  - **Rollback:** a release before this cannot read cycles carrying the new code or refs.
  - **Missed path, found live 2026-09-29 ([LIVE-21](findings/LIVE-live-run-2026-09-25.md#live-21-live-15s-typed-stop-misses-a-delegated-checkpoints-acceptance-so-exo-04s-review-ran-into-the-same-untyped-stop-after-the-fix), open).** LIVE-15's own cycle, b0de849a, stopped as `controller-error` again after the fccce06 deploy. After a mergeable delegated checkpoint review, `acceptWorkflowCheckpoint` builds the checkpoint candidate (`checkpointRecovery(…, true)`), and the candidate's own freshness issue raises a plain conflict before anything else; the typed throw is only in `freshnessConflict`. Its exit is the refresh preview. Recorded under rule 7, not fixed.

### R-C5

**Converge the parent/slice repair loop** · Phase P2 · Effort M · Status: done (2026-09-28; increments 1 to 5)

- **Resolves:** [HIST-04](findings/HIST-history-and-live-usage.md#hist-04-exo-01-parent-acceptance--owning-slice-repair-ping-pong-consumed-29-of-all-runs-without-convergence-detection), [HIST-08](findings/HIST-history-and-live-usage.md#hist-08-merge-approvals-and-record-scope-verification-still-require-manual-clicks-in-delegated-flows)
- **Change:** Track finding identity across parent-acceptance -> owning-slice repair -> re-review rounds; give repair briefs the cumulative remaining work for a finding; detect no-progress vs progress; escalate once with a progress summary; offer to split an oversized finding into a follow-up slice through the amendment path. Verify no repair path still needs manual merge or manual integration update.
- **Done when:** A replay of EXO-01 would escalate once instead of 13 rounds; repair cycles are always roadmap-owned.
- **Scoping 2026-09-25** (read-only DB and code trace). It fits M, delivered in increments.
  - **HIST-04 hypothesis confirmed.** The 16 EXO-01/domain repair cycles each got a packet with one parent source and only the current `R1.F-003`, citing that round's examples. Each review verified the previous round's corrections (194, 184, 131, 442, … corrections) and sampled new examples. The finding's ID, title and severity never changed; only the explanation did, so the exact-repeat fingerprint never matched.
  - **Ownership:** 13 of the 16 repairs came from the operator's work-item route (`delegate-scope-repair`), which creates an unowned cycle. Only 3 were roadmap recovery attempts.
  - **Increments, in order:**
    1. Finding history in the repair packet.
    2. Roadmap ownership of operator-delegated repairs.
    3. A pure progress classifier with a redacted EXO-01 fixture.
    4. One typed escalation with a progress summary (ADR-057 amendment). The allowance stays hard.
    5. A split offered through the amendment path, as an offer only (ADR-049): never proposed automatically.
  - **Replays:** the logic lives outside `decideStepOutcome`, so none are expected to change.
- **Increment 1, done 2026-09-25** (ADR-056 amended):
  - Each open finding in the repair packet carries its history: how earlier finished reviews in the same review worktree reported the same finding ID (status, explanation, location, disposition). History is oldest first and bounded, and is read only from runs before the pinned review, so the packet is deterministic.
  - The packet guidance and the repair brief say to treat every round's examples as remaining work until verified fixed. The operator's preview leaves the history out, so no contract changes.
  - **Test:** `server-execution-scope-findings.test.ts` runs a second verification round of the same F-003 with new examples and asserts the repair packet carries the first round's explanation. It fails without the change.
  - **Gate:** `pnpm check` passes in one run: 187 test files and 1,494 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check. No controller decision is involved, so no replay was needed.
  - **Independent review of e11940d (2026-09-25), and what changed:** no blocking defects. Determinism, per-source separation and the strict preview were confirmed.
    - *MEDIUM, fixed:* history left out the fields that carry each round's examples in the live EXO-01 data. Titles and recommendations named each round's sampled families. Rounds now keep severity, title and recommendation too.
    - *LOW, fixed:* history was built on every call, including previews and turn checks. Only the packet file builds it now.
    - *LOW, fixed:* rounds were matched by worktree and time. They now follow the pinned review's `parentRunId` lineage, within which reviewers carry IDs forward, so an unrelated review that restarted numbering is never mixed in.
    - *LOW, fixed:* rounds of any terminal status with a complete report now count.
    - *LOW, fixed:* the guidance separates open rounds (remaining work) from resolved ones (must not regress).
    - *LOW, fixed:* location paths are capped.
    - *LOW, fixed:* the test asserts the history directly, and that the preview omits it. It fails against both e11940d and the code before R-C5.
    - *Noted for increment 3:* history does not survive a replaced review worktree (WI-02/domain has had three), so the progress classifier must not rely on it.
    - *Second review (2026-09-27):* adopted repairs keep their finding history. It follows the pinned run's `parentRunId` lineage, which adoption does not change.
    - Gate: `pnpm check` passes in one run: 187 test files and 1,494 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check.
- **Increment 2, done 2026-09-26 on `main` (18f0bb8), merged into the P2 line in f471830.** It was built as a live blocker fix ([LIVE-05](findings/LIVE-live-run-2026-09-25.md#live-05-delegate-source-fixes-created-repairs-outside-the-roadmap-that-owned-the-review)), not from this branch, and it has not had an independent review yet ([R-I11](#r-i11)).
  - **Delegate source fixes** on a review owned by a running, paused or stopped-for-attention roadmap now reserves an operator-requested recovery round. This is the attempt automatic recovery already uses, marked `recovery.requestedByUserId`. The repair cycle is owned by the round and uses the slice entry's frozen profiles and policy with the operator's remediation limit. Its instructions are the entry's followed by the operator's. Outside a live roadmap, the repair is still the operator's own cycle.
  - **Operator decisions (2026-09-26):**
    - The roadmap carries an operator-requested round through its merge, fresh verification and parent review, even with automatic recovery off.
    - Operator rounds do not use the automatic allowance. They still count for the repeated-findings check. Increment 4's "the allowance stays hard" applies to automatic rounds.
    - Open repairs delegated earlier without an owner are adopted on the next roadmap pass, including while the roadmap is paused.
  - Creating or adopting a round releases its source entry's needs-attention hold; an explicit item pause stays. The roadmap's automatic merge also waits while the cycle can run a checkpoint review itself.
  - **Test:** `server-execution-scope-recovery.test.ts` ("carries an operator repair round through with automatic recovery off") runs two variants: requested through the route, and adopted while paused. Each covers the hold release, the merge, fresh verification, parent acceptance and reopening the database. It fails without the change.
  - **Gaps:**
    - The allowance exclusion is a one-line filter that no test isolates.
    - Adoption ran live on 2026-09-27 (EXO-04's `b0de849a`). It was observed only through the resulting state.
  - **Independent review (2026-09-27, R-I11).** Findings are fixed one commit each, test first.
    - *HIGH, fixed:* 18f0bb8 taught the scheduler that the roadmap carries an operator-requested round with automatic recovery off (`drivesRound`), but three other places still asked only whether automatic recovery was on:
      - `roadmapClaim` did not claim the round's merge, so every operator or adopted round's repair opened an operator `merge-approval` item that the roadmap then merged itself (a measured false alarm, and a push once the checkpoint-review wait passed the settle window);
      - `refreshOwner` refused the round, so R-C4's refresh before review and at merge never ran, and an integration advance stopped the repair with "Integration branch advanced" again;
      - the runtime refresh did not see the round, and queued a second re-verification beside it.

      One predicate, `roadmapCarriesRound` (`scope-recovery-policy.ts`), now answers it for all of them. The operator-round test asserts no merge-approval item, and a new test advances integration during the repair; both fail without the fix.
    - *MEDIUM, fixed:* Delegate source fixes released the source entry's needs-attention hold when it *reserved* the round, before the repair command checked its version, snapshot and blockers. A refused request removed the reservation but not the release, so the stop the operator never answered was gone, and with automatic recovery on a round could start on the next pass although the hold had stopped it. The hold is now released in `attach`, in the transaction that creates the repair cycle (`server-execution-scope-repair-rounds.test.ts`, which also keeps the reviewer's allowance, retry-in-place and item-pause probes as regression tests).
    - *MEDIUM, fixed:* a second Delegate source fixes request (another tab or device) took over the first one's in-flight reservation as a "retry", was refused by the repair command, and deleted the reservation; the first then failed too. Both requests got 409, no round remained, and a request that arrived during worktree creation left an active slice worktree without a cycle. A reservation is now retried only when no request is still preparing it, so the second request gets "already open" and the first completes.
    - *LOW-MEDIUM, fixed:* an operator round left `preparing` by a failed request or a daemon stop was waited on forever, with entry progress "Roadmap recovery: repair and integration" while nothing ran. The stopped review's inbox item stayed open (its controls repeat the request), so this was a misleading status rather than a dead end. A preparing operator round that no request is preparing now holds its source entry as `entry-preparation-failed`, asking to repeat Delegate source fixes; the repeat retries the same round and answers the hold.
    - *LOW, fixed:* the "allowance exhausted (N rounds)" stop and the recovery panel's "N / M rounds used" counted operator rounds, which the allowance excludes. Both now count automatic rounds only.
    - *Gap closed:* the allowance exclusion now has an isolating test (the decision with operator rounds only, the `>=` boundary, and the repeat check still counting operator rounds). It fails with the filter removed.
    - *Gap closed:* adoption on a running roadmap had no test (only the paused path did). The operator-round test gains an "adopted while running" variant, which fails with the running tick's adoption removed.
- **Increment 3, done 2026-09-28: a pure progress classifier** (`services/recovery-progress.ts`). Nothing calls it yet; increment 4 wires it into automatic recovery, so no replay changes.
  - **Input:** the pinned source report of each round of one review, oldest first, and the report that just finished. It compares consecutive reports only, never ADR-056's finding history, which a replaced review worktree loses (increment 1's review). Finding IDs are compared only between reports of the same review worktree; across a replacement only the severity profile of the open findings is.
  - **Per round:** `repeated` (the report's substantive fingerprint matches an earlier one, ADR-057's existing guard), `regressed` (the open findings got graver), `progress` (less grave, or a finding closed or was downgraded) or `stalled`. Automatic recovery should stop at a repeat, or after two consecutive rounds without progress (`STALLED_ROUND_LIMIT`). A display summary names each round's closed, downgraded, opened and still-open findings.
  - **EXO-01 fixture:** `fixtures/records/exo-01-parent-acceptance-2026-09-18.json`, the 16 parent-acceptance reports of exo/EXO-01 from the 2026-09-23 snapshot, redacted to finding ID, severity and status (run IDs replaced by labels; all prose removed). F-003 (major) stayed open in the first 13 reports that asked for changes. The 14th closed F-003 and opened F-005 (major), which the next review resolved.
  - **Test:** `recovery-progress.test.ts` runs EXO-01 as automatic recovery would. The loop stops after two rounds, with one escalation that names F-003 (major), where 13 rounds ran. The round that closed F-003 counts as progress although a new major opened. Further cases cover a repeat, regression, downgrade and a replaced review worktree.
- **Increment 4, done 2026-09-28: one typed escalation with a progress summary** (ADR-057 amended).
  - **Operator decisions (2026-09-28):** a new persisted hold code, `recovery-not-converging`, and a limit of two consecutive rounds without progress.
  - **Change:** `scopeRecoveryDecision` classifies the review's rounds (increment 3) from each round's pinned source report (`recovery.sourceRunId`) and the review that just finished. A spent allowance, a repeat and two rounds without progress are now one stop: an entry hold coded `recovery-not-converging`, whose text summarizes every round of that review. They were prose holds coded `entry-preparation-failed`. The allowance stays hard. Other refusals keep their stops.
  - **Resume** on that hold re-runs the same evaluation and is refused while it would stop again (R-A7's rule). It succeeds once the allowance is raised, automatic recovery is off or the rounds change. Delegate source fixes (an operator round) answers the hold, as before.
  - **Tests:** `server-execution-scope-recovery.test.ts` gains a `stalled` outcome: F003 stays open with new evidence every round, and recovery stops after two repairs with the typed hold, where it used to run to the allowance. `unchanged` and `exhausted` assert the code and summary too, and all three assert that Resume is refused and leaves the hold. `accepted`, where one stalled round is followed by resolution, still completes after two repairs. Each fails without its change (the stalled case timed out on the allowance; the Resume check returned 200).
  - **Replays, on copies:** `golden.json`, `--every-run` and the scheduler replay report 0 changed on all four snapshots (2026-09-23, 09-27, 09-28 and 09-28b). No snapshot has an automatic round that stops this way.
  - **Rollback note:** a release before this one cannot read a roadmap holding the new code (the contract enum refuses it). Answer such a hold (Delegate source fixes), or turn automatic recovery off and resume the item, before rolling back.
- **Increment 5, done 2026-09-28: the split, offered through the amendment path** (ADR-049; operator decision 2026-09-28: the inbox brings the amendment form into view).
  - **One inbox item.** An entry hold defers to its cycle's own item, so increment 4's hold never reached the inbox: the review's plain `scope-review-recovery` item showed instead, without the rounds. The review cycle's item now carries the escalation while its roadmap entry holds `recovery-not-converging`: that code and the hold's text, with the item's refs to the roadmap and entry. A roadmap write re-projects its open attempts' worktrees, so the item follows the hold both ways.
  - **The offer.** Opened from the inbox, the item hosts the review's cycle panel with Delegate source fixes, as before. It also opens the roadmap's controls with the planning-amendment form in view, where the remaining work can be split into a follow-up slice. Nothing proposes a split automatically.
  - **Tests:** `notifications.test.ts` places and removes the hold on a roadmap-owned review and checks its one item's code, text and refs. `inbox-host.test.ts` checks the amendment form's focus. The `stalled` recovery test checks the real escalation's single item. Each fails without its change.
  - **Walkthrough:** `2026-09-28-recovery-escalation-before` (537abf9) and `-after`; the walk has no escalation state, so the pages are unchanged.
  - **Replays:** 0 changed on all four snapshots.
- **Done-when (2026-09-28):** replayed through the classifier, EXO-01 escalates once, after two rounds, instead of 13 (increment 3's test). EXO-01's rounds were manual, not roadmap attempts, so the fixture feeds the classifier directly; the `stalled` integration case drives the whole pipeline (`scopeRecoveryDecision`, the pinned source runs, the hold and the inbox item). Repair cycles are roadmap-owned wherever a live roadmap owns the review (increment 2); outside a roadmap, a delegated repair is still the operator's own cycle, by design.
- **Independent review of increments 3 to 5 (2026-09-28).** An adversarial reviewer in an isolated worktree re-checked the fixture against the 2026-09-23 snapshot (all 16 reports match; nothing but labels, IDs, severities, statuses, verdicts and times remains), mutation-tested the classifier, the escalation and the projector, and re-ran the 2026-09-28b replays (0 changed). No HIGH or MEDIUM finding.
  - *LOW, fixed:* the hold's text put the operator's ways forward after the round summary, which lists every round and every open finding, so the 4,000-character bound could cut them off. The ways forward now come first, and the summary names the last four rounds and counts the earlier ones.
  - *LOW, fixed:* pausing the held item, then resuming it, went around the Resume refusal and re-ran the parent review without a repair. The refusal now applies to any hold on a stopped or paused review entry while automatic recovery would still stop there.
  - *LOW, fixed:* the done-when wording said "the EXO-01 replay escalates". It is a replay through the classifier (above).
  - *LOW, disposition:* an escalation first opens the review's plain `scope-review-recovery` item, and the next roadmap pass supersedes it with `recovery-not-converging`. The quiescence gate keeps the first from being pushed in the normal case. When it was already pushed (the review stopped while the roadmap was paused, and the escalation came after Resume), the operator is paged once more, with the new fact that automatic recovery gave up. Carrying delivery state across two different codes would hide that fact.
  - *LOW, disposition (pre-existing):* when a verification round completes before the parent review re-runs, a parent entry evaluated in between matches its unchanged report and escalates as a repeat. It does not get stuck: once a round is open the refusal does not apply, and the text is the one the prose stop already gave.
  - *NIT, disposition:* a round that downgrades one finding while another is upgraded, leaving the severity profile equal, counts as progress. A downgrade is progress on that finding.
  - *NIT, disposition:* the classifier's `sourceRunId !== run.id` filter and its creation-order sort have no isolating test. The filter matters for rounds pinned to the review being judged, which the allowance test constructs.
  - *NIT, disposition:* source reports are read as each source run's last turn, not by the pinned sequence. The source runs are finished, so the two agree.
  - *NIT, fixed:* the fixture's time field held each run's start, so it is renamed `startedAt`.
- **Live behaviour after the c547ede deploy (2026-09-28c snapshot, three hours in):** no automatic recovery round started and no `recovery-not-converging` hold was raised, so the escalation has not fired live yet. Cycle 2c9ead5d reached its review remediation limit, one major finding from the source-required security review with an allowance of 3, and the operator authorized 4 more attempts. That is the review allowance, which stays with the operator, not a recovery round.
- **Live behaviour after the fccce06 deploy (2026-09-29 snapshot):** still no automatic round and no `recovery-not-converging` hold. One parent review needed recovery: WI-03's (254ad81c, 12:46 UTC, one major finding). WI-03 has two required slices, so automatic recovery declined to choose an owner and held the entry as `entry-preparation-failed`, "Finding ownership is ambiguous", as designed. Nothing shows that reason to the operator: the projector lets a cycle's own item replace the roadmap's hold item for the same entry, and passes the hold's reason on only for `recovery-not-converging`, so the inbox and the status list show the review's own item. Recorded as [LIVE-20](findings/LIVE-live-run-2026-09-25.md#live-20-automatic-recovery-holds-a-parent-review-whose-finding-it-cannot-assign-and-nothing-says-why), with a replay case.

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

**End the session on a terminal quota error so the reset wait applies** · Phase P2 · Effort S-M · Status: done (see Progress)

- **Added 2026-09-24** in the phase 1 review of R-C8. The operator confirmed P2 the same day.
- **Resolves:** [AGT-60](findings/AGT-GIT-SEC-agents-git-security.md#agt-60-quota-and-session-limit-failures-with-a-known-reset-time-always-need-the-operator) (the part R-C8 left out).
- **Why:** R-C8 schedules the wait only when a quota failure is safe to retry. In the recorded incident (run 736446e8), the session kept background sub-agents and tool calls running for 31 minutes after the terminal quota error, so every quota result was unsafe and the step still stopped for the operator. Only 3 of about 12 quota results in that stream carried a reset time.
- **Change:** On a terminal quota error that has a reported reset, end the session promptly: stop background sub-agents and let outstanding tool calls settle or be cancelled. Keep the latest reported reset for the turn's final failure, rather than applying it to one result only. Add a recorded-stream fixture of the 736446e8 shape.
- **Done when:** Replaying the 736446e8 stream through the normalizer and the controller schedules a retry at the reset.
- **Progress 2026-09-25: done** (ADR-062 amended).
  - **Fixture:** `claude-session-limit-background-736446e8.jsonl` is the recorded stream of run 736446e8 (2,472 lines, from the raw lines the 2026-09-23 snapshot still held), with content and paths redacted and the protocol structure, ids and rate-limit reports kept. One tool result stored truncated is rebuilt from its normalized event.
  - **Adapter** (`packages/agents/src/claude-code/normalize.ts`, `backend.ts`): the normalizer keeps the latest reset any rejected report named until an `allowed` report. At the first quota result with a known reset (not billing), the session ends itself: it reports the reason, terminates the process group (sub-agents and background shells with it), and on exit reports one final quota failure with that reset, safe to retry unless the agent was waiting on the operator. That exit carries no background-work reason, since nothing of the work outlives the process group.
  - **Done-when met:** replayed whole, all nine recorded results stay unsafe (the old outcome); replayed as the session now reads it, the stream ends at the first quota result (10:11:28) with reset 14:50, and the cycle schedules its retry at 14:52 and then continues (`normalize.test.ts`, `server-execution-cycle-recovery.test.ts`). A fake `claude` with a running sub-agent and results failing every 50 ms is ended within seconds with the reset (`backend.test.ts`).
  - **Regression tests fail without the fix** (the terminal-quota detection and the termination, each reverted alone). Replays on a copy of the 2026-09-23 snapshot: 278 and 51 decisions, 0 changed.
  - **Gate:** `pnpm check` stages all pass: 187 test files and 1,475 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check. Under load average 19 from the live daemon, 9 controller tests timed out in waitFor, as did one walkthrough visibility check; each passed rerun alone.
  - **Independent review of 1b34b0b (2026-09-25), and what changed:** no high-severity findings. The incident path, the exit sequence and the fixture (2,472 lines, the same line types and ids as the backup) were confirmed.
    - *MEDIUM, fixed:* the latched "latest reset" was never needed for the incident, and could end a session at an unrelated later 429 using a stale reset. The latch is removed. Only a rejected report still in force counts, and an `allowed_warning` for the rejected window now withdraws it (reports carry their window). The misleading test is replaced.
    - *LOW, fixed:* a result that did not fail could end the session. Now only a failed result (`error_during_execution` or an API error) ends it.
    - *LOW, fixed:* the final failure ignored denied permissions; they now keep the retry with the operator. ADR-062 now says "ever made an interactive request" rather than "waiting on the operator".
    - *LOW, fixed:* a weekly reset stopped with "retry is not safe". The stop now names the reset time and asks to resume after it.
    - *LOW, fixed:* the test's "sub-agent" had no real process. The fake now starts a `sleep` in its process group, and the test asserts that it is gone. The assertion fails when the `sleep` detaches.
    - *LOW, documented:* ending the session discards background checks that would have finished before the reset (in 736446e8, a release-gate run completed at 10:43). The retry repeats them. ADR-062 says so, and that a detached (`setsid`) process outlives the session, as before.
    - *LOW, accepted:* a quota kill records two turns (the real result and the final one), so the run's turn count is one higher. The controller reads the latest turn.
    - *LOW, accepted:* a quota kill landing while the daemon stops is recorded as a restart interruption; resuming hits the limit again and ends the session.
    - The new tests fail against 1b34b0b's normalizer and the previous stop message.
    - Replays: 278 and 51 decisions, 0 changed. Gate: `pnpm check` stages all pass: 187 test files and 1,480 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check. Under load average 35, 25 controller tests timed out in waitFor; the 10 files passed rerun serially.
  - **Second independent review (2026-09-27):** no findings. The kill signals only the detached process group (falling back to the child). A session ends only on a failed result while a rejected rate-limit report is in force, never on a bare 429. Billing is excluded. The backend test fails with the termination removed.

### R-C10

**Re-verify a roadmap item whose evidence is no longer current** · Phase P2 · Effort S-M · Status: done (see Progress)

- **Added 2026-09-25**, from the WI-02 stall. The operator chose this over stopping and recreating the roadmap.
- **Why:**
  - A change such as approving another architecture decision (WI-ADR-016 on 09-24) or a new repository policy makes completed verification and acceptance receipts stale. The roadmap then holds the item with "stop this roadmap and create a new selection".
  - Stopping the roadmap stops every unfinished attempt's cycle: EXO-03/domain in flight, WI-04/domain at merge, WI-09/domain.
  - A review launched manually from Delegation cannot replace the stale one. Recording scope evidence credits only the roadmap's assigned reviewer, which is the current run of the roadmap cycle for that entry; it refused "This exact review run lacks the explicitly assigned independent reviewer roles."
  - Review again needs the original cycle completed and its worktree active. WI-02/domain's verification cycle had been stopped and its worktree removed.
- **Change:** a **Re-verify** item control, offered by the server (`reverifiable` on entry progress). It applies to a verification or parent-acceptance entry whose evidence is not current, whose review cycle has ended, with no queued review and no active scope recovery.
  - **Completed cycle, worktree still active:** the attempt is marked `reverification`, and the scheduler runs Review again in the same cycle, through the same guarded path as a dependency-refresh review.
  - **Cycle stopped, or worktree gone:** the ended attempt moves to the roadmap's `retiredAttempts` history, with who retired it and why, and the entry is scheduled afresh with its assigned reviewer.
  - A second active worktree for the scope is refused by branch name, since a scope has one active worktree and adopting an unassigned one could verify commits the roadmap never assigned.
  - The roadmap can be running, paused or needing attention. The item's hold is cleared, and nothing else is stopped.
  - The hold message now points to Re-verify.
- **Done when:**
  - An in-place and a fresh-attempt re-verification both make stale evidence current again with the assigned reviewer, without stopping the roadmap.
  - Current evidence, an open review, an already-queued review, and a second active worktree are refused.
- **Progress 2026-09-25:** done.
  - `server-execution-roadmap-reverify.test.ts` runs a supervised roadmap until both slice verifications are recorded, then adopts a newer repository policy.
  - It shows both routes and every refusal, then resumes, and both verifications are current again.
  - With the scheduler branch removed, the test times out.
  - `ReverifyItem.test.tsx` covers the control's gating.
  - No walkthrough capture: the control renders only for an item with stale evidence, which the walkthrough map never has.
- **Independent review of d44f8f7 (2026-09-25).** Its findings and what was done:
  - **HIGH: a failed in-place review left the item stuck.** If the queued Review again could not run, the item was held, but Re-verify said "already queued" and every other route was refused. Causes include a worktree removed, dirty or diverged, or a manual review that moved the cycle on. A held item with a queued re-verification may now be re-verified again, and the route is recomputed; with the worktree gone it retires the attempt. The marker is also cleared once the evidence is current again. The test adds the case where the worktree is removed after queuing; it fails without the fix.
  - **MEDIUM: retiring an attempt made its entry look never-started, so a settings save could re-derive its reviewer, profiles and instructions.** `startedAttempts` now counts retired attempts in every "has this entry started" check: roadmap save, the cross-project save, the amendment queue, the agent-settings view, and cycle ownership. The test saves changed defaults after retiring B, and B keeps its instructions; this fails without the fix.
  - **An attempt still being prepared was eligible.** It is refused until its cycle exists, unless the item is held.
  - **Re-verify cleared an operator's item pause.** A paused item is refused; resume the item first. This is tested.
  - **A retired attempt lost ownership of its ended cycle.** Ownership now resolves through retired attempts too, for history.
  - **Still open:** Re-verify of a parent-acceptance entry, and on a running (not paused) roadmap, run the same code, but the test does not exercise them.

### R-C11

**Classify a provider-side credential rejection as its own stop, with a bounded scheduled retry** · Phase P2 · Effort S-M · Status: done (see Progress)

- **Added 2026-09-25** from a live incident; the operator put it on P2 the same day.
- **What happened:**
  - Between 22:40 and about 23:01 UTC, OpenAI's Codex backend rejected requests from ChatGPT-authenticated sessions with "401 Unauthorized: Incorrect API key provided: sk-svcacct…". This was a service-account key that exists nowhere on the host.
  - The host's credentials were healthy throughout:
    - `~/.codex/auth.json` was in ChatGPT mode with valid tokens;
    - no API key was in any environment;
    - single Codex processes alternated between success and 401;
    - four independent processes reported the same masked key.
  - The same failure was reported by other users that day (openai/codex issues #48230, #48232, #48235, #48237).
- **What it cost:**
  - EXO-03/domain and EXO-18/instance-design stopped as `service-failure-not-retryable` ("the backend failed without a recognized temporary service error").
  - WI-02/domain and EXO-04/domain ended with agent questions asking for the "approval-review authentication" to be restored. Codex's automatic approval reviewer failed on the same 401 when they asked to use Docker for `ct-act`.
  - The operator had to diagnose a provider outage as a possible local credential problem, and resume four items by hand once it cleared.
- **Change:**
  - Recognize this failure in the Codex provider-failure normalizer (`packages/agents/src/codex/provider-failure.ts`): a 401 from the Codex backend while the session is in ChatGPT auth mode.
    - It becomes its own provider-failure kind and its own typed attention code. The operator message states the facts, for example "Codex rejected its credentials: provider-side outage suspected; local login is ChatGPT mode", instead of "backend failed".
    - Distinguish a genuinely expired or revoked local login, which needs re-authentication, from a provider-side rejection. Use what the host can observe: whether the local token refresh itself fails, or whether `auth.json`'s tokens are well-formed and fresh.
  - For the provider-side case, schedule a bounded retry with backoff, like R-C8's quota-reset retry. Stop for the operator only when the retries are spent.
  - When an agent's approval request fails on the same error, treat it as the same outage rather than as an operator question about approvals. Retry the step once the provider recovers; don't ask the operator to "restore authentication".
- **Done when:**
  - A recorded stream of this incident, from a failed implement turn and a failed approval review, replays to the new code.
  - It schedules a retry, and a later successful turn continues without operator action.
  - Spent retries stop with an operator message that names a suspected provider outage and the evidence.
  - A locally expired login still stops asking for re-authentication.
- **Progress 2026-09-25: done** (ADR-062 amended).
  - **What Codex reports.** The recorded incident (Codex session logs of runs 7537de3a and 40ee8364, and the daemon's run events) carries `codexErrorInfo: "other"` and the backend's status line only: "unexpected status 401 Unauthorized: Incorrect API key provided: sk-svcac…fvMA … url: https://chatgpt.com/backend-api/codex/responses … request id: …". The approval failure never reached the app-server stream as an item. Codex wrote it to stderr (run 40ee8364, event 50346), and the agent then asked about it: first in an async agent message (event 50348), then in the final report's `## Open questions` and workflow block. The review turn completed.
  - **Adapter** (`packages/agents/src/codex/provider-failure.ts`, `normalize.ts`, `session.ts`):
    - New provider-failure kind `credential-rejected` with `evidence` (endpoint, masked key, request id). It applies only when the session's login is ChatGPT mode and no API key is in Codex's environment. Codex gives no structured code for it, so the status line is read in two places, both named in ADR-062: a failed turn's error message and the approval review's stderr line.
    - A command refused because its automatic approval review hit the same rejection (seen on stderr) is reported with the completed turn as `suspectedOutage`; the turn keeps its outcome.
    - Before calling a rejection the provider's, the session re-reads the login (`account/read`); a login that is gone becomes `authentication`.
    - A local login problem stays with the operator and says so: Codex's `unauthorized`, the same 401 under an API-key login, or a login found gone. The message asks to sign in again (`codex login`).
  - **Controller** (`decideStepOutcome`): three retries after 5, 15 and 30 minutes (about 50 minutes; the incident lasted 21), on the same agent, moving the step deadline by each wait, like R-C8's quota waits. A suspected outage turns the step's operator stop into the same retry, unless output was clipped; the retry's reason names the stop it set aside. Spent or unsafe retries stop with the new operator code `provider-credentials-rejected`, whose message names the suspected outage and the evidence. The inbox labels it "Provider rejected credentials"; the provider recovery panel shows the evidence.
  - **Done-when:**
    - *Recorded streams replay to the new code:* fixtures `codex-provider-credential-rejected.jsonl` (the failed implement turn) and `codex-approval-review-rejected.jsonl` (the review whose approval failed: its stderr line, async question and final report as the daemon recorded them, run paths redacted), with the vendor's masking kept (`normalize.test.ts`).
    - *Schedules a retry, and a later successful turn continues without the operator:* `server-execution-cycle-recovery.test.ts` replays both fixtures into a cycle: retry at +5 minutes, deadline moved by 5 minutes, then the step is retried and the cycle moves on with no attention. The recorded report drives the approval case (its open question stops implementation, which the outage turns into the retry).
    - *Spent retries name the suspected outage and the evidence:* the same file, after 5, 15 and 30 minutes.
    - *A locally expired login still asks for re-authentication:* adapter tests (`unauthorized`, API-key login, login gone after the rejection, through a fake app-server) and a cycle test.
  - **Regression tests fail without their fix:** the classifier, the stderr approval path and the controller's retry, each checked by reverting only that change.
  - **Replays** on a copy of the 2026-09-23 snapshot: 278 and 51 decisions, 0 changed (recorded failures keep their stored kind).
  - **Gate:** `pnpm check` passes: 187 test files and 1,471 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check.
  - **Independent review of 8900aa0 (2026-09-25), and what changed:**
    - *HIGH, fixed:* one approval-review failure the agent recovered from turned a successful turn into a failed run and retried a finished step. The stderr read now only annotates the completed turn (`suspectedOutage`). The controller acts on it only when the step would otherwise stop for the operator, and the retry guard accepts a finished source run only when its last turn carries the annotation.
    - *MEDIUM, fixed:* the approval fixture invented an `item/tool/requestUserInput` server request. The live run events show an async agent message instead. The fixture is rebuilt from the recorded events (stderr verbatim), the exception for that request is removed, and the cycle test is driven by the recorded report.
    - *MEDIUM, fixed:* any `credential-rejected` failure bypassed the questions and clipped-message guards. The failed-turn path keeps both guards. The annotation path skips only the question stop, keeps clipped output with the operator, and names the set-aside stop in the retry reason. The retry brief tells the agent to ask again any question the outage did not cause.
    - *MEDIUM, fixed:* ADR-062 and this entry said the status line was "the one message" read, but raw stderr was read too, contrary to ADR-062. The amendment now names both reads and their limits. The stderr line was confirmed in the live run events; the reviewer could not check this.
    - *LOW-MEDIUM, fixed:* the regex was quadratic on unbounded input (1 MB: 91 s, measured again). It now uses bounded quantifiers within one line, over the first 4 KB.
    - *LOW, fixed:* stderr is now matched line by line, across chunk boundaries.
    - *LOW, fixed:* an API key in Codex's environment (`OPENAI_API_KEY`, `CODEX_API_KEY`) is now treated as a local key.
    - *LOW, fixed:* the login check is skipped once the session is closed.
    - *LOW, fixed:* stale text. The retry brief now mentions credential waits, and the spent and unsafe messages no longer claim three credential retries or "work outstanding".
    - *LOW, fixed:* the key is shown no wider than the vendor's masking.
    - Every regression test was shown to fail with its fix reverted (annotation, recorded-report retry, clipped output, failed-turn questions, stderr lines, regex bound, environment key). Replays: 278 and 51 decisions, 0 changed.
    - Gate after the fixes: `pnpm check` stages all pass: 187 test files and 1,480 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check. Under load average 23, 24 controller tests timed out in waitFor; all 9 files passed rerun alone.
  - **Second independent review (2026-09-27, P2 review with R-I11):**
    - *HIGH, fixed:* the recorded incident's step was a review (run 40ee8364), but the cycle test replayed it as an implementation. As a review, the credential retry reached the launch with `providerRecovery` set and a *finished* source run, and the launch accepts only a failed one as a continuation. So the retry became `controller-error` ("Review continuation requires the interrupted review…"), which neither Resume nor Continue with guidance could clear (the stop still had its open questions, and the current run id never launched). A retry of a finished review now starts a fresh review. The new test replays the recorded turn as a review; it fails without the fix.
    - *MEDIUM, fixed:* the suspected-outage path set aside *every* operator stop of a completed turn, not only its questions as the first review recorded: an operator design decision, a shared decision or a rejected report waited up to about 50 minutes and three re-runs, and the retry brief left it to the agent whether to ask again. Only question stops (`OUTAGE_QUESTION_STOPS`, by code) are retried now; other stops keep their code and note the outage. ADR-062 amended.
    - *LOW-MEDIUM, fixed:* once the three retries were spent, the step's own question stop was replaced by `provider-credentials-rejected`, which lost its code and so its routing to Continue with guidance. The step's stop is now kept, with the evidence. The decision-table test covers both; it fails without the fix.
    - *LOW, accepted:*
      - The stderr sentinel is matched anywhere in a line, not anchored to Codex's log prefix. A spoof could at most delay a stop; it grants no authority.
      - The local-login check is `account/read` (present, ChatGPT mode), thinner than the Change's "tokens well-formed and fresh". The regex needs "Incorrect API key provided: sk-", which a ChatGPT token failure does not produce.
      - Guidance is capped at 16,000 characters, and a step whose stored guidance is near the cap cannot take more (shared with the provider-retry branch).
    - *Checked and sound:* guidance given while a retry is pending joins that retry, with a single launch. Guidance after spent retries opens a new window, as ADR-062 intends. The guided path cannot launch a second live agent (R-G1). Carried guidance never crosses a step (R-G3).

### R-C12

**Automatic recovery records why it did not start a round** · Phase P2 · Effort S-M · Status: done (2026-09-27)

- **Added 2026-09-27** from [LIVE-06](findings/LIVE-live-run-2026-09-25.md#live-06-automatic-recovery-did-not-start-a-round-for-exo-02domain-and-nothing-said-why). The live roadmap was running with scope recovery enabled, EXO-02/domain's verification was stopped on a complete major finding, and no round started. Nothing on the roadmap, the entry or the inbox said why.
- **Change:**
  - First reproduce it offline on the 2026-09-27 snapshot with [R-I10](#r-i10)'s scheduler replay, and find which branch returned. Candidates: `scopeRecoveryDecision`'s `reason` or `waiting`, a swallowed `PhaseGateError.waiting` or `SupersededRoadmapOperation`, `deferredEntries`, or `advanceEntry` never reaching the verification entry.
  - Then make every scheduler pass that leaves a stopped review without a round record a typed reason. It is either a controller wait ("waiting for X") or an operator stop, as an R-A4 attention item. Branch on codes, never on reason text (program rule 4).
  - Fix the underlying cause if it is a defect.
- **Done when:**
  - The 2026-09-27 snapshot's scheduler replay shows EXO-02 either starting a round or holding a typed reason that the inbox and [R-E3a](#r-e3)'s status list show.
  - No return path in `advanceScopeRecovery` or `advanceEntry` leaves a stopped review without a recorded reason. A table test covers each path.
- **Done 2026-09-27.**
  - **Cause, found on the snapshot with [R-I10](#r-i10)'s replay:** a circular wait, not a swallowed error. `scopeRecoveryDecision` named EXO-02/domain as the owning slice. `advanceScopeRecovery` then asked `blocker()` for that slice, got a `capacity-blocked` blocker ("Repository has 2 unmerged worktree(s) or reservations; capacity is 2"), and returned `true` with nothing recorded. The two slots were EXO-04/domain's repair, whose merge waits for EXO-02/domain to be verified, and EXO-18, which waits on the operator's EXO-ADR-022. The slot EXO-04 held could never free before EXO-02's round ran. Meanwhile `automatedScopeRecoveryWait` claimed the verification cycle's stop for the controller ("Waiting for the roadmap to delegate…"), so neither the inbox nor the roadmap showed anything.
  - **Operator decisions (2026-09-27):**
    - Waits are persisted on the roadmap, as a new optional field `entryWaits` (entry → code, reason, refs, `since`), written only when it changes; absent means none recorded. No migration: it lives in the roadmap's state JSON and its contract.
    - A recovery round may take one repository slot beyond `maxPerRepository` when a slot holder's merge waits on the round's own slice. Otherwise the ordinary limit applies, and the wait is recorded.
  - **Typed steps.** `advanceEntry` and `advanceScopeRecovery` now return an `EntryStep` on every path: moved on (a command issued, an attempt or round advanced, the entry's agent at work), or a typed wait (`entry-waits.ts`). A bare `return` no longer compiles. The codes and who acts next are in `ENTRY_WAIT` (domain `attention.ts`):
    - controller: `dependency-blocked`, `capacity-blocked`, `exclusion-blocked` (the scheduler's own blockers), `phase-blocked` (a phase gate that clears by itself, with its blocker codes), `integration-held`, `review-running`, `recovery-round` (a round carries the stopped review), `cycle-waiting` (the cycle waits on its own controller);
    - operator: `cycle-attention` (the cycle's own attention item carries the stop), `cycle-paused` (the operator's pause), `entry-held` (the round's next review is held).
  - **Recorded once per pass.** The parallel pass collects each evaluated entry's step and writes `entryWaits` only when it changes. A wait keeps its `since` while its code and subject stay the same; a lost race keeps the last wait. Entries the pass skips (complete, deferred by a blocker, held) carry no wait, because their attempt, progress or hold already says it. Operator stops that are not waits stay entry holds, so R-A4's inbox shows them.
  - **The fix.** `blocker()` takes a `recoveryRound` flag, passed by the three checks of an automatic round's owning slice. Such a round may use one slot beyond the repository limit, and never more, when an unmerged slice in that repository has a `slice-requirement` merge blocker on the round's own slice (`refs.sliceId`, the phase evaluator's structured blocker).
  - **Swallowed adoption failures, handed over by [R-I11](#r-i11):** each open repair is now adopted in its own `try`. A lost race is retried next pass. Any other failure holds the review the repair came from as `entry-preparation-failed`, naming the repair's cycle, and the roadmap keeps running. Before, the failure was swallowed while the roadmap was paused, or became a whole-roadmap `scheduler-error` while it ran. An identical hold is not rewritten, and a later adoption releases it.
  - **Tests,** each failing without the change:
    - `entry-waits.test.ts`: a 22-row table test of the wait each kind of path records (every cycle state and owner, each blocker kind, phase gates, rounds) and of how a pass keeps, restarts and clears waits.
    - `server-execution-scope-recovery-waits.test.ts`: LIVE-06's shape on the scope fixture. A verification stops on a finding with one repository slot. When another item holds the slot, the stopped review records `capacity-blocked` naming the owning slice, starts no round and is not rewritten on the next pass. When the holder's merge waits on the slice under repair, the round borrows the slot and starts. Adoption failures are tested while paused and while running.
  - **Replay** on the 2026-09-27 snapshot against R-I10's scheduler golden: 5 decisions changed, all intended; there is no other change:
    - `exo/EXO-02/domain` verification: `none` → `recover` (`delegateScopeRepair`). EXO-04/domain's repair holds a slot and waits for EXO-02/domain to be verified, so the round borrows it. **LIVE-06 fixed.**
    - `exo/EXO-03/domain` verification: `none` → wait `cycle-paused` (the operator paused it 2026-09-26 22:44).
    - `wi/WI-04/domain`: `none` → wait `cycle-attention` (its attestation stop, LIVE-07; see [R-C13](#r-c13)).
    - `exo/EXO-04/domain` verification: `none` → wait `cycle-waiting`, "Slice exo/EXO-02/domain must be verified." (its round's repair waits on its own controller).
    - `exo/EXO-18/instance-design`: `none` → wait `cycle-attention` (EXO-ADR-022, the operator's approval).
    
    The step-outcome goldens are unchanged (2026-09-23: 51 and 278; 2026-09-27: 58 and 352).
  - **Not changed:** the Roadmaps page's per-entry progress still derives its status from the cycle, so for a stopped review with a recorded controller wait it shows the cycle's reason. [R-E3a](#r-e3)'s status list is the reader of `entryWaits` (nothing read it at 92f6c93).
- **Independent review of 92f6c93 (2026-09-27).** An adversarial reviewer in an isolated worktree walked every return and throw path in `advanceScopeRecovery`, `advanceEntry` and the pass loop, re-ran the replays, and mutation-tested the new tests. Every finding was verified again before it was acted on. Fixed in one follow-up commit, test first:
  - *MEDIUM, fixed:* an adoption failure replaced the operator's item pause of the source review with an `entry-preparation-failed` hold, and the later adoption then removed it, so the pause was lost. A paused review now keeps its pause; the failure is recorded once the pause lifts. Test: "running, review paused".
  - *MEDIUM, fixed:* sequential roadmaps recorded no waits at all, and scope recovery is not limited to parallel roadmaps. A sequential pass now records the wait of the one entry it evaluates. Test: the sequential roadmap suite's "records why the entry a pass evaluates waits".
  - *MEDIUM, fixed:* the fix broke the circular wait only through a free repository slot. A round blocked by the in-flight limit, or by a repository already over its limit, recorded `capacity-blocked`, a controller-owned wait that could never clear, so nothing reached the operator. When a round's capacity is held by work that waits on the slice it repairs and one extra repository slot cannot resolve it, the round now holds its review as `entry-blocked` (an existing operator code), and the reason says what resolves it. The borrow itself is unchanged (operator decision). Test: "two slots held by work that waits on this slice".
  - *LOW, fixed:* a stopped or completed cycle recorded `cycle-attention`, an operator-owned wait with no item behind it. A new code, `cycle-ended` (operator), names it; the `ENTRY_WAIT` comment now says an operator-owned wait points at the item, pause or stop behind it.
  - *LOW, fixed:* `waitsOnSlice` compared slice source IDs only, so a holder from another map binding with the same slice ID could lend a slot. It now requires the same definition and binding revision.
  - *LOW, fixed (tests):* two mutations survived the tests: the one-slot limit (`===` to `>=`) and the recovery-only borrow (`recoveryRound` to `true`). The "two slots" case and a direct check that only a recovery round borrows now kill them. The deadlock case now also checks that the round's cycle exists and that the next pass records `recovery-round` naming it.
  - *LOW-MEDIUM, fixed (docs):* the amendment said R-E3a reads `entryWaits`, but R-E3a was open.
  - *LOW, disposition:* a `SupersededRoadmapOperation` mid-pass discards that pass's waits; the next pass writes them. No path that repeats it was found.
  - *LOW, disposition:* `entryWaits` persists through a pause and `since` keeps counting, because a wait is what the last pass found; the status list shows the roadmap's own state beside it. Each change of a wait is one roadmap write (version, audit row, event), and only a change writes, so an operator command carrying an older `expectedVersion` can occasionally get a 409, as with any other roadmap write.
  - *LOW, disposition:* the table test pins what each kind of path records, and the compiler guarantees that every path returns a step. It is not a table over the service's own branches: `review-running`, `entry-held`, a round from another source, `integration-held` and the in-flight path are exercised by the snapshot replay and by reading, not by a fixture each.
  - *Checked and sound:* the five replay changes and their classification; every step-outcome golden (2026-09-23 51/278, 2026-09-27 58/352); every new test fails without the change; two rounds in one pass cannot both borrow; other roadmaps sharing the repository cannot borrow; operator-requested rounds and ordinary starts pass no borrow flag; the contract and forward-only format; unchanged waits are not rewritten; no new prose branching.

### R-C13

**Checkpoint readiness agrees with what the attestation needs; no resume that repeats a failed attestation** · Phase P2 · Effort S-M · Status: done (2026-09-27)

- **Added 2026-09-27** from [LIVE-07](findings/LIVE-live-run-2026-09-25.md#live-07-a-delegated-checkpoint-review-repeats-the-same-failed-attestation-on-every-resume). WI-04/domain's delegated WI-WORKER-G1 review ran three times, and failed the same attestation each time.
  - The controller judged the checkpoint ready (`supported && assigned && !pending.length`).
  - The reviewer found the producing-slice receipts of WI-09 and WI-10, which was still at design, missing.
  - Each Resume re-ran the same review.
- **Change:**
  - Confirm the hypothesis on the snapshot.
  - Make checkpoint readiness (`workflowContext` → `prerequisiteIssues`) include every input the attestation needs, such as producing-slice receipts and coverage bindings. Readiness and the attestation check must use one evaluator ([R-F1](#r-f1)).
  - A failed attestation whose inputs have not changed becomes a typed stop. A plain Resume is refused and redirected to the control that can change it ([R-A7](#r-a7)).
- **Done when:**
  - On the 2026-09-27 snapshot, WI-04 waits as `controller-wait`, naming the missing WI-09/WI-10 inputs, instead of launching the review.
  - A resume after a failed attestation with unchanged inputs is refused with the resolving control.
  - Both replays are unchanged except for the explained WI-04 decision.
- **Done 2026-09-27.**
  - **Hypothesis refuted on the snapshot.** Readiness was right. WI-09/domain merged at 00:38 and was verified at 00:53:48 with a current scope receipt; WI-10/domain's receipt was current too. WI-04's WI-WORKER-G1 review started at 00:53, as soon as nothing was pending. "WI-09/domain was still at design" was stale when LIVE-07 was written: it was true on 2026-09-26, when WI-04 first waited. The defect was the evidence given to the reviewer. The ledger `craftingtable-scope-evidence.json` (`scopeEvidenceLedger`) collected receipts only for the work items the slice's own requirements name, and did not expand a required *checkpoint's* own prerequisites. So WI-04's ledger held WI-02's receipts, but not WI-09's or WI-10's, and no coverage bindings for WP-001…WP-008. The reviewer said exactly that each time ("The supplied ledger contains WI-02 receipts but lacks WI-09/WI-10 producing-slice receipts … contains no acceptance_coverage bindings").
  - **Restated done-when (operator decision 2026-09-27).** WI-04's next checkpoint review is given the WI-09/WI-10 receipts and coverage bindings, instead of "WI-04 waits naming them": those inputs are met. The rest stands: a failed attestation with unchanged inputs is a typed stop, and Resume is refused and redirected. The new code `checkpoint-attestation-failed` is an additive value of the persisted cycle attention enum, approved with the restatement.
  - **One evaluator.** `prerequisiteEvaluation` (`runtime-evidence-policy.ts`) returns a subject's gaps and the exact record that met each other requirement: accepted evidence, a scope receipt, a merge, a staged decision, a started run or an accepted parent. `prerequisiteGaps`/`prerequisiteIssues` are its gaps, so readiness is unchanged. From the same evaluation:
    - `workflowContext` reads `pending` and adds each checkpoint's `inputs` (stable keys), so its `contextDigest` and the reviewer's prompt cover every input the controller counted;
    - the ledger gains `checkpoints`: for each checkpoint the scope requires, its requirements, the met prerequisites with the receipts themselves, what is still pending, and its coverage bindings. For WI-04 the section is 19 KB compact (26 KB as the file is written, pretty-printed); the ledger was 796 KB compact before it, 815 KB after.
  - **Typed stop.** `checkpointAttested` is the one check of a delegated attestation (passed; evidence for every exact requirement and none other; every case), shared by the candidate's issues and the accept path. A failed attestation throws `CheckpointAttestationError`, and the cycle stops as `checkpoint-attestation-failed` (operator, `refs.checkpointId`) instead of `controller-error`.
  - **Resume ([R-A7](#r-a7)).** `cycleActions` sends this stop to Continue with guidance, which works whether or not the inputs changed. The daemon refuses a plain Resume while the checkpoint's inputs are the ones its review was given (the current `contextDigest` equals the active review's), and accepts one through the API once they changed; the browser does not offer it (review finding below). A review that runs again records the digest of the inputs it is given, so a second identical failure is refused again; a continued session keeps the digest it was launched with.
  - **Tests,** each failing without the change:
    - `server-execution-checkpoint-attestation.test.ts`: LIVE-07's shape. AQ-01/a's merge needs LOCAL-REVIEW, which needs AQ-02/a, another item's slice, verified. The checkpoint review's ledger carries AQ-02/a's receipt under `checkpoints`, from the evaluation that made the checkpoint ready, and the prompt names the same input.
    - `server-execution-reviews.test.ts`, "delegated contract checkpoint requires complete attestation: false": the stop is `checkpoint-attestation-failed`. A plain Resume is refused with "Continue with guidance", and accepted once the inputs differ from those the review was given; the relaunched review records the current digest.
    - `cycle-actions.test.ts`: the redirect row.
  - **Replays.** Step outcomes unchanged: 2026-09-23 51 and 278, 2026-09-27 58 and 352. Scheduler, against R-I10's golden: R-C12's five entry changes, plus one intended cycle change. WI-04/domain's WI-WORKER-G1 is still ready, and `packetMissing` goes from the WI-09/WI-10 receipts and WP-001…WP-008 to nothing. Its stored stop is the old `controller-error`, so after deploy Resume re-runs the review with the complete packet.
- **Independent review of 26f213c (2026-09-27).** An adversarial reviewer generated WI-04's ledger on a snapshot copy (9 prerequisites, including the WI-09 and WI-10 receipts, and coverage WP-001…WP-008), confirmed the refutation from receipt and run times, and re-ran the replays (58/0, 352/0; scheduler 6 changed, as stated). Every finding was verified again before it was acted on:
  - *MEDIUM, disposition:* the daemon accepts a plain Resume once the inputs changed, but no browser control offers it, because `cycleActions` cannot see the digest, and a roadmap or item resume leaves the stop to its own control. Continue with guidance is offered and works in both cases, so the operator is never trapped. Rendering the actions the daemon returns is R-A6's (R-A7's restated done-when moved it there). The amendment above is corrected.
  - *LOW, fixed:* a paused cycle whose inputs changed was not relaunched, because `effectiveCycleAttention` ignores paused cycles; a pause taken at the stop keeps its code, which is now read. The attestation test pauses at the stop before the inputs change, and fails without the fix.
  - *LOW, fixed:* the new comment had split an existing comment from its method.
  - *LOW, fixed (docs):* the ledger size figures (above).
  - *LOW, disposition:* the resume rule compares the whole context digest. An unrelated change to another checkpoint of the slice lets one Resume through, which may repeat the attestation once; the refreshed digest then refuses again. Inputs in the ledger but outside the digest (runtime pins, operator decisions, accepted evidence that is not a prerequisite) do not unlock Resume, and guidance remains the control. A per-checkpoint digest would need a new persisted field.
  - *LOW, disposition:* the replay's `packetMissing` now reads the same evaluation as readiness, so it can no longer find a divergence between them. It stays as an observation of the packet; the fixture test holds the behaviour. The ledger's `baselineCoverage` lists every baseline case gated by the checkpoint, a superset of the reviewed slice's cases, which is harmless for the reviewer.
  - *LOW, disposition:* receipts appear in both `receipts` and a checkpoint's `prerequisites`, and the section is written for every scoped run. That costs tens of KB beside 800 KB of accepted evidence; PERF work on the ledger belongs to R-H4.
  - *LOW, open gaps:* no test for the coverage bindings in the ledger (verified on the snapshot), for guidance being accepted at this stop (verified by reading), or for a real input change (the test replaces the stored digest).
  - *Checked and sound:* `prerequisiteEvaluation` keeps the old gaps exactly on every branch; `CheckpointAttestationError` is thrown only for the reviewer's attestation, after the delegation and readiness checks and before the candidate, build and Git checks; the check uses the same spec as the candidate path; the digest refresh is skipped only for continued sessions; contracts, labels and the operator-wait kinds take the new code; no prose branching.

### R-C14

**Attention says only what needs the operator now, and what the operator can act on** · Phase P2 · Effort S-M · Status: done (2026-09-28)

- **Added 2026-09-28** from the first day on the deployed P2 line ([LIVE-09 to LIVE-11 and LIVE-13](findings/LIVE-live-run-2026-09-25.md#after-the-p2-deploy-2026-09-28)). With the roadmap running, the inbox held 55 items, and most were not the operator's to act on now:
  - 35 decisions no entry needs yet;
  - 15 checkpoint-evidence items for evidence the controller produces;
  - 2 stale decision preparations;
  - 1 duplicate.
- **Change:**
  - A decision preparation's questions need nobody once its decision is accepted.
  - The roadmap pass raises a checkpoint item only for an operator-owned checkpoint (a decision or plan acceptance, per `PHASE_BLOCKERS`). It raises one only when some open entry waits on that checkpoint and on nothing that is not the operator's.
  - An entry hold does not repeat a stop that its carrying round's cycle already shows.
  - Nothing is branched on prose (program rule 4).
- **Done when:**
  - On the 2026-09-28 snapshot, the scheduler replay projects no `checkpoint-evidence` item, no decision item that no entry waits on, and neither WI-ADR-008 nor WI-ADR-010's preparation item.
  - It shows one item for EXO-02's owning-slice question.
  - A test covers each rule, and fails without it.
- **Independent review of d39b47a..69d788d and b0eda31 (2026-09-28).** An adversarial reviewer re-ran the replay, built fixtures for the shapes the rule could miss, and mutation-tested each change. Every finding was verified again before it was acted on. Fixed in one follow-up commit, test first:
  - *HIGH, fixed:* the frontier rule treated every non-decision checkpoint as the controller's, because its blocker is the controller-owned `checkpoint-evidence`. The controller produces a checkpoint's evidence only through the delegated review of a slice that requires it at merge. So two shapes went silent:
    - evidence only the operator supplies, required at start, verify or acceptance (on the live map: EXO-ENV-G2 to G4, WI-DEPLOYMENT-PARITY, EXO-EMBEDDED-VIABILITY-1, AQ-PUBLISHED, WI-AQ-G5);
    - a decision behind a slice's delegated merge checkpoint (the live shapes: WI-WORKER-G1 behind its ADRs, EXO-ENV-G1 behind EXO-ADR-037/038).
    
    b0eda31 had then made the status list agree, so nothing said the operator was needed.
    
    The rule (`operatorNeeds`) is now:
    - The operator settles a decision, a plan acceptance, and evidence no slice requires at merge.
    - An entry is on the frontier when every blocker is the operator's or a checkpoint.
    - From its checkpoints the walk follows unmet checkpoint prerequisites. It keeps those the operator settles and can answer now.
    - An entry's state is `needs-attention` exactly when that walk finds one, or every blocker is the operator's own setup.
    
    The inbox, `view()`'s state label and the status list all use this one rule (`operatorActsNext`), which also removes the reviewer's LOW-MEDIUM contradiction: 47 live rows labelled `needs-attention` under "Waiting on automation or other work". They are now `dependency-blocked`, as the inbox says.
    
    Tests in `roadmap-attention-relevance.test.ts`, each failing before the fix:
    - "asks for evidence no review produces once work waits on it" (a `release` checkpoint slice b needs to start);
    - "asks for the decision a slice's own checkpoint review waits on" (a semantic review at slice a's merge that requires a decision).
    
    On the 2026-09-28 snapshot no entry is on the frontier: every blocked entry still waits on an unmerged slice or an unaccepted predecessor, so the pass still projects no checkpoint item.
  - *MEDIUM-LOW, fixed:* LIVE-13's deferral matched any live round for the work item, so a hold on another entry of the same item (another slice's verification, the parent acceptance) was hidden while that round ran. It now defers only to the round started from the held entry. Untested: that case needs two entries of one item held at once; fixed by reading.
  - *LOW, fixed:* the ledger's checkpoint decisions repeated decisions the scope's own `architectureDecisions` already carry. They are no longer repeated.
  - *LOW-MEDIUM, disposition:* LIVE-09's `decisionAccepted` checks for an accepted full decision on the preparation's binding, not its currency. A preparation started after an accepted decision went stale on the same binding would have its questions suppressed. The decision's own checkpoint item is raised again when work needs it, through the rule above. The notifications fixture has no map, so it cannot exercise `acceptedEvidence`.
  - *LOW, disposition:* LIVE-11's plan-acceptance focus exists only for the plan checkpoint the saved-plan evidence supports, which is the only one that generates plan evidence today. Checkpoint evidence opens the evidence form without preselecting its subject.
  - *LOW, disposition:* the checkpoint decisions add tens of KB per decision to each scoped run's ledger (WI-WORKER-G1: about 130 KB after de-duplication), beside 800 KB of accepted evidence. Plan-approval prerequisites are still given by submission ID. Ledger size is R-H4's.
  - *LOW, closed 2026-09-28:* LIVE-13's running-repair assertion depended on timing: it checked the inbox only if the round's repair happened to be running when the test looked. A scripted reply can now wait on a `release` promise, so the test holds the round's reassessment run, asserts no item while it works, then releases it. Removing the running-repair deferral fails it every time (two of two runs).
  - *LOW, closed 2026-09-28:* `decisionAccepted`'s conditions were not isolated by a test. `notifications.test.ts` now keeps a preparation's questions open after a partial decision, a decision on another binding revision, a rejected decision, another checkpoint's decision and another definition's decision. Dropping the coverage, binding, outcome or checkpoint condition fails exactly its own case; the definition is the repository query's argument, so dropping it fails the positive case. The test's repository stubs are restored after each projection (they sat on the shared prototype and leaked into later tests).
  - **Independent review of a73cc06 and d6c2fba (2026-09-28).** The reviewer re-ran both mutations (the running-repair deferral fails the LIVE-13 test 2 of 2; each decision condition fails its own case) and logged the scripted launches: the gated run is the round's reassessment review, and an output-format repair cannot count as one.
    - *LOW, fixed:* the subject-kind condition (`subject.kind === 'checkpoint'`) had no case, so the commit title's "each condition" was overstated. A decision on a slice of the same name now keeps the questions open, and fails without the condition.
    - *NIT, fixed:* the `release` gate's comment now says only a launch's first reply is gated; the new wait's timeout fits inside the test's.
  - *Checked and sound:* every replay difference of the batch; no prose branching or new panel; the "every entry complete" rule and held entries; a cycle stopped at a decision still surfaces through its own item; R-C15's replay difference and test.
- **Done-when met (2026-09-28).** Against the batch's baseline golden (`scheduler-golden-d39b47a.json`), the 2026-09-28 scheduler replay projects:
  - none of the 50 checkpoint items (35 decisions, 15 checkpoint-evidence);
  - neither preparation item;
  - one item for EXO-02's owning-slice question.

  No other record changes except R-C15's packet. Each rule has a test that fails without it.
- **The status list agrees with the inbox (2026-09-28).** R-E3a's list took "who acts next" from the entry's state: any operator-owned blocker made it the operator's. After the frontier rule that put 47 live entries under *Needs you* with no inbox item. The list now uses the inbox's rule (b0eda31, then `operatorActsNext` in the review fix above). Test: `roadmap-attention-relevance.test.ts` checks slice b's row: the controller before slice a merges, and the decision's item after. It fails without the change. On the 2026-09-27 snapshot all 61 rows that linked a checkpoint item move from the operator to the controller (review correction).
- **LIVE-10 fixed (2026-09-28), and LIVE-11's controller-produced items with it.** The roadmap pass raises a checkpoint item only for a checkpoint the operator is needed for now (`neededCheckpoints`):
  - one an open entry waits on while every one of that entry's blockers is operator-owned (`PHASE_BLOCKERS`);
  - once every entry is complete, one the selected scope still needs;
  - and the unmet checkpoint prerequisites of those.

  A non-decision checkpoint that a slice requires reaches an entry as the controller-owned `checkpoint-evidence` blocker, so it is never the operator's alone: the 15 checkpoint-evidence items of 2026-09-28 go with the rule. On the 2026-09-28 snapshot the pass projects none of the 50 checkpoint items; no other replay record changes. Test: `roadmap-attention-relevance.test.ts` (a decision that slice b needs is not asked while b waits for slice a, and is asked once a has merged), which fails without the fix; the supervised-map test keeps its target checkpoint's item at completion.
- **LIVE-13 fixed (2026-09-28).** An entry hold's item defers to the recovery round that carries the entry, as it already deferred to the entry's own cycle: no item while the round's repair runs, and none while the repair's own item carries the stop. The test found a second face of the same defect: after the repair stopped, the controller started a bounded reassessment, and the hold's item stayed open although nobody was asked anything. Test: `server-execution-scope-recovery-waits.test.ts`, "an owning-slice question during a recovery round is one inbox item", which fails without the fix. On the 2026-09-28 snapshot, EXO-02's question is one item.
- **LIVE-11 fixed (2026-09-28).** What remains of checkpoint items is the operator's to settle: evidence nobody's review produces (such as a target checkpoint) and plan acceptance. Opened from the inbox, such an item now brings its form into view: the roadmap's evidence form, or the saved plan acceptance. Test: `inbox-host.test.ts`, "opens a checkpoint item at the form that settles it", which fails without the fix. Architecture decisions keep opening the roadmap's decision controls, as before.
- **LIVE-09 fixed (2026-09-28).** A decision preparation's design-questions item is not raised once an accepted, full-coverage decision exists for its checkpoint on the preparation's binding. Every evidence decision re-derives the workspace's preparation worktrees, so accepting the decision resolves the item in the same write. Test: `notifications.test.ts`, "names a roadmap decision preparation…", which fails without the fix.

### R-C15

**A checkpoint review is given the decisions its checkpoint requires** · Phase P2 · Effort S · Status: done (2026-09-28)

- **Added 2026-09-28** from [LIVE-12](findings/LIVE-live-run-2026-09-25.md#live-12-wi-04s-checkpoint-review-is-still-missing-inputs-the-bodies-of-the-decisions-its-checkpoint-requires). R-C13's checkpoint section named the accepted decisions WI-WORKER-G1 requires only by submission ID. WI-04's reviewer therefore failed the attestation for lack of their clauses.
- **Change:** for each prerequisite met by an accepted architecture decision, the ledger's checkpoint section carries the decision record itself, in the same form as the scope's own `architectureDecisions`, and from the same evaluation (R-C13's one evaluator).
- **Done when:**
  - On the 2026-09-28 snapshot, WI-WORKER-G1's packet lacks no decision (the replay's `packetMissing`).
  - A fixture test shows a checkpoint review given the decision a checkpoint requires.
  - It fails without the change.
- **Done 2026-09-28.**
  - **Change.** In the ledger, each checkpoint's section now carries `decisions`: for every prerequisite that R-C13's evaluation met with an accepted architecture decision, the decision record and its approval. The form is the one the scope's own `architectureDecisions` use (`decisionPacketEntries`, shared). The loop is otherwise sound: the remediation after a failed checkpoint review changes the candidate, which the attestation covers, so it runs again on new inputs.
  - **Test:** `server-execution-checkpoint-attestation.test.ts`. LOCAL-REVIEW now also requires an accepted decision, LOCAL-ADR-01. The checkpoint review's ledger carries its record: the proposal and the approval. The test fails without the change, on the missing record.
  - **Replay:** on the 2026-09-28 snapshot, WI-WORKER-G1's `packetMissing` goes from WI-ADR-016, 008 and 010 to nothing. That cycle record is the only replay change; the step outcomes are unchanged (59 and 356).
  - **After deploy:** resuming WI-04 runs WI-WORKER-G1's review with the decision bodies.

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

**Real routes and one Link component** · Phase P2 · Effort M · Status: done (2026-09-28)

- **Resolves:** [UI-07](findings/UI-information-architecture.md#ui-07-navigation-bypasses-the-router-35-of-49-in-app-links-force-full-reloads-and-deep-link-state-lives-in-ad-hoc-hashquery-parsing), [UI-08](findings/UI-information-architecture.md#ui-08-dead-ends-blockers-that-tell-the-operator-to-go-elsewhere-without-a-link-generic-landing-pages-and-deep-links-that-silently-do-nothing)
- **Change:** Extend Route with sub-routes and typed focus parameters (inbox item, roadmap id/tab/focus, settings section); add <Link route=...> and replace the 35 raw in-app hrefs (which reload the page and drop drafts); remove per-component hash/query parsing and cross-page revealElement; a test that bans raw in-app hrefs.
- **Done when:** No in-app navigation causes a document reload; deep links survive without a specific panel being mounted.
- **Done 2026-09-28** (ADR-015 amended; walkthroughs `2026-09-29-routes-before`, `-routes-after`).
  - **Typed focus.** Roadmaps and settings routes may carry a roadmap (`?roadmap=`) and a focus (`#…`); work items take a focus. `parseRoute(pathname, search, hash)` and `buildPath` handle both, and `useRoute` follows the whole address, fragments included.
  - **One `Link`.** `lib/navigation.tsx` provides the current route and `navigate` below the shell. `Link` is a real anchor that navigates in place on an ordinary click and leaves new-tab and modifier clicks to the browser. `PathLink` does the same for a path held as text (notification records, reason destinations, an inbox item's origin).
  - **Every in-app anchor converted:** the 38 raw links the check found, plus seven whose paths were built from variables. API downloads stay plain anchors, through named helpers.
  - **No panel reads the address.** The design-recovery clarification, the roadmap agent-profile and capacity selections, the host-scheduling alias and the runtime panel's decision focus all read the route. The app reveals a route's focus once its page renders (`useRevealRouteFocus`), waiting for a panel that loads later.
  - **Tests (each fails without its part):**
    - `links.test.ts` parses every component's JSX and fails on an `<a>` whose `href` is an in-app path, a `buildPath` call, or a path it cannot see (a variable, a property, a template starting with a value). It found 38 before the change.
    - `route.test.ts`: round trips with roadmap and focus; malformed values are ignored.
    - `navigation.test.tsx`: an ordinary click prevents the document load and navigates, and removing that fails it; a modifier click and a handler that takes over are left alone; a path is read as a route; a focus is revealed in a panel that mounts later, inside a closed disclosure.
- **Independent review of R-E1 (2026-09-28).** An adversarial reviewer in an isolated worktree reviewed a07dbfe, with jsdom tests and live Chromium against the e2e daemon. No in-app navigation loaded the document (0 page loads across a content link and Back). Its reproductions are now the regression tests `navigation-review.test.tsx`, `DesignRecoveryPanel.clarify.test.tsx` and `e2e/deep-links.spec.ts`; each failed at af86f70.
  - *HIGH, fixed:* a focus was revealed as soon as its target mounted, and panels above it that loaded later pushed it down. `/settings#execution-capacity` landed 602 px down a 900 px view (about 16 px before R-E1). `revealElement` now keeps the target at the top while the page settles (3 s, or until the operator scrolls, types or clicks), and returns a cancel. The e2e spec requires both settings deep links to land within 200 px, and no document load.
  - *MEDIUM, fixed:*
    - The clarification draft ran again whenever the focus returned (an in-page anchor, then Back) and replaced an edited draft. It is now consumed once per cycle and link.
    - It compared the decoded focus with an encoded checkpoint id, so an id with a space never got its draft. It now compares the id itself.
  - *LOW, fixed:*
    - A pending reveal outlived its route. It is cancelled on navigation, so a later page's `#slices` is not stolen.
    - `PathLink` rewrote external URLs and parts a route does not carry. Anything that is not exactly an in-app route stays a plain anchor, and a malformed path no longer throws.
    - The ban test missed calls, ternaries, concatenations and spreads. Any `href` it cannot read is now in-app unless it is a named download helper, and spreads on `<a>` are flagged. All four of the reviewer's shapes are caught.
    - A fragment click fired both `popstate` and `hashchange`, and each replaced the route. An unchanged address now keeps the same route.
  - *NIT, fixed:*
    - `?roadmap=` was decoded twice.
    - Handlers now see only plain clicks, so a new-tab click on an inbox link opens a new tab.
    - The settings panels follow an in-place change of `?roadmap=`.
    - The reveal is keyed on the whole address, so a new arrival at the same focus reveals again.
  - *NIT, disposition:* the `host-scheduling` alias reveals twice (an empty span, then the section). It is harmless. The register's claim that every change has a test is corrected: the alias has none.

### R-E2

**Split the Roadmaps mega-page** · Phase P2 · Effort M · Status: partial (3feb310, 2026-09-29)

- **Resolves:** [UI-05](findings/UI-information-architecture.md#ui-05-the-roadmaps-page-is-an-ever-growing-single-document-with-duplicated-panels-and-no-per-roadmap-route), [UI-17](findings/UI-information-architecture.md#ui-17-roadmap-supervision-panels-share-mutable-page-level-dirty-gates-that-disable-unrelated-decisions)
- **Change:** /roadmaps lists roadmaps (active first, completed under History); /roadmaps/:id is the board and controls; /roadmaps/:id/setup is an ordered checklist (bindings, dependency environment, verification environments, reviewer responsibilities and delegation, automation and agents, plan acceptance); /roadmaps/:id/history holds revisions, amendments and decisions. Remove the duplicate CrossProjectPanel/RuntimeEvidencePanel mounts under ConcurrencyImports; namespace DOM ids.
- **Done when:** No roadmap page exceeds ~3 desktop screens; each concurrency definition is rendered once.
- **Split 2026-09-29 in 3feb310; the done-when is half met** (walkthroughs `2026-09-29-roadmaps-split-before` at 69ce1e1, `-roadmaps-split-after` at 3feb310).
  - **Met: each map revision is rendered once per page** (below; amended by the review).
  - **Page heights, desktop captures before → after, in 900 px screens:** the list 1.0 (new scene); a roadmap's board 1.0 (was part of a 12-to-20-screen page); its history 1.0; a running sequential roadmap 1.5 → 1.2. **Not met:** setup with a form open is 6.0 to 7.0 (was 7.5 to 8.4), and a map's page while a roadmap is being created is 11.2 to 18.3 (was 12.5 to 19.7).
  - **Why, and what is left.** Setup renders the supervisor and every dependency subsection expanded (verification environments, upstream transitions, pin refresh, plan acceptance, decisions), and the map page's creation flow opens the whole selected-work list and dependency graph. Getting them under three screens means showing one checklist step at a time, which means breaking `CrossProjectPanel` and `RuntimeEvidencePanel` up by step. That is R-A6's consolidation of those components, so it is left for R-E2's second increment, done with R-A6 or before it.
  - **Routes.** `/roadmaps` lists the roadmaps: active first, finished ones in a closed section, then the map import with one link per imported map. `/roadmaps/:id` is the board (status, controls, status list, entries), `/roadmaps/:id/setup` the setup and `/roadmaps/:id/history` the history, reached from a `Roadmap pages` tab row under the roadmap's header. `/roadmaps/maps/:id` is one imported map.
  - **Setup** opens with an ordered checklist: bindings, dependency environment, verification environments, reviewer responsibilities and delegation, automation and agents, plan acceptance, then shared architecture decisions. Each step reveals its section. The supervisor, dependency and recovery panels follow.
  - **History** loads the saved revisions itself (no "View revisions" button) and holds the amendments. Decided architecture decisions stay on their cards in setup, beside the pending ones, rather than on history.
  - **Each map revision is rendered once per page.** The old page mounted a map's supervisor and dependency panels twice, once under its roadmap and once under the imports. Now a map's page holds the map's own (which creates roadmaps) and lists every roadmap on the map; each roadmap's setup holds that roadmap's.
  - **Ids are namespaced.** The decision cards take the panel's id (`runtime-evidence-roadmap-<id>-decisions`, or `runtime-evidence-<definition>-decisions` on a map page) instead of the definition's, and the recovery panel has `scope-recovery-<id>`.
  - **Old links still land.** Attention items and notification records keep `/roadmaps?roadmap=<id>#<focus>` paths. The browser opens them on the page that holds the focus (setup for runtime, map, decision, recovery and delegation ids; history for amendments and revisions; the board otherwise), in place, without a document load. The daemon now writes the new paths: a moved pin and a decision preparation open the roadmap's setup at their section, and roadmap-level items its board.
  - **Links follow the roadmap.** A cycle's "Open roadmap requirements" opens its owning roadmap's board, and its shared-decision questions that roadmap's setup at the decision cards (the map's page when no roadmap owns it). Settings and scheduling links open the roadmap they name.
  - **The inbox still hosts the whole roadmap**, board, setup and amendments, in its item (`tab="all"`), so the inbox focuses keep working.
  - **UI-17.** Start and Resume are on the board, and setup drafts live on setup, so a draft no longer disables the board's controls. On setup, an unsaved settings draft no longer disables the shared decisions beside it (review fix); it still holds plan-acceptance evidence, which depends on the saved settings. Leaving setup discards an unsaved draft, as on every other page; inside an inbox item, where both are shown, the draft still holds Start and Resume.
  - **Tests (each fails without its part):** `RoadmapsPage.test.tsx` (the list renders no roadmap body and links each roadmap and map; the board, setup and history each render only their panels, setup's checklist in order; a setup element on the board is a link to setup; a map page renders the supervisor only while no roadmap supervises its binding revision), `route.test.ts` (the new routes; stored links open the right page), `navigation.test.tsx` (a stored link navigates in place), `WorkflowStatus.test.tsx` (links follow the owning roadmap), and the notification path test. Mutations: a board that also renders setup, a cross-page reveal left as an in-page button, a map page that always mounts the supervisor, and old links all sent to the board each fail their tests.
  - **e2e and walkthrough.** `openRoadmap` in `e2e/support.ts` opens a roadmap from the list; specs that used the old page, the map selector or "View revisions" follow the new pages. The walkthrough adds three scenes: a roadmap's board, its history, and the list.
- **Independent review of 3feb310 (2026-09-29, isolated worktree).** The reviewer wrote six jsdom reproductions, all failing at 3feb310, and read the server paths (its source edits for mutation were refused by its permissions). Fixes, each with a test that fails without it:
  - *HIGH, fixed:* the map page hid the roadmap creator whenever any roadmap was on the current binding revision, even a stopped one, so another target or a retry could not be created. The map page now always offers its supervisor, once, and lists every roadmap on the map with its revision and status (`RoadmapsPage.test.tsx`).
  - *MEDIUM, fixed:* on setup, an unsaved settings draft still disabled the shared decisions: UI-17's own example, now beside each other. Decisions and the manual decision panel now wait only for unsaved dependency edits (`RuntimeEvidencePanel.test.tsx`).
  - *MEDIUM, fixed:* "Open verification environments" and "Assign reviewer responsibilities" on a work item's scopes opened the list. They open the owning roadmap's setup at the section, else the map's page (`blocker-destinations.test.ts`).
  - *MEDIUM, fixed:* links to a map's page for decisions or prerequisite evidence landed where the panel was not mounted once a roadmap supervised the map. With the HIGH fix the map's page always has it; the prerequisite link now also names its section.
  - *MEDIUM, fixed:* every roadmap-level item opened the board. Setup needed, checkpoint evidence, decisions to accept and plan acceptance open the setup at their section; an amendment opens history; stops, holds and "resume to run refreshed reviews" stay on the board. `roadmapPath` (`roadmap-paths.ts`) is shared. Tests pin the checkpoint and amendment paths, and each fails when its path reverts to the board.
  - *LOW, fixed:* a stored `#architecture-decisions-<map>` link now opens the roadmap's decision cards (their id changed); a stored link whose fragment cannot be read stays a plain anchor instead of dropping the fragment (`route.test.ts`, `navigation.test.tsx`).
  - *LOW, fixed (tests):* the remaining focus prefixes (`future-delegation-`, `decision-preparation-`, `roadmap-setup-`, `roadmap-revisions-`) are covered.
  - *LOW, disposition:* leaving setup (a tab, or "Review binding reconciliation" to history) discards an unsaved draft, as leaving any page does; a leave warning is for R-D4's page state.
  - *LOW, disposition:* after an import the "duplicate" notice is lost when the map's page opens; the list's import history records the outcome.
  - *LOW, disposition:* a checklist step whose section has not appeared yet (plan acceptance before settings are saved) reveals nothing; the reveal waits for it as a deep link does. One step at a time is increment 2.
  - *NIT, fixed:* `PageTabs` is a shared primitive in `components/`; the list's finished section is "Finished roadmaps", not "History"; list links are 44 px tall; `ui-principles.md` names in-page navigation.
  - *NIT, disposition:* the setup checklist keeps its own ordered list of buttons, not `SectionNav`'s chips, because its order is the point; the rail marks no detail page current (work items, runs and projects are the same); scheduling-page links open a cross-project roadmap's setup, where a capacity change's plan acceptance is.
  - *Checked and sound, per the reviewer:* route round trips; every server-written legacy focus lands on the page that holds it; every inbox focus exists in the inbox view; no page mounts a panel twice or repeats an id; history loads once per revision; the copy and anatomy tests.

### R-E3

**Roadmap board: progress and dependencies at a glance** · Phase P2 (a) / P3 (b) · Effort S-M then L · Status: R-E3a done (2026-09-27); R-E3b open

- **Split 2026-09-27.** [LIVE-08](findings/LIVE-live-run-2026-09-25.md#live-08-the-operator-cannot-see-what-is-supposed-to-run-and-what-blocks-it) showed the operator cannot run the live roadmap without this view. The operator paused delivery work to finish P2, and asked for this visibility first.
- **R-E3a (P2, S-M): the roadmap status list.**
  - A read-only list for one roadmap: every entry, with its state, what it waits on and who acts next (controller, agent or operator), and since when.
    - The state comes from the daemon's status vocabulary.
    - "What it waits on" is a typed reason with a link to its subject: an item, a checkpoint, a decision or a run.
  - It reads R-A4's attention items for operator stops, plus the controller waits that R-C12 and R-C13 record. It shows only what the daemon records, never a status derived in the browser.
  - It adds no decision controls: the actions stay in the inbox (program rule 1).
  - It can live in the existing roadmap section until R-E1 and R-E2 give it a route.
  - **Done when:** loaded from the 2026-09-27 snapshot, the list shows each open entry that LIVE-08 names, with the reason established there by database queries, without leaving the page.
- **R-E3a done 2026-09-27.**
  - **Daemon view model.** `GET /api/workspaces/:ws/roadmaps/:id/status` (member access) returns `RoadmapService.statusOf(roadmap)`: every entry that is not completed, in roadmap order, with its state (the daemon's progress vocabulary), `actor` (operator, controller, agent) and `waitsOn` (reason, code, `since`, and the record it links to). Each part is read, in this order, from what the daemon recorded:
    1. an open R-A4 attention item for the entry, its cycles or the recovery round that carries it, or for a checkpoint among its blockers; the reason is the item's message;
    2. the entry's hold;
    3. the scheduler's recorded wait (R-C12 `entryWaits`, owner from `ENTRY_WAIT`);
    4. the entry's progress: `running` is the agent's only while a cycle runs (the round's repair, else the entry's own), otherwise the stopped cycle's own recorded stop says who acts; any other state is the operator's when the daemon classified it `needs-attention` or `paused`, else the controller's.

    Nothing is decided again; the browser derives nothing. Contract `roadmapStatusListSchema`; the route is in the access inventory.
  - **UI.** An "Entry status" block in each non-draft roadmap's section on the Roadmaps page, read-only, grouped by who acts: *Needs you*, *Agents at work*, *Waiting on automation or other work* (open when it has at most ten entries). Each row links its work item and, where recorded, its inbox item or run. It adds no control (program rule 1). It reloads on the roadmaps and workspace refresh rounds. Walkthrough captures: `2026-09-27-status-list-before` and the after capture in INDEX.md.
  - **Exit criterion, on the 2026-09-27 snapshot** (after the review fixes below). The scheduler replay records each roadmap's status list after its pass (`status` in its output). For the live roadmap: 151 open entries, 20 completed; 64 need the operator (63 through their inbox items, mostly architecture decisions and checkpoint evidence), 87 wait on automation or other work. Every entry LIVE-08 names is explained, with no database query:
    - EXO-02/domain verification: its recovery round, which R-C12 now starts (in the replay the round is reserved and its launch intercepted, so the row shows the round and the stopped review; live, the repair's agent is at work);
    - EXO-02 parent acceptance: waits for EXO-02/domain to be verified (controller);
    - EXO-04/domain verification and EXO-04 parent acceptance: their round's repair waits for EXO-02/domain to be verified (controller);
    - EXO-03/domain verification: paused by the operator (`cycle-paused`);
    - EXO-18: "Operator approval required for EXO-ADR-022", with its inbox item;
    - WI-04/domain: "A complete, passing independent checkpoint attestation is required …", with its inbox item (R-C13).
  - **Tests,** each failing without the change: `roadmap-status-list.test.ts` (through the route: an agent at work with its run, entries waiting on a predecessor, the operator's merge approval read from its inbox item, and an item pause read from its hold); `RoadmapStatusList.test.tsx` (the groups, the inbox and run links, the work-item link, and no buttons).
- **Independent review of 42bca8b (2026-09-27).** An adversarial reviewer replayed the snapshot, timed `statusOf`, and mutation-tested the new test. Every finding was verified again before it was acted on. Fixed in one follow-up commit, test first where a test could pin it:
  - *HIGH, fixed:* inbox-item rows showed the item's title ("EXO-18 · Needs attention"), not why; the done-when needs the reason on the page. Rows now carry the item's message. The route test asserts it and fails without the fix.
  - *MEDIUM-HIGH, fixed:* every `running` progress was shown as an agent at work, including a recovery round whose repair waits (EXO-04 parent acceptance), and run links pointed at the entry's old review. `running` is now the agent's only while a cycle runs (the round's repair, else the entry's own), otherwise the stopped cycle's recorded stop says who acts; items on the carrying round's cycle are linked.
  - *MEDIUM, fixed:* the list applied its own operator rule (every blocker operator-owned), which contradicted the daemon's `needs-attention` (any operator-owned blocker) on 47 rows and never linked checkpoint items. It now follows the daemon's classification and links the checkpoint item among the blockers. Roadmap-level items without an entry (decision preparations) stay in the roadmap's own "Needs you" list above it.
  - *MEDIUM, fixed:* the replay `--check` against the golden recorded before R-E3a reports every new `status:` record. The gate records a new scheduler golden and checks against both; see program.md.
  - *MEDIUM, fixed in part:* the test pinned little. It now also pins the entry-wait branch (a paused cycle's `cycle-paused` wait) and the item reason. Recovery-round linking and checkpoint-item linking are pinned only by the snapshot replay's golden.
  - *MEDIUM-LOW, fixed:* the component sent two requests for a round signalling both topics and could apply an older response over a newer one; requests now run one at a time and coalesce. Completed roadmaps no longer mount the list. `statusOf` costs about as much as `view()`, which the page already pays (90–230 ms on the live roadmap); cheaper reads are R-D4/R-D5's.
  - *LOW, fixed:* the list did not show that the roadmap itself is paused or stopped; it now says so, with the waits marked as from the last pass. A refresh error no longer replaces a loaded list. Blocker codes are an array (`blockers`), not a joined string capped at 200 characters, so no client can branch on string content and no long list fails the contract.
  - *LOW, disposition:* `since` of attention items and first-recorded waits is when this daemon first recorded them; schema 32 rebuilds items at deploy, so the first deploy stamps them with the boot time.
  - *LOW, disposition:* "Open run" and the work-item links follow the page's existing links; in-app navigation without reloads is R-E1's. The groups reuse the `Reasons` styling rather than the component, whose kinds are blocker kinds, not rows. Long reasons are shown in full.
  - *Checked and sound:* the counts; EXO-03, EXO-04/domain, EXO-02 parent, EXO-18 and WI-04 rows; the replay output validates against the contract; member access, workspace authorization and 404 across workspaces; the inbox-embedded view and drafts excluded; no buttons; copy rules.
- **R-E3b (P3, L): the board and graph** below, unchanged.

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

**Operator vocabulary and copy** · Phase P1 · Effort M · Status: done (4c77665, a7d1b19)

- **Resolves:** [UI-11](findings/UI-information-architecture.md#ui-11-walls-of-text-and-headings-written-as-sentences), [UI-12](findings/UI-information-architecture.md#ui-12-vocabulary-density-and-inconsistent-labels), [DOC-04](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-04-vocabulary-is-incoherent-around-blockers-decisions-and-recovery), [UI-10](findings/UI-information-architecture.md#ui-10-recovery-panels-render-when-nothing-needs-recovering)
- **Change:** A glossary of ~15 operator-facing terms in ui-principles; rename map "decisions" to scheduling proposals and finalization "decisions" to finding dispositions in labels only (wire and format names unchanged); align rail and page titles; hide panels that have nothing to recover (IntegrationResolutionPanel, ProviderRecovery after recovery); move explanatory prose into About; headings are short; remove stale copy.
- **Done when:** A lint/test enforces heading length and bans long unconditional prose outside About; the spurious panels no longer render.
- **Progress 2026-09-25 (done):**
  - **Glossary.** `docs/ui-principles.md` "Vocabulary → Glossary" defines 17 operator terms (the commit message of 4c77665 says 18; the count is 17). It gives the wire or format name where a label differs, the five kinds of operator-owned stop, and the controller's waits. A new "Copy" section holds the rules below and the rule against new per-stop recovery panels.
  - **Relabels (labels and messages only; wire and format names unchanged).**
    - Map `decisions` are "scheduling proposals" in the supervisor, the import preview and server messages ("Adopt scheduling proposals", "Scheduling proposals · n/m approved").
    - Finalization `decisions` are "finding dispositions" ("Finding dispositions (n)", "Disposition rationale (required)"; a plan-change choice reads "Plan change rationale").
  - **Rail and titles.** The rail says "Work items" and "Workspaces", matching their page titles. Import plan and Settings pages are titled as their rail links. The Dashboard keeps the workspace name as its title (documented exception).
  - **Panels with nothing to recover.**
    - `IntegrationResolutionPanel` renders only with a resolution on record or an integration stop code (`integration-conflict`, `integration-update-failed`, `integration-refresh-limit`).
    - `ProviderRecovery` renders only while a retry is pending or spent (three attempts, or a `service-*` stop code).
    - Both branch on codes, not text. Their tests fail against the previous components.
  - **Copy.** 25 violations fixed: 24 long unconditional paragraphs moved into `About` or shortened to the one fact that matters, and one 40-word `h3` (scope review recovery while a retry waits) became "Resume interrupted review". The stale "available in later releases. This draft cannot run yet" binding notice is replaced.
  - **Enforcement.** `apps/web/src/copy-rules.test.ts` parses every component with Vite's oxc parser (no new dependency). It fails on a heading (`h1`–`h6`, `legend`, `Section`/`PageHeader` title) over 8 words of fixed text, measuring the longest branch of a conditional. It also fails on an unconditional `<p>` over 160 characters outside `About`. A self-test covers each rule.
  - **Walkthrough.** `2026-09-25-finalization-staged-after` (before) and `2026-09-25-vocabulary-copy-after` (after).
  - **Not done here:** internal terms (binding revision, generation, digest) still appear outside disclosures in the map and evidence panels. Moving them belongs with R-A6's consolidation of those panels.
- **Review 2026-09-25 (independent reviewer), fixes:**
  - **Hiding `IntegrationResolutionPanel` removed the only way to inspect conflicts on a cycle without an integration stop.** A manual "Update from integration" on a paused cycle can conflict without recording a stop; the panel was then hidden, a shell-only dead end (ADR-032). An idle cycle with no integration stop now shows just the "Inspect integration conflicts" action; the panel itself still needs a resolution or an integration code. Codes are read through `effectiveCycleAttention` for records written before codes existed.
  - **`ProviderRecovery` hid a retry that was still running,** and showed a stale failure under an unrelated later stop. The server clears the record when a step succeeds. The panel now shows a waiting or running retry and a service stop (waiting or paused), and nothing else; the gate reads codes only. The not-retryable stop asks for guidance rather than promising a new step window.
  - **The copy check exempted any paragraph under any condition,** so loading guards and permission checks hid 47 always-shown long paragraphs. Only paragraphs that report state are exempt now (`role="status"`/`"alert"`, `error-state`, `warning-state`, `empty-state`). All 47 were rewritten: the fact beside the control stays, the explanation moved into `About`, and no fact was dropped. No state marker was used to dodge the rule.
  - **Labels relabelled that the first pass missed:** map "decisions" in a finalization blocker, finding "decision" wording in four server messages and three finalization components, `docs/security.md`, and "Import a plan bundle" on the project cards.
  - **Facts restored:** "later changes require revalidation", build records "freeze when a run ends" with publication still needing review, and guidance "goes to the next agent run only" is visible again.
  - **Glossary wording:** internal identifiers "belong" in disclosures (a target; see the note above). The glossary has 17 terms.
  - Tests: new panel tests fail on 4c77665; the copy check's self-test covers the state exemption and conditional prose.
  - **Walkthrough after the fixes:** `2026-09-25-vocabulary-copy-review-after`. Its row records 61e41cb, captured from the working tree that became this commit, as the earlier `-after` row recorded its parent.

## Workstream F — Plan and roadmap formats (ground truth; Studio readiness)

### R-F1

**One compiled map model and one requirement evaluator** · Phase P1/P4 · Effort S then L · Status: partial (52c5c8b)

- **Resolves:** [FMT-01](findings/FMT-plan-and-roadmap-formats.md#fmt-01-no-compiled-format-model--22-services-re-interpret-raw-map-json), [FMT-02](findings/FMT-plan-and-roadmap-formats.md#fmt-02-requirement-satisfaction-is-implemented-three-times-with-drift), [FMT-03](findings/FMT-plan-and-roadmap-formats.md#fmt-03-validator-milestone-graph-differs-from-the-domain-milestone-model-demonstrated), [FMT-09](findings/FMT-plan-and-roadmap-formats.md#fmt-09-required-dependency-depends_on-enforcement-is-duplicated-in-six-places), [FMT-10](findings/FMT-plan-and-roadmap-formats.md#fmt-10-producer-sets-and-scope-requirementcase-sets-are-re-derived-in-several-places), [CTRL-14](findings/CTRL-controller.md#ctrl-14-the-same-gates-and-validations-are-duplicated-with-drift)
- **Change:** Immediately: make the importer's cycle check use the same milestone graph as targetClosure (FMT-03 imports a map the supervisor then crashes on). Then: compile a map+binding once into an immutable model (nodes, edges, producer sets, requirement sets) cached by definition/binding revision, and implement requirement satisfaction and depends_on enforcement once; migrate the 22 services that read raw map JSON.
- **Done when:** FMT-03 reproduction is rejected at import; one satisfaction implementation; golden conformance fixtures (R-F4) pass unchanged.
- **Progress:** FMT-03 fixed: the import cycle check includes the implicit milestone edges targetClosure uses. The compiled map model and single evaluator remain.
- **Drift found live 2026-09-25 (EXO-03/domain).** The merge gate (`scopePhaseBlockers`) lets an approved clause-level decision (`stagedDecision`) stand in for the full checkpoint for its named slice. The cycle workflow's checkpoint check (`workflowContext`) accepted only full evidence.
  - Each mergeable review of EXO-03/domain was therefore stopped with `shared-decision-required` for EXO-ADR-037, although its approved clauses cover that slice's merge (approval 229d3d4a, 2026-09-21).
  - `workflowContext` now also accepts `stagedDecision`.
  - `server-execution-reviews.test.ts` asserts the workflow accepts the checkpoint for the named slice and not for the other slice; it fails without the fix.
  - The single evaluator this item plans would remove this whole class of drift.
  - Gate at fb42dc5, on an idle machine during the Codex outage: `pnpm check` is green (186 test files, 1,427 unit, 20 e2e, scope check). The earlier failures in scope-recovery and supervised-maps were waitFor timeouts under the live daemon's load.

### R-F2

**Typed feature recognition instead of prose and magic identifiers** · Phase P3 · Effort M · Status: open

- **Resolves:** [FMT-04](findings/FMT-plan-and-roadmap-formats.md#fmt-04-automation-features-are-enabled-by-matching-prose-and-magic-identifiers-in-the-map), [CTRL-21](findings/CTRL-controller.md#ctrl-21-map-specific-vocabulary-is-hard-coded-in-the-controller), [AGT-55](findings/AGT-GIT-SEC-agents-git-security.md#agt-55-rust--and-project-specific-text-is-hard-coded-into-generic-brief-paths)
- **Change:** Replace exact-English-string, role-name, resource-id and regex triggers with a typed recognition layer and explicit defaults; move role/resource/brief vocabulary into data keyed by map-declared ids; keep today's ids as defaults so the v0.3 map behaves identically.
- **Done when:** Rewording map prose does not change behaviour (test with a reworded copy of the fixture).

### R-F3

**Format ingestion bugs and test honesty** · Phase P0/P1 · Effort S-M · Status: partial (7d44b42, 0ef1c95; FMT-15 done in 432bb00, 0ef20b1)

- **Resolves:** [FMT-08](findings/FMT-plan-and-roadmap-formats.md#fmt-08-work-item-phase-is-unbounded-in-the-normalizer-but-64-in-the-database-and-wire-contract), [FMT-11](findings/FMT-plan-and-roadmap-formats.md#fmt-11-the-studio-seam-is-unused-and-produces-a-different-definition-digest), [FMT-13](findings/FMT-plan-and-roadmap-formats.md#fmt-13-the-same-plan-imported-by-discrete-upload-and-by-zip-gets-different-digests), [FMT-14](findings/FMT-plan-and-roadmap-formats.md#fmt-14-silent-truncation-of-plan-fields-that-agents-treat-as-the-contract), [FMT-15](findings/FMT-plan-and-roadmap-formats.md#fmt-15-execution-tests-bypass-the-importer-with-definitions-it-would-reject), [FMT-16](findings/FMT-plan-and-roadmap-formats.md#fmt-16-roadmap-entry-limits-are-inconsistent-and-settings-are-duplicated-in-every-entry-and-revision)
- **Change:** Diagnose over-long phase at import instead of failing in storage; one digest for the same content regardless of transport (discrete vs ZIP, Studio seam vs ZIP); make truncation of agent-contract fields explicit; make execution tests build maps through the importer; align roadmap entry limits.
- **Done when:** Each reproduction script from the FMT report fails before and passes after.
- **Progress:** FMT-08 and FMT-14 fixed. FMT-13 cannot be fixed without changing existing digests (the live AQ-CONT-1 identity); needs a dual digest / digest v2, which is a schema decision; current behaviour pinned by tests. FMT-11 and FMT-16 open. FMT-15 done 2026-09-25 (432bb00, 0ef20b1; see the amendments below).
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
    - the evidence fixture's extra case `CASE-LOCAL` is now listed in its parent's `source_profile_case_ids`, as the importer requires;
    - the whole-plan parent `local/AQ-02` got its own slice, since the format requires one.
  - **Deviation (operator decision 2026-09-25, "schema-valid fixtures").** An importable map has an implemented upstream, and the runtime then requires every consumer to pin it. A pinned run goes through the pinned Cargo build. Storing the imported map as-is would move about 70 scope tests onto that path and make them need Rust. So the fixtures store the imported map without the two scaffolding repositories (`withoutScaffolding`). The stored map conforms to the v0.3 schema, but not to the importer's cross-stack rules; those wait for R-F5's single-repository profile. Bindings are still written directly, and they bind only `local`.
  - **Behaviour the fixtures now carry that they skipped before:** slices declare the one resource the daemon manages (`isolated-development-workspace`) instead of none, so `withLocalPhaseResources` is gone; the parent's acceptance requires its verified slices; `CASE-PARENT` is a real case that slice a produces, so its scope evidence names it. The supervised maps keep no local case, as before. The sealed package gives the peer lane the one case the format requires.
  - **Test cleanup applies the format check.** `unverifiedRecords` calls `verifyRecords(storage)` with the v0.3 schema check on. A regression test stores a hand-built map with the old `AQ-01` id and asserts cleanup refuses it; it fails with the check off (`map-test-support.test.ts`).
  - **Gate:** 176 test files and 1,391 unit tests pass (1,386 before, plus 5 new tests).
  - **Review 2026-09-25 (independent reviewer; no test found weakened):**
    - **Sealing still overwrote test-authored fields.** Two tests wrote case `source_id: 'local'` (not a source file) and an upstream `provider` that kept a planned repository's merge lane; the importer rejects both, and sealing silently fixed them. Sealing now owns provenance only, and its docstring names each field: source files, archives, locks, repository source ids, work-item and case digests and case `source_id`. An upstream's branch and merge lane are left as the test wrote them. The tests leave provenance empty, and give `provider` a null branch and lock. A new check shows an upstream with a merge lane is refused (`upstream-not-runnable`).
    - **`withoutScaffolding`'s docstring understated what dangles.** It now says the peer lock, any peer case, the `BASE-*` checkpoints and the baseline binding stay, naming removed repositories. The schema check allows that, and no stored scope names them.
    - Nits fixed: the operator-decision date in the docstring, the "Progress" line and the status hashes, and this list's missing `CASE-LOCAL` change.
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

### R-F7

**Map-declared upstream pin transitions for each consumer link** · Phase P2 · Effort M · Status: done 2026-09-29 ([ADR-069](../../decisions/ADR-069-upstream-pin-transitions.md))

- **Added 2026-09-25** after a live stop. Direction confirmed by the operator the same day: the roadmap declares when each consumer moves from its historical upstream to the current pin. Agents don't decide it after the fact, and CraftingTable doesn't infer it from what merged. Once the Planning Studio exists, it authors and maintains these declarations.
- **Resolves:** a gap the review missed. [FMT-04](findings/FMT-plan-and-roadmap-formats.md#fmt-04-automation-features-are-enabled-by-matching-prose-and-magic-identifiers-in-the-map) and R-F2/R-F5 cover how a slice's build mode is written (a regex today, a typed `verification_mode` later). Both treat the mode as a fixed property of the slice, which is the gap this item closes.
- **The incident.** The WI-02/domain verification review, run efef4f4e on 2026-09-25, could not build (finding F-001).
  - `buildVerificationPolicy` gives domain slices `scoped-checks`, so every WI-02/domain run since 09-19 was supplied the historical AQ, 97c9dc26 at 0.1.2 (preparation 1aa15e34).
  - The earlier verification tree sat on WI-02/domain's own merge, 9cbdb13d. The fresh tree sits on the current `wi-fabric-2` head, 03370fd5. By then WI-02/integration had merged eaf7843, which adds `crates/worldinterface-runtime` pinned to AQ `=0.2.0`, so Cargo resolution failed in every scoped check.
  - The review's static evidence passed: 22 of 22 canonical vectors matched and the ports stayed isolated.
- **Why it is general.** Pre-contract development belongs to each consumer→upstream link, not to a slice. Each link switches once, when the consumer's migration to that upstream's current pin merges. Every tree based after that merge needs the current pin, whatever its slice kind. Two things break once stacks are developed concurrently:
  - **Classification ignores time.** On the migrated head, domain and qualifying implementation slices still get the historical upstream. On the live map this affects WI-02/domain now, and WI-03/, WI-04/ and WI-09/domain once their bases move past eaf7843.
  - **`prepare()` is all-or-nothing per tree.** Every upstream comes from the historical preparation, or every upstream comes from the runtime pins. EXO depends on AQ and WI, and the two links can switch at different times. A tree that needs current AQ and historical WI cannot be supplied under either mode.
- **What the live map shows** (read-only analysis of definition 0ebcb7cf, binding revision 4):
  - **wi→aq.** Excluding WI-01/implementation, which qualifies for scoped checks, WI-02/integration is the one WI current-upstream slice that every other WI current-upstream slice requires, directly or transitively. It is the natural transition slice.
  - **exo→aq and exo→wi.** EXO has three independent first current-pin slices, and none requires another:
    - EXO-03/integration requires EXO-AQ-G2/G3 and EXO-WI-G1/G2.
    - EXO-05/integration requires EXO-WI-G1/G2 and no AQ gate.
    - EXO-18/instance-qualification has an early-start exception. It can start once EXO-03/domain and EXO-18/instance-design are verified, and its native builds may precede hardware access. ADR-069's order check found it on 2026-09-25; a pass that merged every phase's requirements had missed it.

    Whichever merges first switches EXO's integration branch. The map's staged contract gates (EXO-AQ-G1..G5, EXO-WI-G1..G5) say when an upstream capability is available to consume. They don't say which EXO slice moves EXO's code onto the current pins.
- **EXO note (operator, 2026-09-25).** Deciding EXO's transitions is a planning decision for the next map revision; the Planning Studio makes it later. The cleanest shape is one explicit slice that adopts EXO's current AQ and WI pins, which EXO-03/integration, EXO-05/integration and EXO-18/instance-qualification all require. The alternative is to declare the move on one of those two slices and add the edge the other needs. It is not urgent: EXO's integration slices are still gated on EXO-ADR-037 and the WI gates.
- **Links are coupled.** A planned upstream's current pin carries its own upstreams, and its historical source carries historical ones. WI's pin (03370fd5) requires AQ `=0.2.0`, and historical WI requires AQ 0.1.x. EXO therefore builds only with exo→wi and exo→aq both historical or both current; a mixed state carries two incompatible 0.x AQ versions, or fails. Coupled links must move at the same slice. The import check derives the pairs from the consumers' upstream lists.
  - Amended after review 2026-09-25: the first version only stopped exo→wi moving before exo→aq, and allowed the reverse.
- **Re-pinning is separate.** After a link goes current, its pin keeps moving (EXO-WI-G1 through G5's release-grade pin). Runtime generations and reviewed refreshes cover that (ADR-058). R-F7 only covers the one-time move off the historical upstream.
- **Not a defect:** a fresh tree reusing another slice's historical preparation. A preparation belongs to the consumer binding and records historical refs for each repository, so any tree of that consumer gets the same sources.
- **Change (design to be settled in an ADR before code):**
  - **Format.** An optional, typed declaration in the map, a v0.3 superset under program rule 2: for each consumer→upstream link, the consumer slice that moves it to the current pin.
  - **Import checks.**
    - The transition slice belongs to the consumer and is classified `current-upstream-build`.
    - Every other current-upstream slice of that consumer requires it, so no integration work can precede its own link's transition.
    - Missing or ambiguous declarations are reported on the definition page rather than guessed.
  - **Dependency choice for each link.** A tree gets the upstream's current runtime pin when either:
    - the tree belongs to the transition slice's own scope; or
    - the tree's base contains that slice's recorded merge, by Git ancestry.

    Otherwise it gets the historical source from the consumer's baseline preparation. The link's merge is recorded when the slice merges.
  - **Receipts.**
    - The run manifest, the receipt and the brief record which source each link used.
    - A receipt satisfies a current-upstream gate only when every link is current. Scoped receipts still never satisfy one (ADR-053).
  - **Fail closed.** If a tree needs a current pin on a link with no transition declared (for example, a consumer current-upstream slice merged first), the run does not start. It raises a typed attention code telling the operator to declare the transition. It never falls back silently.
- **Operator decision 2026-09-25: how the live roadmap gets its declarations.** The live roadmap gets them through an operator-approved declaration record, not a new definition. Under ADR-049, a new definition would need new adoption, new dependency environments and fresh verification and acceptance.
  - The record is typed and attached to the current definition. The runtime view shows it. Each run's manifest records the id of the record that decided a link, and the manifest digest the receipts carry binds that id.
  - It passes the same import checks as the map field would.
  - The next map revision absorbs it into the map, and the record retires.
  - It invalidates no receipt. Every earlier receipt was built either on a base that predates the transition merge, or against current pins; neither depends on the missing declaration.
  - The first record is wi→aq at WI-02/integration, whose merge is already in `wi-fabric-2`. EXO's links wait for the next map revision.
- **Progress 2026-09-25:**
  - **Replay baseline re-recorded first** (program rule 3). On a copy of the 2026-09-23 snapshot at a4aa12d:
    - against `every-run-golden-5e0c638.json`, 109 of 278 decisions differ, the explained R-B10 set;
    - the new `every-run-golden-a4aa12d.json` replays with 0 changed;
    - the 51-decision live golden shows 0 changed.
  - **The declaration and its checks.**
    - `upstream_transitions` is an optional field of the v0.3 schema. Maps without it import with the same digest; the golden test is unchanged.
    - `upstreamTransitionIssues` lives in the domain package, so the import and the operator record share it. ADR-053's classification (`scopedBuildScope`) and `consumerUpstreams` moved there too; `buildVerificationPolicy` and `requiredUpstreams` now delegate to them, with the classification tests unchanged.
    - Tests over the live map (`packages/planning/src/upstream-transitions.test.ts`):
      - wi→aq at WI-02/integration is accepted, and a later slice is refused;
      - every choice of EXO's first slice is refused;
      - once EXO has a single first slice, exo→wi or exo→aq alone is refused for coupling, as are the two at different slices; both at one slice pass.
      - coupling runs only through a planned upstream. An implemented upstream's pin is fixed, and the map declares nothing it consumes; the first version coupled through every implemented upstream, and the integration fixture caught it.
  - **The operator record and choosing sources per link.**
    - Schema 31 adds `upstream_transition_records`, which is immutable. The record kind is registered with the write guard, `db:verify` and the persisted-record contracts.
    - `POST …/runtime/declare-transitions` takes the record ids the operator saw, the transitions and a rationale. It applies the same checks to the map's declarations and the records combined, and audits as `runtime.configured`. It is added to the route allowlist, and the route-access sweep covers it.
    - The runtime view lists every consumer→upstream link: its declaration and source (map or record), or the candidate slices the checks would accept.
    - `prepare()` chooses a source for each link through `chooseUpstreamSources`. A scoped tree takes the current pin once the transition's recorded merge (`integratedSlice`) is an ancestor of its HEAD. Current-pin work on an undeclared link throws `UpstreamTransitionUndeclaredError`, which the controller records as `upstream-transition-undeclared` (operator-owned; Resume after approving).
    - The manifest records each link's `transition`. The brief lists the source for each link and the transition that decided it.
    - Tests:
      - `upstream-transition-policy.test.ts` covers a two-upstream consumer with one link current and one historical, and the stop on an undeclared link.
      - `server-execution-upstream-transitions.test.ts` runs a real Cargo build. It shows the undeclared stop with no agent launched, the record API, and a domain tree before the transition merged staying dependency-free. A fresh domain verification after the merge gets the current pin, and `cargo test` passes against it. That last check fails with the choice reverted to slice kind.
      - The integration-mode build test declares its transition in the map.
    - Replay against `every-run-golden-a4aa12d.json`: 278 decisions, 0 changed. The live golden: 51, 0 changed. Unit suite: 183 files, 1,421 tests.
  - **Independent review (2026-09-25) of 2713a6a, 70b0398, 50da8f8.** Its findings and what was done:
    - **Coupling allowed the reverse mixed state.** Declaring exo→aq at an earlier slice than exo→wi would leave EXO trees on current AQ with historical WI, which needs AQ 0.1.x. Coupled links must now move at the same slice. Tests were updated.
    - **No test covered a recorded merge outside a tree's history, or a real historical preparation.** The end-to-end test now does three things:
      - It merges the transition first, then shows a domain tree based before that merge stays dependency-free.
      - With the consumer's historical preparation attached, the same tree builds the historical provider, and the manifest names the preparation.
      - After the domain merge, a fresh verification gets the current pin.
      - Treating any recorded merge as moved, without the ancestry check, fails the test.
    - **Only the latest merge was checked.** `transitionMerges` returns every recorded merge of the transition scope, direct or reused across an amendment. A tree has moved if any of them is in its history.
    - **The stop pointed to a UI that did not exist yet.** The reviewer saw the server commits only; the UI landed in the next commit.
    - **A configured upstream outside the map could never be declared.** `configure` now refuses consumer upstreams that are not the map's links for that consumer.
    - **Unintended changes in `prepare()`.**
      - A historical preparation with no source for a link conflicts again, as it did before.
      - The scoped brief no longer tells an agent to avoid current pins on a link that has moved.
    - **Record triggers were untested, and the register wording was wrong.** A test now shows the table refuses UPDATE and DELETE. The operator-decision text now says the manifest records the id, and the manifest digest binds it.
    - **Operational note.** After deploy, WI current-pin work stops with `upstream-transition-undeclared` until the wi→aq record is approved. Approve it first.
  - **Gate at 9c1904c.**
    - `pnpm check` is green: 184 test files, 1,425 unit tests, 20 e2e tests and the scope check.
    - Replay: 278 every-run decisions and 51 live decisions, 0 changed.
    - Live state, read-only: the only active WI cycles are WI-04/domain and WI-09/domain, both scoped, so deploying stops nothing in flight. WI-09/domain's tree is on the migrated head 03370fd5, so once the record is approved it gets current AQ.
  - **Remaining for done-when (operator):** deploy, approve wi→aq at wi/WI-02/integration, and relaunch the WI-02/domain verification review.
  - **Follow-up 2026-09-25 (live WI-02/domain review c35785e6).**
    - The deployed fix supplied AQ 0.2.0, and the domain, contract and integration checks passed. F-001 was resolved.
    - The review then raised F-002. The run still reported `scoped-checks`, and WI's `wi-integration.yml` asserts `CRAFTINGTABLE_VERIFICATION_MODE = current-upstream-build` to confirm current AQ pins, so the required integration CI job exited before its tests.
    - ADR-069 had broken an implicit contract: `scoped-checks` used to imply historical or no dependencies.
    - The fix: a scoped tree whose every link is on its current pin now runs as `current-upstream-build` (`movedVerificationPolicy`). CI sees that mode, and acceptance requires a pinned Cargo build/test.
    - The mode is frozen in the run environment record, and `assertRun` only honours it as an upgrade.
    - The end-to-end test shows the moved tree reports the mode and its cargo-tested review is accepted, while a scoped-only review is refused. The test fails without the upgrade.
    - A known limit: the pre-transition freshness check still decides by scope, not by tree.
  - **UI.** An "Upstream transitions" section follows Verification environments in the dependency panel (`UpstreamTransitionsPanel`).
    - Each consumer→upstream link shows its transition slice and whether the map or the operator declared it.
    - An undeclared link offers only the slices the checks accept, or says to declare it in the next map revision when none qualifies.
    - Approval takes a rationale and a confirmation that it is permanent for this map revision. It sends the record ids the operator saw.
    - Walkthrough captures `2026-09-25-upstream-transitions-before` and `-after` were taken; the after set adds scene 41, `roadmaps-upstream-transitions`. On the walkthrough's AQ/WI/EXO map it offers wi/WI-02/integration for WI → AQ, and neither EXO link qualifies.
- **Done when:**
  - A WI-02/domain fresh verification on 03370fd5 is supplied AQ 0.2.0.
  - A pre-migration WI-03/domain tree is still supplied 97c9dc26.
  - A fixture with a two-upstream consumer builds with one link current and one historical.
  - The import checks reject a transition that another current-upstream slice of the consumer does not require.
  - They also reject coupled links that are not declared at the same slice.
  - The live roadmap's wi→aq record is approved, and WI-02/domain's verification passes its checks.
- **Done (2026-09-29, from the 2026-09-29 snapshot).**
  - The wi→aq record 628bf02c (wi/WI-02/integration) was approved on 2026-09-25 at 18:08 UTC. It is the only declaration for WI's link: the map declares none.
  - WI-02/domain's fresh verification review fc699c7f (2026-09-26, 02:59 to 03:12 UTC) ran as `current-upstream-build`, which a scoped tree gets only when every link is on its current pin. It passed every check on d8e1a49a:
    - the domain, contract and integration scoped checks;
    - the pinned Cargo clippy, build and test;
    - all three local CI jobs.
    
    Its first runs failed and passed on rerun: each scoped check once at 03:00, and the domain CI job three times (03:00 to 03:03) before passing at 03:06.
  - Its receipt fe8c2aea was recorded at 07:14, and WI-02 was accepted at 07:30 (06ee33b0).
  - This evidence is from 2026-09-26, not from the fccce06 deploy. Since the deploy, WI-05/domain's design run (11febd2f) also carries `current-upstream-build` from its moved link; integration slices always run in that mode.

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

**Daemon-owned verification receipts** · Phase P2 · Effort M-L · Status: done (2026-09-28; declared checks left for a follow-up)

- **Resolves:** [SEC-01](findings/AGT-GIT-SEC-agents-git-security.md#sec-01-agents-can-forge-the-buildcheckcinative-receipts-that-gate-integration), [AGT-08](findings/AGT-GIT-SEC-agents-git-security.md#agt-08-verification-exists-only-for-cargo-non-rust-repositories-get-no-controller-supplied-verification), [AGT-04](findings/AGT-GIT-SEC-agents-git-security.md#agt-04-the-adapters-hard-code-cargo-and-controller-build-concepts)
- **Change:** Check launchers become thin clients of a daemon-owned socket; the daemon runs the command in its own supervised process group outside the agent's writable roots and writes the receipt to SQLite. Generalize verification beyond Cargo (a declared check command per repository). Until then, label receipts as agent-reported in the UI.
- **Done when:** No gating receipt is read from an agent-writable path.
- **Design, decided by the operator 2026-09-28 (option A).**
  - **What the survey found.** The launchers (`ct-check`, `ct-act`, `ct-native` and pinned `cargo`) run inside the agent's process tree and append JSONL to `<runDir>/dependencies/build-receipts.jsonl`, which is one of the agent's writable roots, like the manifest, the launchers and the CI lock directories under `<cacheRoot>/locks`. `freezeRun` copies the file verbatim, and `assertRun` and `candidateCheckpointIssues` trust its fields.
  - **Spikes on the host.** A Codex `workspace-write` sandbox without network cannot connect to any Unix socket (path or abstract: `EPERM`), so SEC-01's socket would need an escalation per check. Writing files inside its roots works. `systemd-run --user` with `ProtectSystem=strict`, `ProtectHome=read-only`, `ReadWritePaths=` and `PrivateNetwork=yes` works.
  - **Options put to the operator:**
    - (A) launchers write a request into the run's spool; the daemon runs it in a confined transient user unit, records HEAD and cleanliness itself, and writes the receipt to SQLite; the CI lock becomes an in-daemon queue;
    - (B) a daemon socket, rejected by the spike;
    - (C) the daemon re-runs declared checks after the run;
    - (D) move only the files, which leaves the launcher running as the agent.
  - **Operator decisions:**
    - A, in increments: `ct-check`; `ct-act` and its lock; `ct-native`; pinned Cargo's build receipts; a daemon-held manifest; the UI label for earlier receipts.
    - A new append-only receipts table (schema 33). Records frozen before the cutover stay valid for gates and are labelled agent-reported; runs prepared after it gate only on daemon receipts.
    - Also fix: a candidate checkpoint needs the receipt kind its mode requires; scoped mode stops accepting local CI; receipt-producing Cargo runs get the check timeout.
    - `ct-check -- true` still counts as a scoped check, because the agent chooses the command. That stays a residual gap for a follow-up (declared per-repository checks, AGT-08).
  - **Limit.** Claude runs have no OS sandbox, so for them every path the user can write, the database included, is agent-writable. R-G5's Claude sandbox (approved the same day) is what closes that.
- **Increment 0 (2026-09-28): receipt kinds.** One rule (`services/build-receipt-policy.ts`, `receiptKindEstablishes`) decides which kinds establish a mode, for `assertRun` and for the checkpoint candidate:
  - a scoped mode accepts scoped checks, pinned Cargo and native checks made under the scoped policy, but not local CI (ADR-053 amended);
  - a current-upstream mode accepts only a pinned Cargo build.
  
  Before this, a candidate accepted any successful receipt, and a scoped review accepted a CI run alone.
  - **Tests.** `server-execution-receipt-gates.test.ts` (a scoped review with only a CI receipt is refused; the same line as a scoped check passes) and `server-execution-scope-evidence.test.ts` (a current-upstream candidate with only a CI receipt has the receipt issue). Both failed before the change. Dropping the local CI exclusion fails the first again. The candidate fixture now runs the pinned Cargo launcher, as its current-upstream scope requires.
- **Increment 1 (2026-09-28): the daemon runs `ct-check` and records its receipt** (schema 33, `run_check_receipts`; ADR-053 amended; `docs/security.md`, `docs/operations.md`).
  - **The spool** (`packages/agents/src/check-spool.ts`). A run's `ct-check` writes `<id>.request` into `<runDir>/dependencies/requests` and relays `<id>.out` until `<id>.exit`. The agent owns the directory, so the daemon:
    - reads a request only as a regular file (no link or FIFO) of at most 64 KiB;
    - creates each reply file exclusively and without following links;
    - refuses a spool that was replaced by a link.
    
    A request nobody claims within 30 s fails the launcher.
  - **The executor** (`executeCheck`, `local-check.ts`). The daemon runs the command in a transient user unit, `craftingtable-check-<instance>-<request>`, with:
    - a read-only file system except the worktree, the run directory and Cargo's `registry`/`git` caches;
    - a private /tmp, no network and no new privileges;
    - `env -i` with named variables only (`allowlistedEnvironment` plus the run's overlay);
    - the check's time limit.
    
    It observes HEAD and cleanliness itself, before and after, and keeps the log under `<data>/check-logs/<run>/`. `CRAFTINGTABLE_CHECK_CONFINEMENT=none` runs a plain process group (tests; a host without a user manager).
  - **The service** (`services/check-request-service.ts`) serves each live run prepared with `receiptAuthority: 'daemon'`, a new optional field on the run environment. It records a receipt only while the run is live and unfrozen. When the run ends it stops the run's checks and answers any request left. At startup it stops the leftover units of its own data directory (the unit names carry an instance hash, so an e2e or replay daemon never stops the live one's).
  - **Freezing.** A daemon-recorded run's build record is its receipt rows, followed by the launcher file's lines of kinds the daemon does not run yet (CI, native, pinned Cargo). A `scoped-check` line in the file is dropped. A daemon-recorded run with no check freezes an empty record rather than an "unavailable" error, and its gate still refuses it. Runs prepared before this keep the file, as decided.
  - **Tests (each fails without its part):**
    - `server-execution-receipt-gates.test.ts`:
      - a forged `scoped-check` line satisfies nothing, and a real `ct-check` runs in the daemon with only named variables and is recorded (keeping forged file lines fails it);
      - a check still running when its run ends records nothing (recording after the end fails it).
    - `check-spool.test.ts`: the output relay; planted links and FIFOs (following links fails it); malformed requests.
    - `local-check.test.ts`, on the real user manager:
      - a confined check writes its run directory but not HOME, opens no connection and sees `HOME,PATH` only;
      - cancelling stops the unit.
  - **Test harness.** Test replies may be asynchronous. Tests call launchers through `runLauncher`, because a blocking call would starve the daemon that serves it.
  - **Rollback:** a release before this cannot read schema 33, or run environments carrying `receiptAuthority`.
- **Increment 2 (2026-09-28): the daemon runs `ct-act` and owns its lock** (LIVE-03; the R-I11 lock cases).
  - `ct-act` is a spool client too. The daemon checks the workflow and job as before (`localActArguments`) and runs act in a unit with the same file-system limits, plus the CI cache.
    - Network is allowed, because act fetches actions itself. Before this, a Codex run needed an escalation for it.
    - act's HOME and working directory are daemon-owned (`<data>/check-logs/<run>/<request>.private`), so an agent cannot plant an `.actrc`.
    - The run's labelled containers are removed asynchronously, after the job and when it is stopped.
  - **The lock** is an in-daemon queue, `WorkflowQueue`, keyed by the Docker host and the workflow's name. Holders are served in order. A waiter that gives up keeps its place in the chain, so nothing behind it starts early. The daemon also takes the old file lock, to exclude the launchers of runs prepared before the cutover.
  - **The R-I11 edge cases:**
    - The wait counts against the check's time limit; a hold granted too late runs nothing.
    - A wait that expires is a failed receipt marked `workflowWait: 'expired'`, not only prose.
    - The queue is keyed by the Docker host.
    - No act is orphaned by a killed launcher, because it runs in the daemon's unit.
    - No PID identity is needed within the daemon.
    
    Two daemons with different act configurations sharing one socket still exclude each other only through the file lock (disposition: one daemon per host).
  - One act per run at a time, as before. At freeze, act still running is unfinished collection and invalidates the record, as the old lease did. A `local-ci` line in the launcher file of a daemon-recorded run is dropped.
  - **Tests (each fails without its part):**
    - `check-request-service.test.ts`: order and who is waited for; a waiter that expires or is cancelled keeps the order. Breaking the chaining fails it.
    - `local-check.test.ts`: act with a private HOME and working directory under the hold, containers removed; an expired hold is a labelled failure and act never runs; a hold granted after the limit runs nothing.
    - `server-execution-receipt-gates.test.ts`: a `local-ci` line an agent appends is dropped (keeping it fails), and CI still running at the end invalidates the record (ignoring it fails).
- **Increment 3 (2026-09-28): the daemon runs `ct-native`.** It is a spool client too. The daemon starts the approved native unit, with ADR-054's limits unchanged (ADR-054 amended) and a HOME and TMPDIR it owns. It refuses without a current approval, allows one native check per run, stops the unit at the end, and records a `native-check` receipt with the approval identity. A `native-check` line in the launcher file of a daemon-recorded run is dropped, and a native check still running at freeze invalidates the record.
  - **Tests.** `local-check.test.ts` (on the user manager): refused without approval; approved runs in the native unit with the daemon's HOME. `server-execution-receipt-gates.test.ts`: every daemon-run kind an agent appends is dropped. Keeping `native-check` fails it.
- **Increment 4 (2026-09-28): the daemon runs pinned Cargo builds; no gating receipt is read from a file** (ADR-047 amended).
  - The pinned `cargo` launcher sends build commands (`build`, `check`, `test`, `clippy`, …) to the spool. Other commands (`metadata`, `fetch`, `fmt`, …) still run in the agent's tree and record nothing, as before.
  - The daemon repeats the adapter's checks:
    - no configuration or toolchain overrides;
    - unchanged pinned sources;
    - `cargo metadata` in a confined unit, and the resolved graph against the pins (shared helpers in `pinned-cargo.ts`).
  - It then runs the build in a confined unit without network, under the check time limit (the operator's fix: pinned builds had no timeout), and records the pinned receipt with `recordedBy: 'daemon'`. The brief says builds run without network, so `cargo fetch` comes first when needed.
  - A daemon-recorded run's build record is now its receipt rows alone; the launcher file is not read.
  - **Tests (each fails without its part):**
    - `local-check.test.ts`: a build through the daemon with the supplied configuration and the receipt; a sleeping build stopped at a 500 ms limit; `cargo fmt` refused.
    - `server-execution-receipt-gates.test.ts`: a forged pinned-build line is dropped (keeping kindless lines fails it).
    - `server-execution-scope-evidence.test.ts`: the real integration build is recorded by the daemon and satisfies the gate.
- **Increment 5 (2026-09-28): the daemon holds the manifest it verified.**
  - The daemon keeps the manifest text it wrote at launch, checked against the digest it recorded, and runs every check from that text. The published `manifest.json` is only for the agent and CI jobs to read.
  - A daemon-recorded run no longer reads the published manifest, or any lease, at freeze or cleanup. A rewritten or deleted copy can neither steer a check nor invalidate the run's own record.
  - **Test.** `server-execution-receipt-gates.test.ts`: the agent rewrites the manifest (a different workspace and Cargo), then its `ct-check` still runs on the verified manifest, is recorded and satisfies the gate. It failed before the change: the launch aborted on "Verification manifest changed".
- **Increment 6 (2026-09-28): earlier receipts are labelled.** Records frozen before the cutover stay valid for gates (operator decision). The runtime view's build records carry `receiptAuthority` (`daemon` or `agent`), and the panel marks the agent's as "agent-reported". It is a text label, so the page structure is unchanged and no walkthrough capture was taken. Test: `RuntimeEvidencePanel.test.tsx` fails without the label.
- **Independent review of R-G4 (2026-09-28).** An adversarial reviewer in an isolated worktree reviewed 95c4a17..6bb668a on the real user manager. It replayed copies of all four snapshots in all three modes: 12 replays, 0 changed. The review was stopped early by a safety classifier, so its list of what was not covered is recorded below.
  - *HIGH, fixed:* the unit left the worktree's `.git` pointer writable. A Codex agent could point it at a repository whose configuration names an fsmonitor command, and the daemon's own `git status` after the check then ran that command unconfined, with the daemon's environment. Before R-G4, the same check ran inside the Codex sandbox, which keeps `.git` read-only.
    - The daemon now resolves the worktree's git directory and common directory before the agent starts, and holds them in the manifest (`resolveGitDirectories`).
    - Its Git on the worktree uses them rather than the pointer: `GIT_DIR`/`GIT_WORK_TREE`, `-c core.fsmonitor=false -c core.hooksPath=/dev/null`, no system or global configuration, named variables only. The act mounts use them too.
    - The unit keeps `<worktree>/.git` read-only.
    - Tests (`check-review-2026-09-28.test.ts`): on the user manager, a check cannot rewrite the pointer; unconfined, a rewritten pointer and a repository-configured fsmonitor are not followed. Removing the read-only path, the `-c` options or `GIT_DIR` each fails a test.
  - *MEDIUM, fixed:* reply files followed a spool directory the agent replaced with a link after the claim, so the daemon could create `<id>.out` and `<id>.exit` in any directory the user can write. Replies now go to a daemon-owned directory, `<data>/check-logs/<run>/replies`. The agent can read it, but the daemon never writes into a path the agent controls. Test: the swapped spool gets nothing.
  - *MEDIUM, fixed:* nothing bounded how many checks a run could start, and each one hashed sources on the event loop and kept up to 2 MiB of log. Now at most 4 of a run's checks run at once, and 8 in the daemon; a run may have 32 waiting, oldest first, and the rest are refused. A waiting check can be cancelled. Test: 40 requests at once peak at 4 running, 4 are refused and 36 are recorded. Raising the per-run bound fails it.
  - *LOW, fixed:* check logs were never pruned. Like run directories they are retained, but now within a budget: 2 MiB per check and 256 MiB per run, with truncation marked in the log. Test: a 64-byte limit truncates the log.
  - *MEDIUM, fixed:* after a restart, nothing stopped a daemon-run native unit or removed a run's act containers, because `cleanupRun` skipped daemon-recorded runs and act's containers belong to the Docker engine rather than the unit. When such a run ends, including when restart recovery ends it, the daemon now stops `craftingtable-native-<run>` and removes containers labelled with the run, using its own CI configuration rather than the run's manifest (`cleanupDaemonRunChecks`). Test: a run that never ran CI still has its labelled containers looked up and removed. Skipping the cleanup fails it.
  - *MEDIUM, fixed by operator decision (finding 6, 2026-09-28):* `ct-act` now runs a repository workflow against the Docker host without the escalation a Codex run needed before, and a workflow's own `container:`/`services:` options could bind host paths into a job. None of the live repositories' workflows (EXO, WI, AQ) uses `container`, `services`, a job-level `uses` or a `docker://` step.
    - The operator chose to refuse them. `localActArguments` parses the workflow (`yaml`, already a workspace dependency, now also declared by `packages/agents`), follows aliases, and refuses any job that declares `container`, `services` or a reusable workflow (`uses`), or has a `docker://` step. An unreadable workflow is refused too. ADR-053 is amended.
    - Test: `local-check.test.ts`, one case per key plus an alias, fails without the check.
  - *Not covered by the reviewer, and checked since:*
    - The increment 0 kind rule against frozen receipts: the reviewer's replays report 0 changed, including the scheduler's checkpoint readiness.
    - Receipt sequence numbers: each is assigned inside a synchronous transaction in the one daemon process, so concurrent checks cannot collide.
    - Toolchains with HOME read-only: in a unit confined as the checks are, with the live daemon's PATH, `cargo`, `rustc`, `node`, `pnpm` and `git` all run.
    - Mutation checks were run for every fix above.
- **Status (2026-09-28): done.** Increments 0 to 6 and the review fixes. For runs prepared after the cutover, no gating receipt is read from an agent-writable path. Records frozen earlier stay valid and are labelled agent-reported. Two gaps are left open: `ct-check -- true` still counts as a scoped check (the declared-checks follow-up, [R-G13](#r-g13), AGT-08), and Claude runs have no OS sandbox (R-G5).
- **First live day (2026-09-29 snapshot, fccce06).** 749 `craftingtable-check-*` units started in 10.5 hours (plus 493 `-metadata` units), and 790 daemon-recorded receipts were stored. The daemon journal has no warnings or errors since the boot. Failed units are check results (exit 1 or Cargo's 101) with two other patterns:
  - Two agent-chosen pinned Cargo commands needed a registry index update, which the no-network unit refuses ("Could not connect to index.crates.io"). The crate (`fs2`) was in the daemon's Cargo home; the lock resolution was not.
  - Four checks exited 127 (`env … scripts/check-wi-{integration,contract}.sh`, 06:59, 09:44, 11:28, 12:38). The cause is unverified: the check logs were not read.
  
  No gate or stop depended on any of these. Local CI ran 99 times with no Docker collision seen (LIVE-17).

### R-G5

**Agent environment and configuration isolation** · Phase P2 · Effort M · Status: done (2026-09-28)

- **Resolves:** [SEC-02](findings/AGT-GIT-SEC-agents-git-security.md#sec-02-agent-confinement-is-cooperative-in-practice-inherited-desktop-environment-routine-sandbox-escalation-docker-socket), [SEC-03](findings/AGT-GIT-SEC-agents-git-security.md#sec-03-daemon-git-calls-execute-repository-controlled-hooks-and-config-the-existing-hardening-is-unused), [AGT-14](findings/AGT-GIT-SEC-agents-git-security.md#agt-14-supervised-agents-inherit-the-operators-personal-claudecodex-configuration-hooks-plugins-skills-memory-mcp), [GIT-08](findings/AGT-GIT-SEC-agents-git-security.md#git-08-daemon-authored-commits-and-merges-run-repository-hooks-outside-agent-supervision)
- **Change:** Build the child environment from an allowlist in one place; run agents with isolated Claude/Codex configuration (no operator hooks, plugins, skills, memory or MCP unless declared); lay out the sandbox so ordinary commits and loopback tests need no escalation; disable repository hooks/fsmonitor for daemon Git operations; snapshot protected refs before/after each run and flag unexpected moves.
- **Done when:** A run's environment contains only allowlisted variables; supervised Claude runs do not load the operator's skills.
- **Design, decided by the operator 2026-09-28.**
  - **What the survey and probes found.**
    - Agents inherit the daemon's whole environment: D-Bus, Wayland/X11, Hyprland, `XDG_RUNTIME_DIR` with the Docker socket, `GUM_*`, the mise activation variables.
    - A headless Claude run with the operator's settings loads 47 skills, the superpowers plugin and its SessionStart hook, the claude.ai Docs and Drive MCP connectors, and auto-memory. With `--setting-sources project,local --strict-mcp-config --disable-slash-commands --settings '{"autoMemoryEnabled":false}'` it loads none of them (checked on the CLI's init event). `--bare` is out, because it refuses OAuth.
    - Codex loads `node_repl` from `~/.codex/config.toml`, `cua_repl` and `codex_app` from plugins, and two user skills. `--disable plugins`, `--disable apps`, `--disable hooks`, `--disable memories`, `-c mcp_servers.<name>.enabled=false` and `-c skills.config=[{name,enabled=false}]` remove them all (checked with the app-server's `skills/list` and `mcpServerStatus/list`). Only Codex's own system skills remain.
    - Both agents sign in through OAuth files under HOME, and Codex refreshes its `auth.json` in place. A separate config directory would break token refresh and the resume of live sessions, so the operator's HOME stays and loading is switched off by flags.
    - The Claude adapter ignores the profile's reasoning effort, so every Claude run inherits the operator's `effortLevel`.
    - Daemon Git reads the operator's global configuration, including `rerere` and `diff.mnemonicprefix`, and runs hooks. The hardening SEC-03 cites was deleted with the inspector in c0ccf3b.
  - **Approved, in increments:**
    1. an allowlisted child environment;
    2. Claude isolation flags on every posture, plus `--effort` from the profile;
    3. Codex feature and MCP/skill switches;
    4. daemon Git hardening;
    5. the Claude OS sandbox (SEC-02c);
    6. protected-ref snapshots (SEC-02d).
    
    Each run's loaded skills, plugins and MCP servers are recorded at session start as the done-when's evidence.
- **Increment 1 (2026-09-28): an allowlisted agent environment** (SEC-02, AGT-04).
  - Both adapters start the agent from `agentEnvironment`, which passes:
    - named variables only: HOME, USER, LOGNAME, SHELL, PATH, LANG, LANGUAGE, `LC_*`, TERM, TZ, the four `XDG_*_HOME` directories, proxy and CA variables;
    - the agent's own login variables;
    - names the operator allows with `CRAFTINGTABLE_AGENT_ENV_ALLOW`;
    - then the run's overlay, which the daemon now computes (scratch `TMPDIR`/`TMP`/`TEMP`, `CARGO_TARGET_DIR` from R-G7's cache, the run namespace), with its launchers ahead of PATH.
  - The adapters no longer contain Cargo policy (AGT-04). `docs/operations.md` is updated.
  - **Tests.**
    - `claude-code/backend.test.ts`: an environment carrying DISPLAY, Wayland, D-Bus, `XDG_RUNTIME_DIR`, an SSH agent, Hyprland and an undeclared name reaches the agent as exactly the allowed names, the declared one and the overlay. It fails without the change.
    - The Codex adapter test passes the overlay.
    - `server-execution-runs.test.ts`: the daemon puts the worktree cache in `CARGO_TARGET_DIR`.
- **Increment 2 (2026-09-28): Claude runs never load the operator's configuration** (AGT-14).
  - Every posture passes `--setting-sources project,local --strict-mcp-config --disable-slash-commands --settings '{"autoMemoryEnabled":false}'`. The repository's own `.claude` settings and CLAUDE.md still apply, because the repository declares them.
  - The profile's reasoning effort would be passed as `--effort`, but Claude profiles cannot carry one yet (see the review below); the operator's `effortLevel` is no longer inherited.
  - `session-started` records what the session loaded (`loaded`: skills, plugins, MCP servers), a new optional field on the run event, from the CLI's init message.
  - **Live check** (the real CLI through the adapter, a Haiku run at low effort): skills `[]`, MCP servers `[]`, plugins `agents-md` and `telemetry` (Claude Code built-ins). With the operator's settings, the same probe loaded 47 skills, superpowers and two claude.ai connectors.
  - **Tests.** `arguments.test.ts` (every posture, including read-only, carries the flags once; effort only when the profile sets it) and `normalize.test.ts` (the loaded names). Each fails without its change.
- **Increment 3 (2026-09-28): Codex runs never load the operator's plugins, hooks, memories, MCP servers or skills** (AGT-14).
  - Before each run, a short-lived app-server started with `--disable plugins --disable apps --disable hooks --disable memories` reports what the operator's configuration still adds: its MCP servers, and skills of `user` scope. `codex/isolation.ts` has the probe and the argument builder.
  - The run's app-server gets the same flags, plus `-c mcp_servers.<name>.enabled=false` for each server and `-c skills.config=[{name,enabled=false},…]` for each user skill.
  - The probe runs every time, so a configuration change applies to the next run.
  - It fails closed: a run whose configuration cannot be read does not start (`AgentLaunchError`), and a name that a `-c` override cannot address is refused rather than left loaded.
  - Repository and system skills stay, the repository's because the repository declares them.
  - `session-started` records the enabled skills and the live MCP servers.
  - **Live check** (the real Codex through the adapter): skills are only Codex's six system skills; MCP servers `[]`; plugins `[]`. Before, the same machine loaded `node_repl`, `cua_repl`, `codex_app` and two user skills.
  - **Tests.** `codex/backend.test.ts`:
    - the fake app-server adds an operator skill and MCP server unless switched off; the run's app-server is started with both switches, and its `session-started` lists only the repository skill;
    - a configuration that cannot be read stops the launch.
- **Increment 4 (2026-09-28): daemon Git runs no repository hooks, fsmonitor or operator configuration** (SEC-03, GIT-08; the hardening SEC-03 cites was deleted in c0ccf3b, so this rebuilds it in `operations.ts`).
  - Every command passes `-c core.fsmonitor=false -c core.hooksPath=/dev/null`, and every diff passes `--no-ext-diff --no-textconv`.
  - It runs with PATH, HOME and a C locale only, no system configuration, and as global configuration only a daemon-written file holding the operator's `user.name` and `user.email` (`writeDaemonGitIdentity`, `<data>/git-identity.gitconfig`).
  - The operator's `rerere`, `diff.algorithm` and `diff.mnemonicprefix` therefore no longer apply to daemon merges and diffs. All four live repositories name their own committer, so their merge authorship is unchanged.
  - A repository's own configuration (merge drivers, signing program, filters) still applies (`docs/security.md`, "Daemon Git").
  - **Tests.** `packages/git`, "daemon Git runs no repository hooks…": with hooks and fsmonitor configured in the repository, and a global configuration naming an fsmonitor, a checkpoint commit, worktree creation, a merge and an inspection run none of them. It fails without the change.
    - The GIT-01 timeout tests relied on hooks. They now slow the merge with a signing program (after `MERGE_HEAD`) or a merge driver (before it). For the driver case the check is on tracked state, because a killed driver leaves temporary files and recovery keeps unknown files.
    - Test fixture repositories name their own committer, as the live ones do.
- **Increment 5 (2026-09-28): Claude runs' Bash in the OS sandbox** (SEC-02c).
  - Every posture except unrestricted passes Claude Code's sandbox settings: enabled, `failIfUnavailable` (a run does not start without it), `allowUnsandboxedCommands: false` (no command may leave it), loopback binding for tests, and network only to the dependency hosts (`SANDBOX_ALLOWED_DOMAINS`: Cargo, npm, GitHub).
  - Writes are limited to the worktree, the run's `--add-dir` directories (run directory, R-G7 cache) and its TMPDIR. Commits in a managed worktree still work.
  - Edit and Write stay under the permission posture, as before; the sandbox covers Bash.
  - The host needs bubblewrap and socat; this workstation has both.
  - **Live check** (the real CLI through the adapter, `auto` posture, a managed worktree): a write to HOME gets "Read-only file system"; `git commit` succeeds; `curl https://example.com` gets "CONNECT tunnel failed, 403"; `static.crates.io` is reached.
  - **Test.** `arguments.test.ts`: auto, edit-only and read-only carry the sandbox with no way out and no Unix sockets; unrestricted has none. It fails without the change.
  - **Consequence:** a Claude run can no longer reach other hosts from Bash. After the review, it reaches no host at all (see below).
- **Increment 6 (2026-09-28): protected-ref snapshots** (SEC-02d; schema 34 adds one audit action).
  - Before each run the daemon records its repository's branch heads (`branchHeads`, `services/ref-watch.ts`). When the run ends it compares every branch no managed worktree owns: main, integration branches, the operator's own.
  - A branch that moved counts as the daemon's if one of its own Git operations during the run left it at that commit. Every daemon operation that can move a branch records the heads it left behind (`RefWatch.wrap` around the daemon's Git).
  - Any other move is flagged in two places: a notice in the run's journal, "Protected branches moved during this run, not by CraftingTable: …", and an audit record, `agent-run.protected-ref-moved`, with the moves, shown in the audit panel.
  - The snapshots are kept in memory, so a restart ends the runs it watched.
  - Routing such a flag to the inbox would be a new attention kind (R-A4). It is left as an operator decision.
  - **Tests.**
    - `ref-watch.test.ts`: a daemon merge into the integration branch and a run's own branch move are not flagged; a main moved and an integration branch deleted outside the daemon are.
    - `server-execution-runs.test.ts`: `main` moved by `git update-ref` during a live run is audited against the run, with the move, and noted in its journal. Skipping the check fails it.
- **Independent review of R-G5 (2026-09-28).** An adversarial reviewer in an isolated worktree reviewed 7b5751a..29d3524. It replayed all five snapshots in all three modes (0 changed) and ran the tests. Much of what it found is about increment 5, whose guarantees were weaker on this workstation than recorded.
  - *HIGH, fixed:* the sandbox did not block Unix sockets, so the rootless Docker socket in `/run/user/<uid>` was reachable from sandboxed Bash, and through it a container with the operator's HOME mounted. Claude Code blocks sockets only with its optional seccomp helper, which this host lacks, and it runs without it after a warning. Sandboxed Bash may now not read `/run/user/<uid>` or the system Docker sockets.
  - *MEDIUM, fixed (three findings):*
    - the auto posture let each command name more hosts, because the allowlist was not strict;
    - the allowed GitHub host plus readable credentials made an exfiltration or push channel;
    - the dependency hosts were useless anyway, because Cargo's and npm's caches are not writable in the sandbox.
    
    The network is now empty and strict (loopback only), and sandboxed Bash may not read `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.docker`, `~/.config/gh`, `~/.git-credentials`, `~/.codex` or Claude's credentials. Dependencies come through the daemon's checks or are fetched beforehand, as for Codex runs.
  - *MEDIUM, fixed:* project and local settings came from a worktree the agent can write, and they can widen the sandbox (`excludedCommands`, `allowWrite`) or add hooks that run outside it. Claude runs now load no settings file from any scope (`--setting-sources ''`); the repository's CLAUDE.md still applies. No live repository tracks Claude settings; their primary checkouts hold only the operator's untracked `settings.local.json`.
  - *LOW, fixed:* `autoAllowBashIfSandboxed` had changed edit-only's meaning, auto-approving any sandboxed command. It is now set only for the auto posture.
  - **Live check** (the real CLI through the adapter, auto): the Docker socket gets "Could not connect to server"; `ls ~/.ssh` shows nothing; `static.crates.io` gets "not on allow list"; a managed-worktree commit succeeds.
  - **Tests.** `arguments.test.ts`: no setting sources; the empty strict network; the denied reads; auto-approval only in auto. Each fails without its change.
  - *MEDIUM, fixed:* the ref watch credited any later daemon operation on the repository with an agent's move: the agent moved main, an unrelated worktree was created, and nothing was flagged. Each daemon operation now records the refs that changed across it (their heads before and after), and a move counts as the daemon's only when one of its operations moved that ref to that commit.
  - *LOW, fixed:*
    - Observations were keyed by the operation's path, so a worktree-path operation (a checkpoint, a resolution) was filed under the worktree rather than the repository, which could produce false positives. `branchHeads` now reports the repository's common git directory, and everything is keyed by it.
    - Tags were not watched. They are now: baseline tags live there, and `ensureBaselineTag` counts as a moving operation.
    - A failed comparison skipped the run's other cleanup; it is now caught and logged.
    - A snapshot never checked (a run that ended with a crash) is dropped after 48 hours.
  - *LOW, disposition:* two daemon operations that overlap an agent's own move of the same ref could still credit it to the daemon. The window is the length of one Git operation.
  - **Tests.** `ref-watch.test.ts`: the reviewer's case (an agent's move of main followed by an unrelated daemon operation is flagged), and a moved tag. The first passed against the old code, which confirmed the gap.
  - *LOW, fixed:* daemon Git still read the operator's ignore and attributes files under HOME. It now passes `core.excludesFile=/dev/null` and `core.attributesFile=/dev/null`. Test (`packages/git`): with a global `status.showUntrackedFiles = no` and a global ignore file naming it, the daemon still lists an untracked file. Without the change the file is hidden, and restoring the operator's global configuration fails the test too, so the environment change is now covered (the reviewer's mutation had passed).
  - *LOW, corrected:* the increment 2 entry said the profile's reasoning effort is passed as `--effort`. The adapter passes it, but Claude profiles cannot carry an effort today, because contracts and services refuse it for non-Codex profiles. Claude runs therefore get the CLI's default effort now that the operator's `effortLevel` is no longer inherited. Allowing effort on Claude profiles is a contract change, left as an operator decision.
  - *NIT, fixed:* a configuration name the switches cannot address surfaced as a plain `Error`; it is now an `AgentLaunchError` (test: `codex/backend.test.ts`). The recorded Codex `loaded` lists are capped at 500, as the event contract requires.
  - *NIT, dispositions:*
    - The probe ignores pagination; the reviewer found 120 servers returned in one page.
    - The probe starts the operator's MCP server processes once per run.
    - `skills.config` disables by name, so a repository skill with a user skill's name is disabled too.
    - `--disable-slash-commands` disables repository skills for Claude, while Codex keeps them.
- **Status (2026-09-28): done.** Increments 1 to 6 and the review fixes. Done-when evidence:
  - a run's environment holds only allowlisted variables (increment 1's test);
  - supervised Claude runs load no operator skills, plugins, MCP servers or memory (increment 2's live check); Codex runs load none of the operator's (increment 3's live check).
- **Follow-ups the operator decided after the batch report (2026-09-28).**
  - **crates.io in Claude's sandbox: done.**
    - The sandbox allows `index.crates.io` and `static.crates.io` (the apex `crates.io` was dropped after the review), still under a strict allowlist, so the brief's `cargo fetch` can download dependencies.
    - It may write Cargo's `registry` and `git` caches, in the daemon's own Cargo home since the review (see below), and nothing else of the home directory.
    - The daemon names the run's `CARGO_HOME` (the check units' one), so the agent and its sandbox agree on the location. The adapter creates the two caches before launch, because the sandbox can make only an existing directory writable.
    - Live check: a sandboxed Claude run downloaded a crate into a fresh Cargo home. Its write to the home's root and a request to another host were refused.
    - **Codex:** its sandbox has only all-or-nothing network, so Codex runs still reach nothing. A place to configure sources like this one, and a way to give Codex the same access, is [R-G14](#r-g14).
  - **Reasoning effort on Claude profiles: done.**
    - Contracts, the domain's `selectAgent`, and the run, profile and cycle services no longer refuse an effort for Claude. The adapter already passed it as `--effort`.
    - Every form that picks an agent offers the effort for both backends. An unset effort reads as the local Codex configuration, or as Claude Code's default.
    - ADR-064 is amended.
    - Tests:
      - `server-execution-runs.test.ts`: a Claude profile saves with an effort, and a Claude run launches with one. Before the change, both were refused with 409.
      - `agent-profiles.test.ts`: `selectAgent` keeps a Claude effort. Mutation: restoring the Codex-only condition fails it.
      - `settings-page.test.tsx`: the field shows for a Claude profile, with its default label.
    - **Rollback:** a release before this rejects stored selections that carry a Claude effort.
  - **Protected-ref moves in the inbox, with Acknowledge: done** (the operator chose a move record and Acknowledge).
    - The daemon keeps each flagged move in `protected_ref_moves` (migration 0035, schema 35), in the transaction that audits it.
    - Triggers allow no change but the acknowledgement, added once, and no delete.
    - The inbox shows one `protected-ref-moved` item per repository: each move is a member, so a new move pages again. The item lists the moves, opens the latest run, blocks nothing, and offers Acknowledge.
    - `POST …/protected-ref-moves/acknowledge` (editor) acknowledges exactly the moves the item listed, all or none, audited as `protected-refs.acknowledged`. The item resolves as the operator's in the same commit.
    - Tests:
      - `server-execution-runs.test.ts`: two runs each move main. Acknowledging the first leaves the second open, and acknowledging the rest resolves the item as the operator's. A repeat acknowledgement is refused; the database refuses an edit and a delete.
      - `AcknowledgeMoves.test.tsx`: the control sends exactly the listed ids, reports a refusal, and is disabled for viewers.
    - **Rollback:** a release before this cannot open a schema-35 database.
  - **Independent review of the follow-ups (2026-09-28, d6823bf..c9b3d78, isolated worktree).** No HIGH findings. The reviewer re-ran the LIVE-15 and effort mutations (all fail as claimed) and emulated the sandbox's write set with bwrap (the fetch succeeds).
    - *MEDIUM, fixed:* the `crates.io` apex is the write API (publish, yank), not needed for a sparse fetch, and so a way to carry data out. Cargo's credential files were readable. The sandbox now allows only `index.crates.io` and `static.crates.io`, and denies reading `credentials.toml` and `credentials` in the Cargo home (test: `arguments.test.ts`).
    - *MEDIUM, fixed by operator decision (a daemon-owned Cargo home):*
      - **The finding.** Writing the operator's `~/.cargo` caches let a sandboxed agent plant crate sources that Cargo trusts, which would run unsandboxed in the operator's own builds.
      - **Why it was new for most runs.** The check units already wrote those caches, but only for runs with a daemon verification environment.
      - **The fix.** Agents and check units now use `<data>/cargo-home`. At each start the daemon copies into it, one way, the registry and Git caches it lacks from the operator's Cargo home (`syncDaemonCargoHome`: copy-on-write where possible, never replacing a file, never copying tokens, configuration or binaries), so offline builds and Codex runs keep working.
      - **Tests:**
        - `daemon-cargo-home.test.ts`: what is and isn't copied; nothing flows back; later crates arrive; no Rust, or seeding off.
        - `server-execution-runs.test.ts`: agents get the daemon's home.
        - `server-execution-receipt-gates.test.ts`: a check unit reports it. Mutation: the operator's home fails it.
      - **Left:** runs can affect one another through the shared daemon cache, as check units already could. Approved native units (ADR-054) are not file-confined and keep the operator's Cargo home.
    - *LOW, fixed:* the trigger's central clause (only the acknowledgement may change) was untested; the test edited a row already acknowledged. And `INSERT OR REPLACE` removed a row without firing any trigger. A new trigger refuses a replace (migration 0035 is not deployed yet, so it is amended in place). Test: `protected-refs.test.ts` (an acknowledgement that also rewrites the moves, an edit without one, a replace). Mutation: removing the clause fails it.
    - *LOW, fixed:* a large set of moves broke the flag.
      - **Too many moves in one run.** A run that moves more than 1000 refs (a fetch of many tags) failed the record's bound and rolled back the audit with it.
      - **Too many to acknowledge.** An item with more than 1000 moves could not be acknowledged.
      - **Duplicates.** Overlapping runs recorded the same outside move once each.
      - **The fix.** The audit is now written in its own transaction. Moves are split into records of at most 1000, and a move already waiting unacknowledged is not recorded again. The control acknowledges in batches of 1000. Branch names may be up to 4096 characters.
      - **Tests:** `ref-watch.test.ts` (the dedupe and the split) and `AcknowledgeMoves.test.tsx` (2300 ids in three requests).
    - *LOW, fixed:* for a cycle no roadmap owns, the `upstream-pin-moved` item linked to `/roadmaps#runtime-evidence-<definition>`. That panel renders only after a map revision is picked, so the link landed nowhere. Such an item now opens the cycle's own page, and a roadmap-owned one still opens its roadmap's dependency environment. The LIVE-15 test asserts the unowned path; `inbox-host.test.ts` covers the owned host.
    - *NIT, documented:* a sequential roadmap's Start or Resume resumes its cycles in turn, so it is refused while an `upstream-pin-moved` stop is stale. That is coherent (the refresh needs the roadmap paused), and it is now stated in ADR-058. Cycles resumed earlier in the same loop staying resumed predates this change.
    - *NIT, fixed:* `refs.pins` allowed at most 50 entries, and a larger set would have failed the stop's write. It now allows 1000.
    - *Out of scope, documented:* Claude Code's network allowlist gates sandboxed commands only, not its in-process WebFetch and WebSearch tools. `docs/security.md` now says so.
    - **Checked and sound, per the reviewer:**
      - The pin error's classification and its HTTP status.
      - The resume guard, which compares against the generation `assertFreshTree` uses. A new binding, a lost scope, an unavailable provider, or a refresh by any path lets the resume through, and there is no deadlock.
      - The acknowledge route: editor access, CSRF, workspace-scoped ids, all or none.
      - Projector text bounds and rebuild.
      - The exact host allowlist, and that the daemon chooses the sandbox paths.
    - *LOW, fixed:* creating the caches could fail every sandboxed launch (an unwritable Cargo home), created `~/.cargo` on hosts without Rust, and an empty `CARGO_HOME` became a relative path. Now the caches are made only inside an existing Cargo home, failures never stop the launch, and an empty value counts as unset (test: `backend.test.ts`, a missing and a read-only home).
- **First boot of fccce06 (2026-09-29, 06:48 UTC), checked from the 2026-09-29 snapshot, the data directory and the daemon journal.**
  - Schemas 33 to 35 migrated at 06:48:52.
  - `<data>/cargo-home` was seeded at the boot: 490 MB, with `registry` (cache, index, src) and `git` only, and no credentials file. Pinned checks resolved from it all day.
  - `<data>/git-identity.gitconfig` holds only `user.name` and `user.email`.
  - Codex: all 57 runs since the deploy launched through the per-run inventory probe and finished. None failed with "Codex could not report its configuration".
  - Claude: not exercised. No live profile has used Claude since 2026-09-15, and a live probe through the deployed adapter (a Haiku run trying a HOME write, a web fetch, the Docker socket, crates.io and a commit) was refused by this session's permission policy. bubblewrap 0.12.0 and socat are installed. **Operator check:** run one short Claude step, or allow the probe.

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

### R-G13

**Declared per-repository checks** · Phase P2 · Effort M · Status: partial (increment 1, 2026-09-29)

- **Added 2026-09-28** (operator decision, after the R-G4 batch), for what R-G4 left open.
- **Resolves:** the rest of [AGT-08](findings/AGT-GIT-SEC-agents-git-security.md#agt-08-verification-exists-only-for-cargo-non-rust-repositories-get-no-controller-supplied-verification), and R-G4's residual gap on [SEC-01](findings/AGT-GIT-SEC-agents-git-security.md#sec-01-agents-can-forge-the-buildcheckcinative-receipts-that-gate-integration).
- **Why:** since R-G4 the daemon runs every check and records its receipt, but the agent still chooses the command, so `ct-check -- true` counts as a scoped check. Verification exists only for Cargo; other repositories get none from the controller.
- **Change:**
  - A repository, or the plan's verification policy, declares its check commands.
  - The daemon runs the declared commands itself, in the check units R-G4 built, at the gates that need them. It may also run them on the agent's request.
  - A scoped-check gate is met only by a receipt of a declared check, run on the gated commit. Commands the agent chooses stay available and stay supplemental.
  - Cargo becomes one declared check among others, not a special case.
- **Needs a design first:** where declarations live (repository file, binding or plan); who may change them, given an agent can edit repository files; migration for repositories that declare nothing.
- **Done when:** A scoped-check gate cannot be met by a command the agent chose, and a non-Rust repository can declare a check the daemon runs.
- **Design, 2026-09-29 (operator decision: option A, fail closed).**
  - **Where declarations live.** An immutable, operator-adopted check declaration per repository, stored by the daemon (a new record kind, schema 36, and an audit action; operator-approved as part of the option). The operator adopts it from a file in the repository, `.craftingtable/checks.json`, which the daemon reads with its own Git at a commit the operator names, never from an agent's branch or worktree. The file is only a proposal; the record is the authority.
  - **Rejected:** declaring checks in the plan or map format (a format change, and plan-bundle and manual runs have no map), and reading the file from the integration tip at launch (delegated merges let an agent weaken the file in one slice for the next).
  - **Undeclared repositories fail closed.** For runs prepared after the cutover, a scoped run in a repository with no adopted declaration does not start: it stops as `repository-checks-undeclared`, owned by the operator, whose exit is adopting a declaration. Records frozen earlier keep today's rule. WI and EXO each need one adoption after the deploy.
  - **What counts.** In scoped mode, a gate is met only by daemon-recorded receipts of the adopted checks, one per declared check, on the gated commit. The daemon takes the command from the manifest it verified at launch (`ct-check --declared <id>`), never from the agent's request. Commands the agent chooses still run, and stay supplemental.
  - **Definitions the agent can edit.** A declared check names the files that define it (its scripts). The daemon records their blob ids at the gated commit with the receipt, and a gate whose definitions differ from the adopted ones stops as `check-definition-changed`; the operator's exit is adopting the new definition.
  - **The boundary, stated.** Declared checks stop agents choosing the gate's command and changing its harness unseen. They do not stop agents weakening the tests themselves; that stays the reviewer's job.
  - **Increments:** (1) the record, adoption, the typed stops, declared receipts and the scoped gate; (2) Cargo as one declared check, for current-upstream gates; (3) the daemon runs declared checks itself when a review starts; (4) a check-only manifest for plan-bundle and non-Rust repositories (AGT-08); (5) the repository Checks panel beyond adoption, with receipts labelled declared or supplemental.
  - The design text above was committed with the LIVE-18 review fixes (1e422d5), not in a commit of its own.
- **Progress, 2026-09-29: increment 1.**
  - **The record.** Migration 0036 (schema 36) adds `repository_check_declarations`: one immutable row per adoption, versioned per repository, with no-update and no-delete triggers, and the audit action `repository-checks.adopted`. A declaration names each check's id, argv and definition files, the SHA-256 of each definition file at the adopted commit, the rationale, who adopted it and when. It is a new record kind, read and written through the R-H3 guard.
  - **Adoption.** The Repositories page has a Checks section. For each active repository it shows the adopted version and its checks, and earlier versions. An editor names a branch or commit; the daemon resolves it and reads `.craftingtable/checks.json` from that commit with its own Git (`resolveCommit`, `exportCommit`), never from a worktree. The preview lists the checks and any issues. Adoption records the commit the operator reviewed and is refused if the ref has moved since, or if the file has issues. The file's schema refuses absolute or `..` programs, options in place of a program, duplicate ids and missing definition files. A program with a path is the repository's own script and defines its check unless the file names other definition files.
  - **The gate.** A run in scoped-checks mode, prepared after this change, carries the repository's current adoption in its manifest (`declaredChecks`) and its record (`checkDeclarationId`). `ct-check --declared <id>` runs the adopted argv from the manifest the daemon verified at launch; the request names the check and nothing else, and extra arguments are refused. A repository program runs from the worktree under review. The daemon's receipt records the check, the adoption, and the SHA-256 of each definition file as it was when the check ran (content digests, not blob ids: the same test, without depending on the worktree's Git objects). The review gate and the checkpoint candidate gate then need one successful, clean, daemon-recorded receipt of every adopted check on the reviewed commit. Commands the agent chooses, even the adopted command itself, still run and are recorded, and count for nothing. Runs prepared before this change keep the old rule. The checkpoint candidate gate applies the same rule to a run held to declared checks. No candidate is in scoped-checks mode today (a slice whose merge needs a contract checkpoint is always held to a current-upstream build), so that branch is defensive and has no test of its own; increment 2 exercises it.
  - **Typed stops.** A scoped run in a repository with no adoption does not start: its cycle stops as `repository-checks-undeclared`, owned by the operator, with the repository as a ref. A gate whose declared check ran only with other definition files (edited, or replaced by a link) stops as `check-definition-changed` with the repository and check. Both inbox items open the repository's checks (`/repositories#repository-checks-<id>`), where adopting is the exit.
  - **Tests.** `repository-checks.test.ts` (reads the named commit, not the working tree or another branch; versions; audit; moved ref and each kind of issue refused; triggers; member reads, editor writes, CSRF, and the service's own role check). `server-execution-receipt-gates.test.ts` (a chosen command, even the adopted one, does not meet the gate; extra arguments and unknown checks refused; the declared check meets it and its receipt names the adoption; an edited or linked definition stops as `check-definition-changed`; an undeclared repository stops as `repository-checks-undeclared` before any launch, and its item opens the repository's checks). Existing scoped tests now adopt fixture checks and run `ct-check --declared`. Web: `RepositoryChecksPanel.test.tsx`, and the repositories route with a focus.
  - **Guards shown by mutation**, each killed by the tests above: extra arguments accepted; any scoped receipt counted; definition digests not compared; an undeclared repository not failing closed; a linked definition followed; the undeclared stop untyped; adoption reading the working tree; a moved ref adopted; a file with issues adopted; the service's editor check replaced by membership; the repository program not resolved in the worktree.
  - **Operator action after deploy.** Scoped slices in WI and EXO stop as `repository-checks-undeclared` until each repository's checks are adopted. Each needs a `.craftingtable/checks.json` committed on a branch the operator reviews, then adoption on the Repositories page.
  - **Open:** increments 2 to 5. Plan-bundle runs and repositories without a pinned environment get no manifest yet, so they are not gated by declared checks until increment 4.

### R-G14

**Operator-configured outside sources for agent sandboxes** · Phase P3 · Effort S-M · Status: open

- **Added 2026-09-28** (operator decision, after the R-G5 batch). Claude's sandbox reaches crates.io and nothing else, and that list is fixed in the adapter (`SANDBOX_ALLOWED_DOMAINS`).
- **Change:**
  - One place where the operator names the outside sources agents may reach (hosts, and the caches they write), per installation and possibly per repository.
  - Both adapters read it.
  - Codex's sandbox cannot allow a single host, so it needs its own route: for example, a daemon-run fetch, or a proxy the daemon owns.
- **Done when:** A source added in that one place reaches both agents' sandboxes, and nothing else does.

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
- **Amended 2026-09-28: the e2e daemon leaked its data directory on every run.** Playwright stops a web server by SIGKILLing its process group unless the config names a graceful signal, and `e2e-entry.ts` removes its temporary data directory only from its SIGINT/SIGTERM and exit handlers. So every `pnpm test:e2e`, walkthrough and rehearsal left about 72 MB in `/tmp`.
  - **Found through the walkthrough crash.** On 2026-09-28 headless Chrome crashed on its first screenshot (four core dumps, the same compositor-thread trap), and replays failed with `SQLITE_IOERR_WRITE` in the same minute. `/tmp` is a tmpfs with a per-user quota (logind's default, 80% of 32 GiB = 25.1 GiB); the user had 23.7 GiB of it in use. `df` showed 7.7 GB free, so the quota was the limit. Of that, 7.5 GB was 202 leaked `craftingtable-e2e-*` directories (the rest is agent-session scratch outside the repository). Chrome runs with `--disable-dev-shm-usage`, so its screenshot buffers live in `/tmp` too.
  - **Fix:** the daemon's `webServer` entry takes `gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 }`. Test: `scripts/e2e-daemon-shutdown.test.mjs` starts the daemon as the config declares it, stops it as Playwright would, and checks no data directory remains. It fails without the change.
  - **Not changed:** 60 `craftingtable-server-test-*` directories from unit tests also remain in `/tmp` (a test killed at its timeout skips cleanup). They take little space and are left for R-I9.
  - **Independent review of 73e1cd9 (2026-09-28).** An adversarial reviewer in an isolated worktree confirmed the claim: Playwright 1.61.1 SIGKILLs the group without `gracefulShutdown`, SIGTERM reaches the daemon through pnpm and tsx, the directory is gone within about 35 ms, and the test fails with the setting removed. No HIGH or MEDIUM finding.
    - *LOW, fixed:* the test starts the daemon through tsx, which resolves the workspace packages from their build, so a bare `pnpm test` on a fresh checkout failed it. It now skips until `tsc -b` has run; `pnpm check` builds first.
    - *NIT, fixed:* the test waits for `close`, as Playwright does, and its cleanup kills the whole group even after the shell has gone.
    - *LOW, disposition:* a daemon that takes more than 10 s to close is still SIGKILLed with its directory. Closing an idle e2e daemon takes milliseconds; removing the directory before the database closes would fail the close's own writes.
    - *LOW, done by the operator's leave (2026-09-28):* the 202 leaked directories, the 60 unit-test directories and finished agent sessions' scratch were deleted from `/tmp`; the quota fell from 23.7 to 0.7 GiB.
    - *NIT, disposition:* `freePort` can race another process for the port; a collision fails loudly.
    - *Observed at the batch gate (2026-09-28), open for R-I9:* one of the gate's two e2e daemons left 43 MB. Its database was removed (the SIGTERM cleanup ran), but run directories written before shutdown remained, so the recursive removal stopped partway. The load average was about 20; three walkthroughs and the earlier gate left nothing. This is not reproducible on demand. A removal that retries (`maxRetries`) or waits for the daemon's run cleanup would close it.
    - *Seen again (2026-09-28, the R-G4/R-G5 batch), still open for R-I9:*
      - A partial directory: 39 MB, `backups` and `runs` (81 run directories) left and `state` removed. It came from the e2e run at load average 14 in which three specs failed; the removal stopped partway again. It could not be reproduced on demand, so the cause is still unproven.
      - A different pattern, twice: an entire data directory, `state` included, left from the walkthrough (17:45) and from the gate's walkthrough rehearsal (18:28), so cleanup never ran at all. A daemon SIGKILLed after the 10 s graceful stop, or a walkthrough web server stopped without SIGTERM, would explain it. Neither is proven.
      - All three were deleted afterwards; they sat in the session's own temporary directory.
    - *Seen again (2026-09-28, the follow-up batch at 527d151):*
      - The gate's `e2e-daemon-shutdown` test failed once at load average 14 with a data directory left behind. It passed rerun serially and three more times.
      - The following e2e run (all passed) left a 43 MB partial directory: `backups` and `runs`, with `state` and the new `cargo-home` both removed. So the daemon's Cargo home does not cause the leak; the removal stopped partway, as before. It was deleted.
    - *Seen again (2026-09-28, gate at ff0bbe9):*
      - The same three files failed in the full run at load average 14, as at 527d151: `e2e-daemon-shutdown`, one timeout in `server-execution-cycles`, and one in `server-execution-receipt-gates`. All three passed serially (49 tests).
      - The e2e run (21 passed) again left a partial 44 MB directory (`backups`, `runs`), which was deleted.
      - The three recur together under full-run load. That is a signal for R-I9, whose e2e workspaces and worker count decide that load.

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

**Documentation reset to current state** · Phase P1-P3 · Effort M · Status: partial (P1 start done 2026-09-25)

- **Resolves:** [DOC-01](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-01-the-readme-is-a-feature-changelog-not-an-operator-guide), [DOC-02](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-02-adr-sprawl--65-records-broken-index-inconsistent-status-metadata-long-refinement-chains), [DOC-03](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-03-doc-claims-out-of-sync-with-code-spot-check-of-14-claims-7-false-or-stale), [DOC-05](findings/QA-DOC-REPO-tests-docs-hygiene.md#doc-05-principles-security-and-operations-docs-have-become-per-feature-narratives), [UI-15](findings/UI-information-architecture.md#ui-15-docsui-principlesmd-has-become-a-per-slice-accretion-log-that-encourages-new-surfaces), [SEC-09](findings/AGT-GIT-SEC-agents-git-security.md#sec-09-docssecuritymd-is-an-accreted-per-slice-log-with-stale-claims), [HIST-13](findings/HIST-history-and-live-usage.md#hist-13-schema-and-adr-churn-rate-22-migrations-46-adrs-in-18-days-with-manual-pre-migration-backups), [HIST-15](findings/HIST-history-and-live-usage.md#hist-15-commit-messages-stopped-describing-changes-adr-numbering-is-inconsistent), [DATA-15](findings/DATA-storage-domain-contracts.md#data-15-documentation-and-vocabulary-drift-adrs-process-authority-branded-ids-exports-plan-specific-literals), [AGT-17](findings/AGT-GIT-SEC-agents-git-security.md#agt-17-documentation-drift-in-the-agent-seam)
- **Change:** README becomes an operator guide (what it is, run it, the main workflow) instead of a feature changelog; architecture.md describes the current design, not schema history; one ADR naming scheme, a complete index and correct statuses, superseded chains marked; ui-principles split into visual language, IA rules ("decisions are made only in the inbox; other pages link"), glossary and short per-surface specs; security.md and operations.md rewritten as current state; commit messages carry a body saying what stop or need motivated the change.
- **Done when:** Spot-checked claims all true; README under ~150 lines.
- **P1 start, done 2026-09-25:**
  - **README.** It is a 150-line operator guide: the main workflow, running it, reaching it from the laptop, key configuration, where things are, and a documentation map (611 lines before). The old feature log moved verbatim to `archive/README-feature-log-2026-09.md`, whose header says it is superseded and may be stale.
  - **Architecture.** `docs/architecture.md` describes the current design by component, with no schema-number history: 431 lines, 548 before.
  - **Spot checks.** Every kept or new claim in both files was checked against the code (about 100 claims). 14 were false or stale and were fixed:
    - process-authority modules (now the `PROCESS_AUTHORITY` map);
    - "applies schema 22";
    - per-run Cargo targets (now per worktree, R-G7);
    - legacy rounds offered for new finalizations (R-B10);
    - 8 of 27 workspace event kinds listed;
    - an incomplete `GitOperations` list;
    - the delegated-roadmap index is partial;
    - verdict source;
    - when profile assignments are allowed;
    - "Git 2.32+";
    - where `ct-native` lives;
    - the ADR-061 citation;
    - where integration evidence is stored;
    - configuration variables.
  - **Not traced end to end:** a few carried-over atomicity statements taken from ADRs (receipt insertion with parent completion, amendment application, stage usage with run reservations) and external tools (openssl, `tailscale serve`, Codex CLI version).
- **Review 2026-09-25 (independent reviewer, 70 claims checked):** five claims corrected:
  - the Git operations list was still missing ancestry, common ancestor, worktree-change inspection and baseline-tag listing;
  - migrations run whenever a CLI command opens the database, not only on daemon start or `db migrate`;
  - config.ts is not the complete list (deploy settings live in `deploy-daemon.mjs`);
  - "Needs your attention" shows cycle stops only;
  - the retired tables came from the CT-04A1/A2 inspector and registry, with `project-repository-*` kinds too.

  Two overstatements are narrowed: the prose-branching check's scope, and the one test that skips record verification. The archive now holds the complete old README verbatim, so the six configuration rows the operator guide leaves out (`WEB_DIST`, model lists, diff limit, session lifetime, log level) are not lost before P2's full variable list.
- **Defect found by the review, fixed.** `admin reset-password` and `admin bootstrap` opened storage, and so migrated it, without the single-daemon lock. The README tells the operator to run reset-password from a checkout. From a checkout newer than the deployed release, that would have changed the schema under the running daemon. Such a command now takes the lock when the database has pending migrations, and is refused while a daemon holds it; on a current database nothing changes. `cli.test.ts` covers both commands and fails without the fix.
- **Left for P2–P3:**
  1. **ADRs:** one naming scheme (033–050 and 057 lack the `ADR-NNN-` prefix) and one header format; a complete `docs/decisions/README.md` index (it omits 033–050 and 054–068); correct statuses (028 still "proposed", 031's retention superseded by 034); mark the superseded chains (004–007, 014, 022→023). DOC-02, HIST-15.
  2. **ADR-008:** its stale claims (Playwright specs and mobile project, the removed `testing` package, `test-support` authority). DOC-03 #4–6.
  3. **Split `docs/ui-principles.md`** into visual language, IA rules ("decisions are made only in the inbox; other pages link"), the glossary (now present), and short per-surface specs. Move the cross-project import narrative out, and fix the "bare Ready/Blocked never appears" claim against `ProjectCards.tsx`. UI-15, DOC-03 #7, DOC-05.
  4. **Rewrite `docs/security.md`** as current state, organized by trust boundary and authority. SEC-09, DOC-05.
  5. **Rewrite `docs/operations.md`** as current state:
     - move the roadmap usage guides out;
     - add the complete environment-variable list, tested against `config.ts`;
     - re-point its "Directly on the LAN" pointer, which names the README's "Using it from the couch" section (kept for now).
     DOC-03 #2, DOC-05.
  6. **Archive completed planning documents:** `docs/finalization-roadmap.md`, `docs/cross-project-roadmap.md`, `docs/plans/`. DOC-05.
  7. **AGENTS.md rules:** the README is not updated per feature; commit bodies say what stop or need motivated the change (HIST-15); correct the claim that every superseded artifact is in `archive/` (REPO-03).
  8. **Remaining vocabulary, export and agent-seam drift** from DATA-15 and AGT-17.

### R-I8

**Deploy from a separate checkout; one daemon per data directory** · Phase P1 · Effort S-M · Status: done (943fb8d, 6729d6e; the operator deletes one remote branch)

- **Resolves:** [REPO-04](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-04-the-production-daemon-runs-from-the-development-checkout-and-its-build-output), [SEC-10](findings/AGT-GIT-SEC-agents-git-security.md#sec-10-the-daemon-runs-straight-from-the-editable-development-checkout), [REPO-03](findings/QA-DOC-REPO-tests-docs-hygiene.md#repo-03-legacy-process-directories-and-branches-are-still-at-top-level)
- **Change:** Run the daemon from a separate deploy checkout updated by an explicit `pnpm deploy:daemon <ref>` command (fetch the exact ref from the dev repo, install, build, restart the single systemd user unit, record the deployed commit; rollback = deploy the previous commit; add the R-B9 drain when it exists), so editing or running tsc in the dev checkout never changes what production loads. Take an exclusive lock on the data directory at daemon start, before migrations and restart recovery: today a stray second daemon on the same data directory (e.g. `pnpm start` in another checkout) would mark live runs interrupted and roadmaps needs-attention before failing to bind the port. `pnpm dev` defaults to its own port and data directory. Archive the CT-01..03 process directories and merged CT-era branches.
- **Done when:** A tsc -b in the dev checkout cannot affect the running daemon; a second daemon on the same data directory exits before touching the database (test); deploy and rollback are one command each.
- **Progress:** Deployed 2026-09-23: the daemon runs from $XDG_DATA_HOME/craftingtable-deploy/current (systemd drop-in deploy-checkout.conf) via `pnpm deploy:daemon <ref>` (release per commit, atomic switch, health check with automatic rollback, `--rollback`, `--status`, deploys.jsonl). The data-directory lock was verified against the live daemon: a second daemon exits naming the holder. `pnpm dev` / `pnpm craftingtable:dev` use their own data directory and port 4601. Remaining: archive the CT-01..03 process directories and merged CT-era branches. Deploys drain through R-B9 once a release containing it is running.
- **Amendment (2026-09-24 review):** the CT-01..03 process directories (`work-items/`, `implementation-reports/`, `review-findings/`) moved to `archive/CT-01..03/`. The AQ fixture's expectations moved to `fixtures/plan-bundles/`, and code comments now cite the archived CT-03 spec. Still remaining, as an operator action: delete the seven merged CT-era branches (`ct-02-persistent-daemon`, `ct-03-plan-dashboard`, `ct-04`, `ct-04a-git-foundation`, `ct-04a2a-repository-model`, `ct=04a2b1-repository-journal`, `ct-04a2b2a-repository-evidence-boundary`), locally and on `origin`. All seven are ancestors of `main`.
- **Amended 2026-09-24 (operator decision): the branches are deleted.** The operator approved deleting the seven merged CT-era branches. All seven are deleted locally, after checking that each is an ancestor of `main`. Of the seven, only `ct-04a-git-foundation` exists on `origin`, and it too is an ancestor of `main`. The agent's shell cannot push, so the operator deletes it: `git push origin --delete ct-04a-git-foundation`. With that, the item is done.

### R-I9

**Independent e2e specs: one workspace per spec** · Phase P2 · Effort S-M · Status: in progress (code done 2026-09-29)

- **Added 2026-09-24** after R-I5 closed. It holds the part of QA-05 that R-I5 did not do; the operator agreed to proceed with it.
- **Resolves:** [QA-05](findings/QA-DOC-REPO-tests-docs-hygiene.md#qa-05-e2e-gate-screenshots-are-unasserted-cause-the-known-flake-and-helpers-are-copied-into-8-specs) (the rest: "give each spec its own workspace so specs are independent").
- **Why:** All specs share one daemon, one admin account and the default workspace. R-I5's ten consecutive passes show this is not a current source of flakes. But specs can see each other's roadmaps, runs and notifications, which is why Playwright is held to `workers: 2` with `fullyParallel: false`, and the gate takes about 4 minutes.
- **Change:**
  - `e2e/support.ts` gains a helper that creates a workspace for the calling spec (`POST /api/workspaces`) and opens it. Specs use it instead of waiting on "Default workspace".
  - Once specs are independent, raise the Playwright worker count.
  - Storage and host scheduling are installation-wide, so the specs that change them stay serialized.
  - The walkthrough keeps its own daemon.
- **Done when:** Every gate spec runs in its own workspace; the gate runs with more than 2 workers; `pnpm test:e2e` passes 10 consecutive runs.
- **Code 2026-09-29.**
  - **Own workspaces.** `openOwnWorkspace` (`e2e/support.ts`) signs in, creates a workspace from the signed-in page (session, CSRF and origin as the app sends them) and opens it. Planning, delegation and deep-links use it; roadmaps, finalization, notifications, mobile and package-imports already made their own. The dashboard spec is about the bootstrap's Default workspace, which no other spec now uses, and opens it by name.
  - **Found by the first parallel run:** after sign-in `/` opens the browser's last-used workspace (local storage), and a fresh browser gets the first workspace by name. "Deep links workspace" sorts before "Default workspace", so once that spec had run every other spec's "landed on Default workspace" check failed (10 of 21). Specs now wait for any workspace page (`expectSignedIn`); corrected after the review, which found the first version blamed a per-user setting.
  - **Parallel.** `fullyParallel` with 4 workers (`CRAFTINGTABLE_E2E_WORKERS` overrides). The e2e daemon gets 8 development and 4 verification slots, so parallel specs do not queue on each other's cycles; the walkthrough keeps the defaults it photographs. (The first version set these in the Playwright config only; the review found the e2e daemon ignored them, so they now pass through `e2eEnvironment`, with a test.)
  - **Installation-wide specs stay serial.** Storage (and workstation capacity, which it edits) runs in its own two projects, after every other spec, one viewport after the other.
  - **R-I5's partial directory, found and fixed.** With four workers every run left a partial data directory (`backups` and `runs`), so the cause could be seen: a run directory was created 20 ms after the removal began. Roadmaps the specs leave running keep launching until the daemon closes, and a launch already under way still creates its directory after the runtime closes. Two things combined:
    - One removal lost that race; the e2e daemon now removes until the directory stays gone (up to 2 s).
    - The daemon was started through pnpm, which left at the stop signal. Playwright then took the server as stopped and killed the group, with the daemon partway through removing (a leftover after the first fix was written 17 ms after removal began, and never retried). The daemon now runs as the web server's own process (`exec node --import tsx src/e2e-entry.ts`), so Playwright waits for it to finish.
  - **10-run check.** The first repetition, at 3836b99, passed run 1 and failed run 2 in delegation with `spawnSync git ENOENT`: I had deleted leftover `craftingtable-e2e-*` directories during the run, and the pattern also matched that spec's live fixture repository (`craftingtable-e2e-repo-*`). The count restarts at the leak fix.
  - **Independent review of 3836b99 (2026-09-29, isolated worktree; no Playwright, the repetition was running).**
    - *HIGH, fixed:* the capacity raise never reached the daemon (above). The repetition then running measured the old capacity, so it was stopped and restarted after the fix.
    - *HIGH, fixed:* the retry did not stop the leak (above). The review's deeper point stands for R-B9 and R-G11: `runtime.close()` does not wait for launches already under way, which then write into the data directory after the database closes. In production the directory stays, so this leaves an orphan run directory, not a lost record; the e2e daemon now removes until nothing is written.
    - *MEDIUM, fixed:* the diagnosis of the sign-in landing (above).
    - *MEDIUM, disposition:* before opening its own workspace, a spec's first page is whichever workspace sorts first; those steps only read (layout and menu checks). Storage runs in that first workspace too: it changes installation-wide settings, not a workspace's, and runs alone after every other spec. Dashboard uses the bootstrap's Default workspace, which no other spec writes to.
    - *LOW, disposition:* a failed spec elsewhere skips storage in that run (its projects depend on the others); a red gate has already failed. `CRAFTINGTABLE_WALKTHROUGH` with no project runs no storage spec; nothing does that.
    - *NIT, fixed:* the phone project's dead storage entry, and a worker count from the environment that is not a number (now falls back to 4).
    - *NIT, disposition:* `expectSignedIn` accepts any page heading; the steps after it wait for their own elements.

### R-I10

**Live plan data as the test corpus: record live stops, replay scheduler decisions** · Phase P2 · Effort M · Status: done (2026-09-27)

- **Added 2026-09-27; direction set by the operator** after the 2026-09-25/26 live run ([LIVE findings](findings/LIVE-live-run-2026-09-25.md)). WI/EXO delivery is paused until P2 is done. The live roadmap's data is now test data.
- **Why:** every live blocker so far was diagnosed by ad hoc database queries in an agent session, then patched on `main`. `controller:replay` covers step outcomes only (`decideStepOutcome`), so a scheduler decision such as LIVE-06's missing recovery round cannot be reproduced offline.
- **Change:**
  - **Snapshot.** Take a read-only `.backup` of the live database in its paused 2026-09-27 state. Keep it with its goldens under `$XDG_DATA_HOME/craftingtable-review/replay/2026-09-27/`, outside the repository, because it holds real plans and agent output. Record `controller:replay --record` and `--every-run --record` from the P2 head.
  - **Scheduler replay.** Extend the harness to the roadmap scheduler. For each non-draft roadmap entry of the snapshot, record the decision one pass would take (start, advance, recover, wait with its reason, or hold) without launching anything. Its golden goes beside the step-outcome goldens. It uses `RoadmapService.tick()` under R-B2's stepping seam, on a copy.
  - **Record, don't patch.** Each live stop the operator hits becomes a LIVE finding plus a replay case or a redacted fixture test. The fix lands with its replay difference explained. A fix goes on `main` ahead of P2 only for data loss, a safety issue, or a stop with no working control. It is then merged into the P2 line the same day (program rule 7).
- **Done when:**
  - The 2026-09-27 snapshot and its step-outcome and scheduler goldens are recorded.
  - The scheduler replay reproduces LIVE-06 (EXO-02 without a round) and LIVE-07 (WI-04's readiness), which R-C12 and R-C13 then change on purpose.
  - Every LIVE finding has a replay case or test.
- **Done 2026-09-27.**
  - **Snapshot.** One read-only `sqlite3 … ".backup …"` of the live database at 21:26 UTC (schema 31, integrity ok, SHA-256 `3f43f73a…`), kept in `$XDG_DATA_HOME/craftingtable-review/replay/2026-09-27/snapshot.sqlite`. The live roadmap `b81d5f92` is `running` in it, with no controller write after 03:57 UTC, so LIVE-06 and LIVE-07 are preserved as the operator left them.
  - **Step-outcome goldens**, recorded at d81db74 (this item does not change step classification): `golden.json` (58 decisions) and `every-run-golden-d81db74.json` (352).
  - **Scheduler replay.** `pnpm controller:replay <snapshot> --scheduler [--record|--check <golden>]` (`scheduler-replay.ts`). It opens a private copy through the real daemon composition and runs one `RoadmapService.tick()`.
    - Every command that would launch an agent, create a worktree, merge or refresh is replaced by a recorder that stops the entry there. Git is present for presence checks, but any call is recorded and stops the entry, because the snapshot's worktrees are real repositories. Agent backends carry the default model lists and a missing executable, so settings validate and nothing can launch. The snapshot file is never modified.
    - It keeps the stored phase capacities: the daemon's configured default would otherwise replace the operator's development capacity (4 live, 2 by default), and plan-acceptance evidence is bound to that capacity, so STACK-PLAN-ACCEPTED and everything behind it would falsely go stale. It takes the snapshot as the live daemon's next pass would find it, without restart recovery (corrected by the review below; it first modelled a drained restart with a clean-stop record).
    - The pass reports how it left each entry through a new observer seam, `RoadmapService.observeScheduling` (outcomes: complete, deferred with its typed blocker, held, evaluated, retried with the swallowed error, hold recorded). No scheduler decision changed.
    - For every entry of every non-draft roadmap it records start, advance, recover, wait (code and reason), hold, complete, `none` (evaluated and nothing recorded) or `not-scheduled`. For every roadmap-owned slice cycle with checkpoints it records each checkpoint's readiness (`supported && assigned && !pending`) and, for a ready or active checkpoint, the attestation inputs its evidence packet lacks.
    - Golden `scheduler-golden.json` (4 roadmaps, 181 entries, 3 cycles). The pass runs at the snapshot's last controller write, so it is deterministic: a re-check reports 188 records, 0 changed.
  - **LIVE-06 reproduced:** `exo/EXO-02/domain` verification is `none`, one of five silent entries (also EXO-03 and EXO-04 verification, WI-04/domain, EXO-18). The branch is `advanceScopeRecovery`: `scopeRecoveryDecision` names the owning slice, then `this.blocker(roadmap, owner)` returns a `capacity-blocked` blocker ("Repository has 2 unmerged worktree(s) or reservations; capacity is 2") and the method returns `true` with nothing recorded. The two slots are EXO-04/domain's repair, which waits for EXO-02/domain to be verified, and EXO-18, which waits on the operator's EXO-ADR-022. Meanwhile the verification cycle's own item is suppressed as "Waiting for the roadmap to delegate a bounded owning-slice repair" (`automatedScopeRecoveryWait`), so nothing reached the inbox. See [R-C12](#r-c12).
  - **LIVE-07 reproduced:** WI-04/domain's WI-WORKER-G1 is ready with nothing pending, while its packet lacks `receipt:wi/WI-09/domain`, `receipt:wi/WI-10/domain` and the coverage bindings `WP-001`…`WP-008`. See [R-C13](#r-c13).
  - **A replay case or test for every LIVE finding:** each is listed on its finding.
  - **Test:** `scheduler-replay.test.ts` replays a stepped parallel roadmap before its first pass (the first item starts at `createWorktree`, the two that need its merge wait as `dependency-blocked`) and at its first merge boundary (`none`), and checks that the replay launched nothing and left the source database's roadmap unchanged. It fails without the change.
  - **Replays:** the 2026-09-23 goldens are unchanged (51 and 278, 0 changed). ~~Its scheduler replay records the roadmap at `restart-resume`, so every entry is `not-scheduled`.~~ That was the replay's own restart modelling, not the snapshot (review finding 1 below): the 2026-09-23 roadmap is `running` with two live runs, and the corrected replay evaluates it.
  - **Found along the way, not changed:** a daemon started without `CRAFTINGTABLE_DEVELOPMENT_CAPACITY=4` in its environment file would reset the live development capacity to 2 and silently invalidate the accepted plan evidence and every checkpoint behind it. Operational note for the deploy.
- **Independent review of 1a75a5b (2026-09-27).** An adversarial reviewer in an isolated worktree re-ran the replay, traced every file, process and Git call it can make, and checked each claim. Every finding was verified again before it was acted on. Fixed together, test first, in one follow-up commit on the replay tool:
  - *HIGH, fixed:* a snapshot with a live run was replayed as a crash-restart. `createServices` counts the clean-stop record only when no run is live, so the replay interrupted the runs and put every running roadmap at `restart-resume`, and `before` was read after that. The 2026-09-23 snapshot (two live runs) showed it, and this item's amendment wrongly reported it as the snapshot's state. `createServices` now takes a replay seam, `restartRecovery: false`, which skips run, cycle and roadmap restart recovery, and `before` is read first. Test: a snapshot taken while a run is live replays as `running` with the entry `running`.
  - *HIGH (sequential roadmaps), fixed:* a sequential pass reported nothing. Its entry's intercepted command was swallowed by `tick()` before the observer ran, so the entry read `not-reached`, and the command leaked into the next roadmap's first entry. The sequential branch now reports `retry` or `failed` before rethrowing. The observer gains `passEnded`, which clears any command left outside an entry and records it on the roadmap, e.g. the cross-project completion check. Test: a sequential roadmap's first entry replays as `start`.
  - *MEDIUM, fixed:* the test's two safety assertions could not fail: they read the fixture's own backend and database. The test now checks the snapshot file's digest, and, on the replay's own copy, that the pass reserved the attempt but created no worktree, cycle or run.
  - *MEDIUM, open → R-C13:* nothing tested `checkpointReadiness`/`packetMissing`. R-C13's test covers the packet, and `packetMissing` is a hand-written second evaluator of the attestation inputs, kept as a replay observation only.
  - *LOW-MEDIUM, fixed:* a hold recorded by the pass lost its typed code, because the observer ran before the hold was written. It now runs after. Test: a moved branch setting replays as `hold` `entry-preparation-failed`.
  - *LOW-MEDIUM, fixed by R-C12:* the golden could not tell the silent causes behind `none` apart. R-C12 gives every path a typed step, so an evaluated entry is now `wait` with its code, or `running`.
  - *LOW, fixed:* a Git call, which the replay cannot follow, is `not-scheduled` with code `replay-stopped-at-git`, not `advance`. None is reachable from a pass today.
  - *LOW, fixed:* `--record`/`--check` without a golden path is a usage error, where it printed and exited 0.
  - *LOW, fixed:* an observer exception can no longer become an entry hold: the `evaluated` report is outside the `try`. Adoptions are reported on the roadmap (`adopted`).
  - *LOW, disposition:* the replay reads this host: native toolchain identity (`nativeHostDigest`) and `CRAFTINGTABLE_KATA_READINESS` from the shell, not the daemon's unit. Documented in `scheduler-replay.ts`: replay on the workstation that took the snapshot.
  - *LOW, disposition:* opening an older schema writes a pre-migration copy beside the database, so a replay needs twice the snapshot's size in its temporary directory. Documented.
  - *Later, 2026-09-27:* with R-E3a's status lists in the output, a re-check of a fresh recording found attention item ids differing between copies (schema 32 rebuilds the items with new ids). The replay now names an item by its subject key, and both snapshots' scheduler goldens re-check with 0 changed.
  - *Checked and sound:* the replay is deterministic and matches the golden (188 records, 0 changed before R-C12). No process is spawned or killed, and no repository, worktree or `/mnt/workhorse` path is touched (traced). The copy's only writes are the migration, attention items and two events. Every mutating collaborator is intercepted, except `items.admit` and `adoptRoadmapRound`, which write only to the database. The live environment sets no model lists, so the default lists are faithful. The fixed `now` changes no decision. The observer seam does not change production behaviour. LIVE-06's and LIVE-07's reproductions were confirmed independently, and the cited LIVE tests exist.

- **2026-09-28: second snapshot and two replay records.**
  - A read-only `.backup` of the live database after the P2 deploy, taken with the roadmap paused, is at `replay/2026-09-28/`. SHA-256 `645b7c3e…`, schema 32. Goldens at ac08291: `golden.json` 59, `every-run-golden-ac08291.json` 356, `scheduler-golden-ac08291.json`.
  - The scheduler replay now also records `attention`: the items each roadmap's pass would project, as if it were running (`RoadmapService.passAttention`), and every other open item.
  - Its packet check also names a prerequisite accepted as an architecture decision whose record the packet lacks (`decision:<id>`).
  - These are LIVE-09 to LIVE-13's replay cases.

### R-I11

**Independent review of the live-run fixes made on `main`** · Phase P2 · Effort S · Status: done (2026-09-27)

- **Added 2026-09-27.** Five fixes landed on `main` during the live run, each with a failing-first test and a full `pnpm check`, but without the independent review every P2 item gets. They are ca7b954 (LIVE-01), 1727f3b (LIVE-02), a2bb20a (LIVE-03), 616f323 (LIVE-04) and 18f0bb8 (LIVE-05, R-C5 increment 2). They reached the P2 line in f471830; both replays report 0 changed there.
- **Review focus:**
  - **1727f3b:** security reviews authorized by the operator for unowned slice cycles. Check `docs/security.md` and ADR-063's delegation wording.
  - **a2bb20a:** the ct-act lock's stale-owner detection (PID plus `/proc` start time) and its behaviour at the check time limit.
  - **616f323:** the `mergedIntoAfter` proxy against ADR-060. Changes outside the controller are still caught only by Git.
  - **18f0bb8:**
    - adoption;
    - the hold release;
    - the untested allowance exclusion;
    - the retry of a reservation that created a worktree;
    - the automatic-merge wait for checkpoint reviews.
- **Done when:** each commit's review findings are fixed or have a recorded disposition in the relevant LIVE finding or R-C5, and `pnpm check` and both replays pass at the head.
- **Independent review, 2026-09-27.** Five reviewers read one area each, in isolated worktrees, and every finding was verified again before it was acted on. Findings are fixed one commit each, test first, and each test fails without its fix. Fixes to 18f0bb8 are recorded on [R-C5](#r-c5) (increment 2), to R-C11's interaction with the live fixes on [R-C11](#r-c11), and the rest here.
  - **a2bb20a, HIGH, fixed:** a ct-act interrupted while it waited for the workflow lock left its run's `act-active` lease behind. The wait was outside the signal handlers, so SIGTERM took the default exit. Every later ct-act in the run failed with EEXIST, and the run's build record was lost at freeze. The wait is now abortable, and SIGTERM/SIGINT end it through the check's own cleanup.
  - **a2bb20a, MEDIUM, fixed:** two contenders that both saw a dead owner could each remove the lock, so one deleted the lock the other had just taken, and both ran act (10 overlapping holds in 6 rounds of 10 contenders). Removal is now serialized by a guard directory, and staleness is decided again under it.
  - **1727f3b, MEDIUM, fixed (operator decision 2026-09-27):** the operator's authority for a source-required security review applied wherever no cross-project delegation existed, which also covered slice cycles owned by single-project roadmaps, and neither `docs/security.md` nor ADR-063 recorded it. The operator chose to keep it to cycles no roadmap owns. A single-project roadmap's slice now stops as `security-reviewer-unassigned`. Tested; the test fails without the fix.
  - **1727f3b, LOW-MEDIUM, fixed (operator decision 2026-09-27):** a cross-project attempt whose saved definition or entry could not be read fell through to the operator's authority and skipped the reviewer-assignment check. It now fails closed as `authority-lost`. ADR-063 and `docs/security.md` are amended for both, and `docs/security.md` now says an adopted or operator-requested round can run under a paused roadmap (R-C4's refresh note).
  - **ca7b954, MEDIUM-LOW, fixed:** the guided-continuation gate now accepts a drain-interrupted run. Continuing it with guidance resumed the vendor session with the restart prompt, which says the step's instructions are unchanged and omits the guidance, so the guidance reached only the brief file. The resume prompt now carries the step's guidance when there is any. Reached only by a Pause between the drain and the automatic resume, or through the API.
  - **Dispositions without a code change:**
    - **a2bb20a, LOW:** the lock wait is not charged to the check's time limit, so one ct-act can take twice the limit, and a wait that times out is a failed `local-ci` receipt that only its prose tells apart from a failing job. It is left for [R-G4](#r-g4), which takes over CI execution and its lock.
    - **a2bb20a, LOW, plausible:** three edge cases are also left for R-G4:
      - the lock is scoped by the CI cache root, not the Docker host, so two daemons sharing a socket with different act configurations do not exclude each other;
      - an act process group orphaned by a SIGKILLed launcher can outlive its reclaimed lock;
      - PID identity assumes a shared PID namespace.

      Agents can delete or plant locks under the cache root, which is consistent with ct-act being a cooperative control, not a sandbox (`docs/security.md`).
    - **a2bb20a, sound:** `/proc/<pid>/stat` parsing handles spaces and parentheses in `comm`, and start times compare as strings. The lock name is a hash of an already validated workflow path. Directories are 0700 and the owner file 0600. Release checks ownership and is unconditional in `finally`. Spawns use argument arrays only.
    - **1727f3b, LOW:** the repeat bound also stops a legitimate one-off re-review when runtime inputs changed during the review; Resume clears it and reviews again. It branches on codes. `onlyOperatorCanAdvance` now evaluates `securityReviewCurrent` each tick for unowned security-required cycles at merge, a small idle cost for R-D.
    - **1727f3b, sound:** the authorizer is the cycle's creator, checked as an active owner or editor at review start and again at launch. A removed or demoted creator authorizes nothing.
    - **616f323, LOW:** `mergedIntoAfter` scans the workspace's worktrees without an index on `(workspace_id, repository_id, integration_branch, merged_at)`. It is cheap at today's sizes, and an index needs a migration, so it is left for R-D. A later merge with an identical timestamp, or a legacy row without an integration branch, is still caught by the merge command's Git comparison. The test's "accepted before" precondition is conditional, and it simulates the later merge by a direct insert.
    - **616f323, sound:** keyed by workspace, repository and branch; every merge path goes through `markMerged`; conservative against ADR-060's tree-equality rule; `merged_at` strings order correctly.
    - **18f0bb8, open gap:** the automatic merge's wait for a checkpoint review the cycle can run itself has no test (replacing it with `false` leaves the suite green). Its predicate is the cycle's own launch condition, and it branches on structured fields.
    - **18f0bb8, LOW, for [R-C12](#r-c12):** adoption failures are swallowed while the roadmap is paused or needs attention (retried next pass, no reason recorded), and become a whole-roadmap `scheduler-error` while it runs.
    - **18f0bb8, by design:** a legacy repair the operator had paused is adopted anyway (operator decision 2026-09-26: adopt open unowned repairs). `answeredHolds` releases a `needs-attention` hold whatever its code, including `evidence-not-current`, which is harmless because the round re-verifies.
    - **18f0bb8, plausible, not constructible:** a retried reservation keeps its recorded source run; the phase gates prevent a stale one from being reused today.
    - **ca7b954, LOW:** the review-remediation shortcut's new `run.status === 'finished'` guard has no test of its own.
    - **f471830 (merge), sound:** both sides' helpers were kept unchanged, and hold removal is an ordinary roadmap write, which the projector observes.
    - **0a7d641 (docs), LOW, fixed:** the R-C5 header still said "increment 1 of 5".
  - **Done-when met.** Every finding is fixed or has a disposition here, on R-C5 or R-C11, and on each LIVE finding. At 2184f9a, `pnpm check` passes in one run: 188 test files and 1,518 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check. On a fresh copy of the 2026-09-23 snapshot, `controller:replay --check` reports 51 decisions and `--every-run --check` (a4aa12d golden) 278, both with 0 changed. The step-outcome change (question stops only) alters no recorded decision, because no recorded turn carries a suspected outage.

## Finding index

All 202 review findings in report order, then the LIVE findings recorded during the 2026-09-25/26 live run. Severity and status are the reviewer's; "Item" is the remediation item that resolves it.

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
| [LIVE-01](findings/LIVE-live-run-2026-09-25.md#live-01-continue-with-guidance-was-refused-after-a-failed-step-though-the-stop-asked-for-guidance) | high | CONFIRMED; fixed ca7b954 | S | [R-A7](#r-a7), [R-I11](#r-i11) | Continue with guidance was refused after a failed step, though the stop asked for guidance |
| [LIVE-02](findings/LIVE-live-run-2026-09-25.md#live-02-a-slice-cycle-no-roadmap-owned-never-ran-its-required-security-review-and-the-merge-refused-forever) | high | CONFIRMED; fixed 1727f3b | S-M | [R-A7](#r-a7), [R-I11](#r-i11) | A slice cycle no roadmap owned never ran its required security review, and the merge refused forever |
| [LIVE-03](findings/LIVE-live-run-2026-09-25.md#live-03-concurrent-ct-act-runs-of-one-workflow-destroyed-each-others-containers) | high | CONFIRMED; fixed a2bb20a | S | [R-G4](#r-g4), [R-I11](#r-i11) | Concurrent ct-act runs of one workflow destroyed each other's containers |
| [LIVE-04](findings/LIVE-live-run-2026-09-25.md#live-04-workflow-acceptance-and-the-merge-gate-disagreed-about-merged-candidate-checkpoint-evidence) | high | CONFIRMED; fixed 616f323 | S | [R-F1](#r-f1), [R-I11](#r-i11) | Workflow acceptance and the merge gate disagreed about merged-candidate checkpoint evidence |
| [LIVE-05](findings/LIVE-live-run-2026-09-25.md#live-05-delegate-source-fixes-created-repairs-outside-the-roadmap-that-owned-the-review) | high | CONFIRMED; fixed 18f0bb8 | M | [R-C5](#r-c5), [R-I11](#r-i11) | Delegate source fixes created repairs outside the roadmap that owned the review |
| [LIVE-06](findings/LIVE-live-run-2026-09-25.md#live-06-automatic-recovery-did-not-start-a-round-for-exo-02domain-and-nothing-said-why) | high | CONFIRMED; cause open | S-M | [R-C12](#r-c12), [R-I10](#r-i10) | Automatic recovery did not start a round for EXO-02/domain, and nothing said why |
| [LIVE-07](findings/LIVE-live-run-2026-09-25.md#live-07-a-delegated-checkpoint-review-repeats-the-same-failed-attestation-on-every-resume) | medium | CONFIRMED; cause HYPOTHESIS | S-M | [R-C13](#r-c13), [R-I10](#r-i10) | A delegated checkpoint review repeats the same failed attestation on every resume |
| [LIVE-08](findings/LIVE-live-run-2026-09-25.md#live-08-the-operator-cannot-see-what-is-supposed-to-run-and-what-blocks-it) | critical | CONFIRMED | S-M then L | [R-E3](#r-e3), [R-C12](#r-c12) | The operator cannot see what is supposed to run and what blocks it |

**Finding-index amendments (2026-09-24, phase 1 review).**
- **DATA-09.** Its remedy, dropping the three empty registry tables in a forward migration, is infeasible. `workspace_events` has foreign keys into them, and SQLite rejects inserts into it once they are missing. The finding stands. The code and configuration part is resolved by R-B8. The schema part needs a journal rebuild and moved to R-H6.
- **AGT-60.** The finding stands. R-C8 covers failures that are safe to retry, but the recorded incident was not safe to retry, so the rest is R-C9.
