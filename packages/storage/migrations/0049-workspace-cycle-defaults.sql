-- R-C17 part 4, decisions 8 and 9: a workspace's default step time limit, the minutes per step
-- that its new cycles, roadmap entries, map settings and finalization stages start with. One row
-- per workspace; no row means the completion policy's own 120 minutes. The browser's forms seed
-- from it; no stored cycle or entry changes with it.
--
-- A new table and audit action: a release without them never writes or reads them, and the
-- deploy preflight (R-H3) refuses a rollback across any migration.

INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES
    ('cycle-defaults.updated', 49);

CREATE TABLE workspace_cycle_defaults (
    workspace_id       TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE RESTRICT,
    max_run_minutes    INTEGER NOT NULL CHECK (max_run_minutes BETWEEN 1 AND 1440),
    updated_at         TEXT NOT NULL,
    updated_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT
) STRICT;
