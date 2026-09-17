CREATE TABLE native_verification_approvals (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 definition_id TEXT NOT NULL, binding_revision INTEGER NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 FOREIGN KEY(workspace_id,definition_id) REFERENCES concurrency_definitions(workspace_id,id)
) STRICT;
CREATE INDEX native_approval_lookup ON native_verification_approvals(workspace_id,definition_id,binding_revision);
CREATE TRIGGER native_approval_no_update BEFORE UPDATE ON native_verification_approvals BEGIN SELECT RAISE(ABORT,'Native approval history is immutable'); END;
CREATE TRIGGER native_approval_no_delete BEFORE DELETE ON native_verification_approvals BEGIN SELECT RAISE(ABORT,'Native approval history is immutable'); END;
