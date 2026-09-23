# HIST — Historical forensics: commit history and live usage data

Reviewer area: git history since the 2026-09-04 pivot (99 non-merge commits + 1 merge, read-only) and the
live SQLite database (read via an online `.backup` copy at
(review-session analysis script, not retained), taken 2026-09-22 20:22 PDT; nothing written to the live DB).

Time conventions: git dates are local PDT (UTC-7); DB timestamps are UTC. "Cycle-hours" add up
across concurrent cycles; "wall hours" are elapsed clock time.

Scripts used for the numbers below are in the scratchpad (`cyc.py`, `wall.py`, `gaps.py`, `ops.py`,
`percyc.py`, `transient.py`, `notiftrans.py`) and can be re-run against a fresh DB copy.

## Summary

- **Agents are not the bottleneck. The controller's stops are.** 297 of 308 runs finished. Only
  3 failed (a Claude session limit, a "model at capacity" error, a background-wait exit) and 2
  were interrupted by restarts. Over the cross-project period (09-17 to 09-23 UTC), there were
  **~112 wall hours with no agent running while at least one cycle waited on the operator**,
  against **~30 wall hours with agents running**. Automated run-to-run transitions take a median
  of 3.2 s (p90 10.5 s). Transitions that need the operator take a median of **3.3 h** (p90
  19.4 h) and total **524 h** over 71 transitions.
- **The #1 cause of intervention is the design stage** on the cross-project roadmap. **10 of the
  11** distinct slices that started had at least one design-stage stop (27 stops in total):
  operator architecture decision, open questions, "investigation finished", or invalid
  classification output. Design stops account for ~227 of ~437 needs-attention cycle-hours.
  On the simpler single-project ActionQueue plan, only 1 of 11 item cycles stopped at design.
- **The #2 cause is the independent-verification / owning-slice repair loop.** EXO-01 alone used
  **89 runs (29% of all runs)**. Finding F-003 stayed open across about 13 repair rounds over
  ~48 h (09-18 to 09-20) until an allowance cap stopped the loop. On 09-18 the operator drove the
  loop by hand: **105 operator commands that day** (repair → merge → worktree integration update
  → review-again, hourly).
- **Development pattern: "blockage-response" commits.** 23 of 99 commits (14 of 48 since 09-16)
  were direct responses, landed within hours, to a live stop recorded in the DB. Each one added
  vocabulary instead of removing a cause:
  - `WorkCycle` optional fields went from **3 to 41** (total fields 30 to 126).
  - About 21 recovery/decision UI components were added.
  - 46 ADRs (020–065) and 22 migrations (0005–0026) landed in 18 days.
- **Controller growth was append-only.** `work-cycle-service.ts` grew from 525 to 4,029 lines
  across 34 commits (+~3,850 / −~370). `roadmap-service.ts` grew from 593 to 2,292 lines, and
  `runtime-evidence-service.ts` from 853 to 2,632 lines in 6 days. The web app grew from 18 to 92
  `.tsx` files and from 4 to 30 `*Panel.tsx`. API paths grew from 17 to 83.
- **Transient operator states and contradictory notifications are confirmed.**
  - 32 `awaiting-merge` states were resolved by the controller itself within 1 minute, and 16 of
    those within 10 s.
  - 10 times, a "Ready to record scope verification" notification was followed 17–403 s later by
    a contradicting "Scope review requires recovery" notification for the same item.
  - Suppression is implemented as a growing exception predicate in `notification-service.ts`
    (six conditions added by six separate commits).
- **Every deploy is a daemon restart, and every restart stops the roadmap.** There were 78 daemon
  starts since 09-04 (44 since 09-16), in lock-step with commits. `roadmap-service.ts:941-947`
  moves every running roadmap to needs-attention on startup. This produced 12 roadmap "Daemon
  restarted" stops, 17 roadmap resumes and 11 operator pauses.
- **Self-attestation ceremony.** There were 33 checkpoint evidence submissions and 32
  decisions, all "accepted" (100%), all by the same single user who submitted them.
  STACK-PLAN-ACCEPTED was re-submitted 9 times. That is 65 operator actions.
- **Real workloads.**
  - ActionQueue AQ-CONT-1 (14 items): fully completed and finalized in about 11 days, using 120
    runs. Finalization alone took 30 runs, 62 wall hours and 10 stops.
  - Cross-project map EXO-STACK-CONCURRENCY-DRAFT-1 v0.3.0: 33 work items, 69 slices, 95
    checkpoints, 18 decisions, 335 graph nodes and 1,221 edges, expanded into a 171-entry
    roadmap. **18 of 171 entries** were complete after 6 days, and the roadmap is now paused.
- **Storage.** The DB is 542 MB, of which `agent_run_events` is 485 MB. 278 MB of that is
  retained raw vendor JSON that duplicates the normalized payload; tool-result events alone are
  388 MB. That works out to ~1.5 MB of DB per run. On disk: runs dir 3.4 GB, `ci/` 4.6 GB, and
  manual pre-migration DB backups 1.6 GB. The repo holds 1.5 GB of UI walkthrough PNGs (4,986
  files).
- **Commit hygiene regressed.** 69 of 99 commits have no body. That includes nearly every
  commit from 09-10 to 09-22 except a handful, even though AGENTS.md says a change must be
  understandable "from the diff, the tests, and the commit message alone".

## Map

### Timeline (git, PDT)

| Phase | Dates | Commits | What happened |
|---|---|---|---|
| Pivot / bootstrap | 09-04 | 8 | Slice-contract process archived. Delegation loop, review-gated merge and dark UI shell built in one day. Operator feedback file (`feedback/post-mvp-feedback.md`, gitignored) written after the first run. |
| Backends and handoffs | 09-08 – 09-10 01:34 | 18 | Codex backend (exec, then app-server). Password recovery. Design→implement→review handoffs. Per-role profiles. |
| Automation core | 09-10 – 09-12 | 11 | Bounded work-item cycles (ADR-025). Integration branches (026). Pushover (027). Sequential/parallel roadmaps (029/030). Delegated merges and finalization (033). Storage (034). |
| **First real use: AQ plan** | 09-10 – 09-15 | 14 | 9 of 14 commits are blockage-responses to AQ roadmap/finalization stops: dirty worktree (ADR-031), conflicts (032), report validity (035), remediation allowance (036), background work (037), finding decisions (038), recovery agent/model (040). Staged finalization (042). |
| Cross-project foundations | 09-15 – 09-16 | 9 | ZIP imports and maps (043). Slices and parent acceptance (045). Phase reservations (046). Pinned builds and evidence (047). Cross-project supervision (048). Amendments (049). |
| UI page-anatomy refactor | 09-16 15:23 – 16:39 | 11 | Walkthrough capture harness, anatomy primitives, AttentionStrip, restructured pages. |
| **Second real use: cross-project** | 09-16 18:46 – 09-22 | 37 | 14 blockage-responses: design recovery (051/052), remediation recovery, scope review recovery, owning-slice repair (056), bounded roadmap recovery (057), dependency refresh (058), shared architecture decisions (059), provider recovery (062), checkpoint recovery (060), controller-obligation vs operator-question split (063), decision preparation (065). |

### Commit classification (99 non-merge commits since 2026-09-04 00:00 PDT)

