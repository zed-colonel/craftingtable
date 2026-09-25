-- R-F7 (ADR-069): an operator-approved declaration of the slice whose merge moves each
-- consumer→upstream link to the current pin, for a definition whose map does not declare it.
-- It applies to that definition only; the next map revision carries the declarations itself.
CREATE TABLE upstream_transition_records (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 definition_id TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 FOREIGN KEY(workspace_id,definition_id) REFERENCES concurrency_definitions(workspace_id,id)
) STRICT;
CREATE INDEX upstream_transition_lookup ON upstream_transition_records(workspace_id,definition_id);
CREATE TRIGGER upstream_transition_no_update BEFORE UPDATE ON upstream_transition_records BEGIN SELECT RAISE(ABORT,'Upstream transition records are immutable'); END;
CREATE TRIGGER upstream_transition_no_delete BEFORE DELETE ON upstream_transition_records BEGIN SELECT RAISE(ABORT,'Upstream transition records are immutable'); END;
