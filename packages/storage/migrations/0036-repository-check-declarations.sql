-- R-G13 (operator decision 2026-09-29): the checks a repository's scoped gates require, adopted
-- by the operator from a file read at a named commit. Each adoption is a new version; a record is
-- never changed, so a run's manifest can name the version it was held to.
CREATE TABLE repository_check_declarations (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 repository_id TEXT NOT NULL,
 version INTEGER NOT NULL CHECK(version > 0),
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 UNIQUE(workspace_id,repository_id,version),
 FOREIGN KEY(workspace_id,repository_id) REFERENCES source_repositories(workspace_id,id)
) STRICT;
CREATE TRIGGER repository_check_declarations_no_update BEFORE UPDATE ON repository_check_declarations BEGIN SELECT RAISE(ABORT,'Repository check declarations are immutable'); END;
CREATE TRIGGER repository_check_declarations_no_delete BEFORE DELETE ON repository_check_declarations BEGIN SELECT RAISE(ABORT,'Repository check declarations are immutable'); END;
INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES
  ('repository-checks.adopted', 36);
