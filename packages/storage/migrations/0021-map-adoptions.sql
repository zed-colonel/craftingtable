CREATE TABLE map_adoptions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, definition_id TEXT NOT NULL,
 binding_revision INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 FOREIGN KEY(workspace_id,definition_id) REFERENCES concurrency_definitions(workspace_id,id)
) STRICT;
CREATE TRIGGER map_adoption_no_update BEFORE UPDATE ON map_adoptions BEGIN SELECT RAISE(ABORT,'Map adoptions are immutable'); END;
CREATE TRIGGER map_adoption_no_delete BEFORE DELETE ON map_adoptions BEGIN SELECT RAISE(ABORT,'Map adoptions are immutable'); END;
INSERT INTO audit_action_kinds VALUES ('concurrency.adopted',21);
