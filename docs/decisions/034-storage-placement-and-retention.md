# ADR-034: Storage placement and retention

Status: accepted. Date: 2026-09-12.

## Context

Per-run test scratch retained multiple complete build caches after their worktrees had merged
and been removed. Scratch accumulated until the host disk filled. Bulk data needs configurable
placement and a lifecycle distinct from durable planning and run evidence.

## Decision

An installation policy stores future worktree/run roots, backup location, a launch reserve,
recognized build-cache cleanup, 30-day scratch expiry (disableable) and daily snapshot retention.
Host-wide settings require ownership of every active workspace. Canonical paths and device
identities fail closed when storage is missing; per-run locations persist before backend launch.
Existing worktrees and merge-recovery scratch keep their locations. Whole-data migration remains
offline and must preserve references and rebind registered identities after verification.

Merged, removed worktrees with terminal runs and no live siblings permit scratch reclamation.
Recognized Cargo cache markers permit immediate cleanup; other scratch expires only when both
execution state and contents have been idle for the configured interval. Scratch retention in
ADR-031 is superseded by this policy. Run briefs, handoffs, plan documents, messages and findings
remain. Agents should reuse normal project build caches and record verification in final output.

Manual cleanup requires a daemon preview and revalidation; scheduled cleanup recomputes eligibility.
SQLite online snapshots are private and bounded, with manual and daily creation. They cover
application state, not source/working files. Disk pressure and maintenance errors enter existing
attention notifications. A free-space launch gate is explicitly not a running-process quota.

## Consequences

The common accumulation problem is handled without interpreting arbitrary agent-created files
as safe source changes. Unknown caches remain until ordinary scratch expiry. Detached/manual
filesystem data and removed-but-unmerged work remain protected. Operators retain filesystem
backup/migration responsibility; the UI describes that boundary rather than pretending a database
snapshot is a complete project backup. No shell-command, remote storage or generic cleanup
capability is exposed to the browser.
