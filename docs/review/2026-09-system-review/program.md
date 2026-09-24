# Remediation program

How to sequence the [register](register.md). Phases are ordered by risk and leverage. Items
within a phase are independent unless noted, so they can run in parallel worktrees, and many
are suitable for delegation to CraftingTable itself.

## Rules for every remediation change

1. **Measure success by deletion and by operator-wait hours, not by new surfaces.** Do not
   add a recovery panel, a stop-specific cycle field or a notification suppression clause to
   fix a blockage. Instead, classify the stop (controller-owned or operator-owned), give it a
   typed code, and either automate it or route it to the single inbox. If a change needs a new
   operator surface, it belongs to R-A5/R-A6.
2. **Plans and roadmaps stay viable.**
   - Every existing plan bundle, v0.3 concurrency map, saved roadmap definition and persisted
     cycle, roadmap and finalization record must keep importing, reading and executing.
   - New persisted fields are optional and derived when absent.
   - Migrations only move forward.
   - The format specification (FMT report, "Format specification") is the invariant.
   - Golden conformance tests (R-F4) guard it: land them first.
3. **Characterize before refactoring the controller.** R-B2's replay harness must exist
   before R-B4, R-B5 or R-B7 changes behaviour-bearing code.
4. **Branch on codes, never on prose.** No new `startsWith`, regex or string comparison on a
   human-readable reason or message.
5. **UI structure changes take walkthrough captures before and after**, as AGENTS.md
   requires. Once R-I1 lands, captures live outside the repository.
6. **Commit messages say which stop or finding motivated the change** and which register
   item they advance. Update the register status in the same commit.

## Phases

### P0: Safeguard and stop the bleeding (days; no schema or IA redesign)

| Item | Why now |
|---|---|
| R-I1 | 42 commits exist only on one disk; the PNG captures grow the repository by about 155 MiB/day. **Operator action required** for push/backup and any history rewrite. |
| R-G1 | Paths that lose or corrupt work: orphaned agent after consumer failure, force-delete on Remove, un-aborted merge timeout, ct-check tree kill, two live agents in one worktree. |
| R-H1 | Live 500 on the first run's event page. |
| R-A1, R-A2 | Removes the confirmed false alarms, the re-pages and a quarter of all workspace events, without waiting for the attention model. |
| R-B1 | Delegation-grant bug (latent), idle CPU, swallowed errors, duplicate events. |
| R-D1, R-D2, R-D3 | Most of the measured read cost and refetch churn; adds the instrumentation that later phases are judged by. |
| R-G2, R-G3 | Automatic provider retry that never fires; guidance that contaminates later steps. |
| R-F3 (FMT-03 part of R-F1), R-F4 | Stop maps that import and then crash the supervisor; pin the format ground truth with golden tests before any refactor touches it. |

**Progress (2026-09-22, branch `review/2026-09-system-review`).** Landed: R-A1, R-A2, R-B1,
R-D1, R-G1, R-G2, R-G3 and R-H1. R-D2 landed, but its "done when" is only partly met. Partly
done: R-D3, R-F1 (FMT-03 only), R-F3 and R-F4.

`pnpm check` passes on the integrated branch:
- 149 test files and 1,360 unit tests;
- 22 e2e tests;
- the scope check.

**Deployment (2026-09-23).** The walkthrough images are out of history and live in an
external store (R-I1). The reviewed work was fast-forwarded into `main` and deployed with
`pnpm deploy:daemon` from a release checkout, with the single-instance lock in place (R-I8,
from phase 1). The daemon no longer runs from the development checkout.

Still open in P0:
- **R-D3:** read-budget tests.
- **R-F3:** FMT-11, FMT-15 and FMT-16.
- **R-F4:** promote the format specification to `docs/formats.md` after operator review.
- **Re-measurement:** re-measure the P0 metrics below against the deployed daemon after a
  few days of real use.

Exit criteria:
- No confirmed false-alarm sequence from the HIST and NOTIF reports reproduces in tests.
- Idle daemon CPU is measurably lower.
- A work-item page's refresh round costs under 150 ms of server time.
- Golden format tests are green.

### P1: Foundations (1–2 weeks)

