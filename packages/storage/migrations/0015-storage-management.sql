CREATE TABLE storage_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CHECK (version > 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
) STRICT;
CREATE TABLE run_directories (
  run_id TEXT PRIMARY KEY REFERENCES agent_runs(id) ON DELETE RESTRICT,
  path TEXT NOT NULL UNIQUE,
  device INTEGER NOT NULL
) STRICT;
CREATE TABLE storage_backups (
  path TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes >= 0)
) STRICT;
INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES
  ('storage.updated', 15), ('storage.cleaned', 15), ('storage.backup', 15);
