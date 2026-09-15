# ADR-041: Plan completion and optional integration branch cleanup

Status: accepted. Extends ADR-026 and ADR-033.

Completion belongs to a plan version and is derived from its completed finalization and durable
merge evidence. Project summaries reflect the active version, while version history preserves
prior promotions. Existing completed finalizations need no migration or reimport.

Final operator approval may opt into removing the local integration branch. The merge
reservation persists this choice; reconciliation marks the plan completed before reserving
cleanup on the finalization record. Older completed attempts expose the same explicit removal
command. Cleanup records pending, blocked or removed independently of merge/worktree cleanup.
Restart preserves the request and exposes retry without repeating the merge.

Removal requires the pinned integration snapshot and recorded promotion to remain ancestors of
the destination. Protected destinations, other plan bindings, active worktrees, pending merges,
active finalization holds and checked-out branches prevent removal. The Git adapter deletes only
the expected local ref value. Missing refs reconcile idempotently; a completed cleanup command
never deletes a branch subsequently recreated with that name. Remote branches remain outside
this operation. Plan settings and all run/review/merge history are retained.
