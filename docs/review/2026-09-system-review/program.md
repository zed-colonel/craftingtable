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
| R-B8 | Remove the dead CT-04A1 inspector and legacy finalization for new starts. (Split on 2026-09-24: the inspector part is done; legacy finalization moved to R-B10, and the registry tables to R-H6.) |
| R-B10 | Retire legacy finalization for new starts: move its tests to staged finalizations first, then change the start form (walkthrough captures). Split from R-B8. |
| R-B9, R-I8 | Bounded drain plus automatic vendor-session resume of interrupted steps (or `--when-idle` deploys); `pnpm deploy:daemon <ref>` into a separate deploy checkout, and a data-directory lock so only one daemon can ever use the live database. Together they end "every commit stops the roadmap". |
| R-C1, R-C2, R-C8 | Measure operator wait; automatic re-prompt on output-format failures; scheduled retry for known quota resets. |
| R-G7 | Stop cold Rust builds on every step. |
| R-H2, R-H3 | Stop storing raw vendor lines; add upcasters, write validation and `db:verify`. |
| R-I2, R-I3, R-I5, R-I6 | Fast, deterministic tests, an auth sweep, reliable e2e, and a lint gate. These make the later phases safe to execute quickly. |
| R-E6, R-I7 (start) | Glossary and vocabulary; README and architecture reset. Doing the docs early stops agents from following the accreted rules. |

**Progress (2026-09-23, branch `remediation/p1-foundations`).** Landed: R-B9 (drained restarts
and automatic session resume, ADR-066), R-B2 (step classification extracted and characterized,
golden replay, stepping seam), R-A3 (typed attention on every stop, ADR-067), R-C2 (automatic
output-format repair through the same agent session), R-C8 (quota waits until a reported reset), R-C1 (operator wait on the dashboard;
reproduces the HIST-02 baseline). Partial: R-B8 (inspector and registry
code removed, about 12k lines; legacy finalization remains), R-A7 (refuses resumes that
cannot make progress; the other panels and one shared transition gate remain). `pnpm check`
passes on the branch: 149 test files and 1,329 unit tests (after R-B8 removed the inspector suites), 22 e2e tests, the scope check. Not yet deployed.

**Phase 1 review (2026-09-24, same branch).** Each landed item was checked against its "done
when", with a replay on a copy of the 2026-09-23 snapshot. Fixes, each with a dated
amendment on its item:
- **R-B9:** a drained daemon that is never restarted now restarts itself; crashes during a deploy
  drain stay failures.
- **R-A7:** Pause then Resume no longer reproduces a stop; integration resolution is gated; guidance
  is offered where Resume redirects.
- **R-A3:** the prose-branching check is wider, and one prefix match is removed.
- **R-C2:** spent repairs no longer carry over; the prompt forbids invented evidence; the done-when is
  restated to `controller:replay --every-run`.
- **R-C8:** billing failures stay with the operator; the backoff floor applies.
- **R-C1:** stop kinds and owner changes are attributed correctly; the read is windowed.
- **R-B8:** removed settings are named at startup.
- **Gate:** `pnpm test:e2e` now rehearses the UI walkthrough.

R-B8 is closed on its inspector part. Legacy finalization moved to R-B10, and the registry
tables to R-H6 (they need a journal rebuild). R-C9 is added for the quota incident R-C8 does not
cover. R-C1 is recorded as done (7689200).

Status at the head of the branch:
- **Done:** R-B9, R-B2, R-A3, R-C2, R-C8, R-C1, R-B8.
- **Partial:** R-A7.
- **Open:** R-B10.
- `pnpm check` passes: 149 test files and 1,341 unit tests, 22 e2e tests, the walkthrough
  rehearsal, and the scope check. `pnpm test` took about 420 s under load. That count includes
  the operator-decision follow-ups: R-C2 repairs only format faults, and the unit's stop
  settings are checked.
- Not yet deployed.

