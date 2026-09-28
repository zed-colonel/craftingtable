# ADR-057: Bounded roadmap recovery across independent review stages

Status: Accepted

Independent verification and parent acceptance intentionally cannot edit source. Their
findings previously required the operator to repeat the owning-slice repair, integration,
fresh verification and parent review commands manually (ADR-056).

A cross-project roadmap can now receive a separate, explicit recovery delegation while
idle. It is execution authority, not a plan amendment: saving it neither changes the
accepted definition nor starts agents. Start/Resume activates the delegation. Manual is
the default. The operator sets a total automatic repair allowance per original parent;
existing rounds remain counted across replacement worktrees, pause and restart.

A round reserves an additional attempt against the owning slice's original definition
before Git preparation. Cycle creation and attempt attachment commit together. Source
reviews remain pinned by run and journal sequence through the existing repair packet.
The repair inherits frozen profiles, completion limits, integration/conflict policies,
branch binding, capacity and exclusion requirements. It starts at remediation and uses
the existing bounded review loop. Only the daemon's ordinary reviewed merge command may
integrate it. A merge does not accept the parent.

After integration the controller refreshes the parent's affected verification snapshots,
records current receipts, and retries parent acceptance with the original reviewer
assignments. Pre-repair run identities distinguish reviews still needing renewal from
new verdicts; a failed new review consumes another round before another source repair.
Related review attention is projected as an automation wait while recovery owns the next
step. Errors and questions remain operator attention.

Routing is deliberately conservative: a complete, successful, question-free report must
have exactly one owning slice in the selected roadmap. Multiple possible owners, existing
manual attempts, stale authority, questions, invalid reports and exhausted allowances stop
for operator recovery. Exact repetition of substantive finding details after repair also
stops; finding IDs alone are not a progress metric. Broader findings prompt a systematic,
bounded audit of related cases within the same scope. This is a conservative repeat guard,
not an automated proof of semantic progress.

The browser displays the separate delegation, total allowance, rounds used, current phase
and recovery history, with a link to the work item. Disabling delegation retains manual
recovery. Planning reconciliation disables recovery until explicitly reauthorized for the
new selection. Main/final promotion remains exclusively an operator decision.

## Amendment 2026-09-28: convergence and one typed escalation (R-C5)

The exact-repeat guard missed the loop it was meant to stop: EXO-01's parent acceptance kept one
major finding open for 13 rounds while each round fixed that round's sampled examples, so the
substance changed every time (HIST-04). Automatic recovery now also judges progress. Each round is
compared with the next report of the same review, from the round's pinned source report and the
review that just finished, never from ADR-056's finding history, which a replaced review worktree
loses. Finding IDs are compared only within one review worktree; across a replacement only the
severity profile of the open findings is compared. A round makes progress when an open finding
closes or is downgraded, or the open findings become less grave; it regresses when they become
graver. Two consecutive rounds without progress stop automatic recovery, as a repeat does. This
remains a conservative guard, not a proof of semantic progress.

Every way automatic recovery ends for a review that has an owning slice (a repeat, rounds without
progress, or the spent allowance) is one entry hold with the typed code
`recovery-not-converging`, whose text summarizes each round: what closed, was downgraded, opened
and stays open. The allowance stays hard. Resume is refused while the same evaluation would stop
again, so it succeeds only once the allowance is raised, automatic recovery is turned off, or the
rounds change. The operator's ways forward are a round of their own (Delegate source fixes, with
guidance), which the roadmap carries and which does not use the allowance, or a split of the
remaining work into a follow-up slice through a reviewed planning amendment (ADR-049). The split
is offered, never proposed automatically. Other refusals (questions, ambiguous ownership, an owner
outside the roadmap) keep their own stops.
