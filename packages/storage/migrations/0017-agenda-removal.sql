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
        SELECT 1 FROM roadmaps r, json_each(r.state_json, '$.definition.entries') e
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

INSERT INTO audit_action_kinds(action, introduced_in_schema) VALUES ('work-item.removed-from-agenda', 17);
INSERT INTO workspace_event_kinds(kind, introduced_in_schema) VALUES ('work-item-removed-from-agenda', 17);
