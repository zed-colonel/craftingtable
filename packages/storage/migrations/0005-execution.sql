-- ---------------------------------------------------------------------------
-- Schema 5: execution model.
--
-- Source repositories, controlled worktrees, agent runs, and the normalized
-- per-run event journal. Workspace-event and audit catalogs gain the execution
-- vocabulary; the workspace_events table itself is unchanged because the
-- schema-4 structural CHECK already permits project, work-item, and run
-- correlations for later kinds.
-- ---------------------------------------------------------------------------

INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES
    ('source-repository.register', 5),
    ('source-repository.retire',   5),
    ('worktree.create',            5),
    ('worktree.remove',            5),
    ('agent-run.start',            5),
    ('agent-run.message',          5),
    ('agent-run.end',              5),
    ('agent-run.cancel',           5),
    ('agent-run.finished',         5);

INSERT INTO workspace_event_kinds (kind, introduced_in_schema) VALUES
    ('source-repository-registered', 5),
    ('worktree-created',             5),
    ('worktree-removed',             5),
    ('agent-run-started',            5),
    ('agent-run-status-changed',     5);

CREATE TABLE source_repositories (
    id                    TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    display_name          TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
    root_path             TEXT NOT NULL CHECK (length(root_path) > 1 AND substr(root_path, 1, 1) = '/'),
    default_branch        TEXT NOT NULL CHECK (length(default_branch) BETWEEN 1 AND 255),
    registered_head_sha   TEXT NOT NULL CHECK (length(registered_head_sha) BETWEEN 7 AND 64),
    status                TEXT NOT NULL CHECK (status IN ('active', 'retired')),
    registered_at         TEXT NOT NULL,
    registered_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    retired_at            TEXT,
    version               INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK ((status = 'retired') = (retired_at IS NOT NULL)),
    UNIQUE (workspace_id, id)
) STRICT;

CREATE UNIQUE INDEX uq_source_repositories_live_path
    ON source_repositories (workspace_id, root_path)
    WHERE status = 'active';

CREATE INDEX idx_source_repositories_workspace
    ON source_repositories (workspace_id, status, registered_at, id);

CREATE TABLE worktrees (
    id                 TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    repository_id      TEXT NOT NULL,
    project_id         TEXT NOT NULL,
    work_item_id       TEXT NOT NULL,
    branch_name        TEXT NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 255),
    base_sha           TEXT NOT NULL CHECK (length(base_sha) BETWEEN 7 AND 64),
    base_branch        TEXT NOT NULL CHECK (length(base_branch) BETWEEN 1 AND 255),
    path               TEXT NOT NULL CHECK (length(path) > 1 AND substr(path, 1, 1) = '/'),
    status             TEXT NOT NULL CHECK (status IN ('active', 'removed')),
    created_at         TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    removed_at         TEXT,
    version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK ((status = 'removed') = (removed_at IS NOT NULL)),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, repository_id)
      REFERENCES source_repositories(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, project_id, work_item_id)
      REFERENCES work_items(workspace_id, project_id, id) ON DELETE RESTRICT
) STRICT;

CREATE UNIQUE INDEX uq_worktrees_live_path
    ON worktrees (path)
    WHERE status = 'active';

CREATE INDEX idx_worktrees_work_item
    ON worktrees (workspace_id, work_item_id, created_at, id);

CREATE TABLE agent_runs (
    id                 TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    worktree_id        TEXT NOT NULL,
    repository_id      TEXT NOT NULL,
    project_id         TEXT NOT NULL,
    work_item_id       TEXT NOT NULL,
    parent_run_id      TEXT,
    backend            TEXT NOT NULL CHECK (backend IN ('claude-code')),
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

CREATE INDEX idx_agent_runs_work_item
    ON agent_runs (workspace_id, work_item_id, created_at, id);

CREATE INDEX idx_agent_runs_worktree
    ON agent_runs (workspace_id, worktree_id, created_at, id);

CREATE INDEX idx_agent_runs_status
    ON agent_runs (status, workspace_id);

CREATE TABLE agent_run_events (
    sequence     INTEGER PRIMARY KEY AUTOINCREMENT,
    id           TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    run_id       TEXT NOT NULL,
    occurred_at  TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN (
                   'session-started', 'user-message', 'assistant-message',
                   'tool-call', 'tool-result', 'turn-completed',
                   'notice', 'stderr', 'run-finished')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
    raw_json     TEXT CHECK (raw_json IS NULL OR length(CAST(raw_json AS BLOB)) <= 262144),
    FOREIGN KEY (workspace_id, run_id)
      REFERENCES agent_runs(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_agent_run_events_run
    ON agent_run_events (run_id, sequence);

CREATE TRIGGER agent_run_events_no_update
    BEFORE UPDATE ON agent_run_events
BEGIN
    SELECT RAISE(ABORT, 'agent_run_events is append-only');
END;

CREATE TRIGGER agent_run_events_no_delete
    BEFORE DELETE ON agent_run_events
BEGIN
    SELECT RAISE(ABORT, 'agent_run_events is append-only');
END;
