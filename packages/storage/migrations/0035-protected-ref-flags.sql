-- R-G5 follow-up (operator decision 2026-09-28): a protected ref that moved during a run, not by
-- the daemon, is kept as a record and shows in the inbox until the operator acknowledges it.
-- The move never changes and is never deleted; the one update records the acknowledgement,
-- once, and leaves everything else as it was.
CREATE TABLE protected_ref_moves (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id),
 repository_id TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json))
) STRICT;
CREATE INDEX protected_ref_moves_repository ON protected_ref_moves(workspace_id, repository_id);
CREATE TRIGGER protected_ref_moves_acknowledge_once BEFORE UPDATE ON protected_ref_moves
 WHEN json_extract(OLD.record_json, '$.acknowledgedAt') IS NOT NULL
  OR json_extract(NEW.record_json, '$.acknowledgedAt') IS NULL
  OR json_extract(NEW.record_json, '$.acknowledgedByUserId') IS NULL
  OR json_remove(NEW.record_json, '$.acknowledgedAt', '$.acknowledgedByUserId') IS NOT json(OLD.record_json)
  OR NEW.id IS NOT OLD.id
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.repository_id IS NOT OLD.repository_id
 BEGIN SELECT RAISE(ABORT, 'A protected ref move changes only when it is acknowledged, once'); END;
CREATE TRIGGER protected_ref_moves_no_delete BEFORE DELETE ON protected_ref_moves
 BEGIN SELECT RAISE(ABORT, 'Protected ref moves cannot be deleted'); END;
INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES
  ('protected-refs.acknowledged', 35);
