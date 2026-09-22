ALTER TABLE workspace_run_profiles RENAME TO workspace_run_profiles_legacy;
CREATE TABLE workspace_run_profiles (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 role TEXT NOT NULL CHECK (role IN ('design','implement','review','remediate','security','checkpoint','acceptance','conflict','investigation')),
 backend TEXT NOT NULL CHECK (backend IN ('claude-code','codex')),
 model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 100),
 permission_mode TEXT NOT NULL CHECK (permission_mode IN ('edit-only','auto','unrestricted')),
 reasoning_effort TEXT CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('low','medium','high','xhigh')),
 updated_at TEXT NOT NULL,
 updated_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 PRIMARY KEY(workspace_id, role)
) STRICT;
INSERT INTO workspace_run_profiles (workspace_id,role,backend,model,permission_mode,updated_at,updated_by_user_id)
 SELECT workspace_id,role,backend,model,permission_mode,updated_at,updated_by_user_id FROM workspace_run_profiles_legacy;
DROP TABLE workspace_run_profiles_legacy;
ALTER TABLE agent_runs ADD COLUMN reasoning_effort TEXT CHECK (reasoning_effort IS NULL OR reasoning_effort IN ('low','medium','high','xhigh'));
ALTER TABLE agent_runs ADD COLUMN profile_selection_json TEXT CHECK (profile_selection_json IS NULL OR json_valid(profile_selection_json));
