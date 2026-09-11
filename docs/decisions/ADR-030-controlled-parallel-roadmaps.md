# ADR-030: Controlled parallel roadmaps

Status: accepted. Date: 2026-09-11.

## Context

Sequential roadmaps have been exercised through three operator merges. The next increment
must run independent siblings concurrently without reusing review approval after integration
changes or turning an item question into a global scheduling stop.

## Decision

Parallel is an explicit roadmap mode; absent settings retain sequential semantics. Ordered
entries express priority, while imported required dependencies determine eligibility. A
started predecessor releases successors only after its own worktree merges. List position
does not create merge constraints. No cross-project sidecar semantics are activated.

Durable attempts reserve in-flight capacity before worktree creation. Awaiting-merge,
attention, and paused attempts retain capacity. Default roadmap and repository limits are
two. Existing manual worktrees count toward repository capacity, and the scheduler never
adopts them or duplicates their item. Shared checkouts respect the tightest delegated
repository limit. Workspace-scoped exclusion groups are held until merge or worktree removal.
Independent workspace scheduling remains subject to those shared-repository constraints.

Item preparation failures and deliberate holds persist separately from roadmap status.
Independent entries continue while an item needs attention. Whole-roadmap pause/stop controls
all owned cycles; item pause/resume controls only its entry. Restart still requires explicit
resume and preserves individually paused entries. Definitions remain immutable. Started
entry settings and refresh budgets bind to their execution revision; queued settings and
parallel priority can change while paused. Mode changes require no in-flight attempts.

The cycle controller refreshes an actively delegated parallel attempt at an idle review
boundary or stale merge checkpoint. It finishes live work first, checks authority and branch
binding, reserves a bounded refresh attempt, invalidates old review context, and normally
merges integration into the item branch. Successful updates require a fresh review with
combined-state checks and existing findings/remediation policy. Conflicts abort and pause
only that item. The default maximum is three refreshes; manual reconciliation remains
available. Git cleanliness does not establish semantic correctness.

Daemon worktree creation, removal, integration updates, and final merges share a repository
mutation lane; worktree guards still prevent live-session overlap. Transient contention waits
without consuming refresh budget. Pause/stop supersede pending work; a started Git operation
may finish but cannot launch a late review. Only the operator invokes final merge, with exact
source and target commit checks. External Git processes remain outside daemon locking.

Parallel settings, holds, and refresh counters are additive fields in existing schema-12 JSON
records. Notification source identity for item preparation failures is independent of sibling
progress, preserving reminder timing. Normal resource waits do not generate attention pushes.

## Consequences

AQ-08 can release AQ-09 and AQ-10 together; either can merge first, after which the other must
update and be reviewed again. Sequential and manual flows remain available. Cross-project
prerequisites, explicit merge-order constraints, pinned upstream environments, and Planning
Studio remain later increments. Git and SQLite still have an explicit crash-reconciliation
gap; no distributed transaction or automatic restart replay is introduced.
