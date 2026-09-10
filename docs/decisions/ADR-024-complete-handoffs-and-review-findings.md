# ADR-024 — Complete handoffs and consolidated review findings

- **Status:** accepted
- **Date:** 2026-09-10

## Context

Handoffs copied only the latest turn result, capped at 120,000 bytes. Findings in
earlier messages or beyond that ceiling were lost. A prose verdict alone cannot
support reliable finding counts or later automation policies.

## Decision

The daemon materializes a handoff manifest and conversation, final-message, and
review-assessment files from the journal for every run in the explicit parent lineage.
Messages retain their order, source run, and event cursor. The initial user-message
event records the source cursors delivered at launch; descendants inherit those
snapshots. Later edits to an open source review cannot silently change its children’s
context or required finding IDs. The prompt previews up to
256 KiB of the immediate parent's final message and directs the agent to the source
files. A 32 MiB aggregate ceiling rejects a handoff before launch rather than dropping
text. Adapter limits remain bounded; explicit truncation flags and legacy markers
warn when source text was already lost. Handoffs cannot cross worktrees or snapshot a
source turn while it is running.

Reviewers consolidate all findings into one `craftingtable-review` JSON block in the
final message, followed by the matching `VERDICT` line. Version 1 includes the verdict,
exit-gate assertion/evidence, and findings with stable IDs, severity, optional location,
explanation, recommendation, and open/resolved/withdrawn status. Closed findings need
a reviewer disposition. Prior IDs from valid reports in this lineage must remain in
later reports. Implementation dispositions are claims, not finding closure authority.

The daemon stores a validated assessment with each review's `turn-completed` event.
The latest assessment is the run-page projection; prior snapshots remain in the journal
and conversation files. Complete means structurally valid and declared consolidated by
the reviewer; it does not prove correctness or that all prose findings were captured.
Malformed, contradictory, truncated, failed, or ID-dropping reports are invalid. They
cannot supply a merge verdict. Every new review result replaces or clears the previous
verdict, preventing a stale mergeable result from surviving a failed follow-up.

Legacy reports stay explicitly unstructured. They retain the manual verdict path and
full recorded conversation handoff; no findings or severity counts are inferred from
prose. Manual remediation is available after a completed review turn even without a
verdict. No automatic transitions, stopping thresholds, or merge authority are added.

## Consequences

The existing journal durably stores report snapshots; no database migration is needed.
A prompt-only coverage guarantee would be dishonest: consolidation remains a reviewer
assertion, with source conversation available for inspection. Upstream-truncated bytes
cannot be restored. Independent reviews without a parent start independent ID lineages.

## Alternatives considered

Increasing only the byte ceiling leaves earlier messages out. Concatenating prose and
treating every statement as current resurrects withdrawn findings. A mutable finding
ledger or model-driven prose extractor adds authority and reconciliation complexity
before the structured report path has been exercised.
