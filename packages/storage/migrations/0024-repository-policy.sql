-- Immutable, operator-adopted plan repository policy revisions, separate from branch bindings.
CREATE TABLE plan_repository_policies (
  workspace_id TEXT NOT NULL,
  plan_version_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  state_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, plan_version_id, version),
  FOREIGN KEY (workspace_id, plan_version_id) REFERENCES plan_versions(workspace_id, id)
);
