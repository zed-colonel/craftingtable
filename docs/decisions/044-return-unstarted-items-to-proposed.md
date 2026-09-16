# ADR-044 — Return unstarted agenda items to Proposed

- Status: accepted
- Date: 2026-09-15

Admission expresses intent to work, so an operator may reverse it before work starts.
Add an item-level Remove from agenda command, with a version check and the existing
owner/editor, session, origin and CSRF protections. A repeated removal is a no-op;
a stale command cannot remove a subsequently re-admitted item.

Schema 17 permits admitted → proposed while preserving immutable imported fields.
Completed items, any agent/cycle history, active worktrees and delegated roadmaps
block removal. An unused worktree may be removed through the existing control first.
Draft/stopped roadmaps do not own dispatch authority. A shared creation guard also
blocks removal during in-flight Git preparation, before the worktree row exists.

Clear current admission fields, increment the item version, and retain the earlier
admission in its journal. Append a distinct removal event and audit record atomically.
Never create a completion, waive dependencies, or rewrite work history. The daemon
supplies UI eligibility and rechecks it at mutation time. This enables revised plan
activation after an operator withdraws merely queued items.