| Item | Notes |
|---|---|
| R-B2 | Characterization harness and a deterministic stepping seam. Prerequisite for R-B4/R-B5/R-B7 and for R-I2. |
| R-A3 | Typed attention and blocker codes, owner, and `awaiting-merge` gate subtypes. The keystone for WS-A, WS-C and WS-E. |
| R-A7 | Action gating and one transition gate. Builds on R-A3's codes. |
| R-B3 | Cycle owner field; roadmap state references its definition by revision. |
| R-B8 | Remove the dead CT-04A1 inspector and legacy finalization for new starts. |
| R-B9, R-I8 | Bounded drain plus automatic vendor-session resume of interrupted steps (or `--when-idle` deploys); `pnpm deploy:daemon <ref>` into a separate deploy checkout, and a data-directory lock so only one daemon can ever use the live database. Together they end "every commit stops the roadmap". |
| R-C1, R-C2, R-C8 | Measure operator wait; automatic re-prompt on output-format failures; scheduled retry for known quota resets. |
| R-G7 | Stop cold Rust builds on every step. |
| R-H2, R-H3 | Stop storing raw vendor lines; add upcasters, write validation and `db:verify`. |
| R-I2, R-I3, R-I5, R-I6 | Fast, deterministic tests, an auth sweep, reliable e2e, and a lint gate. These make the later phases safe to execute quickly. |
| R-E6, R-I7 (start) | Glossary and vocabulary; README and architecture reset. Doing the docs early stops agents from following the accreted rules. |

**Progress (2026-09-23, branch `remediation/p1-foundations`).** Landed: R-B9 (drained restarts
and automatic session resume, ADR-066), R-B2 (step classification extracted and characterized,
golden replay, stepping seam), R-A3 (typed attention on every stop, ADR-067), R-C2 (automatic
output-format repair through the same agent session), R-C8 (quota waits until a reported reset). Partial: R-B8 (inspector and registry
code removed, about 12k lines; legacy finalization remains), R-A7 (refuses resumes that
cannot make progress; the other panels and one shared transition gate remain). `pnpm check`
passes on the branch: 146 test files and 1,324 unit tests (after R-B8 removed the inspector suites), 22 e2e tests, the scope check. Not yet deployed.

Exit criteria:
- Every stop has a code and owner.
- Operator-wait hours are visible on the dashboard.
- `pnpm test` runs in under about 90 s.
- A clean restart does not stop the roadmap.

### P2: One attention model, one inbox, one read model (2–3 weeks)

| Item | Notes |
|---|---|
| R-A4 | Attention items, delivery log, quiescence gate, presence, digests. |
| R-A5 | The "Needs you" inbox. At first it hosts the **existing** forms, unchanged. |
| R-E1, R-E2 | Real routes and a `Link` component; split the Roadmaps page into list, board, setup and history. |
| R-D4, R-D5 | Query store, App.tsx split, server view models, compression and git-fact cache. |
| R-C3, R-C4, R-C5 | Remove the top operator-stop causes: the design stage, integration-advanced refreshes, and the repair loop. |
| R-G4, R-G5, R-G6, R-G9 | Daemon-owned receipts, agent environment isolation, brief redesign, auth hardening. |
| R-H4, R-I4 | Lighter evidence storage; structural test and process boundaries. |

Exit criteria:
- The push log, rail count, inbox and roadmap page always agree.
- No in-app navigation reloads the document.
- An idle tab makes no requests.
- The design-stage stop rate is well below the 10-of-11 baseline.

### P3: Progress view and consolidation (2–3 weeks)

| Item | Notes |
|---|---|
| R-E3 | The roadmap board and graph: the answer to pain point 2. It can start once R-E2 and R-D5 exist. |
| R-A6 | Consolidate decision components and delete the per-page recovery panels. |
| R-E4, R-E5 | Work-item page as drill-down; consolidated settings. |
| R-C6, R-C7 | Evidence ceremony; verification layering and finalization stops. |
| R-F2 | Typed feature recognition instead of prose and magic identifiers. |
| R-G10, R-G11, R-H5 | Git adapter robustness, supervisor loose ends, route rationalization. |

Exit criteria:
- From the board, the operator can answer "what is this waiting on, and what does this decision
  unblock" without leaving the page.
