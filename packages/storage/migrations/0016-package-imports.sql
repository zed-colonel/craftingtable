CREATE TABLE import_archives (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  digest TEXT NOT NULL,
  filename TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 0 AND 8388608),
  content BLOB NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workspace_id, digest), UNIQUE(workspace_id, id),
  CHECK(length(content) = byte_length)
) STRICT;
CREATE TABLE archive_import_attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('plan', 'concurrency')),
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  FOREIGN KEY(workspace_id, archive_id) REFERENCES import_archives(workspace_id, id)
) STRICT;
CREATE INDEX archive_attempt_workspace ON archive_import_attempts(workspace_id, kind);
CREATE TABLE concurrency_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  map_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  digest TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  UNIQUE(workspace_id, map_id, revision), UNIQUE(workspace_id, id),
  FOREIGN KEY(workspace_id, archive_id) REFERENCES import_archives(workspace_id, id)
) STRICT;
CREATE TABLE concurrency_bindings (
  workspace_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  PRIMARY KEY(workspace_id, definition_id, revision),
  FOREIGN KEY(workspace_id, definition_id) REFERENCES concurrency_definitions(workspace_id, id)
) STRICT;
CREATE TABLE plan_archive_links (
  workspace_id TEXT NOT NULL,
  plan_version_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  PRIMARY KEY(workspace_id, plan_version_id, archive_id),
  FOREIGN KEY(workspace_id, plan_version_id) REFERENCES plan_versions(workspace_id, id),
  FOREIGN KEY(workspace_id, archive_id) REFERENCES import_archives(workspace_id, id)
) STRICT;
INSERT INTO audit_action_kinds(action, introduced_in_schema) VALUES
 ('package.import', 16), ('concurrency.bindings', 16), ('plan.version-activated', 16);
CREATE TRIGGER import_archives_no_update BEFORE UPDATE ON import_archives BEGIN SELECT RAISE(ABORT, 'Archive provenance is immutable'); END;
CREATE TRIGGER import_archives_no_delete BEFORE DELETE ON import_archives BEGIN SELECT RAISE(ABORT, 'Archive provenance is immutable'); END;
CREATE TRIGGER archive_attempts_no_update BEFORE UPDATE ON archive_import_attempts BEGIN SELECT RAISE(ABORT, 'Import history is immutable'); END;
CREATE TRIGGER concurrency_definitions_no_update BEFORE UPDATE ON concurrency_definitions BEGIN SELECT RAISE(ABORT, 'Concurrency definitions are immutable'); END;
CREATE TRIGGER concurrency_definitions_no_delete BEFORE DELETE ON concurrency_definitions BEGIN SELECT RAISE(ABORT, 'Concurrency definitions are immutable'); END;
CREATE TRIGGER concurrency_bindings_no_update BEFORE UPDATE ON concurrency_bindings BEGIN SELECT RAISE(ABORT, 'Binding revisions are immutable'); END;
CREATE TRIGGER concurrency_bindings_no_delete BEFORE DELETE ON concurrency_bindings BEGIN SELECT RAISE(ABORT, 'Binding revisions are immutable'); END;
CREATE TRIGGER plan_archive_links_no_update BEFORE UPDATE ON plan_archive_links BEGIN SELECT RAISE(ABORT, 'Plan archive links are immutable'); END;
CREATE TRIGGER archive_attempts_no_delete BEFORE DELETE ON archive_import_attempts BEGIN SELECT RAISE(ABORT, 'Import history is immutable'); END;
CREATE TRIGGER plan_archive_links_no_delete BEFORE DELETE ON plan_archive_links BEGIN SELECT RAISE(ABORT, 'Plan archive links are immutable'); END;
