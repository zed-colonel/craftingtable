CREATE TABLE notification_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE RESTRICT,
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
) STRICT;
CREATE TABLE notification_records (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  source_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'resolved')),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  UNIQUE (workspace_id, source_key)
) STRICT;
CREATE INDEX notification_active ON notification_records(workspace_id, state);
INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES ('notifications.updated', 11);
INSERT INTO workspace_event_kinds (kind, introduced_in_schema) VALUES ('notifications-changed', 11);