Exit criteria:
- Every stop has a code and owner.
- Operator-wait hours are visible on the dashboard.
- `pnpm test` runs in under about 90 s.
- A clean restart does not stop the roadmap.

**Exit-criteria status (2026-09-24).** P1 is not ready to exit.
- **Every stop has a code and owner: partly met.**
  - Met for cycles, roadmaps, entry holds and phase blockers.
  - The stops still without codes are listed in R-A3's amendment: operator-held roadmap pauses,
    merge operations, baseline preparation, cleanup, finalization removals and manual runs. They
    move to R-A4, so for P1 this criterion is restated as "every cycle, roadmap, hold and phase
    blocker stop".
- **Operator-wait hours on the dashboard: met on the branch.** They are visible once deployed.
- **`pnpm test` under about 90 s: not met.** It took 428 s with the live daemon loading the machine,
  against a 346 s baseline. This waits on R-I2.
- **A clean restart does not stop the roadmap: met in tests, not yet live.** It needs:
  - a deploy of this branch (the first deploy cannot drain, because the running daemon predates
    R-B9);
  - for restarts outside `pnpm deploy:daemon`, the unit change in R-B9's amendment.
- **Operator decisions (2026-09-24):**
  - R-C8's deadline extension stays.
  - R-C2 repairs only format faults.
  - R-C9 is P2 and R-H6 is P3.
  - R-A7's done-when is restated to the server half plus the cycle panel, and the rest moved to R-A6.
  - Deployment waits until P1 lands.
- **Items still open in P1:** R-B3, R-B10, R-G7, R-H2, R-H3, R-I2, R-I3, R-I5, R-I6, R-E6, R-I7,
  and R-A7's remainder.

**Test and safety-net batch (2026-09-24, same branch).**
- **R-I2: done.**
  - The execution test file is split by aggregate into 18 files.
  - Its daemons are stepped through the R-B2 seam instead of running free loops.
  - `pnpm test` fell from 426 s to 71–76 s over six readings, with the machine loaded (load average
    6–20). 1,341 tests pass before and after.
  - The exit criterion "`pnpm test` under about 90 s" is met.
- **R-I3: done.**
  - Every API route declares its access, and the daemon will not start with an undeclared one.
  - One guard applies the declared checks before input validation.
  - A sweep requests all 123 routes as an anonymous caller, a cross-origin caller, a non-member and
    each role.
  - No unprotected route was found. 57 mutations answered outsiders with a validation error before
    refusing them; the guard now refuses them first.
- **R-I6: done.**
  - 671 Biome warnings are down to 0. `noNonNullAssertion` (646 of them) is turned off with its reason
    in `biome.jsonc`. The other 25 had mechanical, reviewed fixes.
  - `pnpm lint` now fails on any warning.
- **R-I5: done.**
  - **Screenshots.** Unasserted e2e screenshots are removed, or replaced by visibility checks.
  - **Helpers.** Sign-in and `git()` are shared from `e2e/support.ts`.
  - **Scope evidence.** It is written from the fixture maps, and a focused test checks the resolver
    agrees with it.
  - **Host tools.** Git and Cargo are resolved as the daemon resolves them, and the Cargo tests skip
    without Rust. The Git fixtures live in the temp directory; a committed leaked fixture is
    removed.
  - **Result.** Ten consecutive e2e runs pass, and the unit tests pass on a simulated host without
    Cargo.
  - **Two UI races fixed.** The repetition found two races where a panel reload overwrote the
    operator's newer state: runtime-evidence Inspect, and amendment proposals. Both have regression
    tests.
- **Still open in P1 after this batch:** R-B3, R-B10, R-G7, R-H2, R-H3, R-E6, R-I7, and R-A7's
  remainder.