| Class | Commits | Lines added (excl. walkthrough) | Hashes |
|---|---|---|---|
| feature | 41 | 77,613 | 3f3441c 7712b55 fc43c9e 5589a5e e441251 d066b69 4f14b61 b9fe423 f2adb01 6fdef2d adcbee8 4056977 ea12a5c 28a8c9d 03f63b8 79970ae 89b43ef fcaa48d 5093acd d9fd1d2 b816ad0 b56b165 8155fbc 993e8ec 9bdfdeb 1cee4d9 ba8cc13 023dc39 28750d0 e272b3c 2678af3 3d06bd9 d6d5dc6 828bf51 27752d5 3585aec 6921385 2b50b04 9af9cb0 2000759 bf08c0b |
| **blockage-response** | **23** | **25,232** | 7d59322 54271b0 b0a105a 056b423 729d518 252c7d5 16afe34 57e16d8 3094dd1 ec75719 0a0eda5 9675f17 79ee66e f067000 e2a916b acf9aeb 0edf859 48283ca 0c88b5a f3b3f27 4668fe1 027ee49 bfdd295 |
| UI | 13 | 8,018 | 1d26ae9 601520c 45ff3b5 667163c c966014 b6ba7f0 2037276 2999862 5d022cb a57688b 9d2df8f 81844a9 e60f213 |
| fix | 11 | 3,986 | 58b4a47 3802c00 70b43d8 7409b36 6cbc23b 8004667 95b384a c48acbc 8ee321f 936933b 3605f01 |
| docs | 8 | 1,101 | 49499b9 7ae4053 7909174 3f560d3 d2e6c83 ccee249 3bfcf82 614be2b |
| refactor | 2 | 1,330 | 39944d9 739041b |
| chore | 1 | 3 | 108280b |

"Blockage-response" means the commit's subject, ADR and diff answer a specific stop that the DB
records in the preceding hours. Representative stop→commit pairs (DB UTC → git PDT):

| Live stop (DB) | Response commit |
|---|---|
| 09-12 00:00Z "Review requires a clean worktree" (AQ-08) | 7d59322 09-11 17:54 — ADR-031 review housekeeping |
| 09-12 03:28Z "Merging … conflicts; resolve by hand" (AQ-09) | 54271b0 09-11 21:57 — ADR-032 delegated conflict resolution |
| 09-13 08:33Z "valid structured review report required" (finalization) | b0a105a 09-13 13:17 — ADR-035 |
| 09-13 23:42Z "Remediation limit reached … 1 nits (allowance 0)" | 056b423 09-13 19:58 — ADR-036 extra remediation grant |
| 09-15 03:06Z review failed waiting on background work | 729d518/252c7d5 09-14 — ADR-037 |
| 09-15 02:19Z storage below free-space reserve | 16afe34 09-15 02:26 — ADR-039 post-run cache cleanup |
| 09-15 09:59Z "You've hit your session limit" (Claude) | 3094dd1 09-15 12:05 — ADR-040 model change during recovery |
| 09-17 04:30Z design open questions (WI-01, EXO-01) | ec75719 09-16 22:37, 0a0eda5 — ADR-051/052 |
| 09-17 20:06Z EXO-01 "Remediation limit reached" | 9675f17 09-17 16:17 |
| 09-17 23:38Z "Scope review has open questions" | 79ee66e 09-17 18:19 |
| 09-18 repeated "Scope review requires recovery" | e2a916b (ADR-056), acf9aeb 09-18 16:26 (ADR-057) |
| 09-19/20 "Design needs an operator decision" | 48283ca, 0c88b5a (ADR-059), 3605f01, bf08c0b (ADR-065) |
| 09-20 21:55Z "Merge blocked: Checkpoint WI-AQ-G1 …" | 027ee49 (ADR-060) |
| 09-22 01:09Z "Selected model is at capacity" | f3b3f27 (ADR-062 provider recovery) |
| 09-22 07:33Z "Required predecessor WI-02's merge is absent" | 4668fe1 09-22 00:55 (22 min later) |
| 09-22 08:37Z "Review needs your input. Answer the Open questions" | bfdd295 09-22 12:06 (ADR-063) |

### Growth metrics

| Metric | 09-04 (49499b9) | 09-10 (d9fd1d2) | 09-12 (8155fbc) | 09-16 (d6d5dc6) | 09-20 (8ee321f) | 09-22 (bf08c0b) |
|---|---|---|---|---|---|---|
| server src LOC (non-test .ts) | 4,736 | 10,908 | 14,121 | 23,539 | 29,606 | 32,668 |
| web src LOC (non-test .ts/.tsx) | 2,716 | 8,632 | 10,767 | 15,895 | 21,171 | 23,628 |
| packages LOC (non-test) | 11,777 | 17,605 | 18,980 | 25,305 | 27,180 | 28,049 |
| web `.tsx` files / `*Panel.tsx` | 18 / 4 | 33 / 8 | 40 / 10 | 54 / 15 | 78 / 24 | 92 / 30 |
| test files | 70 | 91 | 93 | 105 | 131 | 145 |
| unique `/api/…` paths in routes | 17 | 47 | 54 | 69 | 75 | 83 |

- Lines added since the pivot, by area: server 27.8k, server tests 17.8k, web 22.4k, web tests
  4.5k, e2e 3.5k, contracts 3.2k, agents 2.8k, planning 2.5k, storage 2.4k, domain 2.3k, ADRs
  2.2k, walkthrough READMEs 20.4k (plus ~1.5 GB of PNGs). Total +120.7k / −10.4k.
- Docs growth: README 60→600 lines, architecture.md 249→480, operations.md 201→378,
  ui-principles.md 72→328.
- ADRs added: 46 (ADR-020 … ADR-065), with two naming schemes (`ADR-0xx-*.md` and `0xx-*.md`,
  033–050). ADR-060 was added after 061/062.
- Migrations added: 22 (`packages/storage/migrations/0005` … `0026`). Seven of them landed on
  09-15/09-16 alone.
- `WorkCycle` domain type (`packages/domain/src/work-cycle.ts`), measured at each commit that
  touched it:

  | Commit | Date | Readonly fields | Optional |
  |---|---|---|---|
  | fcaa48d | 09-10 | 30 | 3 |
  | 54271b0 | 09-11 | 54 | 13 |
  | 16afe34 | 09-15 | 69 | 22 |
  | ec75719 | 09-16 | 91 | 30 |
  | 0a0eda5 | 09-17 | 106 | 32 |
  | 2000759 | 09-22 | 126 | 41 |

  In live data, `work_cycles.state_json` carries 45 distinct top-level keys. 27 of them are
  optional recovery/workflow fields (e.g. `designRecovery` up to 60 KB, `scopeRepair`,
  `providerRecovery`, `designWait`, `phaseWait`, `designDependencyContinuations`,
  `integrationResolution`, `baselinePreparation`, `deferredNits`).
