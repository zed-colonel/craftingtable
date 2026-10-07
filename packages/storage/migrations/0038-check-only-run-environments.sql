-- requires: foreign_keys=off
-- R-G13 increment 4 (operator decision 2026-10-06, D1): a run with no pinned dependency
-- environment is held to its repository's adopted checks through a check-only manifest, so its
-- run environment has no runtime. `run_environments.runtime_id` becomes nullable; a row without
-- one must be held to an adopted declaration and recorded by the daemon. Every existing row,
-- the immutability triggers, and the build records and check receipts that reference the table
-- are kept. A release before this schema cannot read a record without a runtime.

CREATE TABLE migration_0038_guard (
    checkpoint TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

CREATE TABLE run_environments_new (
 run_id TEXT PRIMARY KEY REFERENCES agent_runs(id), workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 runtime_id TEXT REFERENCES runtime_generations(id), record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 CHECK (runtime_id IS NOT NULL OR (
   json_type(record_json, '$.checkDeclarationId') IS 'text'
   AND json_extract(record_json, '$.receiptAuthority') IS 'daemon'
   AND json_type(record_json, '$.runtimeId') IS NULL))
) STRICT;

INSERT INTO run_environments_new (run_id, workspace_id, runtime_id, record_json)
SELECT run_id, workspace_id, runtime_id, record_json FROM run_environments ORDER BY rowid;

-- Every row copied unchanged, or the whole migration rolls back.
INSERT INTO migration_0038_guard (checkpoint, ok)
SELECT 'run_environments', CASE WHEN
    (SELECT COUNT(*) FROM run_environments_new) = (SELECT COUNT(*) FROM run_environments)
    AND NOT EXISTS (
      SELECT run_id, workspace_id, runtime_id, record_json FROM run_environments
      EXCEPT
      SELECT run_id, workspace_id, runtime_id, record_json FROM run_environments_new)
  THEN 1 ELSE 0 END;

DROP TABLE run_environments;

ALTER TABLE run_environments_new RENAME TO run_environments;

CREATE TRIGGER run_environment_no_update BEFORE UPDATE ON run_environments BEGIN SELECT RAISE(ABORT,'Run environments are immutable'); END;
CREATE TRIGGER run_environment_no_delete BEFORE DELETE ON run_environments BEGIN SELECT RAISE(ABORT,'Run environments are immutable'); END;

-- The build records and check receipts still name this table.
INSERT INTO migration_0038_guard (checkpoint, ok)
SELECT 'references', CASE WHEN
    (SELECT COUNT(*) FROM pragma_foreign_key_list('run_build_records')
       WHERE "table" = 'run_environments' AND "from" = 'run_id' AND "to" = 'run_id') = 1
    AND (SELECT COUNT(*) FROM pragma_foreign_key_list('run_check_receipts')
       WHERE "table" = 'run_environments' AND "from" = 'run_id' AND "to" = 'run_id') = 1
  THEN 1 ELSE 0 END;

DROP TABLE migration_0038_guard;
