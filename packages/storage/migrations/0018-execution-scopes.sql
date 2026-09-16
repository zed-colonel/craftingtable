ALTER TABLE worktrees ADD COLUMN execution_scope_json TEXT CHECK(execution_scope_json IS NULL OR json_valid(execution_scope_json));
CREATE TRIGGER worktree_scope_immutable BEFORE UPDATE OF execution_scope_json ON worktrees
WHEN OLD.execution_scope_json IS NOT NEW.execution_scope_json
BEGIN SELECT RAISE(ABORT, 'Execution scope is immutable'); END;
CREATE TABLE scope_receipts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  review_run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('slice', 'parent-acceptance')),
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  UNIQUE(workspace_id, worktree_id, review_run_id),
  FOREIGN KEY(workspace_id, work_item_id) REFERENCES work_items(workspace_id, id),
  FOREIGN KEY(workspace_id, worktree_id) REFERENCES worktrees(workspace_id, id),
  FOREIGN KEY(workspace_id, review_run_id) REFERENCES agent_runs(workspace_id, id)
) STRICT;
CREATE TRIGGER scope_receipts_no_update BEFORE UPDATE ON scope_receipts BEGIN SELECT RAISE(ABORT, 'Scope evidence is immutable'); END;
CREATE TRIGGER scope_receipts_no_delete BEFORE DELETE ON scope_receipts BEGIN SELECT RAISE(ABORT, 'Scope evidence is immutable'); END;
CREATE TRIGGER sliced_parent_completion BEFORE INSERT ON work_item_completions
WHEN EXISTS(SELECT 1 FROM worktrees WHERE workspace_id=NEW.workspace_id AND work_item_id=NEW.work_item_id AND execution_scope_json IS NOT NULL)
 AND NOT EXISTS(SELECT 1 FROM scope_receipts WHERE workspace_id=NEW.workspace_id AND work_item_id=NEW.work_item_id AND kind='parent-acceptance')
BEGIN SELECT RAISE(ABORT, 'Slice parents require acceptance evidence'); END;

INSERT INTO audit_action_kinds(action, introduced_in_schema) VALUES ('scope.evidence-recorded', 18);

INSERT INTO workspace_event_kinds(kind, introduced_in_schema) VALUES ('scope-evidence-recorded', 18);

-- The earlier whole-item uniqueness rule must permit independently owned sibling slices.
DROP INDEX uq_work_cycles_item;
CREATE UNIQUE INDEX uq_work_cycles_item ON work_cycles(
  workspace_id, work_item_id,
  COALESCE(json_extract(state_json, '$.executionScope.definitionId'), ''),
  COALESCE(json_extract(state_json, '$.executionScope.bindingRevision'), 0),
  COALESCE(json_extract(state_json, '$.executionScope.kind'), ''),
  COALESCE(json_extract(state_json, '$.executionScope.sourceId'), '')
) WHERE work_item_id IS NOT NULL AND status NOT IN ('stopped', 'completed');
CREATE TRIGGER work_cycle_scope_immutable BEFORE UPDATE ON work_cycles
WHEN json_extract(NEW.state_json, '$.executionScope.definitionId') IS NOT json_extract(OLD.state_json, '$.executionScope.definitionId')
 OR json_extract(NEW.state_json, '$.executionScope.bindingRevision') IS NOT json_extract(OLD.state_json, '$.executionScope.bindingRevision')
 OR json_extract(NEW.state_json, '$.executionScope.kind') IS NOT json_extract(OLD.state_json, '$.executionScope.kind')
 OR json_extract(NEW.state_json, '$.executionScope.sourceId') IS NOT json_extract(OLD.state_json, '$.executionScope.sourceId')
BEGIN SELECT RAISE(ABORT, 'Cycle scope is immutable'); END;
