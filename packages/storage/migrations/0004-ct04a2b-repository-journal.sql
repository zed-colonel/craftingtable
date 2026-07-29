-- CT-04A2b1 schema version 4: repository workspace-event correlations.
--
-- The database proves structural ownership. Strict contracts prove payload
-- semantics, including payload/structural ID agreement and retirement cause.
-- This migration therefore contains no per-kind JSON-path constraint.

INSERT INTO workspace_event_kinds (kind, introduced_in_schema) VALUES
    ('repository-registered',                    4),
    ('repository-status-changed',                4),
    ('repository-evidence-changed',              4),
    ('project-repository-bound',                  4),
    ('project-repository-binding-retired',        4);

CREATE TABLE migration_0004_state (
    singleton                INTEGER PRIMARY KEY CHECK (singleton = 1),
    row_count                INTEGER NOT NULL CHECK (row_count >= 0),
    max_sequence             INTEGER NOT NULL CHECK (max_sequence >= 0),
    sequence_row_was_present INTEGER NOT NULL CHECK (sequence_row_was_present IN (0, 1)),
    sequence_value           INTEGER NOT NULL CHECK (sequence_value >= 0)
) STRICT;

INSERT INTO migration_0004_state (
    singleton,
    row_count,
    max_sequence,
    sequence_row_was_present,
    sequence_value
)
SELECT
    1,
    COUNT(*),
    COALESCE(MAX(sequence), 0),
    EXISTS(SELECT 1 FROM sqlite_sequence WHERE name = 'workspace_events'),
    COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'workspace_events'), 0)
FROM workspace_events;

CREATE TABLE migration_0004_guard (
    checkpoint TEXT PRIMARY KEY CHECK (length(checkpoint) > 0),
    ok         INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

DROP TRIGGER workspace_events_no_update;
DROP TRIGGER workspace_events_no_delete;
ALTER TABLE workspace_events RENAME TO workspace_events_schema3;
DROP INDEX idx_workspace_events_workspace_sequence;

CREATE TABLE workspace_events (
    sequence                    INTEGER PRIMARY KEY AUTOINCREMENT,
    id                          TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
    schema_version              INTEGER NOT NULL CHECK (schema_version = 1),
    occurred_at                 TEXT NOT NULL,
    workspace_id                TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    actor_user_id               TEXT REFERENCES users(id) ON DELETE RESTRICT,
    project_id                  TEXT,
    work_item_id                TEXT,
    run_id                      TEXT,
    repository_id               TEXT,
    repository_inspection_id    TEXT,
    repository_binding_id       TEXT,
    kind                        TEXT NOT NULL
                                  REFERENCES workspace_event_kinds(kind) ON DELETE RESTRICT,
    -- Kind-agnostic here. Registered vocabulary does not make a payload
    -- semantically valid; strict per-kind meaning remains in contracts.
    payload_json                TEXT NOT NULL CHECK (
                                  json_valid(payload_json)
                                  AND json_type(payload_json) = 'object'),
    CHECK (work_item_id IS NULL OR project_id IS NOT NULL),
    -- Known kinds receive exact structural correlation shapes. An unlisted
    -- future kind is forced to all-NULL repository correlations.
    CHECK (
      CASE
        WHEN kind IN (
          'workspace-created',
          'project-created',
          'plan-version-imported',
          'work-item-admitted'
        ) THEN
          repository_id IS NULL
          AND repository_inspection_id IS NULL
          AND repository_binding_id IS NULL

        WHEN kind = 'repository-registered' THEN
          repository_id IS NOT NULL
          AND repository_inspection_id IS NOT NULL
          AND repository_binding_id IS NULL
          AND project_id IS NULL
          AND work_item_id IS NULL
          AND run_id IS NULL

        WHEN kind = 'repository-status-changed' THEN
          repository_id IS NOT NULL
          AND repository_binding_id IS NULL
          AND project_id IS NULL
          AND work_item_id IS NULL
          AND run_id IS NULL

        WHEN kind = 'repository-evidence-changed' THEN
          repository_id IS NOT NULL
          AND repository_inspection_id IS NOT NULL
          AND repository_binding_id IS NULL
          AND project_id IS NULL
          AND work_item_id IS NULL
          AND run_id IS NULL

        WHEN kind IN (
          'project-repository-bound',
          'project-repository-binding-retired'
        ) THEN
          repository_id IS NOT NULL
          AND repository_inspection_id IS NULL
          AND repository_binding_id IS NOT NULL
          AND project_id IS NOT NULL
          AND work_item_id IS NULL
          AND run_id IS NULL

        ELSE
          repository_id IS NULL
          AND repository_inspection_id IS NULL
          AND repository_binding_id IS NULL
      END
    ),
    FOREIGN KEY (workspace_id, project_id)
      REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, work_item_id)
      REFERENCES work_items(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, project_id, work_item_id)
      REFERENCES work_items(workspace_id, project_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, repository_id)
      REFERENCES registered_repositories(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, repository_id, repository_inspection_id)
      REFERENCES repository_inspections(workspace_id, repository_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, project_id, repository_id, repository_binding_id)
      REFERENCES project_repository_bindings(workspace_id, project_id, repository_id, id)
      ON DELETE RESTRICT
) STRICT;