- **Operator decisions on the batch (2026-09-24):**
  - **Route guard: kept.** R-G9 records that its guard and sweep are done. It also takes on
    deleting the per-handler auth calls, which no item held.
  - **Production non-null assertions:** they move to R-B7. Its rewrite replaces the 198 production
    sites with a named invariant helper and re-enables the lint rule for production files.
  - **The 51 Cargo-dependent tests stay** while the live roadmaps use Cargo pinning. R-F6 moves them
    into the Cargo adapter's own suite once pinning is pluggable; R-G4 does the same for
    verification.
  - **QA-05's per-spec workspaces go ahead as R-I9 (P2).**

**Data and controller batch (2026-09-24, same branch).** Working through R-H3, R-H2, R-B3 and R-G7, then
R-A7's remainder.
- **R-H3: done.** Upcasters at the read boundary, contract-guarded writes, domain/contract equivalence,
  `pnpm db:verify` and rebuild preservation tests. On a copy of the 2026-09-23 snapshot it passes: 54,152 records,
  three upcasts, one invalid record found and fixed with an upcaster (a run summary bounded in characters). Every
  test daemon verifies its database at cleanup. `pnpm test`: 1,359 tests in 76 s, load average about 4.
- **R-H2: partial, pending live measurement.** New runs keep raw vendor lines only for events the adapter could
  not normalize, and move tool-result bodies over 4 KiB into gzipped per-run files, keeping a preview and a
  digest. The bodies expire with the run's scratch. `craftingtable db compact-journal` is audited, dry-run by
  default, and needs the daemon stopped. It applies the same rules to stored runs (ADR-068).
  - **Copy of the 2026-09-23 snapshot:** journal bytes per ended run fell 82% (median 1.3 MB to 0.2 MB), and the
    file fell from 547 MB to 137 MB.
  - **Checks:** db:verify and both replays unchanged.
  - **Operator action:** compact the live journal after deploy (`docs/operations.md`).
- **R-B3: done.** Cycles record their owning attempt, and one memoized `cycleOwnership` replaces the attempt
  scans. Roadmap control rows store only `definitionRevision`; definitions come from a per-database immutable
  cache. Migration 0029 backfills both and keeps the work-item admission guard working.
  - **Snapshot copy:** both replays report 0 changed, db:verify passes, and the largest control row fell from
    257 KB to 27 KB.
- **R-G7: partial, pending live measurement.** Each worktree's runs share one Cargo target directory, created
  by Cargo on first build. It is removed, audited, once the worktree is merged or removed (ADR-039 amended).
  - **Audit baseline:** 825 GB removed across 101 caches in 25 worktrees over ten days.
  - **Projection:** at most 219 GB, about 3.8×. An order of magnitude needs a per-repository cache, which is an
    operator decision.
- **R-A7: partial.** The whole-item predecessor rule is one function shared by commands, the launch and the
  roadmap scheduler. Replays report 0 changed. Two remaining differences would change which stop the operator
  sees: scheduler-side Git ancestry, and item-status checks. They are recorded for R-B4.
- **Defect found along the way:** panels keyed repeated server warnings by their text (duplicate React keys in
  the e2e log). Fixed with a focused test (485969b).
- **Gate at the end of the batch:** `pnpm check` passes: 174 test files and 1,379 unit tests, 22 e2e tests, the
  walkthrough rehearsal, and the scope check. `pnpm test` took 76–84 s at load averages of 1–9.
