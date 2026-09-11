CREATE TABLE roadmaps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('draft','running','paused','needs-attention','stopped','completed')),
  version INTEGER NOT NULL CHECK (version > 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json)),
  CHECK (json_extract(state_json, '$.id') = id),
  CHECK (json_extract(state_json, '$.workspaceId') = workspace_id),
  CHECK (json_extract(state_json, '$.version') = version),
  CHECK (json_extract(state_json, '$.status') = status)
) STRICT;
CREATE UNIQUE INDEX roadmap_workspace_delegation ON roadmaps(workspace_id)
  WHERE status IN ('running','paused','needs-attention');
CREATE TABLE roadmap_definitions (
  roadmap_id TEXT NOT NULL REFERENCES roadmaps(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK (revision > 0),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  PRIMARY KEY (roadmap_id, revision),
  CHECK (json_extract(definition_json, '$.roadmapId') = roadmap_id),
  CHECK (json_extract(definition_json, '$.revision') = revision)
) STRICT;
CREATE TRIGGER roadmap_definition_immutable_update BEFORE UPDATE ON roadmap_definitions BEGIN
  SELECT RAISE(ABORT, 'Roadmap definitions are immutable');
END;
CREATE TRIGGER roadmap_definition_immutable_delete BEFORE DELETE ON roadmap_definitions BEGIN
  SELECT RAISE(ABORT, 'Roadmap definitions are immutable');
END;
INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES ('roadmap.updated', 12);
INSERT INTO workspace_event_kinds (kind, introduced_in_schema) VALUES ('roadmap-changed', 12);
