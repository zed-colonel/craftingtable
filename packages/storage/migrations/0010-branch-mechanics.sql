ALTER TABLE worktrees ADD COLUMN integration_branch TEXT;
ALTER TABLE agent_runs ADD COLUMN review_branch_context_json TEXT CHECK (review_branch_context_json IS NULL OR json_valid(review_branch_context_json));
CREATE TABLE plan_branch_settings (
  workspace_id TEXT NOT NULL,
  plan_version_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  integration_branch TEXT NOT NULL CHECK (length(integration_branch) BETWEEN 1 AND 255),
  updated_at TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version >= 1),
  PRIMARY KEY (workspace_id, plan_version_id),
  FOREIGN KEY (workspace_id, plan_version_id) REFERENCES plan_versions(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, repository_id) REFERENCES source_repositories(workspace_id, id) ON DELETE RESTRICT
) STRICT;
INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES ('branches.updated', 10);
INSERT INTO workspace_event_kinds (kind, introduced_in_schema) VALUES ('branches-changed', 10);

CREATE TABLE work_item_integration_evidence (
  workspace_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  commit_sha TEXT NOT NULL CHECK (length(commit_sha) BETWEEN 7 AND 64),
  recorded_at TEXT NOT NULL,
  recorded_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  PRIMARY KEY (workspace_id, work_item_id, repository_id),
  FOREIGN KEY (workspace_id, work_item_id) REFERENCES work_item_completions(workspace_id, work_item_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, repository_id) REFERENCES source_repositories(workspace_id, id) ON DELETE RESTRICT
) STRICT;
