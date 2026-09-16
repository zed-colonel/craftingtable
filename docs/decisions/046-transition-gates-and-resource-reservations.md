# ADR-046 — Transition gates and resource reservations

- Status: accepted
- Date: 2026-09-16

Evaluate slice requirements at start, merge and verification, and original work-item
requirements at parent acceptance. Merge inherits start requirements; verification inherits
merge requirements and requires a recorded merge. Resource occupancy does not inherit earlier
phases. Typed blockers distinguish dependency, evidence, review, authorization and resources.
Manual commands and automation share this evaluation, with authority and evidence rechecked
at mutation boundaries. Importing a definition never authorizes an exception or passes a gate.

An owner/editor may explicitly authorize a source-declared early-development rule for an
exact slice/map/binding identity when that rule has no unresolved decision references. This
substitutes its explicit slice requirements for incomplete original predecessors during
slice development/integration/verification only. Completed predecessor commits still require
ancestry checks; parent acceptance always retains all original predecessor barriers. Map-wide
proposal adoption remains a later increment. Authorization is immutable and does not migrate
to another definition or binding revision.

Schema 19 persists atomic all-or-none resource claims and their release history. The built-in
local development profile uses installation-wide development admission slots (default 2).
Verification and parent acceptance use a separate local verification pool (default 1).
Repository merge claims key the canonical registered checkout, across workspace/map aliases;
existing repository/worktree mutation guards and review freshness remain authoritative.
Run claims last through waiting/background work until the supervised run ends; Git/evidence
commands release their claims in finally. Ordinary resource waits are retried without attention
alerts or spending a queued step's execution deadline. No claims are acquired for unmet phase
requirements. Restart releases interrupted run/operation claims but retains their history,
existing merge recovery, evidence and explicit resume behavior.

Roadmap in-flight/exclusion limits continue to cover unmerged development attempts. Merged
slices and review-only worktrees do not consume development capacity. One blocked merge does
not stop eligible siblings in parallel mode. Concurrent roadmap/cycle refresh requests share
an in-process refresh guard so a refresh reservation cannot be processed as a completed review.

These are daemon admission reservations, not CPU enforcement, credential controls or isolation.
The local profile uses existing separate worktrees/run scratch; it does not prove isolated
external test state. Native/Kata profiles remain unavailable until enforceable environment
adapters and attributable evidence ship. A resource being available is never a test pass.
Unresolved upstream pins, checkpoints and decision adoption keep the reference map closed.
