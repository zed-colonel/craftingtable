# ADR-037: Bounded recovery of incomplete background work

Status: accepted. Refines ADR-020, ADR-025 and ADR-033.

## Decision

A successful CLI exit does not prove the agent collected background verification or
finished its outcome. The Claude adapter recognizes its background-wait timeout and
normalizes a distinct incomplete exit. Outstanding task notifications, or task updates
after the last result without a subsequent collected outcome, also mark it incomplete. The shared supervisor also detects a surviving
process group after Claude exits, including commands whose output was redirected.
Keep the run live and the worktree occupied until that group drains. Manual handoffs
and competing launches also wait while the session reports uncollected background work.
The controller keeps input open across waiting turns until the agent collects that work;
a provisional result must not trigger EOF and stop its tasks. The original cycle
step deadline bounds this wait; standalone runs allow thirty minutes after the agent exits.
Timeout or cancellation sends TERM and then KILL, retaining escalation even if the
leader has exited. Linux zombie processes do not count as executing work.

Persist the incomplete exit reason in the existing run-finished journal and mark the
run failed even when its exit code is zero. Display that reason above the recorded
outcome. Provisional review reports cannot supply a verdict or close findings; preserve
open concerns and earlier valid dispositions in the pinned handoff history.

For automated work-item and finalization steps, reserve at most two same-step completion
continuations after a clean process exit with this specific lifecycle failure. Each gets
the same configured profile, full handoff, phase and original deadline. Record the count,
next run and attributed audit event atomically. Continuations consume no remediation
allowance and cannot extend the time limit. Reuse complete passing verification only
when its recorded inputs and commits still match; collect failures and missing results,
then emit the required outcome. They do not authorize another whole polish round.

Review continuations require the original recorded candidate and destination commits,
managed branch and worktree version, with no tracked/index changes or pending Git operation.
Up to 100 untracked paths may be carried into this narrowly scoped review: the agent must
inspect their provenance, preserve confirmed verification artifacts and an explanation in
run scratch before removing them, and leave unknown files for questions or remediation.
No tracked edits or commits are authorized. Launch rechecks the baseline; ordinary review
and final approval still require a clean worktree. Explicit plain or guided resume uses
this same path for an interrupted review, with a fresh operator-authorized step window.
Automatic recovery retains its original deadline and persisted continuation limit.

Explicit questions, error turns, truncated output, timeouts, exhausted recovery and owned
integration-conflict resolution require their existing operator controls. Other malformed
reports are not automatically repaired. Pause, stop, revoked delegation and restart retain
their authority checks; restart never launches a continuation without explicit resume.
All normal findings, independent review and exact-commit promotion gates remain.

## Boundary

Process groups supervise ordinary descendants, including nohup with redirected output.
They do not contain a program that deliberately escapes into another session or service;
agents are instructed not to detach verification that way. This is lifecycle supervision,
not an OS sandbox. Existing runs are not retroactively reclassified or adopted. The CLI's
own wait ceiling remains unchanged; there is no indefinite-wait configuration.
