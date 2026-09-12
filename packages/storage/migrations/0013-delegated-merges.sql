CREATE TABLE merge_operations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  worktree_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('reserved','failed','merged','cleaned')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  FOREIGN KEY (workspace_id, worktree_id) REFERENCES worktrees(workspace_id, id) ON DELETE RESTRICT,
  CHECK (json_extract(state_json, '$.id') = id),
  CHECK (json_extract(state_json, '$.workspaceId') = workspace_id),
  CHECK (json_extract(state_json, '$.worktreeId') = worktree_id),
  CHECK (json_extract(state_json, '$.status') = status)
) STRICT;
CREATE UNIQUE INDEX pending_worktree_merge ON merge_operations(worktree_id)
  WHERE status IN ('reserved','merged');
ALTER TABLE plan_branch_settings ADD COLUMN manual_merge_branches_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(manual_merge_branches_json));
