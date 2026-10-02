# TS: test-suite review at `remediation/p2` b417dce (2026-10-02)

Six independent reviewers worked in detached worktrees. This pass deduplicated their reports, cross-checked them, and re-verified every HIGH and MEDIUM in a fresh worktree at b417dce.

The review was report-only: nothing was fixed, committed or pushed, and every review worktree has been removed. The six detailed reports stayed outside the repository, in `~/.cache/ct-p2-tmp/review-reports/`:
- `load-flakiness.md` (LF)
- `e2e.md` (E2E)
- `assertion-strength.md` (AS)
- `risk-coverage.md` (RC)
- `architecture-speed.md` (ARCH)
- `guards-replays.md` (GR)

## How this pass verified

- **Mutations: 24 re-run against the whole relevant test project, not a hand-picked file set.**
  - Web mutants ran against all of `apps/web` (446 tests); server and package mutants ran against the whole node project (1,735 tests).
  - Every file that failed in the parallel run was re-run serially with the mutant still applied. A mutant counts as caught only if the serial re-run still fails.
  - Each mutant was reverted, and the tree was confirmed clean before the next.
  - The runner, diffs, per-mutant vitest JSON and `results.jsonl` are in `~/.cache/ct-p2-tmp/review-verify-scratch/`.
- **Baselines:** unmutated runs of both projects. The web project passed 446/446. The node project's failures were all load-only and passed serially.
- **Code reading at `b417dce` (`git show`):** every other HIGH and MEDIUM was checked against the code at the commit.
- **Probes:**
  - `configFromEnv` with several agent temporary roots (TS-H3);
  - `node scripts/check-forbidden-scope.mjs` with planted files in a throwaway worktree (TS-M11);
  - `@craftingtable/contracts` resolution under the replay's tsx entry (TS-H6).
- **Load:** this pass ran after the six reviewers had finished. Ambient load was 2.4–4.3 for the node runs, and up to 21 for the early web runs, from this pass's own parallel vitest and a Plex transcode.

## Corrections to the reviewer reports

Running mutations against whole projects overturned or narrowed four reviewer claims:

| Claim | Reviewer said | Verified | Effect |
|---|---|---|---|
| AS F-3, QS5: a shrunk array keeps the old identity | survives | **Caught** by `decisions/cycle/ScopeReviewRecovery.test.tsx` | F-3 narrows to QS6, a removed object key, which does survive |
| AS F-4, EI1: `attention-changed` no longer refreshes `notifications` | survives | **Caught** by `NotificationPanel.test.tsx` and `request-budget.test.tsx` | F-4 drops to LOW. EI3 is caught too, by `RoadmapStatusList.test.tsx`. EI2 and EI4 were not re-run. |
| AS F-5, RM2 and RM13: the repository-capacity off-by-one and an unbounded recovery round | survive | **Both caught** by `server-execution-scope-recovery-waits.test.ts` (LIVE-06 cases) | F-5 narrows to RM14, one unmerged worktree per item, which does survive |
| RC F-1: the agent temporary root may be `$HOME` | accepted | Refused when the data directory is under `$HOME` (the default layout). `<data>/state`, `/tmp` and `/var/tmp/x` **are** accepted. | Narrower, but the database case stands; raised to HIGH (TS-H3) |

The lesson for future reviews: a mutation that survives the reviewer's own file set has not shown that no test catches it. Survivors should be re-run against the whole project.

## Cross-checks: where reviewers agreed independently

- **The stepped `waitFor` keeps a wall-clock deadline:** LF F1, ARCH F1, RC (load notes), AS (baseline timeouts).
- **The R-G4 "at most four checks" test:** LF F3, RC NIT, and this pass. It failed in **18 of 18** parallel node runs at ambient load 2.4–4.3 and passed every serial re-run.
- **SQLite `synchronous=FULL` on a btrfs TMPDIR:** E2E F4 (daemon stalls of 1–8 s, matched to fsync spikes) and ARCH F4 (`planning-schema` 83 s in the full run against 6.7 s alone).
- **Code running from `dist/` instead of source:** GR F-1 (replays) and ARCH F6 (the `local-check` launchers).
- **Repeated Git spawns per controller pass:** LF F5 (about 100 per test, 835 `rev-parse` of main for 51 tests) and ARCH F5 (77–787 per test, fixtures under 7%).

