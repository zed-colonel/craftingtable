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
- Status: OPEN; cause not investigated ([R-C12](../register.md#r-c12))
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
- Status: OPEN; cause is a HYPOTHESIS ([R-C13](../register.md#r-c13))
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
- Status: CONFIRMED
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