- Recovery/decision UI surfaces added since 09-11 (all under `apps/web/src/features/`):
  - IntegrationResolutionPanel
  - FinalizationFindingCheckpoint, FinalizationCheckpoint, FinalizationRecoveryAgent,
    FinalizationStageDecision
  - DesignRecoveryPanel, BaselinePreparationPanel, HistoricalEvidencePanel
  - CycleRemediationRecovery, ScopeReviewRecovery, ScopeRepairPanel, ScopeRecoveryPanel
  - DependencyRefreshPanel, ArchitectureDecisionPanel, SharedDecisionInbox
  - CycleGuidanceRecovery, ProviderRecovery, CheckpointRecoveryPanel, DecisionPreparationPanel
  - RoadmapAttention, AttentionStrip

  That is 21 components, each added by the blockage-response commit for its stop.
- Hotspot churn since the pivot (commits touching the file): `work-cycle-service.ts` 34,
  `App.tsx` 29, `composition.ts` 25, `notification-service.ts` 12.

### Live data (DB copy, 2026-09-23 03:22 UTC)

**Inventory**
- 1 workspace, 3 projects/repos (ActionQueue, WorldInterface, Exoskeleton), 5 plan versions,
  80 work items.
- 308 runs, 46,446 run events, 51 cycles, 4 roadmaps (14 definition revisions), 29 merge
  operations, 56 worktrees.
- 2,852 audit events, 3,289 workspace events, 139 notification records, 268 phase reservations,
  188 build records, 33 evidence submissions.

**Plans executed (plan_versions)**

| Project | Plan document | Version | Items | Required deps | Status |
|---|---|---|---|---|---|
| ActionQueue - AQ-CONT-1-r2 | AQ-CONT-1 Implementation Plan | v1 (active) | 14 | 24 | 14/14 completed + finalized, 120 runs (30 finalization), 09-04 → 09-15 |
| WorldInterface - WI-FABRIC-2 | WI-FABRIC-2 Foundational Implementation Plan | v1 superseded; v2 active | 14 | 38 | v2: 6 admitted, 2 completed, 78 runs |
| Exoskeleton - EXO-V3 | EXO-V3 Comprehensive Implementation Plan | v1 superseded; v2 active | 19 | 68 | v2: 4 admitted, 2 completed, 110 runs |

**Cross-project map (`concurrency_definitions`)**
- EXO-STACK-CONCURRENCY-DRAFT-1 rev 0.3.0: 33 work items, 69 slices, 95 checkpoints,
  18 decisions, 15 evidence profiles, 76 acceptance-coverage rows, 335 graph nodes,
  1,221 graph edges.

**Roadmaps**

| Roadmap | Mode | Entries | Result |
|---|---|---|---|
| ActionQueue - Initial Roadmap Test | sequential | 3 | completed 09-11 (5.5 h) |
| ActionQueue - Roadmap w/ Concurrency Test | parallel | 3 | completed 09-12 (6.3 h) |
| Multi-step Autonomous Long Run | – | 4 | completed 09-13 (13.2 h) |
| **Cross-project roadmap** | parallel, maxInFlight 4, maxPerRepo 2, automatic integration merges, manual conflicts | **171** (69 slice, 69 slice-verification, 33 parent-acceptance) | **paused**. 25 attempts: 21 completed covering 18 distinct entries (EXO-01/domain attempted 4×); 4 active. State version 173; `state_json` 248 KB. |

**Runs**

| Role | Backend | n | Avg min | Max min | Total h | Cost reported |
|---|---|---|---|---|---|---|
| design | codex | 39 | 7.2 | 38.7 | 4.7 | – |
| design | claude-code | 1 | 56.9 | – | 0.9 | $10 |
| implement | codex | 97 | 32.0 | 476.2 | 51.7 | – |
| implement | claude-code | 9 | 49.1 | 126.3 | 7.4 | $106 |
| review | codex | 145 | 13.5 | 55.6 | 32.6 | – |
| review | claude-code | 17 | 25.6 | 51.9 | 7.2 | $380 |

- Models: gpt-6-astra 275 runs (91%), claude-fable-5-1 26, gpt-6-sol 6.
- Status: finished 300; failed 3 (review: background wait, session limit, model at capacity);
  cancelled 3; interrupted 2 (restart).
- Review verdicts: 84 mergeable, 71 changes-requested, 7 none.
- 281 runs were inside cycles; 27 were manual.

**Cycles**

| Status | Count |
|---|---|
| completed | 46 |
| paused | 2 (EXO-03, EXO-04) |
| needs-attention | 1 (WI-09 design) |
| awaiting-merge | 1 (WI-04, merge blocked on checkpoint WI-WORKER-G1) |
| stopped | 1 |

- Cycle-hours by status: running 83, needs-attention 437, awaiting-merge 30, paused 29 (all
  concurrent cycles summed).

**Wall-clock (09-10 → 09-23 UTC, 1-minute sweep)**
- 59 h agents running with nothing waiting.
- 27 h agents running while something waited.
- **160 h with no agent running and at least one cycle waiting on the operator.**
- 69 h idle (nothing delegated).
- Mean concurrency was far below the configured 4: ≥2 concurrent runs for only 9.8 h in total.

**Transitions between consecutive runs in a worktree**

| Kind | n | p50 | p90 | Total |
|---|---|---|---|---|
| Automated (no operator action in between) | 159 | 3.2 s | 10.5 s | 91 h, almost entirely a few re-review waits |
| Operator-mediated | 71 | 3.3 h | 19.4 h | 524 h |

**Storage**

| Location | Size |
|---|---|
| state DB | 518 MB on disk / 542 MB logical |
| runs/ | 3.4 GB (309 dirs, median 7.7 MB, max 156 MB — scratch/) |
| worktrees/ | 1.1 GB |
| ci/ | 4.6 GB (4.3 GB docker) |
| backups/ | 1.6 GB (4 manual pre-migration copies named `before-*`/`*-predeploy-*`) |
| before-schema14-* | 112 MB |

## Findings

### HIST-01: Development proceeded by patching each live blockage with new state, panels and vocabulary ("spaghetti-fication" measured)
- Severity: high
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - 23 of 99 post-pivot commits (25.2k added lines) are blockage-responses. Each maps to a stop
    recorded in `audit_events`/`notification_records` hours earlier (Map, stop→commit table).
    Since 09-16, 14 of 48 commits are blockage-responses and only 13 are new features.
  - `packages/domain/src/work-cycle.ts`: optional fields 3 → 41 (fcaa48d → 2000759).
    `work_cycles.state_json` in live data has 45 top-level keys.
  - About 21 recovery/decision UI components were added, one per stop type (Map).
  - 46 ADRs in 18 days (020–065). Most blockage-responses add an ADR describing a narrow
    recovery mode (e.g. 036, 038, 040, 051, 052, 056, 057, 060, 062, 063, 065).
  - `contracts/src/work-cycle.ts:378-398`: the cycle control union grew `retry-provider`,
    `review-again` and `authorize-remediation`. Separate cycle sub-routes were added for
    `baseline-evidence`, `baseline-preparation`, `design-recovery`, `integration-resolution` and
    `scope-repair` (`apps/server/src/routes/work-cycles.ts`), plus roadmap `scope-recovery`,
    `decision-preparations`, `prepare-decision`, `delegation`, `capacity` and `agent-profiles`
    (`routes/roadmaps.ts`).
