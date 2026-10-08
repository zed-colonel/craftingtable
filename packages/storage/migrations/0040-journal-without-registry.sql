-- R-H6 (operator decisions H6-1 and H6-3, 2026-10-06; DATA-09): the workspace journal is rebuilt
-- without the retired CT-04A2 registry's three correlation columns, their per-kind CHECK and
-- their foreign keys, and the three empty registry tables those keys pinned are dropped. The
-- registry's five event kinds keep their append-only catalog rows (ADR-013, amended) and the
-- journal now refuses them.
--
-- The rebuild follows migration 0004's procedure. `sequence` is the event stream's resume
-- cursor (Last-Event-ID), so every row keeps its sequence and payload bytes, and the
-- AUTOINCREMENT high-water mark carries over: the next event follows every sequence ever issued.
-- Guards roll the whole migration back unless nothing dropped holds data, every row is copied
-- unchanged, the high-water mark is restored, and the index, triggers and keys are as expected.
-- No other table references workspace_events, and none but the journal and the registry itself
-- references the registry tables.

CREATE TABLE migration_0040_state (
    singleton                INTEGER PRIMARY KEY CHECK (singleton = 1),
    row_count                INTEGER NOT NULL CHECK (row_count >= 0),
    max_sequence             INTEGER NOT NULL CHECK (max_sequence >= 0),
    sequence_row_was_present INTEGER NOT NULL CHECK (sequence_row_was_present IN (0, 1)),
    sequence_value           INTEGER NOT NULL CHECK (sequence_value >= 0)
) STRICT;

INSERT INTO migration_0040_state (
    singleton, row_count, max_sequence, sequence_row_was_present, sequence_value)
SELECT
    1,
    COUNT(*),
    COALESCE(MAX(sequence), 0),
    EXISTS(SELECT 1 FROM sqlite_sequence WHERE name = 'workspace_events'),
    COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'workspace_events'), 0)
FROM workspace_events;

CREATE TABLE migration_0040_guard (
    checkpoint TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

-- Nothing that goes holds data: the registry tables are empty, and no event names the registry
-- (each registry kind required its correlations, so this also finds every registry event).
INSERT INTO migration_0040_guard (checkpoint, ok)
SELECT 'nothing-dropped-holds-data', CASE WHEN
    NOT EXISTS (SELECT 1 FROM registered_repositories)
    AND NOT EXISTS (SELECT 1 FROM repository_inspections)
    AND NOT EXISTS (SELECT 1 FROM project_repository_bindings)
    AND NOT EXISTS (
      SELECT 1 FROM workspace_events
      WHERE repository_id IS NOT NULL
         OR repository_inspection_id IS NOT NULL
         OR repository_binding_id IS NOT NULL
         OR kind IN (
           'repository-registered',
           'repository-status-changed',
           'repository-evidence-changed',
           'project-repository-bound',
           'project-repository-binding-retired'))
  THEN 1 ELSE 0 END;

-- Triggers go before the rename, so it cannot rewrite their bodies (ADR-013).
DROP TRIGGER workspace_events_no_update;
DROP TRIGGER workspace_events_no_delete;
ALTER TABLE workspace_events RENAME TO workspace_events_schema39;
DROP INDEX idx_workspace_events_workspace_sequence;

CREATE TABLE workspace_events (
    sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
    id             TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    occurred_at    TEXT NOT NULL,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    actor_user_id  TEXT REFERENCES users(id) ON DELETE RESTRICT,
    project_id     TEXT,
    work_item_id   TEXT,
    run_id         TEXT,
    kind           TEXT NOT NULL REFERENCES workspace_event_kinds(kind) ON DELETE RESTRICT,
    -- Kind-agnostic here; strict per-kind payload shape stays in the contracts (ADR-003).
    payload_json   TEXT NOT NULL CHECK (
                     json_valid(payload_json)
                     AND json_type(payload_json) = 'object'),
    -- A correlated work item must carry its project (CT03-R2R2).
    CHECK (work_item_id IS NULL OR project_id IS NOT NULL),
    -- The retired registry kinds stay in the catalog, which is append-only, but never return.
    CHECK (kind NOT IN (
      'repository-registered',
      'repository-status-changed',
      'repository-evidence-changed',
      'project-repository-bound',
      'project-repository-binding-retired')),
    FOREIGN KEY (workspace_id, project_id)
      REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
    -- Strictly weaker than the three-column key below given the CHECK above; kept as the
    -- constraint that still holds if that CHECK is ever relaxed (ADR-002).
    FOREIGN KEY (workspace_id, work_item_id)
      REFERENCES work_items(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, project_id, work_item_id)
      REFERENCES work_items(workspace_id, project_id, id) ON DELETE RESTRICT
) STRICT;

INSERT INTO workspace_events (
    sequence, id, schema_version, occurred_at, workspace_id, actor_user_id,
    project_id, work_item_id, run_id, kind, payload_json)
SELECT
    sequence, id, schema_version, occurred_at, workspace_id, actor_user_id,
    project_id, work_item_id, run_id, kind, payload_json
FROM workspace_events_schema39
ORDER BY sequence;

-- The explicit-sequence copy only sets the new row to MAX(sequence); put back the high-water
-- mark captured before the rename, exactly (an absent row stays absent).
DELETE FROM sqlite_sequence WHERE name = 'workspace_events';
INSERT INTO sqlite_sequence (name, seq)
SELECT 'workspace_events', sequence_value
FROM migration_0040_state
WHERE singleton = 1 AND sequence_row_was_present = 1;

-- Every row copied unchanged, payload bytes included, and none added.
INSERT INTO migration_0040_guard (checkpoint, ok)
SELECT 'rows', CASE WHEN
    (SELECT COUNT(*) FROM workspace_events)
      = (SELECT row_count FROM migration_0040_state WHERE singleton = 1)
    AND COALESCE((SELECT MAX(sequence) FROM workspace_events), 0)
      = (SELECT max_sequence FROM migration_0040_state WHERE singleton = 1)
    AND NOT EXISTS (
      SELECT sequence, id, schema_version, occurred_at, workspace_id, actor_user_id,
             project_id, work_item_id, run_id, kind, hex(CAST(payload_json AS BLOB))
      FROM workspace_events_schema39
      EXCEPT
      SELECT sequence, id, schema_version, occurred_at, workspace_id, actor_user_id,
             project_id, work_item_id, run_id, kind, hex(CAST(payload_json AS BLOB))
      FROM workspace_events)
    AND NOT EXISTS (
      SELECT sequence, id, schema_version, occurred_at, workspace_id, actor_user_id,
             project_id, work_item_id, run_id, kind, hex(CAST(payload_json AS BLOB))
      FROM workspace_events
      EXCEPT
      SELECT sequence, id, schema_version, occurred_at, workspace_id, actor_user_id,
             project_id, work_item_id, run_id, kind, hex(CAST(payload_json AS BLOB))
      FROM workspace_events_schema39)
  THEN 1 ELSE 0 END;

DROP TABLE workspace_events_schema39;
DROP TABLE project_repository_bindings;
DROP TABLE repository_inspections;
DROP TABLE registered_repositories;

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

-- The high-water mark is the one captured, and no lower than any sequence issued.
INSERT INTO migration_0040_guard (checkpoint, ok)
SELECT 'sequence', CASE WHEN
    (SELECT COUNT(*) FROM sqlite_sequence WHERE name = 'workspace_events')
      = (SELECT sequence_row_was_present FROM migration_0040_state WHERE singleton = 1)
    AND COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'workspace_events'), 0)
      = (SELECT sequence_value FROM migration_0040_state WHERE singleton = 1)
    AND (SELECT sequence_value >= max_sequence FROM migration_0040_state WHERE singleton = 1)
  THEN 1 ELSE 0 END;

