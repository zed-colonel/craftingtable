-- ---------------------------------------------------------------------------
-- Schema 6: the working loop closes.
--
-- Work items can be completed, worktrees can be merged into their base branch
-- behind a review verdict, runs record the model and billing source the
-- backend actually used, workspaces can be renamed, and users can change
-- their password. The CT-03 work-contract draft is retired: nothing consumed
-- it, and admission no longer produces one.
--
-- `work_items` keeps its CT-03 CHECK and admission-only trigger; completion
-- lives in its own table so the locked-down row stays immutable and the
-- status is derived by joining. SQLite cannot widen a CHECK in place.
-- ---------------------------------------------------------------------------

INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES
    ('workspace.updated',      6),
    ('user.password-changed',  6),
    ('work-item.completed',    6),
    ('worktree.merged',        6);

INSERT INTO workspace_event_kinds (kind, introduced_in_schema) VALUES
    ('workspace-updated',   6),
    ('work-item-completed', 6),
    ('worktree-merged',     6);

ALTER TABLE agent_runs ADD COLUMN resolved_model TEXT
    CHECK (resolved_model IS NULL OR length(resolved_model) BETWEEN 1 AND 100);
ALTER TABLE agent_runs ADD COLUMN billing TEXT
    CHECK (billing IS NULL OR billing IN ('subscription', 'api-key', 'unknown'));
ALTER TABLE agent_runs ADD COLUMN verdict TEXT
    CHECK (verdict IS NULL OR verdict IN ('mergeable', 'changes-requested'));

ALTER TABLE worktrees ADD COLUMN merged_at TEXT;
ALTER TABLE worktrees ADD COLUMN merge_sha TEXT
    CHECK (merge_sha IS NULL OR length(merge_sha) BETWEEN 7 AND 64);

CREATE TABLE work_item_completions (
    work_item_id         TEXT PRIMARY KEY CHECK (length(work_item_id) > 0),
    workspace_id         TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    project_id           TEXT NOT NULL,
    completed_at         TEXT NOT NULL,
    completed_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    worktree_id          TEXT,
    merge_sha            TEXT CHECK (merge_sha IS NULL OR length(merge_sha) BETWEEN 7 AND 64),
    UNIQUE (workspace_id, work_item_id),
    FOREIGN KEY (workspace_id, project_id, work_item_id)
      REFERENCES work_items(workspace_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, worktree_id)
      REFERENCES worktrees(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_work_item_completions_workspace
    ON work_item_completions (workspace_id, completed_at);

CREATE TRIGGER work_item_completions_no_update
    BEFORE UPDATE ON work_item_completions
BEGIN
    SELECT RAISE(ABORT, 'a work item completion is immutable');
END;

DROP TABLE work_contract_drafts;