## Ranked findings

The Verified column says how this pass checked each finding. "Mutant survives (project)" means the whole relevant project passed with the mutant applied.

### HIGH

| # | Finding | Where | Sources | Verified | Register |
|---|---|---|---|---|---|
| TS-H1 | **A default `pnpm test` is never green, even on a quiet machine.** `waitFor` steps the daemon but gives up after 3 s of wall-clock time. 383 call sites (about 270 on the default) and about 160 per-test `timeout:` values are sized for an idle machine. Load slows each step, not the number of steps needed, so tests fail although the controller converges normally. | `apps/server/src/execution-test-support.ts:521-535`; `vitest.config.ts:27-29`; `server-execution-*.test.ts` | LF F1/F2, ARCH F1 | Code read. In this pass all 18 parallel node runs had 3–15 `Timed out waiting for …` failures, and every one passed serially. LF's trial of a step budget plus a 120 s guard passed 452/452 at load 40. | **R-I2**: reopen. Its "remove wall-clock polling" moved the polling onto steps but kept the wall-clock budget. |
| TS-H2 | **The R-G4 bound test fails in every parallel run.** 40 real `node` checks must finish inside `runToFinish`'s 3 s "turn" wait. A failure there is indistinguishable from a real regression of the bound, so people learn to re-run it. | `server-execution-receipt-gates.test.ts:806-857`, through `execution-test-support.ts:551-581` | LF F3, RC NIT | 18/18 parallel failures at load 2.4–4.3; passed every serial re-run | **R-I2**, **R-G4** |
| TS-H3 | **The restart sweep can delete the database.** At every start, `recoverInterrupted` unlinks every entry under `CRAFTINGTABLE_AGENT_TMP_ROOT`, files included. The config accepts `<data>/state` (the database directory, holding `craftingtable.sqlite` and `pre-migration/`), `/tmp` and `/var/tmp`. The variable is undocumented in operations docs. No test seeds a non-run entry. | `services/agent-run-service.ts:2202-2215`; `services/agent-tree.ts:35-41`; `config.ts:201-208` | RC F-1 (raised from MEDIUM) | Probe: `<data>/state` and `/tmp` ACCEPTED, `$HOME` (containing the data directory) refused, the data directory itself refused. Code read: `removeAgentTree` unlinks non-directories. | **R-G5** (LIVE-31 follow-up). This is a production defect, not only a test gap. |
| TS-H4 | **"Needs you" can stay stale until a reload.** The attention and cycles reads start alongside the snapshot read. The stream starts at `snapshot.asOfSequence`, and opening it re-reads nothing. An event committed between the reads is never delivered. Since R-D4 those keys have no timer re-read, so the rail count, the inbox and decision links can stay wrong until a reload. | `apps/web/src/app/WorkspaceView.tsx:35-36`; `App.tsx:103,189,201-204`; `lib/workspace-projection.ts:39-44,106` | E2E F2 | Code read: the `stream-opened` reducer only sets `connection`. E2E reproduced it 3/3 with the snapshot held 4 s, against a 0/3 control. | **R-D4** (an increment 4b defect) |
| TS-H5 | **The mobile merge-approval flake is a test bug, repeated at 9 sites.** The spec clicks a command and then calls `page.goto` or `reload` at once. The navigation aborts the command's POST, which reaches the daemon only if it wins the race. | `e2e/mobile.spec.ts:164-165,208-209`; `roadmaps.spec.ts:209-210`; `finalization.spec.ts:170-171`; `notifications.spec.ts:46-47`; `walkthrough.spec.ts:435,458,479,501` | E2E F1 | Code read at all the listed sites. E2E reproduced it 2/2 with the POST held 300 ms; `waitForResponse` fixed it 2/2. | **R-D4** (the open mobile item); **R-I5** |
| TS-H6 | **Replays and the `local-check` tests run compiled `dist/`, not the source under review.** Replay "0 changed" can describe stale code: a `packages/contracts` edit showed 0 changed until `tsc -b`, then 3 changed. A fresh checkout fails 7 `local-check` tests, and after an edit without a rebuild those tests check stale code. | `apps/server/package.json` (`replay: tsx src/controller-replay.ts`); `packages/*/package.json` exports to `./dist`; `packages/agents/src/local-check.ts:89-98,780-782` | GR F-1, ARCH F6 | Resolution probe: `@craftingtable/contracts` resolves to `packages/contracts/dist/index.js` from `apps/server`. Code read of `local-check.ts:780`. | **R-I10**, **R-B2**, **R-I4** |
| TS-H7 | **The merge-time security-review gate has no test.** Disabling the `securityCycle` block passes the whole node project. Once a cycle is stopped, it is the only guard on a manual merge of a security-required slice. | `services/execution-service.ts:1715` | AS F-1 | Mutant MG8 survives (project, 1,735 tests) | new (ADR-033 merge gating; next to R-I3) |
| TS-H8 | **The e2e daemon blocks 1–8 s inside SQLite commits when its data directory is on btrfs.** WAL with `synchronous=FULL` on the main thread, and the e2e data directory is `mkdtemp(tmpdir())`. The documented workflow puts TMPDIR on disk (`~/.cache` is btrfs; `/tmp` is a quota'd tmpfs). This is why unrelated specs fail together on 5 s waits. | `packages/storage/src/database.ts:13-16`; `apps/server/src/e2e-entry.ts:10` | E2E F4, ARCH F4 | Code read; `stat -f`: `~/.cache` btrfs, `/tmp` tmpfs. E2E: 6 of 6 daemon stalls over 1 s matched fsync-probe spikes; worst stall 732 ms with the data directory on `/dev/shm`. | new (gate reliability; R-I9 notes). Needs an operator decision on where test data directories live. |

### MEDIUM

| # | Finding | Where | Sources | Verified | Register |
|---|---|---|---|---|---|
| TS-M1 | **The parallel-roadmap conflict flake is the test racing a real app gap.** "Open the decision" takes the first attention item by subject. That list refreshes 0.4–2 s after events, so for that window it links the cycle's resolved merge item ("This item is resolved."). | `features/execution/WorkItemControls.tsx:151-152`; `e2e/roadmaps.spec.ts:178-196`; `support.ts:122-133` | E2E F3 | Code read; E2E trace timings plus 8/8 with a test-side wait | **R-D4** (the open parallel-roadmap item) |
| TS-M2 | **The final-promotion backstops are untested on the merge path:** the staged-promotion issue and the completion policy. `stagedPromotionIssue` is unit-tested only. | `execution-service.ts:1674`, `:1746` | AS F-2 | Mutants MG16 and MG10 survive (project) | new (ADR-033; next to R-C7) |
| TS-M3 | **The R-C16 investigation guards are untested,** and "the worktree is left unchanged" is neither asserted nor checked. The one-at-a-time, live-session and reserved-merge guards each survive. No test or daemon check compares HEAD or status around an investigation. | `work-cycle-service.ts:562,572-580`; `services/investigation.ts:120-135` | AS F-6, RC F-7 | Mutants WC1, WC2 and WC3 survive (project). Grep: no Git assertion in `server-execution-investigation.test.ts`. | **R-C16** |
| TS-M4 | **Nothing tests that the Codex agent environment excludes the daemon's own variables.** Every live run uses Codex. | `packages/agents/src/codex/session.ts:19-30` | RC F-2 | Mutant CX (spreading `process.env` in) survives (project) | **R-G5** |
| TS-M5 | **The record-guard and immutability layer is unproven.** The daemon's fail-closed write guard is never shown refusing a record. Deleting the schema-33 receipt triggers passes everything. Only migrations 0001–0004 have pinned checksums. | `apps/server/src/persisted-records.ts:162-165`; `migrations/0033-run-check-receipts.sql:11-12`; `migrations.test.ts:44-80` | RC F-4, F-5 | Mutants GUARD and TRIG survive (project). Grep: no 64-hex literal outside the 0002–0004 tests. | **R-H3**, **R-G4** |
| TS-M6 | **Protected merge destinations are tested only for the literal `main`.** Dropping the repository's default branch or a finalization target from the protected set passes. | `services/branch-service.ts:741`, `:759` | RC F-6 | Mutants BRD and BRF survive (project) | new (ADR-033) |
| TS-M7 | **Three step-outcome branches are untested:** a retry while the cycle owns an integration resolution; clipped output under a suspected outage; `clearActiveReview` on remediate. | `services/step-outcome.ts:266,374,783` | AS F-7 | Mutants SO2, SO4 and SO20 survive (project) | **R-B2**, **R-C11** |
| TS-M8 | **A failed answer submit clearing the operator's draft would go unnoticed.** This is the R-C16 16b data-loss class, which happened twice in review. Today only success clears the draft; nothing pins that. | `decisions/cycle/CycleDecisions.tsx:39-53` | RC F-3 | Mutant CD (`onChanged` in `finally`) survives (web, 446 tests) | **R-C16** |
| TS-M9 | **`replaceEqualDeep` keeps a removed key.** A dropped optional field (`workflow.activeReview`, `cycle.investigation`) is reused, stale. | `apps/web/src/lib/query-store.ts:322` | AS F-3 (narrowed) | Mutant QS6 survives (web); QS5 is caught | **R-D4** |
| TS-M10 | **The scheduler's one-unmerged-worktree-per-item rule is untested.** It is masked by other rules in every fixture. | `services/roadmap-service.ts:3401-3416` | AS F-5 (narrowed) | Mutant RM14 survives (project); RM2 and RM13 are caught | new (LIVE-06/16 lineage) |
| TS-M11 | **Every source-scan guard is pattern-based, and two are vacuous.** The links guard and the decision-boundary import rule pass with their detector disabled. `check:scope` passes a static `child_process` import planted under `apps/server/src/dist/` (which tsc compiles), a template-literal `import()`, and `switch (x.reason)`. | `apps/web/src/links.test.ts:80`; `decisions/boundary.test.ts:153`; `scripts/check-forbidden-scope.mjs:92-97,135,231-265` | GR F-4–F-7 | Mutants LINKS and BOUND survive. A `check:scope` probe in a throwaway worktree printed "passed", while a plain-import control was caught. No live violations found (GR grep). | **R-I4**, **R-E1**, **R-A6**, **R-A3** |
| TS-M12 | **The replay gate is a person reading output, and it sees less than it is credited with.** `replays.sh` is unversioned, changes into the main checkout, and ignores exit codes (`set -u`, `tail -2`). The scheduler replay records the intercepted command's name only, never its arguments. It never runs `prepare()`. The 14 goldens hold 2 starts, 1 recover and 0 advances. | `~/.cache/ct-p2-tmp/replays.sh`; `scheduler-replay.ts:122-136,178` | GR F-2, F-3 (F-8 related) | Script and code read (`issued ??= { command, decision }`). The golden counts are GR's. | **R-I10** |
| TS-M13 | **Suite speed: one file is the critical path.** `server-execution-scope-recovery` took 195 s of a 225–270 s parallel node run in this pass. Every test daemon also migrates a fresh database (350–600 ms, against 12–19 ms to reopen), and controller passes respawn the same Git reads. | `server-execution-scope-recovery.test.ts:50`; `apps/server/src/test-support.ts:63-76`; `packages/git/src/operations.ts:568,978` | ARCH F2, F3, F5; LF F5, F6 | Per-file times from this pass's BRF run JSON. Code read (fresh `openDaemonStorage` per context). Git counts are LF and ARCH shims. | **R-I2** (rebalancing); **R-D5** (git-fact caching) / **R-B5** |
| TS-M14 | **The two fixture stacks have drifted, and test teardown skips production's `closeAll`.** `stepController` never ticks the roadmap scheduler or notifications. `designDone` is a string in one file and an object in the other. Test cleanup never calls `checkRequestService.closeAll()`, so a check can write logs into a deleted daemon directory. | `cycle-test-support.ts:412-420,223`; `execution-test-support.ts:725`; `test-support.ts:156-170`; `composition.ts:494` | ARCH F7, F8c | Code read; all three confirmed | **R-I4** (move test support out of `src`); **R-I5** |
| TS-M15 | **Smaller e2e and fixture weaknesses.** The default 5 s `expect` follows commands whose latency has no bound under load. The walkthrough rehearsal checks only "no Loading… text" for 48 of 66 phone captures, with no `pageerror` listener and no app error boundary. A failing `expect` inside `backend.onLaunch` shows up only as a generic `waitFor` timeout. | `playwright.config.ts` (no `expect.timeout`); `e2e/walkthrough.spec.ts:150-161,207-210`; `execution-test-support.ts:647` | E2E F5, F6; AS F-9 | Code read; all confirmed | **R-I5**, **R-I9** |

### LOW and NIT (not re-verified; see the source reports)

- **LF:** F4 tests whose progress is real time (sleeping checks, a `< 3000 ms` drain assertion; code-confirmed); F7–F11.
- **ARCH:** F8 a/b/d/e (TMPDIR leaks), F9 (`process.env` mutation), F10 (the Unix socket path limit breaks the instance lock when `TMPDIR` is long), F11–F14.
- **AS:** F-8 (QS7, RM5, RM12, CT1, TG2, AU4, WC9, MG17).
- **RC:** F-8–F-17 (worktree-removal guards, the decision-worktree guard, the delivery-log savepoint, which contradicts the register's "fails without its fix", reminder-hold wiring, the merge-time role recheck, spool bounds, the pre-migration snapshot call site, the clean-stop check, hidden roots, presence calls).
- **GR:** F-8–F-13.
- **E2E:** F7–F11.
- **New from this pass (LOW):** `agent-tree.test.ts` ("removes a tree deeper than a path can name…", "holds a bounded number of descriptors…") fails with `STACK_TRACE_ERROR` in about half of the parallel node runs and passes serially. It is a fourth load-sensitive file not named by any reviewer.

## Checked and found sound (aggregated)

- **Read-only launches** are caught at all three layers: the daemon's `readOnly`, Claude's tools and the Codex sandbox (AS ARS1–3, RC).
- **The route authorization sweep:** default-deny at registration, `preParsing`, CSRF, roles and installation ownership (AS AU1–3, AU5, AU7).
- **Merge-gate core:** superseding, live run, failed verdict, plan promotion needing final approval, exact-commit promotion, scoped review at merge, protected `main` for automatic merges, check adoption at merge (AS MG1–3, 5, 9, 11, 13–15; BR1–4).
- **The step-outcome decision table:** 16 of 20 mutants caught (AS).
- **R-C16:** lineage pinned in storage SQL, and the investigation lifecycle (AS).
- **Scheduler:** in-flight limit, exclusion groups, merge policy, holds, predecessors, waits and grants (AS). This pass also found the capacity off-by-one and the recovery-round bound covered (RM2, RM13).
- **Query-store concurrency core;** the page and panel invalidation tables; most of the roadmap invalidations, through page-level tests.
- **Spec isolation:** one workspace per spec, no cross-spec bleed in 12+ full e2e runs, ports free, no leaked e2e directories, no retries hiding flakes (E2E).
- **The stepping seam itself is deterministic:** 700 of 717 waits took identical step counts at very different loads (LF).
- **Teardown discipline,** fake timers restored, no `process.chdir`, the daemon's Git environment scrubbed (ARCH).
- **Each replay mode copies its snapshot before opening it;** the documented snapshot hashes match; the comparator catches real decision changes (GR).
- **No live production code** matches any shape the guards miss (GR grep).

## Proposed order of work (keyed to register items)

The order is by payoff for trust in the gate first, then the data-safety and authority gaps, then speed.

1. **R-I2 (reopen): make the unit gate deterministic.** It is a precondition for trusting anything else, because every gate today re-runs 60–260 tests serially and normalizes flakes.
   - Covers TS-H1, TS-H2, LF F4 and TS-M15's `onLaunch` part.
   - Step-budget `waitFor` (fail after N steps, plus a large hang guard that names the label). One scalable test timeout instead of about 160 per-test numbers.
   - Rewrite the four-checks test so it awaits its own release, or use smaller limits.
   - Gate sleeping checks on a FIFO.
   - Collect `onLaunch` errors and assert them after the test.
   - Done-when: three consecutive default parallel `pnpm test` runs green at ambient load.
2. **New, small: tmpfs data directories for test daemons.** Covers TS-H8 and ARCH F4.
   - Operator decision: e2e and vitest daemon data directories under `$XDG_RUNTIME_DIR` rather than TMPDIR. This keeps the "TMPDIR on disk" rule for everything else.
   - Production pragmas stay unchanged.
3. **R-G5 follow-up: the agent temporary root.** Covers TS-H3, a production data-safety defect.
   - Sweep only names matching `^[0-9a-f]{12}$` (or require a marker).
   - Refuse a root that overlaps the data directory's `state/`, the database directory, `$HOME`, `/tmp` or `/`.
   - Document the variable.
   - Tests: a non-run entry survives restart; the config refusals.
   - Also covers TS-M4: a Codex environment exclusion test mirroring Claude's.
4. **R-D4 (still open): finish the increment and close its e2e items.** Covers TS-H4, TS-H5, TS-M1 and TS-M9.
   - Seed fix: invalidate the workspace shell keys once when the stream opens, or have reads return `asOfSequence`.
   - Decision links resolved by subject.
   - A `commandThenGoto` helper at the 9 sites.
   - A test for `replaceEqualDeep` with a removed key.
   - Optionally a suite-wide `expect.timeout` (TS-M15).
5. **New (ADR-033): merge and promotion gate tests.** Covers TS-H7, TS-M2 and TS-M6.
   - Security-required merge refused when the receipt is missing or stale, including after a stop.
   - Promotion refused on an unmet obligation or a failed final check.
   - A fixture repository on `trunk`, plus a finalization target, for automatic merges.
6. **R-H3 / R-G4: record-guard and immutability tests.** Covers TS-M5.
   - The daemon guard refuses an out-of-contract record and rolls the transaction back.
   - Raw UPDATE and DELETE on `run_check_receipts` fail.
   - An append-only golden table of every deployed migration's checksum.
7. **R-C16: investigation guard and outcome tests.** Covers TS-M3 and TS-M8.
   - Each `startInvestigation` refusal, asserted by message.
   - Compare HEAD and clean status at read-back (a daemon check plus a test).
   - A rejected submit keeps the draft for every cycle command.
8. **R-B2 / R-C11 and the scheduler: step-outcome rows and the one-worktree-per-item test.** Covers TS-M7 and TS-M10. Small table additions.
9. **R-I10: a versioned replay gate.** Covers TS-H6 (replay part) and TS-M12.
   - `scripts/replays.mjs` with a manifest. It runs `tsc -b`, or resolves packages to source, and exits non-zero on any unexpected change.
   - Record command arguments.
   - Compare status-list headers and attention as a multiset.
   - Before the next controller change, which is R-D5.
10. **R-D5 / R-B5 and R-I2 rebalancing: speed.** Covers TS-M13.
    - Split `scope-recovery` and `cycles`.
    - A migrated template database per worker.
    - A pass-scoped Git read memo; R-D5's git-fact caching is already next in the program.
    - Cap integration workers in a separate vitest project.
11. **R-I4: structural boundaries.** Covers TS-H6 (`local-check` part), TS-M11 and TS-M14.
    - Compiler-derived file sets and AST imports for `check:scope`.
    - Branded routes and links in place of the regex guards.
    - Positive self-tests for every guard.
    - Test support moved out of `src` into one shared stack, with `createDaemon` shared with `composition.ts` so teardown matches production.
12. **R-I5 / R-I9: e2e hygiene.** Covers the rest of TS-M15: walkthrough landmarks per capture, a `pageerror` listener, no 400 ms sleeps in rehearse mode.

## Operator decisions this raised

- **Test data directories:** use `$XDG_RUNTIME_DIR` (tmpfs) for test daemons' data directories, while TMPDIR stays on disk (TS-H8).
- **Reopening R-I2:** whether to reopen it, or record TS-H1 and TS-H2 as a new item, with the "three green default runs" done-when.
- **TS-H3's scope:** whether it is a P2 blocker fix under program rule 7 (data loss), or a normal P2 item. It needs an operator to misconfigure an undocumented variable, but the damage is the live database.
- **New register items:** whether TS-H7, TS-M2, TS-M6 and TS-M10 go under one new "ADR-033 gate tests" item.

## Operator decisions (2026-10-02)

1. **Test data directories:** test daemons (vitest and e2e) keep their data directories on tmpfs (`$XDG_RUNTIME_DIR`), and TMPDIR stays on disk for everything else (TS-H8). Production pragmas are unchanged.
2. **R-I2 is reopened** to remediate TS-H1 and TS-H2, together with the related load findings (LF F4, AS F-9) and decision 1.
3. **TS-H3 is a rule-7 blocker, but not urgent:** it has not been material. It will be fixed on `main` in a review pass after P2 merges, not on the P2 branch.
4. **TS-H7, TS-M2, TS-M6 and TS-M10 go into that review pass**, not a new register item.

