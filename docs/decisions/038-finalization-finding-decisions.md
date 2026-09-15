# ADR-038: Explicit finalization finding decisions

Status: accepted. Refines ADR-033 and ADR-036.

A paused finalization with a complete, successful current review can accept an explicit
operator decision on selected findings, including at a questions checkpoint. The command
records rationale and optional answers; the next agent must ask again if guidance leaves
any genuine question unanswered. Invalid or incomplete reviews and owned Git conflicts
retain their existing recovery paths.

Deferral is limited to open nits. Store their full snapshots, review identity, exact source
and destination commits, actor, time and rationale in durable cycle state and audit history.
Keep reviewer findings open. Only matching findings on the authorized commits are excluded
from the controller's nit count; changed details, severity or commits invalidate the exemption.
The next independent review must still report technical readiness and meet required checks
and plan obligations. Deferral at the last improvement verification proceeds directly to the
configured final independent review; earlier checkpoints retain remaining scheduled rounds.
No deferral or report rewrite grants final merge authority.

Focused remediation selects an explicit batch and adds 1–20 attempts without resetting used
counts. It passes rationale and answers to implementation, followed by independent verification.
Other findings remain gates unless separately deferred. Bound the batch and avoid unrelated
optional polish. Recheck current editor authority, versions, review lineage, idle worktree,
cleanliness and exact branch context after asynchronous inspection. Store the decision and
next-run reservation atomically; restart retains both without replaying an agent launch.

The staged evolution is recorded in ../finalization-roadmap.md and remains future work.
