# ADR-056: Owning-slice remediation from independent reviews

Status: accepted
Date: 2026-09-17

An independent verification or parent-acceptance review cannot implement its findings.
Repeating the review is insufficient, and reopening its snapshot for implementation
would invalidate its separate role. A completed development attempt must retain history.

Provide an explicit owner/editor command to delegate source fixes into the owning slice.
Preview the current related review findings and eligible owning scopes; require the exact
preview digest and source cycle version when delegating. Prepare a fresh editable slice
from current integration, reuse its previous implementation profiles and completion policy,
and start at remediation with a separately bounded follow-up allowance. An existing active
slice is opened rather than replaced. Running related reviews block delegation.

Pin complete review-report turns from the same work item and exact map binding using run
IDs and journal sequences. Verification findings are limited to the selected slice; parent
findings remain explicit obligations. Namespace finding IDs by source review so identical
original IDs cannot collapse distinct defects. Materialize the full reports and final
messages separately from ordinary same-worktree handoffs. Subsequent repair reviews must
report every namespaced open finding with a supported disposition; the packet grants no
policy, scope expansion, waiver, publication or merge authority.

The repair is an explicit local cycle, not a replacement of the roadmap's prior attempt.
Its integration merge requires approval. Then resume independent verification and parent
acceptance with their existing frozen reviewer assignments. Resume fast-forwards idle,
clean snapshots before review even with roadmap scheduling paused; dirty or diverged
snapshots remain guarded. Active owning-slice work blocks verification and acceptance.
Prior merges, runs and evidence remain recorded; current gates determine their applicability.

Project prerequisite waits as waits instead of stale operator questions. Hide duplicate
header attention and resolve corresponding outbox reminders while these prerequisites are
pending, without rewriting the historical cycle reason or dismissing current findings.
Missing authority, reviewer qualifications and external execution evidence remain actionable.

## Amendment 2026-09-25: finding history in the repair packet (R-C5)

Each open finding in the packet carries its history: how earlier rounds of the same review
reported the same finding ID (status, severity, title, explanation, recommendation, location,
disposition), oldest first, at most 12 rounds of 2,000 characters per field. Rounds are the pinned
review's own lineage (`parentRunId` within its worktree), within which reviewers carry finding
IDs forward, so a review that restarted numbering is never mixed in; history does not survive a
replaced review worktree. A reviewer samples examples of a broad finding each round: the repair
treats the examples of every open round as remaining work until it verifies them fixed, and
resolved rounds as what must not regress. Finished runs never change, so the packet stays
deterministic. Only the packet file carries the history; previews and fingerprints do not.
