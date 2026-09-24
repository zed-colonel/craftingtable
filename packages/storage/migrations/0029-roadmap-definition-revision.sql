-- R-B3: a roadmap's control row keeps only the revision of its immutable definition, and a
-- work cycle records the roadmap attempt that owns it.
--
-- 1. Every roadmap's embedded definition must already be stored as that revision, byte for
--    byte after JSON normalisation. A missing revision is stored from the embedded copy; a
--    different one aborts the migration instead of dropping the only copy of a definition.
-- 2. The control row drops `definition` and gains `definitionRevision`.
-- 3. Each cycle gains `owner`: the attempt whose cycleId it is, or null when no roadmap owns it.
-- 4. The work-item admission trigger read the embedded definition's entries; it now reads the
--    stored revision, so returning an item to proposed stays refused while an active roadmap
--    includes it.

CREATE TABLE migration_0029_guard (
    checkpoint TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

INSERT OR IGNORE INTO roadmap_definitions (roadmap_id, revision, definition_json)
SELECT id, json_extract(state_json, '$.definition.revision'), json(json_extract(state_json, '$.definition'))
FROM roadmaps
WHERE json_type(state_json, '$.definition') = 'object';

INSERT INTO migration_0029_guard (checkpoint, ok)
SELECT 'embedded definitions match their stored revision', CASE WHEN NOT EXISTS (
    SELECT 1 FROM roadmaps r
    WHERE json_type(r.state_json, '$.definition') = 'object'
      AND NOT EXISTS (
        SELECT 1 FROM roadmap_definitions d
        WHERE d.roadmap_id = r.id
          AND d.revision = json_extract(r.state_json, '$.definition.revision')
          AND json(d.definition_json) = json(json_extract(r.state_json, '$.definition'))))
  THEN 1 ELSE 0 END;

UPDATE roadmaps
SET state_json = json_set(
    json_remove(state_json, '$.definition'),
    '$.definitionRevision', json_extract(state_json, '$.definition.revision'))
WHERE json_type(state_json, '$.definition') = 'object';

INSERT INTO migration_0029_guard (checkpoint, ok)
SELECT 'every roadmap references a stored revision', CASE WHEN NOT EXISTS (
    SELECT 1 FROM roadmaps r
    WHERE json_type(r.state_json, '$.definition') IS NOT NULL
       OR NOT EXISTS (
        SELECT 1 FROM roadmap_definitions d
        WHERE d.roadmap_id = r.id AND d.revision = json_extract(r.state_json, '$.definitionRevision')))
  THEN 1 ELSE 0 END;

UPDATE work_cycles
SET state_json = json_set(state_json, '$.owner', COALESCE(
    (SELECT json_object(
        'roadmapId', r.id,
        'attemptId', json_extract(a.value, '$.id'),
        'entryId', json_extract(a.value, '$.entryId'),
        'definitionRevision', json_extract(a.value, '$.definitionRevision'))
     FROM roadmaps r, json_each(r.state_json, '$.attempts') a
     WHERE r.workspace_id = work_cycles.workspace_id
       AND json_extract(a.value, '$.cycleId') = work_cycles.id
     LIMIT 1),
    json('null')))
WHERE json_type(state_json, '$.owner') IS NULL;

INSERT INTO migration_0029_guard (checkpoint, ok)
SELECT 'no cycle is owned by two attempts', CASE WHEN NOT EXISTS (
    SELECT json_extract(a.value, '$.cycleId')
    FROM roadmaps r, json_each(r.state_json, '$.attempts') a
    GROUP BY json_extract(a.value, '$.cycleId')
    HAVING COUNT(*) > 1)
  THEN 1 ELSE 0 END;

DROP TRIGGER work_items_admission_only;
CREATE TRIGGER work_items_admission_only
BEFORE UPDATE ON work_items
WHEN NOT (
      OLD.id IS NEW.id
  AND OLD.workspace_id       IS NEW.workspace_id
  AND OLD.project_id         IS NEW.project_id
  AND OLD.plan_version_id    IS NEW.plan_version_id
  AND OLD.source_id          IS NEW.source_id
  AND OLD.ordinal            IS NEW.ordinal
  AND OLD.title              IS NEW.title
  AND OLD.risk               IS NEW.risk
  AND OLD.phase              IS NEW.phase
  AND OLD.primary_areas_json IS NEW.primary_areas_json
  AND OLD.exit_gate          IS NEW.exit_gate
  AND OLD.source_fields_json IS NEW.source_fields_json
  AND NEW.version = OLD.version + 1
  AND (
    (OLD.status = 'proposed' AND NEW.status = 'admitted'
      AND NEW.admitted_at IS NOT NULL AND NEW.admitted_by_user_id IS NOT NULL)
    OR (OLD.status = 'admitted' AND NEW.status = 'proposed'
      AND NEW.admitted_at IS NULL AND NEW.admitted_by_user_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM work_item_completions WHERE work_item_id = OLD.id)
      AND NOT EXISTS (SELECT 1 FROM agent_runs WHERE work_item_id = OLD.id)
      AND NOT EXISTS (SELECT 1 FROM work_cycles WHERE work_item_id = OLD.id)
      AND NOT EXISTS (SELECT 1 FROM worktrees WHERE work_item_id = OLD.id AND status = 'active')
      AND NOT EXISTS (
        SELECT 1 FROM roadmaps r
          JOIN roadmap_definitions d
            ON d.roadmap_id = r.id AND d.revision = json_extract(r.state_json, '$.definitionRevision'),
          json_each(d.definition_json, '$.entries') e
        WHERE r.workspace_id = OLD.workspace_id AND r.status NOT IN ('draft', 'completed', 'stopped')
          AND json_extract(e.value, '$.workItemId') = OLD.id
      )
    )
  )
)
BEGIN
  SELECT RAISE(
    ABORT,
    'a work item accepts only the atomic proposed-to-admitted transition or guarded return to proposed; imported fields and all other updates are immutable'
  );
END;

DROP TABLE migration_0029_guard;
