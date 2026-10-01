# LIVE — Findings from running the live roadmap, 2026-09-25 to 2026-09-27

Source: the operator's live cross-project roadmap (`b81d5f92`, map definition `0ebcb7cf`,
binding revision 4), run on `main` at a4fabdf and later heads while P2 was developed on
`remediation/p2`. The evidence is read-only queries of the live database
(`/mnt/workhorse/craftingtable/state`), run logs under `/mnt/workhorse/craftingtable/runs`, and
the code at the named commits. Nothing was written to the live database.

Unlike the other reports, this one was written after the review. It records blockers the
operator hit while using the product, so they can be tested and prioritized like the other
findings. On 2026-09-27 the operator paused WI/EXO delivery so P2 could finish. From then on,
live stops are recorded here and in the replay corpus instead of being patched ([R-I10](../register.md#r-i10)).

## Summary

- **One pattern runs through all eight.** Two parts of the system answered "can this move
  on, and who acts?" differently, and the operator saw the gap as a stop that either repeated
  on every attempt or had no working control:
  - the browser form and the server gate (LIVE-01);
  - the workflow and the merge gate (LIVE-02, LIVE-04);
  - an unowned repair and the roadmap that should own it (LIVE-05);
  - the controller's readiness check and the checkpoint reviewer (LIVE-07).

  This is the register's thesis (10 or more places decide "needs the operator"), seen live.
- **Five fixes were made on `main` during the run**, each with a failing-first test:
  - ca7b954, 1727f3b, a2bb20a and 616f323;
  - 18f0bb8, which is R-C5's increment 2.

  They were merged into the P2 line in f471830. None had the independent review that P2
  items get ([R-I11](../register.md#r-i11)).
- **Three are open:**
  - LIVE-06: automatic recovery did not start and gave no reason.
  - LIVE-07: a checkpoint review repeats on every resume.
  - LIVE-08: the operator cannot see what is running and what is blocked.

  They are the items that motivate reordering P2.

## Findings

### LIVE-01: Continue with guidance was refused after a failed step, though the stop asked for guidance
- Severity: high
- Category: operator dead end
- Status: CONFIRMED; fixed in ca7b954. Reviewed 2026-09-27 ([R-I11](../register.md#r-i11)): guidance given on a drain-interrupted step now reaches the resumed session (dab7c24).
- Test: `server-execution-cycle-recovery.test.ts`, "continues a nonretryable service stop with the guidance its stop asks for" (ca7b954), and `restart-drain.test.ts`, "gives a resumed session the guidance the operator added while its step was interrupted" (dab7c24).
- Evidence:
  - WI-02/domain slice cycle `72717cd3`, step `remediate`. Run `1d3cabf6` failed within 30 s on
    the Codex 401 outage (R-C11) and stopped as `service-failure-not-retryable`. That stop's
    message says to "provide any required guidance before resuming".
  - The guided-continuation gate in `WorkCycleService.control` accepted only a *finished*
    current run. It refused with "Guided continuation requires answers or guidance and the
    finished current implementation or review."
  - The cycle still held the earlier review's workflow question, so `CyclePanel` showed only
    the guidance form and hid plain Resume. Stop was the only way out.
- Impact: a whole class of stops, failed steps with a pending question, had no working
  control.
- Fix: the gate accepts any ended current run, and a retry of a step that did not finish
  carries forward that step's earlier guidance.

### LIVE-02: A slice cycle no roadmap owned never ran its required security review, and the merge refused forever
- Severity: high
- Category: operator dead end; controller/merge-gate disagreement
- Status: CONFIRMED; fixed in 1727f3b. Reviewed 2026-09-27 ([R-I11](../register.md#r-i11)): by operator decision the operator's authority is kept to cycles no roadmap owns, an unreadable delegation fails closed, and ADR-063 and `docs/security.md` record the rule (2184f9a).
- Test: `server-execution-reviews.test.ts`, "runs a source-required security review on operator authority when no roadmap owns the slice cycle" (1727f3b), and the two roadmap-owned cases added in 2184f9a.
- Evidence:
  - EXO-04/domain repair cycle `b0de849a` (`owner: null`) reached `merge-approval` with
    `workflow.securityRequired: true` and no security receipt.
  - `advanceWorkflow` scheduled the security review only through `workflowDelegation`, which
    exists only for cross-project roadmap attempts.
  - The merge gate (`execution-service.ts`) still required a current receipt: "The required
    separate security review must pass on this exact candidate and integration target before
    merge."
  - While testing the fix, a second defect turned up. A security review that finished but
    whose receipt could not be current (unavailable runtime inputs) was started again at once,
    without bound, on roadmap-owned cycles too.
- Fix: without a delegating roadmap, the operator who started the cycle authorizes the
  source-required security review. The operator chose this on 2026-09-26. A just-finished,
  still-not-current security review now stops as `workflow-obligation`.

### LIVE-03: Concurrent ct-act runs of one workflow destroyed each other's containers
- Severity: high
- Category: verification reliability
- Status: CONFIRMED; fixed in a2bb20a. Reviewed 2026-09-27 ([R-I11](../register.md#r-i11)): an interrupted wait no longer leaves the run's lease behind, and a stale lock is reclaimed by one contender only (ccd618c).
- Test: `packages/agents/src/local-check.test.ts`, "runs one act invocation per workflow at a time across runs on a Docker host" (a2bb20a), and the interrupted-wait and stale-lock cases (ccd618c).
- Evidence:
  - act 0.2.89 names job containers and volumes after the workflow `name` and job only, for
    example `act-EXO-V3-development-contract-contract-93e0…-env`. It has no per-run prefix
    option.
  - On 2026-09-26 between 07:20 and 07:49 UTC, five EXO runs (`9f9ab3c3`, `53dd91ed`,
    `0cd4e7bb`, `74294bd7`, `b3ad55d0`) ran `exo-v3-contract.yml`, and their runs overlapped.
    The EXO-03/domain verification lost both contract attempts: exit 137, "RWLayer … is
    unexpectedly nil", "volume is in use".
  - The `act-active` lease serialized ct-act only within one run.
  - The reviewer then asked the operator whether the controller would serialize contract CI.
    That was an operator question caused by the controller's own resource defect.
- Fix: a host-wide lock keyed by the workflow name, held until the run's labelled containers
  are removed. Owners that died are reclaimed.
- Note: this is a shared resource that the phase-resource model (`resources_by_phase`) does
  not cover. [R-G4](../register.md#r-g4)'s daemon-owned receipts should own CI execution and its locks.

### LIVE-04: Workflow acceptance and the merge gate disagreed about merged-candidate checkpoint evidence
- Severity: high
- Category: two evaluators of one requirement ([R-F1](../register.md#r-f1))
- Status: CONFIRMED; fixed in 616f323. Reviewed 2026-09-27 ([R-I11](../register.md#r-i11)): no defects; an index for the check is left for R-D.
- Test: `server-execution-reviews.test.ts`, "delegated $kind checkpoint requires complete attestation", `semantic_review` case (616f323).
- Evidence:
  - `EXO-WI-TIME-REVIEW` (a stack-owned `semantic_review`, so it records no tested commits) was
    accepted from EXO-04/domain's first merge.
  - ADR-060 lets such evidence outlive the merge only while the integration tree equals the
    reviewed tree. Only the merge command's live Git comparison enforced that
    (`candidateFreshness`).
  - The durable check behind `acceptedEvidence` compared tested commits only. So after later
    merges into `exo-v3`, the workflow, the projections and `merge-requirements` still counted
    the checkpoint as accepted, never scheduled a fresh checkpoint review, and offered merge
    approval. The merge then refused with "Integration changed after this candidate was
    merged. Prepare fresh checkpoint evidence."
- Fix: `candidateCheckpointIssues` reports a later controller merge into the same integration
  branch (`worktrees.mergedIntoAfter`).
- On live data this changed exactly one record's acceptance.

### LIVE-05: Delegate source fixes created repairs outside the roadmap that owned the review
- Severity: high
- Category: ownership ([R-B3](../register.md#r-b3)); HIST-04 repeated
- Status: CONFIRMED; fixed in 18f0bb8 ([R-C5](../register.md#r-c5) increment 2). Reviewed 2026-09-27 ([R-I11](../register.md#r-i11)); five follow-up fixes on R-C5 (49686f6, c5d4078, 76bf280, 31afe57, 9eb327b).
- Test: `server-execution-scope-recovery.test.ts`, "carries an operator repair round through with automatic recovery off" (requested, adopted while paused, adopted while running), and `server-execution-scope-repair-rounds.test.ts` (R-I11 fixes).
- Evidence: EXO-04/domain's repair (`b0de849a`) came from the verification cycle `b29ec411`,
  which roadmap `b81d5f92` owns. Because the repair had no owner:
  - it had no reviewer delegation, which caused LIVE-02 and left the checkpoint review of
    LIVE-04 impossible;
  - it escaped the roadmap's holds and merge policy;
  - the roadmap never re-ran the verification and parent review afterwards.

  HIST-04 found 13 of EXO-01's 16 repairs had the same shape.
- Fix: on a live roadmap's review, the command reserves an operator-requested recovery round
  (`recovery.requestedByUserId`). Earlier unowned repairs are adopted on the next pass.

### LIVE-06: Automatic recovery did not start a round for EXO-02/domain, and nothing said why
- Severity: high
- Category: silent controller wait (the visibility gap of LIVE-08)
- Status: CONFIRMED; fixed 2026-09-27 ([R-C12](../register.md#r-c12)). Cause, found with the scheduler replay: a circular wait. The owning-slice round was `capacity-blocked`, because EXO-04/domain's repair, which waits for EXO-02/domain to be verified, and EXO-18 held both repository slots. `advanceScopeRecovery` returned with nothing recorded. Now every evaluation records a typed wait on the roadmap (`entryWaits`), and a round may borrow one slot from a holder that waits on its own slice.
- Replay case: the 2026-09-27 scheduler golden records `exo/EXO-02/domain` verification as `none`: evaluated, no round, nothing recorded ([R-I10](../register.md#r-i10)).
- Evidence:
  - The operator's WI pin refresh queued a fresh EXO-02/domain verification. Cycle `556d0bca`,
    run `ca42c1d2`, started at 2026-09-27 00:45 UTC. At 01:01 it found a new major defect,
    `EXO02.F-003` (a semantic retry that bypasses the durable transition-ID binding), and
    stopped as `scope-review-recovery`.
  - At 03:52 the roadmap was `running`, with scope recovery enabled (3 rounds for each parent),
    no entry holds and no open round for EXO-02. The only open round was EXO-04's operator
    round. No EXO-02 round had started, and no roadmap or entry attention said why.
  - EXO-04's repair waited on that result ("Slice exo/EXO-02/domain must be verified").
- Impact: the live roadmap looked idle with no explanation. The operator could not tell a
  real wait from a stuck scheduler without database queries.
- Candidate causes to check first:
  - `scopeRecoveryDecision` returned a `reason` or `waiting` that the parallel scheduler
    swallowed (`PhaseGateError.waiting`, `SupersededRoadmapOperation`);
  - the item was deferred (`deferredEntries`);
  - `advanceEntry` never reached the verification entry.

### LIVE-07: A delegated checkpoint review repeats the same failed attestation on every resume
- Severity: medium
- Category: controller-readiness/reviewer disagreement; a plain resume reproduces the stop ([R-A7](../register.md#r-a7))
- Status: CONFIRMED; fixed 2026-09-27 ([R-C13](../register.md#r-c13)). The hypothesis was refuted on the snapshot: readiness was right, because WI-09/domain was verified at 00:53:48 with current receipts. The reviewer's evidence ledger omitted the checkpoint's own prerequisites (the WI-09/WI-10 receipts) and its coverage bindings. Readiness and the ledger now come from one evaluation. A failed attestation stops as `checkpoint-attestation-failed`, and Resume is refused until its inputs change.
- Replay case: the 2026-09-27 scheduler golden records WI-04/domain's WI-WORKER-G1 as ready, with `receipt:wi/WI-09/domain`, `receipt:wi/WI-10/domain` and coverage `WP-001`…`WP-008` missing from its evidence packet ([R-I10](../register.md#r-i10)).
- Evidence:
  - WI-04/domain slice cycle `2f1ab211` waited at 2026-09-26 07:17 with "WI-WORKER-G1: Slice
    wi/WI-09/domain must be verified" (`controller-wait`).
  - At 2026-09-27 00:53 the controller judged the checkpoint ready and started the
    WI-WORKER-G1 review. An integration conflict was then resolved automatically.
  - The review ended "A complete, passing independent checkpoint attestation is required for
    every exact requirement and case" (01:23). The operator resumed at 02:09 and 03:44, and
    both reviews failed the same way (02:22, 03:57).
  - The reviewer's summary says all eight definition cases passed, but controller coverage
    bindings and the WI-09/WI-10 producing-slice receipts are missing. WI-09/domain was still
    at design.
- Hypothesis: `workflowContext` counts the checkpoint as ready (`supported && assigned &&
  !pending.length`) because `prerequisiteIssues` does not include the producing-slice
  receipts that the attestation needs. The pin refresh may have changed what `pending`
  reports. Resume is offered although it can only reproduce the stop.

### LIVE-08: The operator cannot see what is supposed to run and what blocks it
- Severity: critical
- Category: visibility (pain point 2; UI-06, HIST-19, DATA-12)
- Status: CONFIRMED; addressed 2026-09-27 by the roadmap status list ([R-E3a](../register.md#r-e3)), which explains each of the entries below from the daemon's records, with no database query.
- Replay case: the 2026-09-27 scheduler golden's five `none` entries (EXO-02, EXO-03 and EXO-04 verification, WI-04/domain, EXO-18) are the entries the operator could not explain ([R-I10](../register.md#r-i10)).
- Evidence: on 2026-09-27 the operator refreshed the WI pin, generated plan evidence,
  resumed scheduling and unblocked EXO-03 and EXO-04. After that, "nothing seems to be going"
  except WI-04. The actual state, which took several database queries to establish:
  - one real finding (LIVE-06's EXO02.F-003) with EXO-04 behind it;
  - EXO-03's verification paused, and EXO-04's verification stopped since the 401 incident;
  - EXO-18 waiting on the operator's EXO-ADR-022 approval;
  - WI-04 in LIVE-07's loop;
  - a recovery that silently did not start.

  None of this was visible from one place in the app.
- Impact: every stop needed an agent session to diagnose, and the operator could not judge
  what autonomy was already handling. It is the reason the operator paused delivery work
  until P2 is done.

## After the P2 deploy (2026-09-28)

The operator fast-forwarded `main` to the P2 line (ac08291) and deployed it. With the roadmap
paused the inbox held 7 items, matching the 7 blocked entries in the agenda. Once scheduling
resumed, the deploy restarted stalled EXO and WI work, and the inbox grew to 55 items. The
operator paused the roadmap again; the evidence below is a read-only `.backup` taken at
17:25 UTC (`replay/2026-09-28/`), replayed with [R-I10](../register.md#r-i10)'s scheduler replay.
The pattern is the same as before: the attention model now makes every stop visible, but
it did not decide whether a stop needs the operator *now*, or whether the operator can act on it.

### LIVE-09: Decision preparations kept asking after their decisions were accepted
- Severity: medium
- Category: stale attention (R-A4 projection)
- Status: CONFIRMED; fixed 2026-09-28: a preparation's questions need nobody once its decision is accepted in full. ([R-C14](../register.md#r-c14))
- Replay case: the 2026-09-28 scheduler replay's `attention` lists `decision-preparation-questions` for runs 81b39a78 (WI-ADR-008) and ad8db1c6 (WI-ADR-010).
- Evidence: both decisions were accepted on 2026-09-24 (full coverage, submissions 8560d4ab and 751fa25b). Their preparation runs had ended with open questions. The projector raises the item from the preparation's worktree while it is active and its design run left questions (`attention-projector.ts`, `worktreeItems`), and never asks whether the decision was accepted since.
- Impact: two "Needs attention" items for decisions that are settled, which also read as if the decisions were not accepted.

### LIVE-10: Every open shared decision in the map is an inbox item, whether or not work needs it now
- Severity: high
- Category: attention relevance; notification noise
- Status: CONFIRMED; fixed 2026-09-28: a checkpoint is asked for only when an entry waits on it and on nothing but the operator and checkpoints, or when the roadmap's completion waits on it. Per the review fix (fd9c7d6), it also asks for a decision that a slice's delegated checkpoint review waits on. The inbox, the entry's state and the status list share this one rule. ([R-C14](../register.md#r-c14))
- Replay case: the 2026-09-28 scheduler replay projects 35 `architecture-decision` items for the paused roadmap.
- Evidence: the roadmap pass (`RoadmapService.attentionItems`) raises an item for every included, unsatisfied checkpoint whose own prerequisites are met, with "blocks" counting every map milestone downstream (15 to 185). None asks whether any roadmap entry is waiting on it now. On the snapshot, every one of the 50 checkpoint items blocks only entries that also wait on other, unfinished work: an unmerged slice, an unaccepted predecessor or parent, or an unqualified resource. No entry has an operator decision as its only blocker.
- Impact: 35 of the 55 items were decisions that can be answered, but need not be answered yet. They would also page once notifications are on, and they bury the few items that do hold work up.

### LIVE-11: Checkpoint-evidence items offer the operator nothing to do
- Severity: high
- Category: attention ownership (two evaluators disagree)
- Status: CONFIRMED; fixed 2026-09-28: evidence a slice's own review produces no longer reaches the operator. Evidence only the operator supplies is still asked for when work waits on it (review fix fd9c7d6), and each checkpoint item opens at its form. ([R-C14](../register.md#r-c14))
- Replay case: the 2026-09-28 scheduler replay projects 15 `checkpoint-evidence` items.
- Evidence: the pass raises operator items for non-decision checkpoints: contract, profile, semantic review, release. The phase blocker table owns the same checkpoints' evidence as the controller's (`checkpoint-evidence: { owner: 'controller' }` in `PHASE_BLOCKERS`). Their evidence comes from delegated checkpoint reviews that a slice cycle runs itself, or from verification the operator sets up separately (`verification-setup` items). An item opened from the inbox leads to the roadmap page with no form for it.
- Impact: 15 items the operator cannot act on, which teach that the inbox is not to be trusted.

### LIVE-12: WI-04's checkpoint review is still missing inputs: the bodies of the decisions its checkpoint requires
- Severity: high
- Category: controller-readiness/reviewer disagreement ([R-C13](../register.md#r-c13) one level deeper)
- Status: CONFIRMED; fixed 2026-09-28 ([R-C15](../register.md#r-c15)): each checkpoint's section of the ledger carries the decisions that met its prerequisites.
- Replay case: the 2026-09-28 scheduler replay's checkpoint readiness for WI-04/domain reports WI-WORKER-G1 ready with `decision:WI-ADR-016`, `decision:WI-ADR-008` and `decision:WI-ADR-010` missing from its packet.
- Evidence:
  - After the deploy, the operator's resume at 16:37 UTC ran the WI-WORKER-G1 review (run 328ce485). R-C13's fix worked: "This export supplies the previously missing coverage and producer receipts".
  - It failed the attestation again, now because "approved ADR-008/010 clauses are absent". It also left a minor finding about the ADR documentation, so the step went to remediation (run 11d7c0e9). That cleared the active checkpoint review, and a plain review followed (e09e5f75). The checkpoint review would then be scheduled again with the same packet.
  - All three decisions are accepted with full decision records. The packet's `architectureDecisions` (`scopeArchitectureDecisions`) holds only decisions named by the slice's own requirements. WI-WORKER-G1's own requirements (WI-ADR-016, 008 and 010) reach the ledger only as submission IDs in R-C13's checkpoint section.
- Impact: the reviewer cannot attest the checkpoint's "WI-ADR-016 and referenced authorization/evidence ADR clauses reviewed" criterion, so every round repeats the failure, and the checkpoints downstream of WI-WORKER-G1 wait.

### LIVE-13: One owning-slice question appears twice in the inbox
- Severity: low
- Category: duplicate attention
- Status: CONFIRMED; fixed 2026-09-28: an entry hold defers to the round that carries it. ([R-C14](../register.md#r-c14))
- Replay case: the 2026-09-28 scheduler replay's `attention` lists both `work-item-questions` on cycle de49d2f6 and `entry-preparation-failed` on the EXO-02/domain verification entry.
- Evidence: EXO-02/domain's recovery round started after the deploy (R-C12). Its repair (de49d2f6) asked a genuine work-item question. The scheduler holds the source verification entry with "Owning-slice recovery needs your input", and the entry's hold item is deduplicated only against the entry's own cycle, not the round's repair cycle.
- Impact: two items for one question; answering the question clears one, and the other follows on the next pass.

### LIVE-14: A stray `.codex` file in the primary checkout failed a Codex review in one second
- Severity: medium
- Category: agent configuration isolation ([R-G5](../register.md#r-g5))
- Status: CONFIRMED 2026-09-28 (after the c547ede deploy); not fixed. The stop had a working exit: the operator resumed 16 minutes later and the review ran.
- Replay case: none. The cause was a file outside the database. The 2026-09-28c snapshot (`$XDG_DATA_HOME/craftingtable-review/replay/2026-09-28c/`) holds the cycle (556d0bca) and the run's journal.
- Evidence:
  - Cycle 556d0bca (EXO-02/domain) resumed its review at 21:51:55 UTC. Codex run 1d389c9c exited at 21:52:08 with "failed to load configuration: Failed to read project hooks config file /home/keith/src/exoskeleton/.codex/config.toml: Not a directory".
  - The cycle stopped as `step-incomplete`.
  - The run's working directory was its managed worktree, but Codex resolved the project configuration in the primary checkout. There, an untracked `.codex` (gitignored since April) was a file at the time; it is gone now.
- Impact: an operator stop caused by the operator's own working checkout. It shows that Codex reads project configuration, including project hooks, from the repository's primary checkout rather than the worktree the run owns.
- Note: since R-G5 increment 3, runs start Codex with `--disable hooks`; whether that also skips this file read is not verified. The wider point stays: project configuration comes from a checkout the run does not own.

### LIVE-15: A checkpoint review whose upstream pin moved stopped as `controller-error`
- Severity: medium
- Category: typed stops (rule 4); dependency refresh ([ADR-058](../../../decisions/ADR-058-reviewed-dependency-refresh.md), [R-C4](../register.md#r-c4))
- Status: CONFIRMED 2026-09-28 (after the c547ede deploy). FIXED 2026-09-28 by operator decision (typed stop, refresh action), on `remediation/p2`, deployed in fccce06: see [R-C4](../register.md#r-c4). It had a working exit: the operator resumed at 00:18 UTC and the review ran again. **The fix missed this stop's own path** (2026-09-29): the same cycle stopped the same way after the fccce06 deploy, because the stop comes from the delegated checkpoint's acceptance, not the tree freshness check the fix typed. See [LIVE-21](#live-21-live-15s-typed-stop-misses-a-delegated-checkpoints-acceptance-so-exo-04s-review-ran-into-the-same-untyped-stop-after-the-fix).
- Replay case: none captured, because the cycle was resumed before the 2026-09-28c snapshot. The path is in the code: `WorkCycleService.pass` (`work-cycle-service.ts`, the `controller-error` fallback) turns any `ExecutionRequestError` raised while advancing a cycle into `controller-error`, with its message as the reason. Here the message was the pin freshness issue from `RuntimeEvidenceService.pinStatus`.
- Evidence: cycle b0de849a (EXO-04 checkpoint review EXO-WI-TIME-REVIEW, run 47fb8caf) went to `needs-attention` at 00:11:13 UTC. The code was `controller-error`, owner operator, with the reason "wi integration changed. Preview dependency refresh to review the new pin and affected evidence."
- Impact:
  - A dependency refresh, which ADR-058 already models, reaches the operator as a generic controller error.
  - The status list and inbox cannot tell it from a real fault.
  - The prose asks for a dependency-refresh preview, but resuming only reruns the review.

### LIVE-16: Two finished decision preparations held all of WorldInterface's slice capacity for days
- Severity: high
- Category: scheduling capacity ([R-C3b](../register.md#r-c3))
- Status: CONFIRMED 2026-09-28 from the 2026-09-28c snapshot. FIXED the same day on `remediation/p2`, deployed in fccce06: see [R-C3b](../register.md#r-c3). Its exit was manual only: the worktrees can be removed through the API, but no page lists them.
- **Verified live (2026-09-29 snapshot):** both worktrees were removed on the first pass after the deploy (36c8cef4 at 06:48:52.683 UTC, 5e15984c at 06:48:52.940), and WI-03/integration and WI-04/integration started one second later (06:48:53 and 06:48:54). WI-05/domain and WI-03's parent review followed at 12:09 and 12:30, and WI-03/integration was merged and verified by 12:30.
- Replay case:
  - The 2026-09-28c scheduler replay records six WorldInterface slices whose dependencies are met, each waiting with "Repository has 2 unmerged worktree(s) or reservations; capacity is 2": WI-03/integration, WI-04/integration, WI-05, WI-07, WI-11 and WI-12.
  - The 2026-09-27 replay records the same with a count of 3.
- Evidence:
  - Decision preparations for WI-ADR-008 and WI-ADR-010 ran on 2026-09-24 at 01:06 and 01:26 UTC, and finished in two minutes each.
  - Both decisions were accepted at 01:31 and 01:32.
  - Their worktrees (`ct/decision-c4ec5cd1…`, id 36c8cef4; `ct/decision-d0537fe0…`, id 5e15984c) stayed active. Nothing removes a preparation's worktree, and merging one is refused.
  - A worktree with no execution scope counts toward a repository's slice capacity, so the two held both of WorldInterface's places.
  - The last new WorldInterface slice started on 2026-09-21 (WI-09/domain).
- Impact:
  - No new WorldInterface slice could start while the roadmap ran, for four and a half days.
  - R-C3b's standing preparation grant would have made it permanent, since every automatic preparation would take a place.
  - R-C3b's measurement (design stops per started slice) had nothing to measure.

### LIVE-17: Local CI still collides on the shared Docker host after the LIVE-03 fix
- Severity: high
- Category: local CI isolation ([LIVE-03](#live-03-concurrent-ct-act-runs-of-one-workflow-destroyed-each-others-containers), [R-G4](../register.md#r-g4))
- Status: CONFIRMED 2026-09-28 from the 2026-09-28c snapshot, after the c547ede deploy (which carries a2bb20a and ccd618c). Not fixed. Mechanism unproven. Each failure had an exit (a remediation round re-ran CI), but three rounds of EXO-18/instance-design and its remediation limit went on nothing else.
- Replay case: none. The failures are Docker's, outside the database. The snapshot holds the runs' tool output.
- Evidence (UTC):
  - After the deploy (21:42), contract CI jobs of the EXO-V3 development workflow died with `exitcode '137'` and "RWLayer of container … is unexpectedly nil", or "volume is in use".
  - Runs: EXO-04/domain 4333f842 (21:49, 22:11), 95967bd3 (22:58 to 23:12), a3c6a7f1 (23:14) and dd679429 (23:26); EXO-18/instance-design ee08681f (22:37) and 7c280429 (23:10 to 23:29; at 23:15:44 the job was killed after 4 min 50 s); EXO-02/domain 9e486dae (22:32).
  - The EXO-04 and EXO-18 runs overlap in time on the same workflow. The lock itself was visibly taken: runs waited with "Waiting for run … to finish this workflow's local CI".
  - Review 7c280429 reports "replacement containers labeled for other controller runs".
- Impact:
  - Infrastructure failures surface as major review findings. EXO-18 spent three remediation rounds (2e0dc092, a3585f30, 1fc71781) that only re-ran CI, and stopped at its remediation limit.
  - Inference, unproven: act names containers per workflow and job, so a run that reaches the Docker host while another's containers still exist (a launcher killed while its containers live on, AGT-09, or a path that runs act without the lock) replaces them.
- Note: R-G4 (not deployed) moves the lock into the daemon and runs act there, in its own unit, keyed by Docker host and workflow name, and removes a run's labelled containers when it ends. Whether that closes this must be checked on the first live day after the deploy.
- **Not seen after the R-G4 deploy (2026-09-29 snapshot, 10.5 hours after fccce06).** 99 local CI runs. No receipt exited 137, and neither the daemon journal nor the agents' tool output mentions "RWLayer … unexpectedly nil" or "volume is in use"; the job logs themselves were not read (run logs are out of bounds), and a receipt records only act's exit code. Runs of one workflow overlapped and took turns: EXO-18/instance-design (5305d5d9) and EXO-04/domain (845e1ecf), the pair that collided on 2026-09-28, ran their contract and domain jobs alternately between 06:53 and 07:12, all passing, and WI-03/integration and WI-04/integration (09d016f6, 06c5be91) did the same from 07:23 to 07:37. The 18 failures were `ct-act --help` usage requests (10) and job failures (8). Six are explained: two runs' three jobs failed within three seconds each (dc8d19ff at 10:12, fdcf1efe at 11:10) because the agent's own check script broke, and passed on its rerun. Two are not classified: 06c5be91's integration job (07:14:31) and 811258ce's domain job (07:52:36). Treated as closed by R-G4; reopen if a collision appears.

### LIVE-18: A shared-decision stop names one missing decision, and a plain Resume runs the review chain back into it
- Severity: medium
- Category: typed stops and resume ([R-A7](../register.md#r-a7))
- Status: CONFIRMED 2026-09-28 from the 2026-09-28c snapshot. FIXED 2026-09-29 on `remediation/p2` by operator decision (option B), not deployed: see [R-A7](../register.md#r-a7). Its exit was to approve the decisions.
- Replay case: the 2026-09-28c snapshot, cycle 2c9ead5d (EXO-18/instance-design).
- Evidence:
  - The slice merge-requires four architecture decisions: EXO-ADR-022, 030, 037 and 038. After its security review passed at 2026-09-26 08:39, the cycle stopped as `shared-decision-required` with "Operator approval required for EXO-ADR-022", naming only the first.
  - Nothing was ever submitted for 022, 030 or 038, and 037 is accepted only for EXO-03/domain's clauses.
  - The operator resumed at 2026-09-28 20:59 with 022 still unapproved. The resume was accepted (`resumeRedirect` does not refuse this code) and ran an integration update, two reviews and two security reviews toward the same gate.
  - The stop's push was never delivered, because notifications were turned off on 2026-09-24. Its inbox item appeared only when schema 32 backfilled it on 2026-09-28.
- The operator's report (2026-09-28): opening EXO-ADR-022 showed no prepared recommendation and no way to start an investigation. Checked on the 2026-09-28c snapshot, in-process on a copy:
  - "Shared architecture decisions" builds a card only for a decision that has a submission, or a recommendation from a finished agent report naming it. 022, 030 and 038 have neither, so they have no card. 037 has one.
  - Earlier decisions got recommendations because they gated a slice's start, and its design turn raised them. These gate only EXO-18's merge, so no agent report ever names them.
  - All four can be prepared (`supportsArchitectureDecision`). The dispatch control is the roadmap's collapsed "Prepare architecture decision briefs" section, but neither the stop nor the decisions area links to it. No EXO preparation has ever run, and the standing grant is off.
  - Approving also needs the roadmap paused and no live run on the map.
- Impact:
  - 60 of the slice's 74 hours so far were spent at this gate.
  - After 022, the cycle would stop again for each next decision, one at a time.
  - Resuming spends agent time on reviews that end at the same stop.
- **Seen again after the fccce06 deploy (2026-09-29 snapshot).** The operator resumed the cycle at 06:50:55 UTC with the four decisions still unapproved. Review 5305d5d9 ran for 23 minutes, finished mergeable, and the cycle stopped at 07:13:53 with the same one-decision reason. Two resumes in a row have now ended here: e3dd6f2c (to 00:41) and 5305d5d9. Earlier, the resume after the drain ran 32097783 (mergeable), whose security review then requested changes.
  - The standing preparation grant (set 06:50:33) has since prepared all four: EXO-ADR-022 (run bb2a9b13), 030 (b34881e8), 037 (43dcc82f, recommending a narrow clause for EXO-18/instance-design) and 038 (4b87c8c2). So each now has a card with a recommendation, and none is approved.

### LIVE-19: Resuming after a drain discards a review that finished while the cycle was paused
- Severity: low
- Category: restart and drain ([R-B9](../register.md#r-b9))
- Status: CONFIRMED 2026-09-28 from the 2026-09-28c snapshot. Not fixed.
- Evidence:
  - EXO-18/instance-design's review efd58796 finished mergeable at 21:43:00 UTC. The operator had paused the roadmap and cycle for the deploy drain at 21:38:40.
  - The resume at 21:46:29 started a new review, 32097783, which reached the same result 21.3 minutes later. A new security review followed.
- Impact: repeated agent time after each drain that catches a finishing review.

## After the fccce06 deploy (2026-09-29)

The operator deployed fccce06 at 06:48 UTC; the roadmap came up running. The operator paused it at 06:49:55, set the standing preparation grant at 06:50:33 and resumed at 06:50:55. Automatic preparation briefed 35 decisions by 08:14, the operator approved nine of them in one batch from 16:04 to 17:16 (with the roadmap paused, as approval requires), and three slices started. The evidence below is a read-only `.backup` taken at 17:18 UTC (`replay/2026-09-29/`, SHA-256 `80a94173…`).

### LIVE-20: Automatic recovery holds a parent review whose finding it cannot assign, and nothing says why
- Severity: low
- Category: automatic recovery ([R-C5](../register.md#r-c5)); one reason per stop ([R-C14](../register.md#r-c14))
- Status: CONFIRMED 2026-09-29 from the 2026-09-29 snapshot. FIXED 2026-09-30 on `remediation/p2`, not deployed: the stopped review's item, and so the status list, carries the hold's reason. It always had a working exit: Delegate source fixes on the review's inbox item, where the operator chooses the owning slice. See [R-C5](../register.md#r-c5).
- Replay case: the 2026-09-29 snapshot, entry 1926f0d1 (wi/WI-03, parent acceptance), cycle a1f7972e. The snapshot's roadmap is paused, so the stored scheduler golden records `roadmap-paused`. On a copy with the roadmap set to running, one scheduler pass keeps the stored hold (`existing-hold`, `entry-preparation-failed`, "Finding ownership is ambiguous: more than one slice could own it."), and with the hold removed it derives the same hold again (`new-hold`). Either way the status list gives the entry's wait as the review's `scope-review-recovery` item.
- Evidence:
  - WI-03's parent review 254ad81c (12:30 to 12:46 UTC) requested changes for one major finding, WI03P-F001: an expired pending delivery exhausted 100 AQ retries and then received a second retained signal.
  - WI-03 has two required slices, domain and integration. For a parent-acceptance finding, `scopeRecoveryDecision` (`scope-recovery-policy.ts`) will not choose between them, and holds the entry for the operator.
  - The hold is stored in the roadmap's `entryHolds`, and no attention item carries it, by design: the projector lets a cycle's own item replace the roadmap's hold item for the same entry (`projectUnit`), and `worktreeItems` passes the hold's reason on only for `recovery-not-converging`. The inbox shows the review's own item, "Address findings through the owning slice".
  - Automatic recovery is on (3 rounds per parent). The roadmap ran for 3 h 14 min after the review, until the operator paused it at 16:00, and no round started.
- Impact:
  - The hold is right, because the finding names no slice. But the operator cannot tell that automatic recovery looked and gave up, or why, and the status list names a different reason than the scheduler recorded.
  - A reviewer's finding could name its owning slice, so ambiguity need not reach the operator. That is a brief and report-format question for R-G6 and R-F5, not a controller one.

### LIVE-21: LIVE-15's typed stop misses a delegated checkpoint's acceptance, so EXO-04's review ran into the same untyped stop after the fix
- Severity: medium
- Category: typed stops (rule 4); dependency refresh ([ADR-058](../../../decisions/ADR-058-reviewed-dependency-refresh.md), [R-C4](../register.md#r-c4))
- Status: CONFIRMED 2026-09-29 from the 2026-09-29 snapshot and the code at fccce06. FIXED 2026-09-29 by operator decision, on `remediation/p2`, not deployed: the delegated checkpoint's acceptance now raises the typed `upstream-pin-moved` stop for a moved pin, and Resume is refused while it is stale. See [R-C4](../register.md#r-c4).
- Replay case: the 2026-09-29 snapshot, cycle b0de849a (exo/EXO-04/domain, delegated checkpoint review EXO-WI-TIME-REVIEW), current run 845e1ecf, stopped `controller-error` with "wi integration changed. Preview dependency refresh to review the new pin and affected evidence."
- Evidence:
  - Four mergeable checkpoint reviews of this cycle ended at this stop: 082948fb (2026-09-28, 20:52 to 21:13 UTC), 47fb8caf (to 00:11), 66999724 (00:18 to 00:41) and 845e1ecf (06:51 to 07:14). The operator resumed after each of the first three (21:18, 00:18, 06:50).
  - LIVE-15's fix (4498c01) was committed at 02:16 and deployed in fccce06 at 06:48, so only 845e1ecf ran with it. The fix did not cause the earlier stops; it failed to prevent the next one.
  - The path: after a mergeable delegated checkpoint review, `WorkCycleService` calls `RuntimeEvidenceService.acceptWorkflowCheckpoint`. EXO-WI-TIME-REVIEW is in EXO-04/domain's merge requirements, so it first builds the checkpoint candidate (`checkpointRecovery(…, true)`). The candidate's issues include its evidence freshness, and `if (!candidate || candidate.issues.length) conflict(…)` raises a plain conflict, which the cycle pass turns into `controller-error`. The later submission check in the same function is never reached for a moved pin, so a fix there alone would miss again.
  - LIVE-15's fix types the stop only in `freshnessConflict`, which `assertFreshTree` uses. LIVE-15 had no replay case, and its stop was this same cycle and path, so the fix typed a neighbouring path and missed its own.
  - EXO-WI-TIME-REVIEW is a design-level checkpoint ("do not require completed WI runtime"), yet the wi pin's movement makes its evidence stale.
- Impact:
  - About 90 minutes of review agent time across the four reviews, about 23 of them after the fix, on a candidate that was mergeable each time.
  - The status list and inbox still show a moved pin as a controller fault, and Resume is not refused while it would stop again (R-A7's rule).

### LIVE-22: a decision item stays open after a clause approval without saying which slices it still waits for
- Severity: low (no stop; a misleading item)
- Category: operator clarity (inbox and decision cards; R-A5, R-C3b, LIVE-18)
- Status: OBSERVED 2026-09-30 by the operator, after the e0d33b8 deploy. FIXED 2026-09-30 on `remediation/p2` (option A, operator decision), not deployed: the item and card say which slices the decision is settled for and which still need it. See [R-C3](../register.md#r-c3).
- Replay case: the 2026-09-29b snapshot (00:06 UTC) holds the map and the earlier clause approval; the operator's clause approval for exo/EXO-18/instance-design came after it. Check against a later snapshot.
- Evidence:
  - The operator recorded a clause-limited ("scoped") approval of EXO-ADR-037 for exo/EXO-18/instance-design, which then ran. The "Needs you" item for EXO-ADR-037 stayed open.
  - That is correct: EXO-ADR-037 is a merge requirement of six slices (exo/EXO-03/domain, exo/EXO-03/integration, exo/EXO-18/domain, exo/EXO-18/instance-design, exo/EXO-18/instance-qualification, exo/EXO-18/integration; the last two also through EXO-ENV-G1). Clause approvals settle it only for exo/EXO-03/domain and exo/EXO-18/instance-design; the other four still need the full decision or clauses naming them.
  - The item's message is the generic "Ready for independent evidence review and your acceptance", and the card does not say which slices are settled and which still wait, so the item looks stale.
- Proposed fix (next batch): the decision's inbox item and its card show "Settled for …" and "Still needed by …", from the rule the merge gate uses (`unsettledSliceDecisions` and the clause coverage `stagedDecision` applies). Nothing persisted changes.

## After the e0d33b8 deploy (2026-09-30)

The operator deployed e0d33b8 at 00:31 UTC, after adopting WI's and EXO's checks (00:34). The evidence below is a read-only `.backup` taken at 02:14 UTC (`replay/2026-09-30/`, SHA-256 `5f7527f4…`).

### LIVE-23: No agent runs the adopted checks, because no brief names them, so every review held to them is refused at merge
- Severity: medium (a stop with a costly exit; with R-G13 increment 2 it would reach every current-upstream review)
- Category: declared checks ([R-G13](../register.md#r-g13)); briefs ([R-G6](../register.md#r-g6))
- Status: CONFIRMED 2026-09-30 from the 2026-09-30 snapshot. FIXED 2026-09-30 on `remediation/p2`, not deployed: a run held to adopted checks is told each check's `ct-check --declared <id>` command and that only those count. See [R-G13](../register.md#r-g13).
- Replay case: the 2026-09-30 snapshot. Runs 27d0548c (exo/EXO-04/domain review, cycle b0de849a) and bfd67980 (exo/EXO-18/instance-design review, cycle 2c9ead5d) are held to EXO's adoption (e5be5602, 7 checks); both cycles are `awaiting-merge` with an open merge-approval item. `declaredCheckGaps` over their frozen build records gives all seven checks missing, so the merge gate refuses both with "The review needs a successful run of each declared check …".
- Evidence:
  - Six runs since the deploy carry a check declaration (scoped mode). Their agents ran the adopted commands themselves (`ct-check -- python3 -B scripts/check_exo_v3_contract.py`, `cargo clippy --manifest-path v3/Cargo.toml --locked …`), which count for nothing; no receipt since the deploy names a declared check.
  - No brief mentions `ct-check --declared`: the only place the command appears is the gate's refusal, which the agent never sees.
- Impact: the operator's merge approval of both cycles is refused; the exit is a resume with guidance naming each command, then a fresh review. R-G13 increment 2 (not deployed) holds current-upstream reviews to the adopted checks too, so without the fix every review would stop this way.

### LIVE-24: The roadmap's refused merge shows as "merge approval", which the operator cannot give
- Severity: medium (no working control in the inbox)
- Category: attention ([R-C14](../register.md#r-c14)); declared checks ([R-G13](../register.md#r-g13))
- Status: CONFIRMED 2026-09-30 by the operator and from the 2026-09-30 snapshot. FIXED 2026-09-30 on `remediation/p2` (operator decision: re-review automatically), not deployed. See [R-G13](../register.md#r-g13).
- Replay case: the 2026-09-30 snapshot. The roadmap's automation is `integrationMerge: automatic`, `parentAcceptance: automatic`.
  - exo/EXO-18/instance-design (entry 1801ae43, cycle 2c9ead5d): the scheduler record is `existing-hold`, `entry-preparation-failed`, with LIVE-23's refusal (all seven adopted checks missing); the cycle stays `awaiting-merge` with an open merge-approval item.
  - exo/EXO-04/domain: the slice merged on 2026-09-25. Cycle b0de849a is an automatic-recovery repair (round attempt 6f84ef91, source entry 7b749337, EXO-04/domain's verification). Its merge was refused the same way and held on the source entry, which has no item; the repair's item says "Operator merge approval required".
- Evidence:
  - The operator found no control to merge either one: a roadmap-owned merge has none, and the item offered none of the hold's exits.
  - The refusal is not the code's: the review simply had not run the adopted checks (LIVE-23), so a fresh review is the exit, and the roadmap could take it itself.
  - For EXO-04 the hold's reason reached no item at all, even with LIVE-20's fix, because it sits on the round's source entry.
- Impact: two slices stopped with no working control shown; the operator could not tell what to do.

### LIVE-25: "Fresh review required" stays after the fresh review ran
- Severity: low (misleading text)
- Category: UI ([R-A6](../register.md#r-a6))
- Status: CONFIRMED 2026-09-30 by the operator and from the 2026-09-30 snapshot. FIXED 2026-09-30 on `remediation/p2`, not deployed: the text asks for a fresh review only until one has started at the resolution commit. See [R-C14](../register.md#r-c14).
- Replay case: cycle b0de849a in the 2026-09-30 snapshot: its integration resolution committed 95f22b91, and its current review (27d0548c) ran on 95f22b91 and was mergeable, yet `IntegrationResolutionPanel` shows "Integration update committed … Fresh review required." whenever a resolution commit exists.

### LIVE-26: The brief names a build directory the launchers do not use, so an agent stops to ask which is right
- Severity: low (a question stop with a working exit: Continue with guidance)
- Category: briefs ([R-G6](../register.md#r-g6))
- Status: OBSERVED 2026-09-30 by the operator on WI-03 ("May native checks use the launcher-mandated scratch/target, or will the controller supply a manifest targeting the required worktree cache?"). FIXED 2026-09-30 on `remediation/p2`, not deployed: the brief says daemon-run builds choose their own build directory. See [R-G6](../register.md#r-g6).
- Replay case: none in the snapshots (the question came after 2026-09-30 02:14). The brief text is the reproduction: `brief.ts` tells the agent CARGO_TARGET_DIR is the worktree's build cache and to keep build outputs there, while `ct-native` and the pinned Cargo launcher run in the daemon with the manifest's `targetDirectory` (the run's `scratch/target`) or a per-commit target.
- Impact: a stopped work item and an operator question that nobody could act on as asked (no corrected manifest exists); the answer is that the launchers are used as supplied.

## After the b63df53 deploy (2026-09-30)

The operator deployed b63df53 at 07:10 UTC, re-adopted WI's and EXO's checks, set Claude for design and some specialist roles, refreshed the WI pin and restarted the roadmap. The evidence below is a read-only `.backup` taken at 16:15 UTC (`replay/2026-09-30b/`, SHA-256 `b9e2788a…`); goldens at 9f4da08 (`golden.json` 68, `every-run-golden-9f4da08.json` 475, `scheduler-golden-9f4da08.json`).

### LIVE-27: A parent finding repaired in a slice whose scope excludes it burns every remediation round on no-ops
- Severity: medium (operator time and agent time lost; the limit was raised by hand)
- Category: automatic recovery ([R-C5](../register.md#r-c5)); remediation ([R-C14](../register.md#r-c14)); findings ownership ([R-G6](../register.md#r-g6))
- Status: CONFIRMED 2026-09-30 from the 2026-09-30b snapshot. FIXED 2026-09-30 on `remediation/p2` (operator decision: stop no-op remediations; findings name their owning slice), not deployed. See [R-C5](../register.md#r-c5).
- Replay case: the 2026-09-30b snapshot. Roadmap round attempt for entry c4ae17de (wi/WI-03/domain), source entry 1926f0d1 (WI-03 parent acceptance), requested from the operator's account on 2026-09-29 22:59 UTC; its cycle ace289b2 is `remediation-exhausted` at 6 of 3 rounds.
- Evidence:
  - WI-03's parent review found R1.WI03P-F001 (expired deliveries are not reconciled by runtime dispatch). The finding names no slice, so automatic recovery held it as ambiguous (LIVE-20), and the round that followed was owned by WI-03/domain.
  - WI-03/domain's scope excludes "Production AQ/WI adapters, externally effective operations, live lifecycle activation"; WI-03/integration's scope is "the remaining production integration". Every run since agrees the fix belongs to WI-03/integration.
  - Seven remediation runs (22:59 to 08:09); four say they made no source change (ff7e2783, 24f6d7a6, 70c27655, 9418cdd6); seven reviews each request changes for the same finding, "open for WI-03/integration". The limit was reached at 02:19 and again at 08:41 after being raised.
  - Nothing in the controller noticed a remediation that left the head unchanged; "two unchanged remediation rounds" compares review findings, which shifted between reviews as other findings closed.
- Impact: about ten hours of agent runs on work the slice may not do; the operator raised the limit without a way to see the round was misrouted.

### LIVE-28: Automatic recovery counts its allowance over a work item's life, so an old allowance stops a new, minor finding as "not converging"
- Severity: medium (a passing parent review stopped; the operator raises limits by hand)
- Category: automatic recovery ([R-C5](../register.md#r-c5))
- Status: CONFIRMED 2026-09-30 from the 2026-09-30b snapshot and the code. FIXED 2026-09-30 on `remediation/p2` (operator decision: reset after a passing review), not deployed. See [R-C5](../register.md#r-c5).
- Replay case: the 2026-09-30b snapshot. EXO-01 parent acceptance (entry cbf93d54, cycle 10dbc912): review cfaa127d (07:31 UTC) is mergeable with its exit gate met and one open minor finding (F-006); `scope-review-recovery` at 07:47:02.189 became `recovery-not-converging` at 07:47:02.938.
- Evidence:
  - `scopeRecoveryDecision` counts every automatic round of the work item on the roadmap (`maxRoundsPerParent`, 3). EXO-01's three were on 2026-09-18 and 09-19, before R-C5's escalation existed; the new finding could not start a round.
  - The escalation's own summary says round 3 made progress; the inbox labels the code "Recovery not converging".
  - F-006 asks that EXO's CONTRIBUTING.md list the seven adopted checks instead of generic `ct-check` commands: a consequence of the checks adopted that night, not of EXO-01's code.
  - The review also carries 20 withdrawn "alias" findings from earlier rounds renaming finding IDs, which each review re-checks.
- Impact: a parent review that passed its exit gate waits for the operator; raising the allowance by hand becomes routine.

### LIVE-29: The plan's evidence view grows with history until panels across the app stall behind it
- Severity: medium (every page and the scheduler wait while it runs; no data loss, no stop)
- Category: read performance ([R-H4](../register.md#r-h4), [PERF-08](PERF-browser-and-read-performance.md#perf-08-map-evaluation-hot-spots-in-roadmap-view-cycles-list-and-cross-project-preview)); refresh volume ([R-D5](../register.md#r-d5))
- Status: CONFIRMED 2026-09-30 from the daemon's request log (read-only) and a CPU profile on a copy of the 2026-09-30b snapshot. Operator decision 2026-09-30: take a first increment of R-H4 next. FIXED 2026-09-30 by R-H4 increment 1 (not deployed; operator decision the same day: the size is accepted): 1.37 MB and about 380 ms of CPU on the snapshots, content equal to the golden; see the register.
- Replay case: the 2026-09-30b snapshot, map definition `0ebcb7cf`, `GET …/concurrency-definitions/0ebcb7cf-9686-4bc1-9b9d-bb85a1d0b4c9/runtime`. The scheduler replays do not read this view, so its fix needs its own golden of the view's content.
- Evidence:
  - The request log gives the view's median, worst time and size by day: 09-23 0.5 s, 1.8 s, 5.7 MB; 09-26 1.4 s, 6.8 s, 6.4 MB; 09-29 1.3 s, 16 s, 9.7 MB (589 requests); 09-30 3.4 s, 25 s, 9.7 MB. The operator noticed panels waiting for data after the 09-30 deploy.
  - On the snapshot copy, with Git stubbed, the view takes about 1.9 s of CPU and returns 9.7 MB. `submissions` is 8.6 MB of it: all 86 evidence submissions of the definition in full, about 100 KB each. `decisionInbox` is 0.4 MB, `architectureDecisions` 0.3 MB and `subjects` (197) 0.3 MB.
  - The profile: `prerequisiteIssues` and `acceptedEvidence` run for every subject and every submission, each re-decoding the submissions (`runtimeEvidence.submissions`, 0.7 s) and recomputing decision digests through `canonicalDefinition` (0.56 s self), as PERF-08 found on 2026-09-22 at a smaller size. Each request also makes 28 Git calls (freshness of pins and candidates).
  - The view is fetched by the evidence panel on the Roadmaps and Plans pages, again on each roadmap revision, and returned by every shared-decision and evidence action. The daemon reads SQLite synchronously on one event loop, so each request holds every other request, and the scheduler's pass, for its duration.
  - Lesser costs in the same log: `worktrees/:id/branch-status` up to 5.8 s (Git) and the Delegate source fixes preview (`cycles/:id/scope-repair`) occasionally 7 to 9 s.
- Impact: the app feels slow everywhere while a roadmap runs, worse as evidence accumulates and as agent builds load the machine; automation waits with it.
