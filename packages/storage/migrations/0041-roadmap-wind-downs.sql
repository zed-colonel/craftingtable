-- R-B11 (operator decisions 2026-10-13, ADR-073): winding down a roadmap. Three new tables beside
-- the records they describe; no existing table is rebuilt or changed.
--
-- roadmap_wind_downs: one settlement record per roadmap. `settling` is the hold the scheduler and
-- the cycle worker honour; `settled` means the roadmap is wound down. Its identity never changes
-- and it is never deleted; a settled record is entered again only to add retirements.
-- retired_plan_versions: one immutable row per retired plan version, with its disposition and the
-- wind-down that retired it.
-- repository_cleanups: a cleanup's pinned plan and each action's state; at most one running per
-- roadmap, and a finished one never changes.
--
-- A guard rolls the whole migration back unless the tables start empty, their keys and triggers
-- are in place, and each new catalog row was added exactly once.

CREATE TABLE migration_0041_guard (
    checkpoint TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

CREATE TABLE roadmap_wind_downs (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 roadmap_id TEXT NOT NULL UNIQUE REFERENCES roadmaps(id) ON DELETE RESTRICT,
 status TEXT NOT NULL CHECK (status IN ('settling','settled')),
 version INTEGER NOT NULL CHECK (version > 0),
 record_json TEXT NOT NULL CHECK (json_valid(record_json)
   AND json_extract(record_json, '$.id') IS id
   AND json_extract(record_json, '$.workspaceId') IS workspace_id
   AND json_extract(record_json, '$.roadmapId') IS roadmap_id
   AND json_extract(record_json, '$.status') IS status
   AND json_extract(record_json, '$.version') IS version)
) STRICT;
CREATE INDEX roadmap_wind_downs_settling ON roadmap_wind_downs(workspace_id) WHERE status = 'settling';
CREATE TRIGGER roadmap_wind_downs_identity BEFORE UPDATE ON roadmap_wind_downs
WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.roadmap_id IS NOT OLD.roadmap_id OR NEW.version <= OLD.version
BEGIN SELECT RAISE(ABORT, 'A wind-down keeps its identity and only moves forward'); END;
CREATE TRIGGER roadmap_wind_downs_no_delete BEFORE DELETE ON roadmap_wind_downs
BEGIN SELECT RAISE(ABORT, 'Wind-down history is immutable'); END;

CREATE TABLE retired_plan_versions (
 plan_version_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 disposition TEXT NOT NULL CHECK (disposition IN ('superseded','parked')),
 wind_down_id TEXT NOT NULL REFERENCES roadmap_wind_downs(id) ON DELETE RESTRICT,
 retired_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 retired_at TEXT NOT NULL,
 FOREIGN KEY (workspace_id, plan_version_id) REFERENCES plan_versions(workspace_id, id) ON DELETE RESTRICT
) STRICT;
CREATE INDEX retired_plan_versions_workspace ON retired_plan_versions(workspace_id);
CREATE TRIGGER retired_plan_versions_no_update BEFORE UPDATE ON retired_plan_versions
BEGIN SELECT RAISE(ABORT, 'A retirement is immutable'); END;
CREATE TRIGGER retired_plan_versions_no_delete BEFORE DELETE ON retired_plan_versions
BEGIN SELECT RAISE(ABORT, 'A retirement is immutable'); END;

CREATE TABLE repository_cleanups (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 roadmap_id TEXT NOT NULL REFERENCES roadmaps(id) ON DELETE RESTRICT,
 status TEXT NOT NULL CHECK (status IN ('running','done')),
 version INTEGER NOT NULL CHECK (version > 0),
 record_json TEXT NOT NULL CHECK (json_valid(record_json)
   AND json_extract(record_json, '$.id') IS id
   AND json_extract(record_json, '$.workspaceId') IS workspace_id
   AND json_extract(record_json, '$.roadmapId') IS roadmap_id
   AND json_extract(record_json, '$.status') IS status
   AND json_extract(record_json, '$.version') IS version)
) STRICT;
CREATE UNIQUE INDEX repository_cleanups_running ON repository_cleanups(roadmap_id) WHERE status = 'running';
CREATE INDEX repository_cleanups_roadmap ON repository_cleanups(workspace_id, roadmap_id);
CREATE TRIGGER repository_cleanups_identity BEFORE UPDATE ON repository_cleanups
WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id
  OR NEW.roadmap_id IS NOT OLD.roadmap_id OR NEW.version <= OLD.version OR OLD.status = 'done'
BEGIN SELECT RAISE(ABORT, 'A cleanup keeps its identity, only moves forward and is final once done'); END;
CREATE TRIGGER repository_cleanups_no_delete BEFORE DELETE ON repository_cleanups
BEGIN SELECT RAISE(ABORT, 'Cleanup history is immutable'); END;

INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES
  ('roadmap.wind-down', 41),
  ('plan.version-retired', 41),
  ('repository-cleanup.updated', 41),
  ('repository-cleanup.action', 41);
INSERT INTO workspace_event_kinds (kind, introduced_in_schema) VALUES
  ('plan-version-retired', 41),
  ('repository-cleanup-changed', 41);

INSERT INTO migration_0041_guard (checkpoint, ok)
SELECT 'new-tables-empty', CASE WHEN
    NOT EXISTS (SELECT 1 FROM roadmap_wind_downs)
    AND NOT EXISTS (SELECT 1 FROM retired_plan_versions)
    AND NOT EXISTS (SELECT 1 FROM repository_cleanups)
  THEN 1 ELSE 0 END;

INSERT INTO migration_0041_guard (checkpoint, ok)
SELECT 'catalog-rows', CASE WHEN
    (SELECT COUNT(*) FROM audit_action_kinds WHERE introduced_in_schema = 41
       AND action IN ('roadmap.wind-down', 'plan.version-retired',
                      'repository-cleanup.updated', 'repository-cleanup.action')) = 4
    AND (SELECT COUNT(*) FROM audit_action_kinds WHERE introduced_in_schema = 41) = 4
    AND (SELECT COUNT(*) FROM workspace_event_kinds WHERE introduced_in_schema = 41
       AND kind IN ('plan-version-retired', 'repository-cleanup-changed')) = 2
    AND (SELECT COUNT(*) FROM workspace_event_kinds WHERE introduced_in_schema = 41) = 2
  THEN 1 ELSE 0 END;

INSERT INTO migration_0041_guard (checkpoint, ok)
SELECT 'triggers-and-indexes', CASE WHEN
    (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (
       'roadmap_wind_downs_identity', 'roadmap_wind_downs_no_delete',
       'retired_plan_versions_no_update', 'retired_plan_versions_no_delete',
       'repository_cleanups_identity', 'repository_cleanups_no_delete')) = 6
    AND (SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name IN (
       'roadmap_wind_downs_settling', 'retired_plan_versions_workspace',
       'repository_cleanups_running', 'repository_cleanups_roadmap')) = 4
  THEN 1 ELSE 0 END;

DROP TABLE migration_0041_guard;
