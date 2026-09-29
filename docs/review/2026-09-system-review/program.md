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
   - **First step of the next controller work (operator, 2026-09-25):** re-record the
     `controller:replay --every-run` baseline from the current head, on a copy of the snapshot.
     The saved baseline (`every-run-golden-5e0c638.json`) predates R-B10's deletion. It differs
     from today's controller by 109 explained decisions, which would hide real changes.
4. **Branch on codes, never on prose.** No new `startsWith`, regex or string comparison on a
   human-readable reason or message.
5. **UI structure changes take walkthrough captures before and after**, as AGENTS.md
   requires. Once R-I1 lands, captures live outside the repository.
6. **Commit messages say which stop or finding motivated the change** and which register
   item they advance. Update the register status in the same commit.
7. **Live plan data is test data (operator, 2026-09-27).** WI/EXO delivery is paused until P2
   is done.
   - A live stop becomes a [LIVE finding](findings/LIVE-live-run-2026-09-25.md) plus a
     replay case or a redacted fixture ([R-I10](register.md#r-i10)). It is not a patch.
   - A fix goes on `main` ahead of the P2 line only for data loss, a safety issue, or a stop
     with no working control. It is merged into the P2 line the same day, and gets an
     independent review like any P2 item.

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

**Rest of P1 (2026-09-25, same branch, after the deploy of 0190845).** R-F3's FMT-15, R-B10, R-E6 and
R-I7's P1 start. Every item has a dated amendment in the register. Each commit was reviewed against its
done-when by an independent agent, and the confirmed findings were fixed.
- **R-F3 (FMT-15): done.** 432bb00, 0ef20b1; review fixes 2f2e52a.
  - The scope fixture maps pass the real v0.3 importer, and test cleanup applies the map-format check.
  - Operator decision (2026-09-25, "schema-valid fixtures"): the stored maps drop the scaffolding
    repositories, because an implemented upstream would force every scope test onto the pinned
    Cargo build.
- **R-B10: done.** 0e4eb04, adeb4cf, 9b7316a, 6ea1fae; review fixes f32b407 and
  2bd6e40.
  - The start form offers only staged finalizations.
  - The legacy finalization tests run on stages, and legacy-only behaviour sits in one file that is
    deleted with the branches.
  - The completed 2026-09-13 record is a fixture that validates, renders and is served by
    `GET …/finalizations`.
  - The migration found and fixed one defect: a staged review without a structured report stopped
    instead of getting R-C2's format repair.
  - **The deletion gate (operator decision 2026-09-25).** No live plan was ready to finalize, so
    the operator chose a run on an isolated scratch daemon. A staged finalization completed all
    five stages with real Claude runs (Sonnet 5), including an automatic report repair and a batch
    selection, and ended in an approved promotion. The legacy controller was then deleted (6ea1fae).
    - A start must carry stages.
    - An open stage-less finalization can no longer run.
    - The completed 2026-09-13 record still reads, renders and is served.
  - **Replays on a copy of the 2026-09-23 snapshot.**
    - Before the deletion: 51 current-run and 278 every-run decisions, 0 changed.
    - After it: current-run 0 changed; every-run 109 changed, all explained. 81 only drop an empty
      `reviewChanges` field. 28 are the runs of the completed legacy cycle, which now classify as
      `legacy-finalization-retired`.
- **R-E6: done.** 4c77665; review fixes a7d1b19, 68c9bde.
  - A 17-term glossary; map and finalization "decisions" relabelled.
  - Rail and page titles aligned.
  - The recovery panels gated on codes.
  - `copy-rules.test.ts` enforces short headings and no long prose outside `About`, except paragraphs
    that report state.
  - Walkthroughs: `2026-09-25-finalization-staged-after` (before), `-vocabulary-copy-after`,
    `-vocabulary-copy-review-after`.
- **R-I7: P1 start done.** e317636; review fixes 61e41cb.
  - The README is a 150-line operator guide; the full old README is archived.
  - `docs/architecture.md` describes the current design.
  - 19 false or stale claims fixed.
  - What is left for P2–P3 is listed on the item.
- **Defect found along the way (61e41cb).** `admin reset-password` and `admin bootstrap` migrated
  the database without the single-daemon lock. From a checkout newer than the deployed release they
  would have changed the schema under the running daemon. They now take the lock whenever they would
  migrate.
- **Gate at 68c9bde:** `pnpm check` passes.
  - 181 test files and 1,413 unit tests; `pnpm test` took 90 s at load average about 3.
  - 20 e2e tests, the walkthrough rehearsal and the scope check.
  - One known flake: a transient `package-imports` e2e miss, which passed twice on rerun.
- **Final gate after the R-B10 deletion and its review fixes:** `pnpm check` passes. 180 test files and
  1,402 unit tests (`pnpm test` 89 s at load average about 3), 20 e2e tests, the walkthrough rehearsal
  and the scope check. Replay unchanged since the deletion: current-run 0 changed, and every-run the same 109
  explained changes.
- **P1 exit criteria (2026-09-25):**
  - **Every stop has a code and owner:** met as restated (every cycle, roadmap, hold and phase-blocker
    stop). The remainder is R-A4.
  - **Operator-wait hours on the dashboard:** met and deployed (0190845).
  - **`pnpm test` under about 90 s:** met (90 s at load 3).
  - **A clean restart does not stop the roadmap:** met in tests. The drop-in is live; the first
    drained restart is confirmed on the next deploy.
- **Left in P1 (all live-data work):**
  1. **Redeploy the final head.** It carries no migration. Run `pnpm db:verify` on a fresh backup
     first, as before, then confirm that a live turn drains and resumes (R-B9).
  2. **Compact the live journal** with the daemon stopped (`docs/operations.md`).
  3. **After a few days, measure** R-H2's journal growth per run and R-G7's cache-removal volume
     against the 825 GB baseline.
  4. **Recommended with the redeploy:** watch the first live staged finalization, since the gate
     run used a scratch daemon, not live data.

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
| R-C10 (added 2026-09-25; done) | Re-verify a roadmap item whose evidence went stale, without stopping the roadmap. It unblocks WI-02 now and every later decision-set or policy change. |
| R-C11 (added 2026-09-25) | Give a provider-side credential rejection (the 25 Sep Codex 401 outage) its own stop code and a bounded scheduled retry, instead of "backend failed" and agent questions about approval authentication. |
| R-I10, R-I11 (added 2026-09-27) | The live roadmap as the test corpus: a 2026-09-27 snapshot, scheduler-decision replay, and record-don't-patch. Independent review of the five live-run fixes made on `main`. |
| R-C12, R-C13 (added 2026-09-27) | The open live stops: automatic recovery that silently did not start (LIVE-06), and a checkpoint review that repeats a failed attestation on resume (LIVE-07). |
| R-E3a (split 2026-09-27) | A read-only roadmap status list: every entry's state, what it waits on and who acts next. It was pulled forward from P3 because the operator cannot run the roadmap without it (LIVE-08). R-E3b, the board and graph, stays in P3. |
| R-F7 (added 2026-09-25; code done 2026-09-25, 2713a6a..9c1904c; done 2026-09-29, the live wi→aq record and WI-02/domain's verification) | Map-declared upstream pin transitions for each consumer link. It blocks the live roadmap now (WI-02/domain cannot build on the migrated `wi-fabric-2` head), so it comes ahead of R-F5's wider format additions and adds only its own optional field. |

Exit criteria:
- The push log, rail count, inbox and roadmap page always agree.
- No in-app navigation reloads the document.
- An idle tab makes no requests.
- The design-stage stop rate is well below the 10-of-11 baseline.
- Loaded from the 2026-09-27 snapshot, the status list (R-E3a) states what each open entry is
  doing or waiting on, and who acts, with no database query (added 2026-09-27).
- No scheduler path leaves a stopped item without a recorded reason (R-C12).

**Progress, 2026-09-25/26 (branch `remediation/p2` from a4fabdf; not merged or deployed).** Each item had an
independent review; every finding is fixed or its disposition is recorded in register.md.
- **Done:**
  - R-A4: 16d94de, 40d3a9b (ADR-070, schema 32).
  - R-A5: a4635c7, 52ab71a, e271f8f.
  - R-C11: 8900aa0, 4a76d76.
  - R-C9: 1b34b0b, 1a505a3.
  - R-C4: 9c41c1a, e53ea8a.
  - R-C3a: bf329f6, 8f6d6f8. The operator approved splitting R-C3 on 2026-09-25.
  - R-C5 increment 1 of 5: e11940d plus its review fixes.
  - f4fb00a removes a diagnostic script committed by mistake.
- **Open:**
  - R-C3b: prepare shared ADR decisions per roadmap before slices start. It needs the operator's design for a standing preparation grant (ADR-065). It also carries the design-stop exit criterion: of the 15 live design stops, up to 11 would go, and R-C3a removes none on its own.
  - R-C5 increments 2 to 5: roadmap ownership of operator-delegated repairs, a progress classifier with the EXO-01 fixture, one typed escalation, and a split offer.
  - The other P2 items: R-E1, R-E2, R-D4, R-D5, R-G4 to R-G6, R-G9, R-H4, R-I4, R-I9.
- **Replays:** every controller change kept the 2026-09-23 replays at 278 and 51 decisions, 0 changed.
- **Live run and sync (2026-09-25 to 27).**
  - Five blocker fixes landed on `main` while the live roadmap ran; see the [LIVE findings](findings/LIVE-live-run-2026-09-25.md). They are ca7b954, 1727f3b, a2bb20a, 616f323 and 18f0bb8, and the last is R-C5 increment 2.
  - They were merged into this line on `remediation/p2-sync` in f471830. There was one textual conflict: R-A5's `EntryHoldError` beside the new hold helpers. Both were kept.
  - At f471830, `pnpm check` passes (187 files, 1,500 unit tests, e2e, scope). Both 2026-09-23 replays report 0 changed.
  - The operator then paused WI/EXO delivery until P2 is done (rule 7).
- **Next, in order (reordered 2026-09-27):**
  1. **R-I11.** Review the five live fixes, while the change is still small. **Done 2026-09-27.**
  2. **R-I10.** Snapshot the paused live database. Record its goldens. Add the scheduler replay. **Done 2026-09-27.**
  3. **R-C12 and R-C13.** Reproduce LIVE-06 and LIVE-07 on that snapshot, then fix them. Each leaves a typed reason where the operator or the status list can see it. **Done 2026-09-27.**
  4. **R-E3a.** The status list, reading R-A4's items and R-C12's reasons. **Done 2026-09-27.**
  5. **Deploy the P2 line.** Schema 32 rebuilds the attention items, then do the notification checks below. The live roadmap stays paused while R-E3a is checked against it. **Deployed by the operator 2026-09-28**; the first day found LIVE-09 to LIVE-13.
  5a. **R-C14 and R-C15.** Fix LIVE-09 to LIVE-13 as one batch. **Done 2026-09-28, not merged or deployed.**
  6. **R-C5 increments 3 to 5, then R-C3b.** These remove the largest operator-stop causes (HIST-03, HIST-04) once the stops are visible. **Done 2026-09-28, not merged or deployed** (R-C3b's done-when is measured after deploy).
  7. **The rest of P2, in order (proposed 2026-09-28, approved by the operator the same day):**
     1. **R-G4** (daemon-owned receipts): agents can still forge the receipts that gate integration (SEC-01), R-C6 depends on it, and it should take over CI execution and its lock from a2bb20a (LIVE-03). **Done 2026-09-28** (not merged or deployed).
     2. **R-G5** (agent environment isolation): supervised runs inherit the operator's environment, hooks, skills and MCP servers (SEC-02, SEC-03). Together with R-G4 it closes the open security findings before more delegation is automated. **Done 2026-09-28** (not merged or deployed).
     3. **R-E1, then R-E2** (routes; split the Roadmaps page): two P2 exit criteria depend on them (no reloads; the inbox deep-links). The Roadmaps page is now over 7,000 px tall on the desktop capture, and R-E3b's board needs its own route. **R-E1 done 2026-09-28; R-E2 next** (not started in the 2026-09-28 batch).
     3a. **R-G13** (declared per-repository checks): added by the operator 2026-09-28 after the batch report, to close R-G4's last gap. A check the agent chooses (`ct-check -- true`) still meets a scoped-check gate, and non-Rust repositories get no controller verification (AGT-08). It needs a short design first: where declarations live and who may change them.
     4. **R-D4, then R-D5** (query store; server view models): the remaining P2 exit criteria (an idle tab makes no requests; the work-item page's request count).
     5. **R-G9, R-I9, then R-H4, R-I4, R-G6.** Auth hardening beyond the landed guard, e2e specs in their own workspaces so the gate can use more workers, then storage weight, structural test boundaries and brief redesign.
- **Gate at the head:** `pnpm check` passes in one run. 187 test files and 1,494 unit tests, 20 e2e tests,
  the walkthrough rehearsal and the scope check. At load averages of 20 to 35, earlier runs timed out in waitFor;
  the failing files passed rerun serially each time.
- **Independent review of P2 and the live fixes (2026-09-27, R-I11 done).**
  - The review ran on `remediation/p2` after a fast-forward to `remediation/p2-sync` (0a7d641). It covered every P2 item since a4fabdf, the five live fixes, the f471830 merge and the 0a7d641 docs. Five reviewers read one area each, and every finding was verified again before it was acted on.
  - Twelve commits: eleven fixes and one added test. Each fix's test fails without it, and each commit updates its item.
    - **LIVE-03 (a2bb20a): ccd618c.** An interrupted lock wait wedged the run. Two contenders could both reclaim a stale lock.
    - **R-C11: 0b8c688 and 34524ed.** A review retried after a refused approval review became a stop with no exit. The suspected-outage path set aside genuine decisions. Spent retries lost the step's own stop.
    - **LIVE-01 (ca7b954): dab7c24.** Guidance given on a drain-interrupted step reached only the brief file.
    - **R-C5 increment 2 (18f0bb8): 49686f6, c5d4078, 76bf280, 31afe57, 9eb327b, and the test commit 5a595d0.**
      - Three places ignored operator rounds: a false merge-approval item, R-C4's refresh, and the runtime refresh.
      - A refused request dropped the hold.
      - Overlapping requests lost both rounds.
      - A stranded round waited silently.
      - The allowance count shown to the operator was misleading.
      - Two test gaps are closed.
    - **LIVE-02 (1727f3b): 2184f9a.** By operator decision, the operator authorizes the security review only for cycles no roadmap owns, and an unreadable delegation fails closed. ADR-063 and `docs/security.md` are amended.
  - **Left open:**
    - R-A4's per-merge `merge-recovery-required` flicker (low-medium; reasons on R-A4).
    - No test for 18f0bb8's checkpoint-review merge wait.
    - ct-act lock edge cases, for R-G4.
    - An index for `mergedIntoAfter`, for R-D.
    - Swallowed adoption failures, for R-C12.
  - **Gate at 2184f9a:** `pnpm check` passes in one run: 188 test files and 1,518 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check. Both 2026-09-23 replays report 0 changed (51 and 278).
  - **Next:** R-I10 (item 2 above).
- **Steps 2 to 4 (2026-09-27, same branch; not merged or deployed).** Each item had an independent adversarial review in an isolated worktree; every finding is fixed or has a disposition on its item in register.md.
  - **R-I10: done.** 1a75a5b; review fixes 884c66a. Snapshot of the paused live database with its goldens in `$XDG_DATA_HOME/craftingtable-review/replay/2026-09-27/`. `pnpm controller:replay <snapshot> --scheduler` runs one real scheduler pass on a copy with every launch, worktree, merge, refresh and Git call replaced by a recorder, and records each entry's decision, each workflow cycle's checkpoint readiness and each roadmap's status list. It reproduced LIVE-06 and LIVE-07. Every LIVE finding names its replay case or test.
  - **R-C12: done (LIVE-06 fixed).** 92f6c93; review fixes f80f679. Cause: a circular wait. EXO-02/domain's recovery round needed a repository slot held by EXO-04/domain's repair, which waits for EXO-02/domain to be verified. Every scheduler path now returns a typed step, and each pass records waits on the roadmap (`entryWaits`, operator-approved). A round may borrow one slot from such a holder (operator-approved); a circular wait one slot cannot resolve holds for the operator. Adoption failures are held, not swallowed.
  - **R-C13: done (LIVE-07 fixed).** 26f213c; review fixes b81b2fa. The hypothesis was refuted: readiness was right, and the reviewer's ledger lacked the checkpoint's own prerequisites. Readiness and the ledger now come from one evaluation. A failed attestation is its own stop, `checkpoint-attestation-failed`, and Resume is refused while its inputs are unchanged. The done-when was restated by operator decision.
  - **R-E3a: done (LIVE-08).** 42bca8b, walkthrough 2c8d037; review fixes 0727885, a96f4db, 34be397. `GET …/roadmaps/:id/status` and an Entry status block on the Roadmaps page. On the 2026-09-27 snapshot it explains every entry LIVE-08 names, with no database query. Walkthroughs `2026-09-27-status-list-before`, `-after-42bca8b`, `-review-after`.
  - **Intended decision changes on the 2026-09-27 snapshot**, against the scheduler golden recorded before R-C12:
    - EXO-02/domain verification: `none` → `recover` (R-C12);
    - EXO-03, EXO-04 verification, WI-04/domain and EXO-18: silent → typed waits (R-C12);
    - WI-04/domain's WI-WORKER-G1 packet: WI-09/WI-10 receipts and WP-001…WP-008 missing → none missing (R-C13).
    
    Step outcomes are unchanged on both snapshots.
  - **Gate at 34be397:** `pnpm check` passes in one run: 194 test files and 1,557 unit tests, 20 e2e tests, the walkthrough rehearsal and the scope check (load average about 3.5).
  - **Replays, each on a copy:**
    - 2026-09-23: `--check golden.json` 51, 0 changed; `--every-run --check every-run-golden-a4aa12d.json` 278, 0 changed.
    - 2026-09-27: `golden.json` 58, 0 changed; `every-run-golden-d81db74.json` 352, 0 changed. The scheduler replay against `scheduler-golden.json` (recorded before R-C12) reports the six intended changes listed above, plus 151 new `status:` records (R-E3a). New scheduler goldens are recorded at this head for both snapshots (`scheduler-golden-<head>.json`) and re-check with 0 changed; the replay names attention items by subject, because a copy rebuilds them with new ids.
  - **Operator decisions taken (2026-09-27):**
    - `entryWaits` persisted on the roadmap (R-C12);
    - a recovery round may borrow one repository slot from work that waits on its slice (R-C12);
    - R-C13's done-when restated, with the new stop code `checkpoint-attestation-failed`.
  - **Before the deploy:**
    - Confirm that `CRAFTINGTABLE_DEVELOPMENT_CAPACITY=4` stays in the unit's environment file. A restart with the default of 2 would invalidate the accepted plan evidence and every checkpoint behind it (R-I10).
    - On first boot, R-C12 lets EXO-02/domain's recovery round start, by borrowing a repository slot.
- **Post-deploy batch (2026-09-28, `remediation/p2`; not merged or deployed).** The operator merged steps 2 to 4 into `main` and deployed. The first day found five stops, recorded as LIVE-09 to LIVE-13 with replay cases on a 2026-09-28 snapshot (`$XDG_DATA_HOME/craftingtable-review/replay/2026-09-28/`, sha256 `645b7c3e…`). Two new items: R-C14 (the inbox asks only for what work waits on) and R-C15 (a checkpoint review gets its decisions).
  - Commits: d39b47a (findings and replay cases), 0ca00cb (LIVE-09), a444901 (LIVE-10), 00077d5 (LIVE-11), 1be7a18 (LIVE-13), 849b5b3 (R-C15, LIVE-12), 69d788d (docs), b0eda31 (status list), fd9c7d6 and 85ad226 (review fixes).
  - **Independent review:** one HIGH finding, fixed. The first frontier rule hid evidence only the operator supplies, and decisions behind a slice's delegated review. One rule (`operatorActsNext`) now decides the inbox, an entry's state and the status list's actor. Two lower findings are fixed. Three have dispositions and one test gap is open, all on R-C14 in register.md.
  - **Intended decision changes**, scheduler replay against the golden before the batch (`scheduler-golden-d39b47a.json`) on the 2026-09-28 snapshot:
    - WI-04/domain's cycle packet no longer lacks decision bodies (R-C15);
    - 47 entries waiting on unfinished work move from `needs-attention`/operator to `dependency-blocked`/controller;
    - the 50 checkpoint items, 2 decision-preparation items and the EXO-02 hold item are no longer raised (no entry is on the frontier yet).
    
    Against the pre-batch goldens (`scheduler-golden-ac08291.json`), the 2026-09-23 and 2026-09-27 snapshots show the same move for 61 rows, plus two cycle items from d39b47a's new attention section.
  - **Gate at 85ad226:** format, lint, typecheck, build, 195 test files and 1,562 unit tests, 20 e2e tests and the scope check pass. The walkthrough rehearsal could not run: headless Chrome crashed on the host in three runs, at different steps, with the daemon healthy. It needs a rerun once the host is stable.
  - **Replays, each on a copy:** `golden.json` and `--every-run` report 0 changed on all three snapshots (51/278, 58/352, 59/356). New scheduler goldens `scheduler-golden-85ad226.json` are recorded for all three.
- **R-C5 and R-C3b batch (2026-09-28, `remediation/p2` from 8146974; not merged or deployed).** A fresh read-only snapshot of the live database, taken with the roadmap running after the 8146974 deploy, is at `$XDG_DATA_HOME/craftingtable-review/replay/2026-09-28b/` (SHA-256 `f5e8d6ca…`, schema 32). Its goldens were recorded at 8146974 before any change: `golden.json` 59, `every-run-golden-8146974.json` 358, `scheduler-golden-8146974.json` 341. Every item had an independent adversarial review in an isolated worktree; every finding is fixed or has a disposition on its item.
  - **Carry-overs.**
    - **Walkthrough crash (R-I5, 73e1cd9).** Headless Chrome crashed again (four identical core dumps, a compositor-thread trap), and replays failed with `SQLITE_IOERR_WRITE` in the same minute. Cause: the user's `/tmp` tmpfs quota (25.1 GiB, logind's default) was at 23.7 GiB. 7.5 GB of that was 202 leaked e2e daemon directories: Playwright SIGKILLs a web server unless told otherwise, so `e2e-entry.ts` never removed its data directory. The daemon now stops on SIGTERM. With the operator's leave, the leaked directories and old agent scratch were deleted (quota 0.7 GiB used), and three walkthrough captures have since run cleanly.
    - **R-C14 test gaps closed.** LIVE-13's running-repair check no longer depends on timing (a73cc06); each of `decisionAccepted`'s conditions has a case (d6c2fba, review fix b784837).
  - **R-C5 increments 3 to 5: done.**
    - 54e24d3: a pure progress classifier and a redacted EXO-01 fixture. Replayed through the classifier, EXO-01 escalates once after two rounds, where 13 rounds ran.
    - 4ded132: one typed escalation, `recovery-not-converging`, with the rounds' progress. Operator decisions: the new code, and two rounds.
    - d257e06: the stopped review's one inbox item carries it and brings the amendment form into view as the split offer.
    - Review fixes: acc87e7.
  - **R-C3b: code done; done-when after deploy.** The operator chose a standing, revocable grant (option A).
    - 7c21b95: preparation beside a running roadmap; it no longer blocks approval.
    - ec35ead: the grant (a new persisted roadmap field).
    - 69cf52a: the scheduler prepares needed decisions, most slices first.
    - 5748466: "unblocks N" counts slices.
    - 9e7d22e: batch approval.
    - Review fixes: 1710c0a, ad81fa0, 8959655.
  - **Walkthroughs:** `2026-09-28-recovery-escalation-before` (537abf9), `-recovery-escalation-after` (04939b2), `-decision-preparation-after` (573a709).
  - **Replays, on copies:** `golden.json`, `--every-run` and the scheduler replay report 0 changed on all four snapshots after every item: 2026-09-23 (51/278/346), 09-27 (58/352/341), 09-28 (59/356/344) and 09-28b (59/358/341). No snapshot holds a grant or an automatic round that would escalate.
  - **Gate at 4c7caf4:** format, lint, typecheck, build and the scope check pass. 200 test files and 1,599 unit tests: in the full run at a load average of 22, 19 tests in 8 files timed out in `waitFor`, and all 8 files (106 tests) passed rerun serially. e2e: 20 tests and the walkthrough rehearsal pass, with no Chrome crash. One e2e daemon left a partial data directory (on R-I5, for R-I9).
  - **Before the deploy:**
    - Schema stays 32, but two persisted values are new: the hold code `recovery-not-converging` and the roadmap field `decisionPreparationGrant`. A release before this batch cannot read a roadmap carrying either.
    - To roll back, answer such holds first and remove the grant field from the stored roadmap.
    - Grant standing preparation only when wanted, while the roadmap is paused.
- **R-G4, R-G5 and R-E1 batch (2026-09-28, `remediation/p2` from c547ede; not merged or deployed).** The operator deployed c547ede at 14:45. Three hours later a read-only snapshot of the live database was taken, at `$XDG_DATA_HOME/craftingtable-review/replay/2026-09-28c/` (SHA-256 `f3b27347…`, schema 32), with goldens recorded at c547ede before any change: `golden.json` 60, `every-run-golden-c547ede.json` 392, `scheduler-golden-c547ede.json`. Each item had an independent adversarial review in an isolated worktree, and every finding is fixed or has a disposition on its item.
  - **Carry-overs.**
    - **R-C3b:** nothing to measure yet. No slice started after the deploy, and no standing grant is set.
    - **R-C5:** no automatic round started and no escalation fired. One review remediation limit was raised by the operator.
    - **Two new stops, with working exits,** so they are recorded rather than fixed (rule 7):
      - LIVE-14: an untracked `.codex` file in EXO's primary checkout failed a Codex review; Codex reads project configuration from the primary checkout.
      - LIVE-15: a checkpoint review whose upstream pin moved stopped as a generic `controller-error`.
    - **R-I5:** the partial e2e directory was seen again but could not be reproduced on demand, so it stays for R-I9, with a second pattern recorded.
  - **R-G4: done** (95c4a17, 96ddfe6, a2ef627, 9f7fd4a, 28bcdff, 512e47d, 6bb668a; review fixes e949ec6, 90427bf, cbdabd6, 99716b8, 49ad4e0).
    - `ct-check`, `ct-act`, `ct-native` and pinned Cargo builds only leave a request in the run's spool. The daemon runs each in a confined user unit, from the manifest it verified at launch, observes HEAD itself and records the receipt in `run_check_receipts` (schema 33).
    - A daemon-recorded run's build record reads no file the agent can write. Earlier records are labelled agent-reported.
    - Receipt kinds now decide the gates, so local CI is supplemental.
    - The CI lock is an in-daemon queue. The R-I11 cases are closed: the wait is charged to the time limit, an expired wait is labelled, and no act is orphaned.
    - **Review:** one HIGH (the unit left `.git` writable; daemon Git followed the pointer); MEDIUMs for spool links, unbounded checks and restart cleanup; LOWs. The operator decided to refuse workflows whose jobs reach the host through Docker.
    - **Left:** `ct-check -- true` still counts as a scoped check, pending declared checks (AGT-08).
  - **R-G5: done** (7b5751a, b4cde90, f70d2dd, 4abafcd, ebc4c0c, 29d3524, e5071f6; review fixes d1ad0e7, c6ea435, 4d3b48e, 1cf1984).
    - Agents get allowlisted variables only.
    - Claude and Codex load none of the operator's settings, skills, plugins, MCP servers, hooks or memory (live checks).
    - Daemon Git runs no hooks or fsmonitor and reads no system or global configuration beyond the operator's identity.
    - Claude's Bash runs in the OS sandbox: no network, no Docker socket, no credentials, no settings files.
    - Protected refs moved outside the daemon are flagged (schema 34 adds the audit action).
    - **Review:** one HIGH (the Docker socket was reachable from the sandbox without the seccomp helper) and five MEDIUMs, all fixed.
  - **R-E1: done** (a07dbfe; review fixes 4102517; walkthroughs `2026-09-29-routes-before`, `-routes-after`).
    - In-app links navigate in place (`Link`, `PathLink`), and routes carry a typed roadmap and focus. No panel reads the address.
    - A test bans raw in-app anchors, and an e2e spec requires deep links to land on their target without a document load.
    - **Review:** one HIGH (a deep link landed off target while panels loaded) and one MEDIUM (a clarification draft was overwritten on Back), both fixed.
  - **Gate at 4102517:**
    - format, lint, typecheck and build pass;
    - 209 test files and 1,648 unit tests pass; in the full run at load average 5 to 14, two tests in two files timed out, and both files (70 tests) passed rerun serially, one of them three more times;
    - e2e: 21 tests and the walkthrough rehearsal pass;
    - the scope check passes.
  - **Replays, on copies:** `golden.json`, `--every-run` and the scheduler replay report 0 changed and 0 missing on all five snapshots: 2026-09-23 (51/278/346), 09-27 (58/352/341), 09-28 (59/356/344), 09-28b (59/358/341) and 09-28c (60/392/333).
  - **Before the deploy:**
    - Schema 33 and 34 are new. A release before this cannot read them, or run environments carrying `receiptAuthority`.
    - The daemon needs its systemd user manager for check units (`CRAFTINGTABLE_CHECK_CONFINEMENT=none` otherwise), and bubblewrap and socat for Claude's sandbox; both are present on this workstation.
    - Checks, CI and native units now run in the daemon's units. Runs in flight at the deploy keep their old launchers.
  - **Next:** R-E2 (split the Roadmaps page), LIVE-18 (proposed: name every missing decision; give each one a card in Shared architecture decisions with a Prepare brief action; refuse Resume until they are settled), R-G13 (declared checks, scheduled by the operator 2026-09-28), then R-D4 and R-D5, then R-G9, R-I9, R-H4, R-I4, R-G6. R-G14 (configurable outside sources) is P3.
- **Operator follow-ups to the R-G4/R-G5/R-E1 report (2026-09-28, same branch; not merged or deployed).** The operator answered the report's five decisions, and each was built test-first and reviewed.
  - **crates.io for Claude's sandbox (R-G5): 214a844, after review 2806815 and 8a71388.**
    - The sandbox reaches `index.crates.io` and `static.crates.io` only. The review dropped the `crates.io` apex, which is the publish API.
    - It cannot read Cargo's tokens, and it may write the registry and git caches of the daemon's own Cargo home, `<data>/cargo-home`.
    - By operator decision after the review, agents and check units use that home, never `~/.cargo`, so a planted crate cannot run in the operator's own builds. The daemon seeds it one way at each start.
    - A place to configure outside sources, and Codex's all-or-nothing network, are R-G14 (P3).
  - **Effort on Claude profiles: 0a198b2.** ADR-064 amended.
  - **Protected-ref moves in the inbox with Acknowledge: 15b0154, after review 1f5b010 and 0d9b6c5.** Schema 35, `protected_ref_moves`.
  - **Declared per-repository checks scheduled as R-G13, after R-E2: 2d67a0f.**
  - **LIVE-15, the typed stop `upstream-pin-moved` (R-C4): 4498c01 and c9b3d78, after review 4475469.**
    - Its refs name the moved pins, and Resume is refused while they are stale. ADR-058 amended.
    - Starting the refresh preview automatically is an open follow-up.
  - **Also:** the register summary now shows R-G4, R-G5 and R-E1 done (bb133c4). Review nits and wording: 527d151.
  - **Review** (isolated worktree, d6823bf..c9b3d78): no HIGH. Two MEDIUM, both fixed: the apex host with readable tokens, and the shared Cargo cache. Four LOW, fixed. Two NITs and one out-of-scope wording point, addressed. The dispositions are on R-G5's follow-ups entry.
  - **Gate at 527d151:**
    - format, lint, typecheck and build pass;
    - 212 test files and 1,662 unit tests pass: in the full run at load average 14, three tests in three files failed (two timeouts and the R-I5 shutdown leak), and all three files passed rerun serially, the shutdown test three more times;
    - e2e: 21 tests and the walkthrough rehearsal pass;
    - the scope check passes.
  - **Replays at c9b3d78 and again at 527d151, on copies:** `golden.json`, `--every-run` and the scheduler replay report 0 changed and 0 missing on all five snapshots.
  - **Before the deploy:**
    - Schemas 33 to 35 are new. A release before this cannot open the database, read Claude-effort selections, or read cycles with the new stop.
    - The first start copies the operator's Cargo registry cache into `<data>/cargo-home`: about 480 MB, and a full copy, because `/mnt/workhorse` is not on the home file system.
- **Why no new slices started (2026-09-28, operator question; same branch, not merged or deployed).**
  - From the 2026-09-28c snapshot:
    - The last new slices started on 2026-09-21 (WorldInterface) and 2026-09-25 (Exoskeleton).
    - Seven slices had every dependency met and waited only on repository capacity (2 per repository).
  - **WorldInterface, LIVE-16 (fixed in cb86fba, R-C3b).** Two decision preparations that had finished on 2026-09-24 kept worktrees that nothing removed, and a worktree with no scope counted as a slice. Preparations now take no capacity, and a preparation's worktree is removed once its decision is accepted.
  - **Replays.** The scheduler replays of 2026-09-27 (10 records) and 2026-09-28c (13 records) changed as intended: WI-03/integration and WI-04/integration start, and the rest wait on the roadmap's in-flight limit of 4. New goldens were recorded at cb86fba (`scheduler-golden-cb86fba.json`), and all 15 replays then report 0 changed.
  - **Exoskeleton: EXO-18/instance-design, 74 h so far, agents running for 6.8 h.**
    - 60 h at the `shared-decision-required` gate. Four decisions (EXO-ADR-022, 030, 037, 038) are unapproved, and the stop names one (LIVE-18).
    - Local CI collisions persisted after the LIVE-03 fix (LIVE-17): three remediation rounds that only re-ran CI.
    - A drain discarded a finished review (LIVE-19).
    - LIVE-17 to LIVE-19 are recorded and open. Check LIVE-17 on the first day after the deploy, since R-G4 changes how CI runs.
- **Post-deploy batch (2026-09-29, `remediation/p2` from fccce06; not merged or deployed).** The operator deployed fccce06 at 06:48 UTC. At 17:18 a read-only snapshot of the live database was taken, at `$XDG_DATA_HOME/craftingtable-review/replay/2026-09-29/` (SHA-256 `80a94173…`, schema 35). Its goldens were recorded at fccce06 before any change: `golden.json` 65, `every-run-golden-fccce06.json` 416, `scheduler-golden-fccce06.json` 365 (181 entries and 4 cycles). All 18 replays of the six snapshots report 0 changed at fccce06.
  - **First-boot checks** (details on R-G4 and R-G5):
    - Schema 35 migrated at 06:48:52.
    - `<data>/cargo-home` was seeded (490 MB, no credentials), and `git-identity.gitconfig` holds name and email only.
    - 749 check units started, with 790 daemon receipts, and the daemon logged no warnings or errors.
    - The Codex probe passed for all 57 runs.
    - The Claude sandbox launch is unverified: no live profile uses Claude, and this session's permission policy refused a live probe. It needs one operator-run Claude step.
  - **LIVE-16: verified.** Both stale worktrees were removed on the first pass, and WI-03/integration and WI-04/integration started a second later.
  - **R-C3b: preparation works; the done-when is not met yet.** The grant prepared 35 decisions in 84 minutes, and the operator approved nine in one batch. But the one slice that started with an undecided decision (WI-05/domain, WI-ADR-009) still stopped at design: its brief was ready five hours before, and was approved four hours after. The other two started slices needed no new decision. Closing it needs decisions approved before their slices start, or a scheduler that holds such a slice (an operator decision).
  - **R-F7: done.** WI-02/domain's verification passed every check as `current-upstream-build` under the wi→aq record, and WI-02 was accepted.
  - **LIVE-17: not seen.** 99 local CI runs, with overlapping runs of one workflow taking turns, and no collision message anywhere readable; two job failures stay unclassified because job logs were not read. Closed by R-G4, to be reopened if one appears.
  - **R-C5: not fired.** WI-03's parent review needed recovery, and automatic recovery held it for an ambiguous owner, as designed.
  - **New stops recorded, not fixed (rule 7):**
    - LIVE-20: the ambiguous-owner hold's reason reaches neither the inbox nor the status list.
    - LIVE-21: LIVE-15's typed stop missed the delegated checkpoint's acceptance, so EXO-04's mergeable checkpoint review ended at the same `controller-error` after the fix too (the fourth time).
    - LIVE-18 recurred: EXO-18 was resumed at 06:50 and stopped at the same gate at 07:13.
  - **Independent review of these records (2026-09-29, isolated worktree, 69ce1e1).** The reviewer re-queried a copy of the snapshot, re-ran the replays and read the journals. Every finding is fixed in the records:
    - *HIGH, fixed:* R-C3b's "done-when met" compared unlike cases. The two slices without a stop started before the grant and needed no undecided decision; the one that did stopped. R-C3's status is restored to "done-when not yet met", with what would close it.
    - *MEDIUM, fixed:* 35 preparations, not 36 (7 WI and 28 EXO; two older records date from 09-24), 06:50:57 to 08:14.
    - *MEDIUM, fixed:* LIVE-21 blamed three stops on a fix that was live for only one, and missed a fourth (082948fb, 09-28 21:13). It now says four mergeable reviews ended there, one after the fix.
    - *LOW-MEDIUM, fixed:* LIVE-21 named the later submission check; the conflict comes earlier, from the checkpoint candidate's own issues. A fix at the later statement would miss again.
    - *LOW-MEDIUM, fixed:* R-G4's unit count was the units that logged resource use (463); 749 started. Four checks exited 127, cause unverified.
    - *LOW, fixed:* LIVE-20 now names the mechanism (a cycle's item replaces the roadmap's hold item; only `recovery-not-converging` passes the hold's reason on) and the replay's two variants.
    - *LOW, fixed:* LIVE-17 no longer claims receipts show no collision; two job failures are unclassified.
    - *LOW, fixed:* LIVE-18's review list and its preparation IDs (worktree IDs had been given).
    - *NIT, fixed:* R-F7's CI rerun count and the date of its evidence; the operator's pause, grant and resume sequence at 06:49 to 06:50.
  - **R-E2: partial** (3feb310; walkthroughs `2026-09-29-roadmaps-split-before`, `-after`; review fixes 211949c).
    - `/roadmaps` lists roadmaps and imported maps. Each roadmap has a board, a setup page (a checklist in order) and a history page; each imported map has its own page. Stored links open the page that holds their focus.
    - The list, a board and a history page each fit in one desktop screen. **Not met:** setup with a form open is 6 to 7 screens and a map's page while creating a roadmap 11 to 18, because `CrossProjectPanel` and `RuntimeEvidencePanel` render every step at once. The second increment goes with R-A6.
    - **Review:** one HIGH (the map page hid the roadmap creator once any roadmap used the revision) and four MEDIUMs (UI-17's shared dirty gate, blocker links, map links, item paths), all fixed.
  - **LIVE-18: done on the branch** (option B, operator decision; f4a238c, e687e6a, d08b7c7; review fixes 1e422d5).
    - A shared-decision stop names every unsettled merge decision. Each has a card with "Needed now by" and Prepare decision brief, even before a brief exists. The stop's item and cycle panel link to the cards. The cycle offers "Open shared decisions (N)" instead of Resume until each is settled, and plain, guided and roadmap resumes are refused or skipped meanwhile. Nothing persisted changes.
    - **Review:** one HIGH (a deadlock on a decision whose prerequisite only this slice's own review produces) and four MEDIUMs (a clause approval read as accepted, a stale roadmap version on Prepare, single-project roadmaps without cards, a sequential resume refused for open questions), all fixed.
  - **R-I9: done** (3836b99, 6fb5a4a; review fixes 0cf4fa5, b702dfe). Each gate spec works in its own workspace, the gate runs four workers with installation-wide specs serial at the end, and the e2e daemon gets enough capacity. The review found the capacity never reached the daemon and the data-directory leak's real cause (pnpm let Playwright kill the daemon mid-removal); both fixed. **Done:** ten consecutive `pnpm test:e2e` passes at 661282f (21 tests and the walkthrough rehearsal, 219 to 250 s each, no retries, nothing left behind).
  - **R-G13: increment 1 done on the branch, one HIGH open for the operator** (8d0482c; walkthroughs `2026-09-29-repository-checks-before`, `-after`; review fixes 242bc20 and 661282f).
    - Schema 36 adds immutable, versioned check declarations and the `repository-checks.adopted` audit action. The operator adopts `.craftingtable/checks.json` on the Repositories page from a branch or exact commit the daemon reads; the preview shows each definition file.
    - A scoped review prepared after the change is met only by daemon runs of every adopted check (`ct-check --declared <id>`) on the reviewed commit. The daemon runs each in a private, verified clone of that commit, with a PATH and file view that exclude everything the run can write, and compares the definition files' stored blobs with the adoption. Commands the agent chooses are supplemental.
    - A repository with no adoption stops as `repository-checks-undeclared` before any run; a changed definition stops at review approval as `check-definition-changed`; adopting clears either.
    - **Two reviews.** The first found three HIGHs (a program planted on the run's PATH ran instead of the declared one; the check ran in the agent's live worktree; adoption refused any tree with a link or a large file) and four MEDIUMs; the second found that the clone read objects the agent could rewrite, and that the unit could still see the run's files. All fixed, each shown by mutation (29 guards).
    - **Open, operator decision:** the check units build from the daemon's Cargo home, which agents can write (the R-G5 follow-up decision). A planted source in `registry/src` is compiled by any later Cargo build, declared or pinned; this predates R-G13. Recommendation on R-G13.
  - **Tooling:** lint failed at fccce06 already (biome's warnings on tests that drive private roadmap members); fixed in 34bd8ab.
  - **R-D4: not started** (time).
  - **Gate at e081eb5** (code as at 661282f):
    - format, lint, typecheck and build pass;
    - 219 test files, 1,710 unit tests: in the full run at load average up to 13, 46 tests in 15 files timed out waiting on the controller; all 15 files (262 tests) passed rerun serially;
    - e2e: 21 tests and the walkthrough rehearsal pass (and ten consecutive runs for R-I9);
    - the scope check passes.
  - **Replays at 661282f, on copies:** `golden.json`, `--every-run` and the scheduler replay report 0 changed and 0 missing on all six snapshots, including 2026-09-29 against the goldens recorded at fccce06 (65/416/365). No new goldens. The replays classify recorded outcomes and prepare no runs, so R-G13's fail-closed start and its approval-time check are not exercised there; they have their own tests.
  - **Before the deploy:**
    - Schema 36 is new (`repository_check_declarations`, the `repository-checks.adopted` action). A release before this cannot open the database. Run environments may carry `checkDeclarationId`; cycle attention may carry `repositoryId` and `checkId` refs and the codes `repository-checks-undeclared` and `check-definition-changed`. Cycle reads carry a derived `unsettledDecisions` (never stored).
    - **Fail closed at once:** every scoped slice prepared after the deploy in a repository with no adopted checks stops as `repository-checks-undeclared`. WI and EXO each need a `.craftingtable/checks.json` committed on a branch the operator reviews, and adoption on the Repositories page. Runs already prepared keep the old rule.
    - Declared checks clone the reviewed commit through a pack (`--no-local`) into `<data>/check-logs/<run>/`, with a Cargo target per commit there; both are removed when the run's checks close, and at start.
    - Every daemon Git command now sets `GIT_NO_REPLACE_OBJECTS`.
  - **First-boot checks after this deploy:**
    - schema 36 migrated, and the daemon logs no warnings;
    - the Repositories page shows a Checks section per repository, "No adopted checks" until adoption;
    - after adoption, a scoped review's receipt names `declaredCheck` and runs in `check-logs/<run>/<id>.private/tree`; nothing is left there once the run ends;
    - an EXO-18-like shared-decision stop shows "Open shared decisions (N)" and its item opens the roadmap's setup at the decision cards;
    - `/roadmaps` lists roadmaps, and stored links (`/roadmaps?roadmap=…#…`) open the right page;
    - still open from the last deploy: one Claude step, to verify the Claude sandbox launch.
  - **Decisions needed:**
    1. **R-G13, the shared Cargo home (HIGH, open).** Agents can write `<data>/cargo-home`, and every Cargo build in a check unit, declared or pinned, compiles what is there. Recommended: a private `CARGO_HOME` per check, extracted fresh from the shared download cache (read-only to the unit). It changes the R-G5 follow-up decision, so it waits for you.
    2. **R-C3b.** Hold a slice whose decision is prepared but unapproved, or keep approving decisions before their slices start.
    3. **R-G13 adoptions for WI and EXO,** right after the deploy (above).
    4. **LIVE-21** (a checkpoint candidate conflict reaches the operator as `controller-error`): fix next, or leave while it has an exit.
  - **Next:** the Cargo-home decision (R-G13), then LIVE-21 and LIVE-20, R-G13 increments 2 to 5, R-E2's second increment with R-A6, R-D4 and R-D5, then R-G9, R-H4, R-I4, R-G6. R-G14 (configurable outside sources) is P3.
- **Live-data work left:**
  1. Deploy. This runs schema 32, and the attention items rebuild on first boot.
  2. Enable notifications, and check that the inbox, rail count and push log agree.
  3. After a few days, count false alarms (`resolved_by = 'automation'` on pushed items).

### P3: Progress view and consolidation (2–3 weeks)

| Item | Notes |
|---|---|
| R-E3b | The roadmap board and graph: the answer to pain point 2. It can start once R-E2 and R-D5 exist. It builds on R-E3a's status list from P2 (split 2026-09-27). |
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
R-I10 snapshot + scheduler replay ► R-C12, R-C13 (reproduce before fixing) (added 2026-09-27)
R-A4 items + R-C12 reasons ► R-E3a status list ► R-E3b board (added 2026-09-27)
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
