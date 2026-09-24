-- R-G7: one Cargo target directory per worktree, shared by the worktree's steps, instead of a
-- cold build in every run's scratch. The daemon records where it put each one so cleanup can
-- check its identity; it is removed once the worktree is merged or removed and nothing runs
-- in it (ADR-039).
CREATE TABLE worktree_build_caches (
 worktree_id TEXT PRIMARY KEY REFERENCES worktrees(id) ON DELETE RESTRICT,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 path TEXT NOT NULL UNIQUE CHECK (length(path) > 1 AND substr(path, 1, 1) = '/'),
 device INTEGER NOT NULL,
 created_at TEXT NOT NULL
) STRICT;