- Each decision command is posted from exactly one component.

### P4: Controller kernel and decomposition (3+ weeks, behind the harness)

R-B4 (pure decision core, stop record and step history), R-B5 (event-driven kernel), R-B6
(scoped consistency instead of whole-roadmap pause), R-B7 (service decomposition), R-F1 full
(compiled map model and one evaluator), R-F5 (backward-compatible format additions: explicit
operator decision points, typed capabilities, relaxed cardinalities; format ADR, v0.3 keeps
working), R-D6 (only if measurements still call for it).

Exit criteria:
- `reconcile` is a thin shell.
- Idle CPU is near zero.
- No service file is over about 1,200 lines.
- `WorkCycle` optional-field count has fallen.
- The golden replay and format tests are unchanged.

### P5: The Development Studio's foundations

R-F6 (the Studio format family: plan v2 and stack documents, planning feedback as amendment
patches, generic upstream model, scheduling hints, canonicalization v2) is the Studio's opening
design step, recorded as an operator-approved format ADR before Studio UI work begins. R-G8
(backend capability model and persistent-agent seam) and R-G12 (agent runs that outlive the
daemon, designed together with persistent agents) follow where the Studio's first real
plans show the need. The operator decided on 2026-09-23 that the Appendix A format improvements
are scheduled work, split between R-F5 (P4) and R-F6 (P5), not last-resort items.

## Dependencies worth knowing

```text
R-F4 golden format tests ─► every item that touches map/plan interpretation (R-F1, R-F2, R-C6, R-C7)
R-F1 compiled map model ─► R-F5 format additions ─► R-F6 Studio format family
R-B2 harness ───────────► R-B4, R-B5, R-B7, R-I2
R-A3 typed attention ───► R-A4 ─► R-A5 ─► R-A6
                     ├──► R-A7, R-C1, R-E6 labels, R-E3 attention overlay
                     └──► R-C2..C5 (stops become codes before they are automated)
R-E1 routes ────────────► R-A5 deep links, R-E2, R-E3
R-D1/R-D2 ──────────────► R-D4 ─► R-D5 ─► R-E3 board read model
R-B3 ownership ─────────► R-B5, R-B6, R-B7
R-G4 daemon receipts ───► R-C6 automatic acceptance of controller-verifiable checkpoints
R-B9 drain + R-I8 deploy ► makes self-hosted remediation (CraftingTable working on itself) practical
```

## Baseline metrics (live data, 2026-09-10 → 2026-09-23)

Re-measure after each phase against a fresh read-only snapshot. The HIST and NOTIF reports
describe how each number was derived.

| Metric | Baseline | Source |
|---|---|---|
| Wall hours with no agent running while work waited on the operator (09-17 → 09-23) | ~112 h (vs ~30 h agent work) | HIST-02 |
| Operator-mediated run hand-offs: median / total | 3.3 h / 524 h over 71 | HIST-02 |
| Automated run hand-off, median | 3.2 s | HIST-02 |
| Cross-project slices with a design-stage stop | 10 of 11 | HIST-03 |
| Pushes sent within 2 s of record creation | 127 of 134 | NOTIF-01 |
| First pushes within 120 s of an operator action | 53 of 134 (40%) | NOTIF-04 |
| `notifications-changed` share of workspace events | 24% (792 / 3,289) | NOTIF-10 |
| Refresh rounds per run hand-off (median / p90) | 4 / 10 | PERF-02 |
| `execution-scopes` server time | ~405 ms | PERF-04 |
| Idle Roadmaps tab | ~15 MB/min, ~7.7% of daemon CPU | PERF-06 |
| Idle daemon CPU (no live runs, roadmap paused) | 15–20% of one core | CTRL-08 |
| `reconcile` length / cycle optional fields | 656 lines / 41 | CTRL-01, HIST-01 |
| DB size / share that is raw vendor JSON | 542 MB / ~50% | DATA-01 |
| Rust build cache written and deleted | 768 GB in 10 days | AGT-05 |
| `pnpm test` wall time | 5 min 46 s | QA-01 |
| Repository size / walkthrough share | 1.5 GB working tree, 1.1 GB `.git` / 99% | REPO-01 |
| Commits not on `origin` | 42 | REPO-02 |