- Impact:
  - Each stop class has its own state field, reason string, panel, command and ADR. The operator
    has to learn a new recovery surface for each kind of stop, which is pain point 1.
  - Maintainers face a combinatorial state space in the cycle JSON (45 keys) that no single
    state machine describes.
  - Fixes rarely removed a stop class. They added a way for the operator to resolve it (e.g.
    design stops went from 5 "open questions" to 9 "operator decision" + 6 "investigation
    finished" + 4 "invalid classification" after three design-recovery commits).
- Recommendation:
  - Stop adding per-stop recovery modes. Define one closed `Stop` record per cycle/roadmap entry
    with fields `{ kind, owner: controller|agent|operator, requiredDecision?, evidenceRefs,
    allowedActions[] }`.
  - Route every operator-facing stop through one decision inbox with a uniform action set:
    answer/approve, grant budget, retry with guidance, take over, abandon.
  - Convert the ~27 optional recovery fields into (a) that single stop record and (b) an
    append-only per-cycle step history table.
  - Classify each existing stop reason (list in HIST-03) as auto-resolvable, agent-resolvable or
    operator-decision, and delete the panels whose stop class becomes controller-resolved.
- Effort: L
- Related: HIST-03, HIST-05, HIST-18; the controller and UI reviewers' areas
- Plan/roadmap format impact: none. The stop record is controller state, not plan format.

### HIST-02: Wall-clock throughput is dominated by waiting for the operator, not by agent work or controller latency
- Severity: high
- Category: performance
- Status: CONFIRMED
- Evidence:
  - `wall.py` (1-minute sweep over run intervals and cycle status intervals from
    `audit_events` `work-cycle.updated`) gives these totals for 09-10 → 09-23 UTC:
    - 160 h with no agent running and at least one cycle in needs-attention, awaiting-merge or
      paused.
    - 86 h with an agent running.
    - Daily for 09-19 → 09-22 UTC, hours with no agent running while a cycle waited: 17.3,
      17.6, 23.8 and 20.8.
  - `gaps.py`: 159 automated run→run transitions (p50 3.2 s, p90 10.5 s) against 71
    operator-mediated transitions (p50 11,734 s ≈ 3.3 h, p90 70,002 s ≈ 19.4 h, max 44 h,
    total 524 h).
  - The cross-project roadmap is configured for `maxInFlight: 4, maxPerRepository: 2`, but ≥2
    runs were concurrent for only 9.8 h in total.
- Impact:
  - Controller transition latency is not the problem. Every hour spent on controller speed
    buys nothing compared with removing operator stops.
  - With a 171-entry roadmap at ~3 completed entries/day, completion would take ~2 months at
    the current stop rate.
- Recommendation:
  - Make "time waiting on operator" a first-class metric. Record `stop.openedAt`/`resolvedAt` in
    the stop record from HIST-01 and show it on the dashboard.
  - Prioritize remediations by cycle-hours lost (HIST-03 ranking).
  - Keep independent work flowing while one entry waits: check that entries blocked on one
    parent do not starve siblings, since the scheduler already claims not to disable siblings
    (docs/architecture.md "item attention does not disable scheduling for siblings"). Data shows
    long no-agent periods even with 171 entries, so eligible parallel work was scarce. See
    HIST-19.
- Effort: M (metric); the fixes live in other findings
- Related: HIST-03, HIST-04, HIST-19
- Plan/roadmap format impact: none

### HIST-03: Ranked operator-intervention causes (the highest-leverage automation fixes)
- Severity: high
- Category: reliability
- Status: CONFIRMED (counts); remediation ideas are recommendations
- Evidence: `cyc.py` over `audit_events` `work-cycle.updated` system transitions to
  `needs-attention`, 67 entries, reasons normalized. Hours are cycle-hours spent in
  needs-attention until the next transition.

  | Rank | Stop cause (reason text prefix) | Entries | Cycle-hours | Class |
  |---|---|---|---|---|
  | 1 | Design: "Design needs an operator decision. Use Shared architecture decisions…" | 9 | 131.0 | operator decision (shared ADRs across slices) |
  | 2 | Agent asked operator: "Review/Implementation needs your input. Answer the Open questions…", "Finalization needs your input or a complete Open questions checkpoint" | 8 | 70.6 | mixed; often protocol |
  | 3 | Scope review recovery: "Scope review requires recovery: … Address findings through the owning slice" | 17 | 55.4 | controller loop (HIST-04) |
  | 4 | Design: "Design has open questions or lacks an explicit '## Open questions' section containing only 'none'" | 5 | 43.5 | protocol/format + genuine |
  | 5 | Upstream/integration advanced: "wi integration changed. Preview dependency refresh…", "Integration branch advanced; update the worktree…" | 2 | 37.5 | controller-resolvable |
  | 6 | Design: "Design investigation finished. Review the evidence and answers, then use Resolve design questions to continue." | 6(+1 open) | 31.4 | controller checkpoint (no decision needed if answers are complete) |
  | 7 | Design: "Design classifications require valid kinds, dependency identities and cited answers." | 4 | 24.2 | agent output validation → should auto-retry |
  | 8 | "Remediation limit reached…" / "Two remediation rounds left the same open findings" | 5 | 19.4 | budget policy |
  | 9 | "The step did not finish with a complete successful result" (session limit / capacity) | 2 | 12.5 | provider (now ADR-062) |
  | 10 | "A complete, valid structured review report is required." | 2 | 8.4 | agent output validation → auto-retry |
  | 11 | "Review requires a clean worktree…" | 2 | 2.9 | fixed by ADR-031 |
  | 12 | Integration conflicts; "Required predecessor … merge is absent" | 4 | 2.4 | controller |
  | 13 | Daemon restarted (cycle) | 1 | 1.3 | deploy (HIST-06) |

  Additional operator touches outside cycle needs-attention (`ops.py`, user `audit_events`):

  | Action | Count |
  |---|---|
  | checkpoint evidence submit+decide | 65 |
  | worktree integration update requests (`branches.updated` update-requested + updated) | 64 |
  | cycle resume | 42 |
  | manual run start/end/message/cancel | 68 |
  | merge approvals (`worktree.merged` by user) | 27 |
  | control pause/stop | 22 |
  | roadmap resume | 17 |
  | record scope verification | 15 |
  | design-recovery | 14 |
  | review-again | 14 |
  | delegate-scope-repair | 14 |

  Before 09-16, user commands were 23 setup, 26 routine, 78 manual execution, 31
  recovery/decision. From 09-16 onward: 28 setup, 42 routine, 22 control, **246
  recovery/decision**, 25 manual execution.
- Impact: every design-stage stop on a 69-slice plan costs the operator a context switch and
  hours of idle agents. 10 of 11 started cross-project slices hit at least one design stop, so
  this pattern would recur ~60 more times on the remaining slices.
- Recommendation, in order of leverage:
  1. **Design stage.** Batch and prefetch shared architecture decisions per roadmap before
     slices start: bf08c0b's "decision preparation" goes in this direction. Make "investigation
     finished" continue automatically when every question has a cited answer and no
     operator-classified decision remains. Treat classification/format validation failures
     (#7, #10, missing Open-questions heading in #4) as a bounded automatic re-prompt of the
     same run, not an operator stop.
  2. **Scope-review loop (HIST-04).** Add convergence detection across parent/slice rounds, and
     keep repair cycles under the roadmap's merge policy.
  3. **Integration advanced (#5).** Refresh and re-review automatically when the only change is
     upstream integration and the policy allows automatic integration merges. The operator
     issued 33 manual update requests.
  4. **Agent open questions (#2).** Split "questions answerable by a controller obligation"
     from real operator questions (ADR-063 started this). Surface only the latter, batched.
  5. **Evidence ceremony (HIST-07)** and **restart stops (HIST-06)**.
- Effort: L overall. Individual items S–M.
- Related: HIST-01, HIST-04, HIST-06, HIST-07, HIST-10
- Plan/roadmap format impact: none required. Checkpoints and decisions in the map format stay.
  The change is who or what satisfies them and when.

### HIST-04: EXO-01 parent-acceptance ↔ owning-slice repair ping-pong consumed 29% of all runs without convergence detection
- Severity: high
- Category: reliability
- Status: CONFIRMED (loop and counts); root cause of non-convergence is a HYPOTHESIS
- Evidence:
  - `percyc.py` gives, for scope `exo/EXO-01/domain`: 17 cycles and 73 runs. For
    `exo/EXO-01` parent-acceptance: 1 cycle, 16 review runs, 96.5 h. Slice-verification cycle
    `b0514f6d…`: 18 reviews and 16 `awaiting-merge` entries, re-armed by `review-again` 15
    times. That is **89 runs**, 22.1 agent-hours.
  - Parent-acceptance review outcome summaries (agent_runs, 09-18T00:12Z → 09-20T00:23Z) say
    "F-003 remains open" in ~13 consecutive reviews. Each owning-slice repair meanwhile merged
    and passed slice verification: test counts rose 52 → 59 → 65 → 69 → 72 → 78 → 81 → 85 → 91
    → 95 → 101 → 106 → 112 → 116. F-003 ("Complete semantic dispositions in the non-test
    ledgers", major) was resolved only on 09-20 00:23Z, when F-005 was raised.
  - "Automatic recovery allowance exhausted (3 rounds for this parent)" appeared only on
    09-20T07:21Z, after acf9aeb (ADR-057) introduced the bound.
  - Before acf9aeb, repair cycles ran outside the roadmap attempt. The roadmap `attempts` list
    shows only 4 EXO-01/domain attempts against 16 cycles, so each repair needed a manual merge
    (10 user `worktree.merged` on 09-18), a manual integration update (21 user update requests
    on 09-18), and a manual `review-again`. The operator issued 105 commands on 09-18 (PDT).
- Impact: one parent item absorbed a day and a half of operator time and 29% of all agent runs.
  The loop made progress but could not be observed as progress: the "same finding still open"
  signal existed per cycle ("Two remediation rounds left the same open findings") but not
  across the parent/slice boundary.
- Recommendation:
  - Track finding identity across the parent→slice→parent loop, since F-IDs are already stable
    in review reports (ADR-035). Detect "same finding open after N repair rounds with
    measurable progress" versus "no progress". Escalate once, with the finding text and a
    progress summary, instead of per-round stops.
  - When a parent finding is larger than one bounded remediation (a ledger completion task),
    let the controller propose splitting it into a follow-up slice/work item. That feeds back
    into planning, as the operator's vision describes.
  - Keep all repair cycles inside the roadmap's merge/integration policy (already partly done in
    acf9aeb). Verify that no repair path still requires manual merges.
  - HYPOTHESIS: each repair round got only the current review snapshot, not the cumulative
    remaining-work list for F-003, so each round fixed a subset. Verify by reading the repair
    implement briefs (`agent_runs.brief` for the EXO-01/domain repair cycles on 09-18).
- Effort: M
- Related: HIST-03 (#3), HIST-08
- Plan/roadmap format impact: none. Proposing new slices would go through the existing
  map-amendment path (ADR-049).

### HIST-05: Operator-facing states and notifications fire during automated transitions (pain point 3 confirmed in data)
- Severity: high
- Category: ux
- Status: CONFIRMED
- Evidence:
  - `transient.py`: of 139 needs-attention/awaiting-merge entries, 60 were left within 5 min
    and 50 of those by `system`. **32 `awaiting-merge` states lasted under 1 minute** (16 of
    them ≤10 s) before the controller itself advanced them.
  - `work-cycle-service.ts:2246-2253`: review-only cycles are parked in `awaiting-merge` with
    "Independent review meets the completion policy. Ready to record scope verification or
    parent acceptance." The roadmap then consumes that state.
  - 10 cases where a delivered "Ready to record scope verification" notification was followed
    17–403 s later by a "Scope review requires recovery" notification for the same item.
    Examples: 09-18T17:06:24Z → +26 s; 18:35:48Z → +17 s; 19:40:28Z → +20 s.
  - `notification-service.ts:238-274` decides "automation-owned, don't notify" with a predicate
    that re-derives roadmap policy. Its clauses were added by b56b165 (entryHolds, 09-11),
    8155fbc (automatic integration, 09-12), e2a916b (`scopeReviewWait`, 09-17), acf9aeb
    (`automatedScopeRecoveryWait`, 09-18), c48acbc (`cycleTransitioning`, 09-19) and 027ee49
    (`scopeMergeWait`, 09-22).
  - Notification `sourceKey` includes `cycle.version` (`notification-service.ts:282`), so every
    version bump in an attention state yields a new record. There are 114 attention records.
- Impact:
  - The operator gets pushed, reads, and finds the state already changed or contradicted.
  - The dashboard AttentionStrip flickers for automated steps.
  - Each new automated path needs another exception clause, or it leaks notifications.
- Recommendation:
  - Invert the rule. A cycle/roadmap entry should only enter an operator-owned state when the
    stop record (HIST-01) says `owner: operator`. Automated hand-offs should use distinct
    controller-owned states, e.g. `verifying`, `integrating`, `recording-evidence`, not
    `awaiting-merge`.
  - The notification service should then notify on `owner: operator` alone and delete the
    policy re-derivation.
  - Add a short settle window (e.g. 60–120 s) before pushing, as defense in depth.
  - Key notifications on the stop ID, not the cycle version.
- Effort: M
- Related: HIST-01, HIST-17; notification/controller reviewers
- Plan/roadmap format impact: none

### HIST-06: Deploy = restart, and every restart stops running roadmaps and live runs
- Severity: medium
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - `journalctl --user -u craftingtable`: 78 "Started CraftingTable daemon" since 09-04, 44
    since 09-16. Start times match commit times, e.g. fcaa48d 09-10 13:49 → start 13:50:51;
    bf08c0b 09-22 19:24 → start 19:24:46.
  - `roadmap-service.ts:941-947`: on startup every `running` roadmap →
    `needs-attention` "Daemon restarted. Inspect the current item and explicitly resume the
    roadmap." Cycle equivalent: `work-cycle-service.ts:1525`. docs/operations.md:326 documents
    the manual resume.
  - DB: 12 roadmap "Daemon restarted" stops, 17 roadmap resumes, 11 roadmap pauses (the
    operator pausing before deploying), 1 cycle restart stop, 2 runs `interrupted`.
  - 4 manual pre-deploy DB backups (1.6 GB) plus a `before-schema14-*` copy in
    `~/.local/share/craftingtable`.
- Impact:
  - While the operator dogfoods and develops CraftingTable at the same time, each commit costs
    a manual pause, deploy, resume and inspect round.
  - Restarts during live runs lose agent work.
  - Overnight automation cannot survive an unattended restart (e.g. an OS update).
- Recommendation:
  - Add graceful drain: `systemctl stop` should stop admitting new runs, wait (bounded) for
    running turns to reach a boundary, and persist that the shutdown was clean.
  - On a clean restart with no live process lost, auto-resume roadmaps and cycles, and require
    explicit resume only after unclean interruption.
  - Take the pre-migration DB snapshot automatically in the migration runner (StorageService
    already has backup machinery, ADR-034).
- Effort: M
- Related: HIST-13
- Plan/roadmap format impact: none

### HIST-07: Checkpoint evidence acceptance is a self-attestation ceremony (65 operator actions, 100% accepted)
- Severity: medium
- Category: ux
- Status: CONFIRMED
- Evidence:
  - `evidence_submissions`: 33 rows, all `subject.kind = checkpoint`. 22 are architecture
    decisions (WI-ADR-*/EXO-ADR-*). STACK-PLAN-ACCEPTED was submitted 9 times; AQ-BASELINE-ACCEPTED
    and WI-AQ-G1 once each.
  - `evidence_decisions`: 32 rows, all `outcome: accepted`.
  - Audit: 33 `evidence.submitted` and 32 `evidence.decided`, all by the one user.
  - "Checkpoint evidence needed" notifications: 12 records, up to 8 deliveries each.
  - 21 submissions were decided within about 6 h on 09-21 (17:42Z–23:14Z), in bursts of one
    every 1–3 min (22:28–22:45Z). That is consistent with batch rubber-stamping.
- Impact: evidence review gives no real independence: the same human submits and accepts,
  often in bulk. It stops the roadmap ("Merge blocked: Checkpoint WI-AQ-G1 must pass…") and
  sends reminders.
- Recommendation:
  - For checkpoints whose evidence is controller-verifiable (generated saved-plan acceptance,
    receipts, build records), have the controller record acceptance automatically and show it
    as an audit fact.
  - Keep operator acceptance only for checkpoints the map marks as requiring a human (e.g.
    architecture decisions). Present those as one batched decision list per roadmap, ahead of
    the slices that need them.
  - Stop re-requesting STACK-PLAN-ACCEPTED on revisions that don't change its inputs: 9
    submissions for one checkpoint.
- Effort: M
- Related: HIST-03, HIST-01
- Plan/roadmap format impact: none if the map's checkpoint semantics are preserved. Whether a
  checkpoint "requires human" should be derived from existing map fields (evidence profile /
  reviewer roles). If the map cannot express it, a format addition would be needed; flag for
  the planning reviewer.

### HIST-08: Merge approvals and "record scope verification" still require manual clicks in delegated flows
- Severity: medium
- Category: ux
- Status: CONFIRMED
- Evidence:
  - 27 `worktree.merged` by user against 12 by system. On 09-18 there were 10 user merges,
    while the cross-project roadmap had `integrationMerge: automatic`, because repair cycles
    were outside roadmap attempts (HIST-04).
  - 24 "Ready for merge" notifications.
  - 15 user `scope.evidence-recorded`.
  - 66 system transitions to `awaiting-merge`.
- Impact: routine approvals are mixed in with real decisions in the same attention surfaces.
- Recommendation: after the HIST-05 state split, the only operator merge approval left should be
  protected-destination promotion (ADR-033). Audit that every automated scope/repair/
  verification path records its evidence and merges under the roadmap policy.
- Effort: S–M
- Related: HIST-04, HIST-05
- Plan/roadmap format impact: none

### HIST-09: Agent reliability is high; stops are controller-derived. Prioritize accordingly
- Severity: medium
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - Runs: 300 finished, 3 failed, 3 cancelled, 2 interrupted (by restart).
  - Failure summaries: "waiting on the background…" (09-15), "You've hit your session limit"
    (09-15), "Selected model is at capacity" (09-22).
  - Codex gpt-6-astra runs 91% of runs, with no failures. Only 5 of the 67 needs-attention
    entries are due to run failure or provider problems.
- Impact: engineering effort spent on agent/process supervision edge cases (ADR-037, ADR-062)
  addresses ~3% of stops. Controller policy stops are ~90%.
- Recommendation: treat the HIST-03 ranking as the roadmap for the automation work. Freeze new
  process-supervision features unless data shows new failure classes.
- Effort: S (prioritization)
- Related: HIST-03
- Plan/roadmap format impact: none

### HIST-10: Agent-output format validation becomes operator stops instead of automatic re-prompts
- Severity: medium
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - Needs-attention stops for "A complete, valid structured review report is required." (2,
    8.4 h), "Design classifications require valid kinds, dependency identities and cited
    answers." (4, 24.2 h; WI-09 repeated on 09-22 00:02, 07:32, 08:06 and 09-23 00:06), and
    "…lacks an explicit '## Open questions' section containing only 'none'" (part of 5,
    43.5 h).
  - The finalization had 10 stops in 62 h (AQ, 09-13→09-15), several of this type.
- Impact: a malformed or incomplete agent report parks the cycle until the operator reads it
  and clicks resume. Nothing in these cases needs a human decision.
- Recommendation:
  - On a structural validation failure, send one bounded follow-up turn to the same session
    (the session stays open while waiting, per ADR-037) quoting the validator errors.
  - Stop only after N failed repairs (N=2), and record the attempts in the stop record.
- Effort: S–M
- Related: HIST-03 (#4, #7, #10)
- Plan/roadmap format impact: none

### HIST-11: Run-event storage is dominated by duplicated raw vendor JSON
- Severity: medium
- Category: performance
- Status: CONFIRMED
- Evidence:
  - `dbstat`: `agent_run_events` is 485 of 542 MB.
  - Per kind: tool-result 18,565 events, 159 MB payload + 229 MB raw; tool-call 19 MB + 41 MB
    raw.
  - By backend: codex 389 MB (227 MB raw), claude 83 MB (51 MB raw).
  - ~1.5 MB per run; 29–64 MB/day on active days.
  - `raw_json` column: `packages/storage/src/repositories/execution/index.ts:595`.
- Impact:
  - The DB grows ~0.5 GB per ~300 runs. The 171-entry roadmap at the current runs-per-entry
    rate would add several GB.
  - Online backups (ADR-034) scale with it: 509 MB per backup copy.
  - HYPOTHESIS: large rows slow journal paging queries.
- Recommendation:
  - Retain `raw_json` only for a bounded window, or only for events whose normalization failed.
    Move tool-result bodies above a threshold into per-run compressed files under the run
    directory, keeping a digest and preview in the DB.
  - Add a retention policy aligned with run-directory cleanup (ADR-039).
- Effort: M
- Related: HIST-13
- Plan/roadmap format impact: none

### HIST-12: Roadmap state rewrites a 248 KB JSON blob (including a full definition copy) on every change
- Severity: medium
- Category: performance
- Status: CONFIRMED (sizes); UI-slowness contribution is a HYPOTHESIS
- Evidence:
  - The `roadmaps` row for the cross-project roadmap: `state_json` 248,074 bytes at version
    173. Its `definition` key alone is 230,804 bytes, and `attempts` is 9.4 KB.
  - `packages/domain/src/roadmap.ts:153` (`readonly definition: RoadmapDefinition` inside the
    mutable roadmap state).
  - `roadmap_definitions` holds 11 full revisions (174–231 KB each). 4 revisions were saved
    within ~2 minutes (09-17 00:55–01:57Z, 21:52–21:54Z).
  - 247 `roadmap.updated` audit events and 252 `roadmap-changed` workspace events.
- Impact: every scheduler advance re-serializes and rewrites ~250 KB, and every browser
  refetch of roadmap state transfers it. HYPOTHESIS: this contributes to the UI slowness on
  automated transitions (pain point 3). Verify with request timing on `GET …/roadmaps`.
- Recommendation: store only `definitionRevision` in mutable state and join the immutable
  definition on read (cached by revision). Give the browser a compact per-entry projection
  (status, blockers, dependencies) instead of the full definition.
- Effort: M
- Related: HIST-19; controller/UI reviewers
- Plan/roadmap format impact: none (storage layout only)

### HIST-13: Schema and ADR churn rate (22 migrations, 46 ADRs in 18 days) with manual pre-migration backups
- Severity: medium
- Category: architecture
- Status: CONFIRMED
- Evidence:
  - Migrations 0005–0026, 7 of them on 09-15/16.
  - ADR-020…065, with two filename schemes (`033-…`–`050-…` without the `ADR-` prefix).
  - `backups/` holds `before-native-verification-…`, `before-repository-policy-…`,
    `agent-profiles-schema25-…` and `agent-profiles-predeploy-…` (1.6 GB), plus
    `before-schema14-*`.
  - architecture.md is now a changelog of schema numbers ("Schema 12…23" paragraphs) rather
    than a description of the current design.
- Impact: every blockage-response ships a migration. The operator protects himself with manual
  backups. New agents must read 46 ADRs to understand the current model, which is less than
  its history.
- Recommendation:
  - Consolidate: after the HIST-01 state redesign, write one current-state architecture doc and
    mark superseded ADRs.
  - Fix ADR naming.
  - Automate pre-migration snapshots (HIST-06).
- Effort: M
- Related: HIST-01, HIST-06; docs reviewer
- Plan/roadmap format impact: none

### HIST-14: UI walkthrough captures are committed on nearly every commit since 09-16 (1.5 GB, 4,986 PNGs)
- Severity: medium
- Category: simplification
- Status: CONFIRMED
- Evidence:
  - `du -sh docs/ui-walkthrough` = 1.5 GB, 57 capture dirs, 4,986 PNGs.
  - Walkthrough READMEs account for 20.4k added lines. Every commit from 828bf51 onward adds
    ~570–1,230 README lines plus a full PNG set (see the numstat table).
  - `.git` is 1.1 GB.
  - AGENTS.md requires captures "before and after any UI change that alters page structure".
    In practice one was made per commit, including server-only fixes (e.g. 8ee321f, 3605f01).
- Impact: clone and checkout cost, and diffs dominated by capture noise. Most captures are
  near-identical.
- Recommendation: keep captures out of the main history (e.g. Git LFS, or an ignored directory
  with an index of commit→capture). Capture only for structure-changing UI commits, as
  AGENTS.md says.
- Effort: S
- Related: docs/UI reviewers
- Plan/roadmap format impact: none

### HIST-15: Commit messages stopped describing changes; ADR numbering is inconsistent
- Severity: low
- Category: docs
- Status: CONFIRMED
- Evidence:
  - 69 of 99 commits have an empty body (ignoring attribution trailers), including nearly every automation and blockage-response
    commit from 09-10 (e.g. fcaa48d, 8155fbc, e2a916b, acf9aeb, f3b3f27, 027ee49).
  - None of the 69 bodiless commits carries a Co-Authored-By trailer. Most of the 30 with bodies are
    Claude-attributed (5 unattributed commits have bodies: b816ad0, ba8cc13, 023dc39, 8004667, bfdd295).
  - AGENTS.md ("A different agent should be able to understand a change from the diff, the
    tests, and the commit message alone").
- Impact: forensic reconstruction (this report) had to rely on ADRs and DB timing. Future
  agents lose the "why".
- Recommendation: require a body (what stop or need it addresses, what state/vocabulary it
  adds) through a commit-msg hook or review checklist. Record which live stop motivated the
  change.
- Effort: S
- Related: HIST-13
- Plan/roadmap format impact: none

### HIST-16: Plan finalization was the most expensive phase of the only completed plan
- Severity: medium
- Category: reliability
- Status: CONFIRMED
- Evidence:
  - AQ finalization cycle: 30 runs (18 review, 12 implement), 19.8 agent-hours, 62.1 wall
    hours, 10 needs-attention entries, 11 operator actions, 8 remediation rounds.
  - For comparison, the 11 AQ item cycles took 3–7 runs and 1.2–4.0 h each.
  - Stops included invalid report, remediation limit (1 nit, allowance 0), "needs your input",
    dirty worktree, session limit, and 5 non-deferred nits.
  - It produced 7 commits and 8 ADRs (035–042) in 3 days, including a full staged-finalization
    redesign (1cee4d9, +3,034 lines).
- Impact: whole-plan finalization is where the Studio's "minimum operator input" goal is
  furthest away. Cross-project plans have not reached it yet.
- Recommendation:
  - Before the cross-project roadmap reaches finalization, replay the AQ finalization stop
    sequence against the current staged-finalization controller, for example as a scenario
    test built from the DB copy.
  - Nit-only remediation limits should not stop finalization. Defer nits to a follow-up list
    automatically.
- Effort: M
- Related: HIST-03, HIST-10
- Plan/roadmap format impact: none

### HIST-17: Notification delivery volume floods the workspace event stream
- Severity: medium
- Category: performance
- Status: CONFIRMED
- Evidence:
  - 139 notification records produced 494 deliveries (attention records delivered up to 10
    times; 30-min reminders).
  - 792 `notifications.updated` audit rows (494 delivery, 296 attention) and 792
    `notifications-changed` workspace events. That is 24% of all workspace events, the second
    largest kind after `agent-run-status-changed` (1,017).
  - architecture.md: "Notification delivery wakes browser streams without waking workflow
    workers."
- Impact: each reminder causes browser invalidation and refetch. HYPOTHESIS: this contributes to
  UI slowness. There is also audit noise, since delivery bookkeeping is audited as if it were a
  workflow change.
- Recommendation: do not emit workspace events or audit rows for delivery attempts and
  reminders. Only emit them for attention set/clear. Keep delivery attempts in the outbox row.
- Effort: S
- Related: HIST-05, HIST-12
- Plan/roadmap format impact: none

### HIST-18: Controller services grew append-only through feature-by-feature accretion
- Severity: high
- Category: architecture
- Status: CONFIRMED
- Evidence (`git log --numstat` per file):
  - `work-cycle-service.ts`: 525 (fcaa48d) → 1,336 (09-11) → 2,529 (09-15) → 3,252 (09-17) →
    4,029 lines (2000759). 34 commits touched it; deletions are ~9% of additions. It has ~45
    needs-attention call sites and ~258 hard-coded operator-facing sentences.
  - `roadmap-service.ts` 593 → 2,292 lines (16 commits; acf9aeb alone +425).
  - `runtime-evidence-service.ts` 853 → 2,632 lines between 09-16 and 09-22.
  - `agent-run-service.ts` 675 → 1,860 lines.
  - `apps/server/src/services/` has 87 files, 20+ of them `*-policy.ts` fragments added one
    per blockage (e.g. `scope-recovery-policy.ts`, `design-dependency-policy.ts`,
    `decision-preparation-policy.ts`, `checkpoint-candidate-policy.ts`,
    `technical-checkpoint-policy.ts`).
- Impact: this is pain point 3, "monolithic and sprawling". Each new stop path touches the cycle
  service, the roadmap service, the notification predicate and the UI in one commit (e.g.
  bfdd295 +3,097 lines, 2000759 +3,284 lines, 72 files).
- Recommendation: this belongs with the controller reviewer's target design. The historical data
  suggests the seams:
  - (a) a pure cycle step state machine (states × events → transitions + effects);
  - (b) an effects executor (Git/agent launches);
  - (c) a stop/decision service (HIST-01);
  - (d) the roadmap scheduler consuming only cycle outcomes.

  Measure success by deletion: the ~27 optional cycle fields and the notification predicate
  should disappear.
- Effort: L
- Related: HIST-01, HIST-05; controller reviewer
- Plan/roadmap format impact: none

### HIST-19: Real cross-project workload is ~10× the scale the UI's lists were designed for; progress and dependencies are hard to see
- Severity: high
- Category: ux
- Status: CONFIRMED (scale and progress); the UI-impact claim relies on the operator's stated
  pain point
- Evidence:
  - Map: 335 graph nodes, 1,221 edges, 95 checkpoints, 18 decisions.
  - Roadmap: 171 entries (69 slices + 69 verifications + 33 parent acceptances). After 6 days:
    18 entries completed, 4 active, the rest pending; roadmap paused.
  - Parent completion so far: WI-01, WI-02, EXO-01, EXO-02 (4 of 33 work items). WI-FABRIC-2 is
    2/14 complete and EXO-V3 is 2/19.
  - Evidence-needed notifications list 10+ checkpoint IDs at a time (e.g. "AQ-BASELINE-ACCEPTED,
    EXO-ADR-004 … EX…").
- Impact: with 1,221 edges, the operator cannot reason about "what is blocked on what" from
  lists (pain point 2). A single stuck parent (EXO-01, HIST-04) also blocked every EXO slice
  depending on it, which explains the low parallelism in HIST-02.
- Recommendation:
  - Build the progress view as a dependency graph projection over roadmap entries, collapsed
    to work-item level by default. Color it by status and stop owner, and draw the
    critical-path/blocked-by chain for the selected item. The data is already in the map
    (graph nodes/edges) and roadmap attempts.
  - Pair it with HIST-12's compact projection so it stays fast.
- Effort: L
- Related: HIST-02, HIST-04, HIST-12; UI reviewer
- Plan/roadmap format impact: none (read-only projection of existing format)

### HIST-20: The first automated real use (AQ) went smoothly; complexity arrived with slices/verification/evidence layers
- Severity: medium
- Category: simplification
- Status: CONFIRMED (data); interpretation is a HYPOTHESIS
- Evidence:
  - AQ item cycles (whole-item scope, 09-10→09-13): 3–7 runs, 1.2–4.0 h, 0–2 attention stops
    each, 11 items. The 3 small roadmaps completed in 5.5–13 h.
  - Cross-project slices (09-17→09-22): 10/11 slices had design stops. Slice verification and
    parent acceptance add 2 more review cycles per slice/parent. The EXO-01 parent needed 89
    runs.
  - Of the 171 roadmap entries, 102 (60%) are review-only verification/acceptance entries.
- Impact: the verification layering (slice → slice-verification → parent-acceptance, each an
  independent review with its own stop semantics) roughly triples review cycles and multiplies
  stop opportunities.
- Recommendation:
  - Evaluate whether slice-verification can be folded into the slice's own final review when the
    reviewer profile already satisfies the independent-reviewer role. The map's reviewer roles
    decide this, and ADR-048 reviewer assignments already exist.
  - Run parent acceptance once per parent, with cumulative finding tracking (HIST-04).
- Effort: M
- Related: HIST-04, HIST-19
- Plan/roadmap format impact: possibly. If the map requires distinct slice-verification
  entries, folding them changes how the map is executed but not its format. Must keep the
  map's acceptance-coverage semantics intact.

## Remediation direction

1. **Instrument first (S).** Persist per-stop `openedAt`/`resolvedAt`/`owner`/`kind`, then put
   "operator-wait hours" and "stops by kind" on the dashboard. This turns HIST-02/03 into a
   live metric, so every later change is judged by hours saved rather than panels added.
2. **Remove stops that are not decisions (M, highest leverage).**
   - Auto re-prompt on format/validation failures (HIST-10).
   - Auto-continue "investigation finished" when answers are complete, and auto-refresh on
     upstream integration changes (HIST-03 #5–7).
   - Controller-recorded acceptance for controller-verifiable checkpoints (HIST-07).
   - Graceful drain and auto-resume on clean restarts (HIST-06).

   On historical data this targets ~100+ cycle-hours and ~150 operator commands.
3. **Separate controller-owned from operator-owned states (M).** Add a distinct automated
   "verifying/integrating/recording" state. Notify only on operator-owned stops, add a settle
   window, and key notifications by stop ID. Drop audit/workspace events for delivery attempts.
   This fixes pain point 3's notification symptoms directly (HIST-05, HIST-17).
4. **Converge the repair loop (M).** Track findings across parent/slice rounds, escalate once
   with progress, propose splitting oversized findings via map amendments, and keep all repairs
   under roadmap policy (HIST-04, HIST-08).
5. **Batch real decisions ahead of time (M).** Build one per-roadmap decision queue (shared ADRs,
   human-required checkpoints) that is prepared before dependent slices start, extending
   bf08c0b's decision preparation. That is the single operator inbox from HIST-01 and pain
   point 1.
6. **Structural consolidation (L).** Once the stop classes are reduced, collapse the ~27 optional
   cycle fields into a stop record plus a step history, and split `work-cycle-service` into a
   pure state machine, an effects executor and a stop service (HIST-01, HIST-18). Store the
   roadmap definition by reference (HIST-12), and move raw vendor JSON and large tool results
   out of SQLite (HIST-11).
7. **Progress view (L).** Build a dependency-graph projection of the roadmap with blocked-by
   chains and stop owners (HIST-19). This is feasible cheaply once HIST-12's compact projection
   exists.
8. **Hygiene (S).** Walkthrough captures out of history, commit bodies, ADR consolidation and
   naming, automated pre-migration snapshots (HIST-13/14/15).

Target design, as the history suggests: a cycle is a small state machine whose only
operator-facing exit is a typed Stop with a closed action set. The roadmap scheduler consumes
cycle outcomes and never re-derives cycle policy. Notifications and the UI read only Stops.
Success is measured by fewer stop kinds, fewer optional fields, and fewer operator-wait hours,
not by new recovery panels.
