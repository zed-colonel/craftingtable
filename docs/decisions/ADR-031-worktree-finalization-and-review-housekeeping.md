# ADR-031: Worktree finalization and review housekeeping

Status: accepted. Date: 2026-09-11.

## Context

AQ-08's implementer committed its work. Review verification then redirected temporary
files into the worktree and left untracked test artifacts. A valid negative review
stopped at the cleanliness check before its findings could reach remediation.

## Decision

Every new agent run receives a private scratch directory beneath its run directory,
outside the Git worktree, through TMPDIR/TMP/TEMP and its brief. Both backends receive
that directory within the existing run-file access scope. Scratch is retained with run
files for inspection; it is not an automatic disk-space reclamation mechanism.

Implementers must commit intended work after verification and explicitly stage intended
new source. At successful automated implementation/remediation boundaries, the controller
can checkpoint tracked edits and staged additions. It never stages arbitrary untracked
files. The controller reserves the source run, parent commit, content fingerprint and
paths durably before Git, then records the resulting commit and audit evidence. Preparation
and commit use explicit path operands, repository/worktree guards, current delegation,
and idle sessions. Hooks remain enabled. Conflicts, changed content, foreign branches and
unexpected commits stop the operation. A crash between Git and SQLite can reconcile only
an exact matching checkpoint patch, parent and run-labelled subject on explicit resume.
Pause/stop can allow in-flight Git to finish but cannot launch a subsequent review.

A complete negative review goes to remediation before the approval cleanliness check.
Its full findings travel with instructions to inspect and classify leftover files, remove
only confirmed generated artifacts, preserve intended source and commit the fixes. Resuming
an older stopped-for-attention negative review follows the same path. Unclassified files
at implementation completion also use a bounded remediation run. These runs consume the
existing remediation budget; unchanged findings retain the stall limit. Routine housekeeping
does not enter needs-attention or send an attention notification. Failures and exhausted
budgets still do.

Positive reviews still require a clean managed branch at the reviewed commit. Verification
changes invalidate approval and require remediation followed by a fresh review. Integration
refresh and operator-only final merge gates remain intact. Manual runs receive scratch and
commit guidance, but the daemon does not automatically commit their work.

## Consequences

Normal source leftovers and review artifacts can be handled without an operator shell or
commit button. Unknown files are classified by an agent, not inferred safe by the daemon.
Controller commits establish a reviewable revision, not correctness. Additive schema-12
cycle fields retain reservations; audit events retain earlier checkpoint evidence.

## Alternatives considered

Prompt guidance alone is unreliable. Letting reviewers commit source mixes implementation
and review responsibilities. Blanket staging can commit test artifacts or unrelated data.
A commit-only agent round wastes work when the controller already has an explicit path set;
classification and substantive remediation can share a run when judgment is needed.