- **New operator actions** (all on the live data, none run here):
  - **Deploy.** Deploying the branch applies migrations 0027–0030 on start. 0029 aborts on a roadmap whose embedded
    definition differs from its stored revision; the 2026-09-23 data has none.
  - **Verify first.** Run `pnpm db:verify` on a fresh backup before deploying.
  - **Compact.** After deploy, compact the journal with the daemon stopped (`docs/operations.md`, "Checking and
    compacting the database"). Then re-measure database growth per run (R-H2) and cache-removal volume (R-G7).
- **Decisions for the operator (batch of 2026-09-24):**
  1. **R-G7 target.** A cache per worktree projects a 3.8× cut in removal volume, not the 10× in the done-when.
     - Option (a): accept the per-worktree cache and restate the done-when to the measured figure after deploy.
     - Option (b): add a per-repository cache. It serializes parallel worktrees on Cargo's lock, and it never
       frees disk unless a size bound is added.
  2. **R-A7 remainder.** Mark R-A7 done and move to R-B4 the two gate differences that change which stop the
     operator sees: scheduler-side Git ancestry, and item-status alignment.
  3. **R-H2 retention settings.**
     - Tool-result previews are 4 KiB.
     - Full bodies expire with the run's scratch retention (30 days after the work merges).
     - Raw lines on failure notices are kept indefinitely.
     - Confirm these, or set a different window.
  4. **Contract guard on writes fails closed.** A record that breaks its contract now fails the write, as a 500 on
     a command or an error in a controller pass, instead of reaching the browser. The live data conforms, but a
     latent writer bug would now surface as a failed action. The alternative is to log and allow for one release.
  5. **FMT-15 (R-F3) fixtures.** The scope fixtures store v0.3 sources the importer would reject, so test-cleanup
     verification skips the format check. Rebuilding those fixtures through the importer makes it strict.
- **Still open in P1 after this batch:**
  - R-B10;
  - R-E6 and R-I7;
  - R-A7's remainder, unless moved to R-B4;
  - the post-deploy measurements for R-H2 and R-G7.

**Review of the test, safety-net, data and controller batches (2026-09-24, same branch).** Each
landed commit since the first P1 review was checked against its item's "done when". R-B3 and
R-A7 had no defects. Fixes, each with a dated amendment on its item:
- **R-G7 (d800ae6).** The shared Cargo target was missing from the sandbox's writable
  directories, so every Codex Cargo build would have failed.
- **R-H2 (56e536f).**
  - The compaction dry run migrated the database. It now refuses pending migrations.
  - Bodies that compaction writes into runs already past retention would have expired on the
    next maintenance tick. They now wait out scratch's quiet period.
  - Body files are read without following links, from regular files only, with a size bound.
- **R-H3 (3e5561c).**
  - Upcasters could hide a writer defect from the read-back guard; read-backs now refuse any
    upcast.
  - Work-item status writes are now guarded.
  - A refused audit record no longer stays committed.
- **R-I3 (d0fa07b).** The guard ran after body parsing, so outsiders sending malformed JSON got
  a 500. It now runs before parsing.
- **UI (4220722).** 22 more server message lists are deduped, finishing 485969b.
- **R-I8 (6729d6e).** The CT-01..03 process directories are archived. Deleting the merged CT-era
  branches is left to the operator.
- **Found and left as they are:**
  - The runtime-evidence setup panel keeps its draft's concurrency tokens when a reload lands,
    so a save after a binding change is refused as stale. That failure is loud and correct.
  - The amendment panel may show readiness that is up to 15 s stale after a command.
  - The roadmap definition cache has no size bound.
  - The sweep's admitted-caller check accepts 400 and 404, so it cannot prove a declaration
    is as tight as its service. That matters once R-G9 removes the per-handler checks, and
    R-G9 should tighten the sweep then.
- **Gate after the fixes:** `pnpm check` passes: 175 test files and 1,386 unit tests, 22 e2e tests,
  the walkthrough rehearsal, and the scope check. Not yet deployed.
- **Decisions for the operator (updated):** the five above. Decision 3 has a consequence the
  batch did not state. Compacting the live journal keeps full tool output for historical runs
  for 30 days after compaction. After that those runs keep only 4 KiB previews, where the
  journal kept full output forever. The alternative is to exempt bodies written by compaction
  from expiry, at about 54 MB on disk. A sixth: delete the seven merged CT-era branches
  (R-I8), locally and on `origin`.
- **Operator decisions (2026-09-24), each recorded on its item:**
  1. **R-G7:** keep one cache per worktree. The done-when is restated: re-measure removal volume
     after deploy against the 825 GB baseline and record the cut.
  2. **R-A7: done.** Scheduler-side Git ancestry and item-status alignment move to R-B4.
  3. **R-H2 retention confirmed:**
     - 4 KiB previews;
     - bodies expire with scratch retention (30 days after merge, and 30 quiet days);
     - raw lines on failure notices are kept indefinitely;
     - compacted history keeps full output for 30 days after compaction.
  4. **R-H3:** the write guard stays fail-closed.
  5. **R-F3 (FMT-15):** rebuild the scope fixtures through the importer. Scheduled, not yet done. **Done 2026-09-25.** The fixture maps pass the importer, and the stored maps are schema-valid without the scaffolding repositories (the operator chose "schema-valid fixtures"). See R-F3's amendment.
  6. **R-I8: done.** The seven CT-era branches are deleted locally. `origin/ct-04a-git-foundation`
     is left for the operator to delete, since the agent cannot push.
- **Still open in P1:**
  - R-B10;
  - R-E6 and R-I7;
  - the post-deploy measurements for R-H2 and R-G7.

**Deployed 2026-09-25 (0190845, release `20260925T021344Z-0190845cd490`),** ahead of the rest of
P1, so a staged finalization can run live before R-B10 deletes the legacy branches.
- **Checked before deploy.** `pnpm db:verify` on a fresh backup of the live database
  (`pre-p1-deploy-2026-09-24.sqlite`) migrated the copy from schema 26 to 30 and passed.
  56,303 records, 0 invalid, 3 upcasts, integrity ok.
- **Unit.** The R-B9 drop-in (`drain.conf`: node on dist, `KillMode=mixed`, `TimeoutStopSec=300`)
  was installed before the deploy. The daemon now runs `node apps/server/dist/index.js`, so a
  plain `systemctl` stop or restart drains too.
- **Restart.** As expected, the old daemon predated drain support and was restarted without
  draining. No agent run was live, so nothing was interrupted.
  - The paused roadmap and the four waiting cycles all date from before the deploy.
  - Schema 30 is live, and the pre-migration copy is in `state/pre-migration/`.
- **Still to do on live data:**
  - compact the journal (`docs/operations.md`);
  - after a few days, measure R-H2's growth per run and R-G7's cache-removal volume;
  - confirm on the next deploy that a live turn drains and resumes (R-B9's exit criterion).

### P2: One attention model, one inbox, one read model (2–3 weeks)

| Item | Notes |
|---|---|
| R-A4 | Attention items, delivery log, quiescence gate, presence, digests. |
| R-A5 | The "Needs you" inbox. At first it hosts the **existing** forms, unchanged. |
| R-E1, R-E2 | Real routes and a `Link` component; split the Roadmaps page into list, board, setup and history. |
| R-D4, R-D5 | Query store, App.tsx split, server view models, compression and git-fact cache. |
| R-C3, R-C4, R-C5 | Remove the top operator-stop causes: the design stage, integration-advanced refreshes, and the repair loop. |
| R-C9 (added 2026-09-24) | End the session on a terminal quota error, so R-C8's reset wait applies to incidents like the one that motivated it. |
| R-G4, R-G5, R-G6, R-G9 | Daemon-owned receipts, agent environment isolation, brief redesign, auth hardening. R-G9's route guard and sweep landed early with R-I3; it now also removes the per-handler auth calls (amended 2026-09-24). |
| R-H4, R-I4 | Lighter evidence storage; structural test and process boundaries. |
| R-I9 (added 2026-09-24) | One workspace per e2e spec, so the gate can run with more workers. The rest of QA-05 after R-I5. |

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
| R-H6 (added 2026-09-24) | Journal cleanup of the empty registry tables. It needs a `workspace_events` rebuild, so it waits for R-H3's preservation tests and should share a rebuild with any other journal change. |

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
R-H3 upcasters/db:verify ► R-H6 journal rebuild (added 2026-09-24)
R-C9 terminal quota ────► R-C8 covers the recorded incident (added 2026-09-24)
R-A6 one decision component per kind ► R-A7's "UI renders only returned actions" (2026-09-24)
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
