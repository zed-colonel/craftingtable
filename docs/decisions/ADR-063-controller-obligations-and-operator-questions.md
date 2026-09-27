# ADR-063: Controller obligations and operator questions

Status: accepted. Date: 2026-09-22.

## Decision

Scoped roadmap runs distinguish technical findings, later transition prerequisites,
source-required specialist reviews, and genuine operator questions. A validated workflow
report routes shared architecture questions to the shared decision inbox and local questions
to the work-item guidance form. Plan-backed answers require citations. Prose never grants
checkpoint acceptance, changes a dependency, or waives a source finding.

Technical candidate approval and permission to merge are separate. The daemon keeps existing
phase, dependency, source-review, build, cleanliness and exact-commit merge gates. A missing
later checkpoint does not make an implementation incomplete or require a code remediation.
Older successful runs stopped on unclassified questions receive at most two read-only
reassessments under a running roadmap. They retain their reports and finding IDs. Unknown
questions, invalid reports beyond this bound, exceptions and exhausted budgets remain
operator work. Explicit pauses, entry holds, revoked authority and daemon restart remain
launch boundaries.

The saved attempt's reviewer responsibilities authorize separate agent reviews. A declared
source requirement for a second security review causes a distinct read-only run after
technical remediation. Its receipt binds source and integration commits, repository policy and consumed dependency
inputs; changes require a fresh review. The final merge command enforces that receipt even after stopping automation.

Amended 2026-09-27 (LIVE-02, R-I11). A slice cycle that no roadmap owns (a manual start) has no
saved responsibilities, yet the merge gate still requires the source-required security review.
The operator who started that cycle authorizes it, and only it: checkpoint and reassessment
reviews stay roadmap delegations. A roadmap that owns a cycle but delegates no reviewer (a
single-project roadmap) authorizes no review, and the cycle stops as
`security-reviewer-unassigned`. A cross-project attempt whose saved delegation cannot be read
fails closed as `authority-lost`, rather than falling back to the operator's authority. A
security review that finished and still is not current for the candidate stops as
`workflow-obligation` instead of repeating.

Local contract, profile and design-level semantic checkpoints may receive a separate
technical review when their mapped prerequisites are satisfied and every reviewer
responsibility is assigned. The agent must explicitly attest every source requirement and
case, with passing frozen build evidence. The server creates immutable candidate evidence
and an attributed delegated acceptance, retaining the actual run, roles and saved roadmap
revision. This is an agent attestation, never a fabricated human approval. The existing
explicit manual checkpoint path remains available. Architecture decisions, saved-plan
acceptance, qualified external/Kata evidence, unsupported cross-repository evidence and
protected final promotion retain their separate authority requirements.

Candidate evidence may survive later passing reviews of the same unchanged candidate;
source edits, a failed later review, changed relevant inputs or integration invalidate it.
Subsequent merged-slice verification and parent acceptance remain mandatory. No step gains
source-editing authority merely because it is a checkpoint or security reviewer.

## Consequences

Controller-owned waits show their named prerequisites instead of asking the operator to
promise future controller action. Genuine questions name the right browser destination.
Implementation and review questions are included in the shared inbox; malformed legacy
classification can expose a cited question but cannot manufacture its recommendation or
approve it. Automatic classification and review use the existing supervised process,
reservations, profiles, recovery budgets, journal and authorization checks.