INSERT INTO workspace_events (
    sequence,
    id,
    schema_version,
    occurred_at,
    workspace_id,
    actor_user_id,
    project_id,
    work_item_id,
    run_id,
    repository_id,
    repository_inspection_id,
    repository_binding_id,
    kind,
    payload_json
)
SELECT
    sequence,
    id,
    schema_version,
    occurred_at,
    workspace_id,
    actor_user_id,
    project_id,
    work_item_id,
    run_id,
    NULL,
    NULL,
    NULL,
    kind,
    payload_json
FROM workspace_events_schema3
ORDER BY sequence;

-- Explicit sequence inserts only restore MAX(sequence), not a deleted
-- AUTOINCREMENT high-water. Replace the generated row with the captured value,
-- or normalize a previously absent empty-journal row to zero.
DELETE FROM sqlite_sequence WHERE name = 'workspace_events';
INSERT INTO sqlite_sequence (name, seq)
SELECT
    'workspace_events',
    CASE
      WHEN sequence_row_was_present = 1 THEN sequence_value
      ELSE 0
    END
FROM migration_0004_state
WHERE singleton = 1;

CREATE INDEX idx_workspace_events_workspace_sequence
    ON workspace_events(workspace_id, sequence);

CREATE TRIGGER workspace_events_no_update
BEFORE UPDATE ON workspace_events
BEGIN
  SELECT RAISE(ABORT, 'workspace events are append-only');
END;

CREATE TRIGGER workspace_events_no_delete
BEFORE DELETE ON workspace_events
BEGIN
  SELECT RAISE(ABORT, 'workspace events are append-only');
END;

-- Exact old-row preservation, including payload bytes and issued sequence
-- high-water. The sentinel is changed exactly once by the rollback test.
INSERT INTO migration_0004_guard (checkpoint, ok)
SELECT 'legacy-row-preservation', CASE WHEN
    1 /* B1_GUARD_TEST_SENTINEL */
    AND (SELECT COUNT(*) FROM workspace_events)
      = (SELECT row_count FROM migration_0004_state WHERE singleton = 1)
    AND COALESCE((SELECT MAX(sequence) FROM workspace_events), 0)
      = (SELECT max_sequence FROM migration_0004_state WHERE singleton = 1)
    AND NOT EXISTS (
      SELECT
        sequence,
        id,
        schema_version,
        occurred_at,
        workspace_id,
        actor_user_id,
        project_id,
        work_item_id,
        run_id,
        kind,
        hex(CAST(payload_json AS BLOB))
      FROM workspace_events_schema3
      EXCEPT
      SELECT
        sequence,
        id,
        schema_version,
        occurred_at,
        workspace_id,
        actor_user_id,
        project_id,
        work_item_id,
        run_id,
        kind,
        hex(CAST(payload_json AS BLOB))
      FROM workspace_events
    )
    AND NOT EXISTS (
      SELECT
        sequence,
        id,
        schema_version,
        occurred_at,
        workspace_id,
        actor_user_id,
        project_id,
        work_item_id,
        run_id,
        kind,
        hex(CAST(payload_json AS BLOB))
      FROM workspace_events
      EXCEPT
      SELECT
        sequence,
        id,
        schema_version,
        occurred_at,
        workspace_id,
        actor_user_id,
        project_id,
        work_item_id,
        run_id,
        kind,
        hex(CAST(payload_json AS BLOB))
      FROM workspace_events_schema3
    )
    AND NOT EXISTS (
      SELECT 1
      FROM workspace_events
      WHERE repository_id IS NOT NULL
         OR repository_inspection_id IS NOT NULL
         OR repository_binding_id IS NOT NULL
    )
  THEN 1 ELSE 0 END;

