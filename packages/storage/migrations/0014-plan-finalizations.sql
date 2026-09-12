-- requires: foreign_keys=off

-- Preserve execution history while permitting an explicit plan-level subject.

CREATE TABLE worktrees_new (
    id                 TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    repository_id      TEXT NOT NULL,
    project_id         TEXT NOT NULL,
    plan_version_id TEXT,
    work_item_id       TEXT,
    branch_name        TEXT NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 255),
    base_sha           TEXT NOT NULL CHECK (length(base_sha) BETWEEN 7 AND 64),
    base_branch        TEXT NOT NULL CHECK (length(base_branch) BETWEEN 1 AND 255),
    path               TEXT NOT NULL CHECK (length(path) > 1 AND substr(path, 1, 1) = '/'),
    status             TEXT NOT NULL CHECK (status IN ('active', 'removed')),
    created_at         TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    removed_at         TEXT,
    version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1), merged_at TEXT, merge_sha TEXT
    CHECK (merge_sha IS NULL OR length(merge_sha) BETWEEN 7 AND 64), integration_branch TEXT,
    CHECK ((status = 'removed') = (removed_at IS NOT NULL)),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, repository_id)
      REFERENCES source_repositories(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, project_id, work_item_id)
      REFERENCES work_items(workspace_id, project_id, id) ON DELETE RESTRICT
,
    CHECK ((work_item_id IS NOT NULL) != (plan_version_id IS NOT NULL)),
    FOREIGN KEY (workspace_id, plan_version_id) REFERENCES plan_versions(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, plan_version_id) REFERENCES plan_versions(project_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO worktrees_new (id, workspace_id, repository_id, project_id, work_item_id, branch_name, base_sha, base_branch, path, status, created_at, created_by_user_id, removed_at, version, merged_at, merge_sha, integration_branch) SELECT id, workspace_id, repository_id, project_id, work_item_id, branch_name, base_sha, base_branch, path, status, created_at, created_by_user_id, removed_at, version, merged_at, merge_sha, integration_branch FROM worktrees;

DROP TABLE worktrees;

ALTER TABLE worktrees_new RENAME TO worktrees;

CREATE UNIQUE INDEX uq_worktrees_live_path
    ON worktrees (path)
    WHERE status = 'active';

CREATE INDEX idx_worktrees_work_item
    ON worktrees (workspace_id, work_item_id, created_at, id);

CREATE TABLE agent_runs_new (
    id                 TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    worktree_id        TEXT NOT NULL,
    repository_id      TEXT NOT NULL,
    project_id         TEXT NOT NULL,
    plan_version_id TEXT,
    work_item_id       TEXT,
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
    verdict TEXT CHECK (verdict IS NULL OR verdict IN ('mergeable', 'changes-requested')), review_branch_context_json TEXT CHECK (review_branch_context_json IS NULL OR json_valid(review_branch_context_json)),
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
,
    CHECK ((work_item_id IS NOT NULL) != (plan_version_id IS NOT NULL)),
    FOREIGN KEY (workspace_id, plan_version_id) REFERENCES plan_versions(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (project_id, plan_version_id) REFERENCES plan_versions(project_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO agent_runs_new (id, workspace_id, worktree_id, repository_id, project_id, work_item_id, parent_run_id, backend, role, status, permission_mode, model, brief, backend_session_id, created_at, created_by_user_id, started_at, finished_at, exit_code, outcome_summary, cost_usd, turn_count, version, resolved_model, billing, verdict, review_branch_context_json) SELECT id, workspace_id, worktree_id, repository_id, project_id, work_item_id, parent_run_id, backend, role, status, permission_mode, model, brief, backend_session_id, created_at, created_by_user_id, started_at, finished_at, exit_code, outcome_summary, cost_usd, turn_count, version, resolved_model, billing, verdict, review_branch_context_json FROM agent_runs;

DROP TABLE agent_runs;

ALTER TABLE agent_runs_new RENAME TO agent_runs;

CREATE INDEX idx_agent_runs_work_item
    ON agent_runs (workspace_id, work_item_id, created_at, id);

CREATE INDEX idx_agent_runs_worktree
    ON agent_runs (workspace_id, worktree_id, created_at, id);

CREATE INDEX idx_agent_runs_status
    ON agent_runs (status, workspace_id);

CREATE TABLE work_cycles_new (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    work_item_id TEXT,
    worktree_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'needs-attention', 'awaiting-merge', 'stopped', 'completed')),
    version INTEGER NOT NULL CHECK (version >= 1),
    state_json TEXT NOT NULL CHECK (json_valid(state_json)),
    FOREIGN KEY (workspace_id, work_item_id) REFERENCES work_items(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, worktree_id) REFERENCES worktrees(workspace_id, id) ON DELETE RESTRICT,
    CHECK (json_extract(state_json, '$.id') = id),
    CHECK (json_extract(state_json, '$.workspaceId') = workspace_id),
    CHECK (json_extract(state_json, '$.workItemId') = work_item_id),
    CHECK (json_extract(state_json, '$.worktreeId') = worktree_id),
    CHECK (json_extract(state_json, '$.status') = status),
    CHECK (json_extract(state_json, '$.version') = version)
,
    CHECK ((work_item_id IS NOT NULL) != (json_type(state_json, '$.finalizationId') IS 'text'))
) STRICT;

INSERT INTO work_cycles_new (id, workspace_id, work_item_id, worktree_id, status, version, state_json) SELECT id, workspace_id, work_item_id, worktree_id, status, version, state_json FROM work_cycles;

DROP TABLE work_cycles;

ALTER TABLE work_cycles_new RENAME TO work_cycles;

CREATE UNIQUE INDEX uq_work_cycles_item ON work_cycles(workspace_id, work_item_id)
    WHERE status NOT IN ('stopped', 'completed');

CREATE UNIQUE INDEX uq_work_cycles_worktree ON work_cycles(workspace_id, worktree_id)
    WHERE status NOT IN ('stopped', 'completed');

CREATE TABLE finalizations (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 plan_version_id TEXT NOT NULL,
 status TEXT NOT NULL CHECK (status IN ('preparing','active','stopped','completed')),
 version INTEGER NOT NULL CHECK (version > 0),
 state_json TEXT NOT NULL CHECK (json_valid(state_json)),
 FOREIGN KEY (workspace_id, plan_version_id) REFERENCES plan_versions(workspace_id, id) ON DELETE RESTRICT,
 CHECK (json_extract(state_json, '$.id') = id),
 CHECK (json_extract(state_json, '$.workspaceId') = workspace_id),
 CHECK (json_extract(state_json, '$.planVersionId') = plan_version_id),
 CHECK (json_extract(state_json, '$.version') = version),
 CHECK (json_extract(state_json, '$.status') = status)
) STRICT;
CREATE UNIQUE INDEX active_plan_finalization ON finalizations(workspace_id, plan_version_id) WHERE status IN ('preparing','active');
INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES ('finalization.updated', 14);

