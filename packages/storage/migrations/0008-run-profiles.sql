-- ---------------------------------------------------------------------------
-- Run profiles: the operator's standing agent, model, and permission choice
-- per run role in a workspace. Launch forms and handoffs pre-fill from these;
-- a later orchestrator reads them to pick a backend without a human.
-- ---------------------------------------------------------------------------

INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES
    ('run-profiles.updated', 8);

CREATE TABLE workspace_run_profiles (
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    role               TEXT NOT NULL CHECK (role IN ('implement', 'review', 'design')),
    backend            TEXT NOT NULL CHECK (backend IN ('claude-code', 'codex')),
    model              TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 100),
    permission_mode    TEXT NOT NULL CHECK (permission_mode IN ('edit-only', 'auto', 'unrestricted')),
    updated_at         TEXT NOT NULL,
    updated_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    PRIMARY KEY (workspace_id, role)
) STRICT;