INSERT INTO migration_0004_guard (checkpoint, ok)
SELECT 'sequence-preservation', CASE WHEN
    (SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'workspace_events') = 1
    AND (SELECT seq FROM sqlite_sequence WHERE name = 'workspace_events')
      = (
        SELECT CASE
          WHEN sequence_row_was_present = 1 THEN sequence_value
          ELSE 0
        END
        FROM migration_0004_state
        WHERE singleton = 1
      )
    AND (
      SELECT sequence_row_was_present = 0 OR sequence_value >= max_sequence
      FROM migration_0004_state
      WHERE singleton = 1
    )
  THEN 1 ELSE 0 END;

WITH expected(kind, introduced_in_schema) AS (
  VALUES
    ('workspace-created', 1),
    ('project-created', 2),
    ('plan-version-imported', 2),
    ('work-item-admitted', 2),
    ('repository-registered', 4),
    ('repository-status-changed', 4),
    ('repository-evidence-changed', 4),
    ('project-repository-bound', 4),
    ('project-repository-binding-retired', 4)
)
INSERT INTO migration_0004_guard (checkpoint, ok)
SELECT 'event-kind-catalog', CASE WHEN
    (SELECT COUNT(*) FROM workspace_event_kinds) = 9
    AND NOT EXISTS (
      SELECT kind, introduced_in_schema FROM expected
      EXCEPT
      SELECT kind, introduced_in_schema FROM workspace_event_kinds
    )
    AND NOT EXISTS (
      SELECT kind, introduced_in_schema FROM workspace_event_kinds
      EXCEPT
      SELECT kind, introduced_in_schema FROM expected
    )
  THEN 1 ELSE 0 END;

WITH expected(type, name, tbl_name) AS (
  VALUES
    ('index', 'idx_workspace_events_workspace_sequence', 'workspace_events'),
    ('trigger', 'workspace_events_no_update', 'workspace_events'),
    ('trigger', 'workspace_events_no_delete', 'workspace_events')
)
INSERT INTO migration_0004_guard (checkpoint, ok)
SELECT 'schema-catalog', CASE WHEN
    NOT EXISTS (
      SELECT type, name, tbl_name FROM expected
      EXCEPT
      SELECT type, name, tbl_name
      FROM sqlite_master
      WHERE name IN (
        'idx_workspace_events_workspace_sequence',
        'workspace_events_no_update',
        'workspace_events_no_delete'
      )
    )
    AND NOT EXISTS (
      SELECT type, name, tbl_name
      FROM sqlite_master
      WHERE name IN (
        'idx_workspace_events_workspace_sequence',
        'workspace_events_no_update',
        'workspace_events_no_delete'
      )
      EXCEPT
      SELECT type, name, tbl_name FROM expected
    )
  THEN 1 ELSE 0 END;

INSERT INTO migration_0004_guard (checkpoint, ok)
SELECT 'pre-drop-database-checks', CASE WHEN
    NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
    AND (SELECT COUNT(*) FROM pragma_integrity_check) = 1
    AND NOT EXISTS (
      SELECT 1 FROM pragma_integrity_check WHERE integrity_check <> 'ok'
    )
  THEN 1 ELSE 0 END;

DROP TABLE workspace_events_schema3;

INSERT INTO migration_0004_guard (checkpoint, ok)
SELECT 'post-drop-state', CASE WHEN
    NOT EXISTS (
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'workspace_events_schema3'
    )
    AND (SELECT COUNT(*) FROM workspace_events)
      = (SELECT row_count FROM migration_0004_state WHERE singleton = 1)
    AND COALESCE((SELECT MAX(sequence) FROM workspace_events), 0)
      = (SELECT max_sequence FROM migration_0004_state WHERE singleton = 1)
    AND (SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'workspace_events') = 1
    AND (SELECT seq FROM sqlite_sequence WHERE name = 'workspace_events')
      = (
        SELECT CASE
          WHEN sequence_row_was_present = 1 THEN sequence_value
          ELSE 0
        END
        FROM migration_0004_state
        WHERE singleton = 1
      )
    AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check)
    AND (SELECT COUNT(*) FROM pragma_integrity_check) = 1
    AND NOT EXISTS (
      SELECT 1 FROM pragma_integrity_check WHERE integrity_check <> 'ok'
    )
  THEN 1 ELSE 0 END;

DROP TABLE migration_0004_state;
DROP TABLE migration_0004_guard;
