CREATE TABLE runtime_generations (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, definition_id TEXT NOT NULL,
 binding_revision INTEGER NOT NULL, generation INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 UNIQUE(workspace_id,definition_id,binding_revision,generation),
 FOREIGN KEY(workspace_id,definition_id) REFERENCES concurrency_definitions(workspace_id,id)
) STRICT;
CREATE TABLE evidence_submissions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), runtime_id TEXT NOT NULL REFERENCES runtime_generations(id),
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(workspace_id,id)
) STRICT;
CREATE TABLE evidence_decisions (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, submission_id TEXT NOT NULL UNIQUE,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)), FOREIGN KEY(workspace_id,submission_id) REFERENCES evidence_submissions(workspace_id,id)
) STRICT;
CREATE TABLE run_environments (
 run_id TEXT PRIMARY KEY REFERENCES agent_runs(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 runtime_id TEXT NOT NULL REFERENCES runtime_generations(id), record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE TRIGGER runtime_generation_no_update BEFORE UPDATE ON runtime_generations BEGIN SELECT RAISE(ABORT,'Runtime generations are immutable'); END;
CREATE TRIGGER runtime_generation_no_delete BEFORE DELETE ON runtime_generations BEGIN SELECT RAISE(ABORT,'Runtime generations are immutable'); END;
CREATE TRIGGER evidence_submission_no_update BEFORE UPDATE ON evidence_submissions BEGIN SELECT RAISE(ABORT,'Evidence is immutable'); END;
CREATE TRIGGER evidence_submission_no_delete BEFORE DELETE ON evidence_submissions BEGIN SELECT RAISE(ABORT,'Evidence is immutable'); END;
CREATE TRIGGER evidence_decision_no_update BEFORE UPDATE ON evidence_decisions BEGIN SELECT RAISE(ABORT,'Evidence decisions are immutable'); END;
CREATE TRIGGER evidence_decision_no_delete BEFORE DELETE ON evidence_decisions BEGIN SELECT RAISE(ABORT,'Evidence decisions are immutable'); END;
CREATE TRIGGER run_environment_no_update BEFORE UPDATE ON run_environments BEGIN SELECT RAISE(ABORT,'Run environments are immutable'); END;
CREATE TRIGGER run_environment_no_delete BEFORE DELETE ON run_environments BEGIN SELECT RAISE(ABORT,'Run environments are immutable'); END;
INSERT INTO audit_action_kinds VALUES ('runtime.configured',20),('evidence.submitted',20),('evidence.decided',20);
INSERT INTO workspace_event_kinds VALUES ('runtime-evidence-changed',20);

CREATE TABLE run_build_records (run_id TEXT PRIMARY KEY REFERENCES run_environments(run_id), workspace_id TEXT NOT NULL REFERENCES workspaces(id), record_json TEXT NOT NULL CHECK(json_valid(record_json))) STRICT;
CREATE TRIGGER run_build_record_no_update BEFORE UPDATE ON run_build_records BEGIN SELECT RAISE(ABORT,'Build records are immutable'); END;
CREATE TRIGGER run_build_record_no_delete BEFORE DELETE ON run_build_records BEGIN SELECT RAISE(ABORT,'Build records are immutable'); END;
