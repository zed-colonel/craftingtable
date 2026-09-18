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
