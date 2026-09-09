-- requires: foreign_keys=off
-- Rebuild only agent_runs to widen its backend CHECK; preserve child journals.
CREATE TABLE agent_runs_new (
    id                 TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    worktree_id        TEXT NOT NULL,
    repository_id      TEXT NOT NULL,
    project_id         TEXT NOT NULL,
    work_item_id       TEXT NOT NULL,
    parent_run_id      TEXT,
    backend            TEXT NOT NULL CHECK (backend IN ('claude-code', 'codex')),
    role               TEXT NOT NULL CHECK (role IN ('implement', 'review', 'design')),
    status             TEXT NOT NULL CHECK (status IN (
                         'starting', 'running', 'waiting',
                         'finished', 'failed', 'cancelled', 'interrupted')),
    permission_mode    TEXT NOT NULL CHECK (permission_mode IN ('edit-only', 'auto', 'unrestricted')),
    model              TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 100),
    brief              TEXT NOT NULL CHECK (length(brief) BETWEEN 1 AND 400000),
    backend_session_id TEXT CHECK (backend_session_id IS NULL OR length(backend_session_id) BETWEEN 1 AND 200),
    created_at         TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    started_at         TEXT,
    finished_at        TEXT,
    exit_code          INTEGER,
    outcome_summary    TEXT CHECK (outcome_summary IS NULL OR length(outcome_summary) <= 4000),
    cost_usd           REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
    turn_count         INTEGER NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
    version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    resolved_model TEXT CHECK (resolved_model IS NULL OR length(resolved_model) BETWEEN 1 AND 100),
    billing TEXT CHECK (billing IS NULL OR billing IN ('subscription', 'api-key', 'unknown')),
    verdict TEXT CHECK (verdict IS NULL OR verdict IN ('mergeable', 'changes-requested')),
    CHECK ((status IN ('finished', 'failed', 'cancelled', 'interrupted')) = (finished_at IS NOT NULL)),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, worktree_id)
      REFERENCES worktrees(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, repository_id)
      REFERENCES source_repositories(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, project_id, work_item_id)
      REFERENCES work_items(workspace_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, parent_run_id)
      REFERENCES agent_runs(workspace_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO agent_runs_new SELECT
    id, workspace_id, worktree_id, repository_id, project_id, work_item_id,
    parent_run_id, backend, role, status, permission_mode, model, brief,
    backend_session_id, created_at, created_by_user_id, started_at, finished_at,
    exit_code, outcome_summary, cost_usd, turn_count, version,
    resolved_model, billing, verdict
FROM agent_runs;
DROP TABLE agent_runs;
ALTER TABLE agent_runs_new RENAME TO agent_runs;

CREATE INDEX idx_agent_runs_work_item
    ON agent_runs (workspace_id, work_item_id, created_at, id);

CREATE INDEX idx_agent_runs_worktree
    ON agent_runs (workspace_id, worktree_id, created_at, id);

CREATE INDEX idx_agent_runs_status
    ON agent_runs (status, workspace_id);

