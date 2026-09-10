INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES ('work-cycle.updated', 9);
INSERT INTO workspace_event_kinds (kind, introduced_in_schema) VALUES ('work-cycle-changed', 9);

CREATE TABLE work_cycles (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    work_item_id TEXT NOT NULL,
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
) STRICT;
CREATE UNIQUE INDEX uq_work_cycles_item ON work_cycles(workspace_id, work_item_id)
    WHERE status NOT IN ('stopped', 'completed');
CREATE UNIQUE INDEX uq_work_cycles_worktree ON work_cycles(workspace_id, worktree_id)
    WHERE status NOT IN ('stopped', 'completed');
