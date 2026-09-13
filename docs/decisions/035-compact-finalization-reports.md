# ADR-035: Compact finalization reports and scoped recovery guidance

Status: accepted. Refines ADR-024 and ADR-033 for plan finalization.

## Decision

A finalization review reports every previously open finding with its current status,
plus new or reopened findings. A reviewer must explicitly verify and dispose of a finding
before it may be omitted in subsequent reports. Unchanged resolved/withdrawn findings
remain in the journal; omission preserves their last valid disposition. Work-item
reviews keep their existing all-ID continuity requirement.

Reconstruct latest finding states from valid review events at the source cursors delivered
to the run. Invalid reports and implementation claims cannot establish closure. Handoffs
materialize active findings and a closed-ID index separately from closed finding details,
with source run/event references. Complete conversations and original reports remain
available under the existing size and retention rules. Finalization briefs point to those
files instead of embedding the entire preceding report again. Closed work-item history
is supporting evidence, not a requirement to manufacture finalization findings.

Exit-gate evidence summarizes the current candidate, conformance and checks, referencing
larger verification records instead of appending earlier evidence. Its existing 20,000
character limit remains. Prompts state field limits and the finding-ID character rules.

Resume guidance applies to one attempt. Later steps retain the recorded answer through
the handoff, without repeating the instruction as a new operator command. A retry after
an invalid review receives the validation issues. Reuse of completed verification is
suggested only for a successful, untruncated prior review with matching candidate and
destination commits and branch; the reviewer must still recheck applicability and return
a valid report. Drift or incomplete results require fresh verification. This does not
accept an invalid report, automatically resume a paused cycle, or grant merge authority.

## Consequences

Finalization report size follows unresolved work and current evidence instead of total
project review history. Existing finalizations use this behavior on their next launch;
no migration or rewriting of recorded reviews is needed. The current findings UI shows
the current report; older dispositions remain accessible through earlier run outcomes.