-- The journal's index and triggers are back on it; the old table and the registry are gone,
-- with every index and trigger of theirs; the journal's keys are exactly the six expected, and
-- no table names a dropped one.
WITH keys(parent, columns) AS (
  SELECT "table", group_concat("from", ',' ORDER BY seq)
  FROM pragma_foreign_key_list('workspace_events')
  GROUP BY id
),
expected(parent, columns) AS (
  VALUES
    ('workspaces', 'workspace_id'),
    ('users', 'actor_user_id'),
    ('workspace_event_kinds', 'kind'),
    ('projects', 'workspace_id,project_id'),
    ('work_items', 'workspace_id,work_item_id'),
    ('work_items', 'workspace_id,project_id,work_item_id')
)
INSERT INTO migration_0040_guard (checkpoint, ok)
SELECT 'schema', CASE WHEN
    (SELECT COUNT(*) FROM sqlite_master
     WHERE tbl_name = 'workspace_events'
       AND name IN (
         'idx_workspace_events_workspace_sequence',
         'workspace_events_no_update',
         'workspace_events_no_delete')) = 3
    AND NOT EXISTS (
      SELECT 1 FROM sqlite_master
      WHERE tbl_name IN (
        'workspace_events_schema39',
        'registered_repositories',
        'repository_inspections',
        'project_repository_bindings'))
    AND (SELECT COUNT(*) FROM keys) = 6
    AND NOT EXISTS (SELECT * FROM keys EXCEPT SELECT * FROM expected)
    AND NOT EXISTS (
      SELECT 1 FROM sqlite_master AS m, pragma_foreign_key_list(m.name) AS f
      WHERE m.type = 'table'
        AND f."table" IN (
          'workspace_events_schema39',
          'registered_repositories',
          'repository_inspections',
          'project_repository_bindings'))
    AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check('workspace_events'))
  THEN 1 ELSE 0 END;

DROP TABLE migration_0040_state;
DROP TABLE migration_0040_guard;
