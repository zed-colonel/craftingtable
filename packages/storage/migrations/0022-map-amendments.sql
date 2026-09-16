CREATE TABLE map_amendments (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), roadmap_id TEXT NOT NULL REFERENCES roadmaps(id),
 proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)), decision_json TEXT CHECK(decision_json IS NULL OR json_valid(decision_json))
) STRICT;
CREATE UNIQUE INDEX one_pending_amendment ON map_amendments(roadmap_id) WHERE decision_json IS NULL;
CREATE TRIGGER amendment_immutable BEFORE UPDATE ON map_amendments WHEN OLD.proposal_json != NEW.proposal_json OR OLD.decision_json IS NOT NULL OR OLD.id != NEW.id OR OLD.workspace_id != NEW.workspace_id OR OLD.roadmap_id != NEW.roadmap_id BEGIN SELECT RAISE(ABORT,'Amendment proposals and decisions are immutable'); END;
CREATE TRIGGER amendment_no_delete BEFORE DELETE ON map_amendments BEGIN SELECT RAISE(ABORT,'Amendment history is immutable'); END;
CREATE TABLE scope_integration_reuse (
 id TEXT PRIMARY KEY, amendment_id TEXT NOT NULL REFERENCES map_amendments(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 work_item_id TEXT NOT NULL, definition_id TEXT NOT NULL, binding_revision INTEGER NOT NULL, source_id TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE INDEX scope_reuse_lookup ON scope_integration_reuse(workspace_id,work_item_id,definition_id,binding_revision,source_id);
CREATE TRIGGER scope_reuse_no_update BEFORE UPDATE ON scope_integration_reuse BEGIN SELECT RAISE(ABORT,'Integration provenance is immutable'); END;
CREATE TRIGGER scope_reuse_no_delete BEFORE DELETE ON scope_integration_reuse BEGIN SELECT RAISE(ABORT,'Integration provenance is immutable'); END;
CREATE TABLE retired_scope_worktrees (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), worktree_id TEXT NOT NULL, amendment_id TEXT NOT NULL REFERENCES map_amendments(id),
 PRIMARY KEY(workspace_id,worktree_id)
) STRICT;
CREATE TABLE superseded_map_bindings (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), definition_id TEXT NOT NULL, binding_revision INTEGER NOT NULL,
 amendment_id TEXT NOT NULL REFERENCES map_amendments(id), PRIMARY KEY(workspace_id,definition_id,binding_revision)
) STRICT;
INSERT INTO audit_action_kinds VALUES ('roadmap.amendment',22);

CREATE TRIGGER retired_scope_worktrees_update BEFORE UPDATE ON retired_scope_worktrees BEGIN SELECT RAISE(ABORT,'Reviewed retirement is immutable'); END;
CREATE TRIGGER retired_scope_worktrees_delete BEFORE DELETE ON retired_scope_worktrees BEGIN SELECT RAISE(ABORT,'Reviewed retirement is immutable'); END;
CREATE TRIGGER superseded_map_bindings_update BEFORE UPDATE ON superseded_map_bindings BEGIN SELECT RAISE(ABORT,'Reviewed retirement is immutable'); END;
CREATE TRIGGER superseded_map_bindings_delete BEFORE DELETE ON superseded_map_bindings BEGIN SELECT RAISE(ABORT,'Reviewed retirement is immutable'); END;
