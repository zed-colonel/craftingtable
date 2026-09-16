CREATE TABLE phase_resource_limits (resource_key TEXT PRIMARY KEY, capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 32)) STRICT;
INSERT INTO phase_resource_limits VALUES ('local-development', 2), ('local-verification', 1);
CREATE TABLE phase_reservations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('start','merge','verify','accept')),
  resource_key TEXT NOT NULL,
  capacity INTEGER NOT NULL CHECK(capacity > 0),
  acquired_at TEXT NOT NULL,
  released_at TEXT,
  release_reason TEXT,
  FOREIGN KEY(workspace_id, worktree_id) REFERENCES worktrees(workspace_id, id)
) STRICT;
CREATE UNIQUE INDEX phase_reservation_owner ON phase_reservations(owner_id, resource_key) WHERE released_at IS NULL;
CREATE INDEX phase_reservation_active ON phase_reservations(resource_key) WHERE released_at IS NULL;
CREATE TRIGGER phase_reservation_capacity BEFORE INSERT ON phase_reservations
WHEN NEW.released_at IS NULL AND
 (SELECT count(*) FROM phase_reservations WHERE resource_key=NEW.resource_key AND released_at IS NULL)
 >= min(NEW.capacity, coalesce((SELECT min(capacity) FROM phase_reservations WHERE resource_key=NEW.resource_key AND released_at IS NULL), NEW.capacity))
BEGIN SELECT RAISE(ABORT, 'Phase resource capacity exhausted'); END;
CREATE TABLE scope_scheduling_authorizations (
  workspace_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  authorized_by_user_id TEXT NOT NULL REFERENCES users(id),
  authorized_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, work_item_id, scope_key),
  FOREIGN KEY(workspace_id, work_item_id) REFERENCES work_items(workspace_id, id)
) STRICT;
CREATE TRIGGER scope_scheduling_no_update BEFORE UPDATE ON scope_scheduling_authorizations BEGIN SELECT RAISE(ABORT, 'Scheduling authorization is immutable'); END;
CREATE TRIGGER scope_scheduling_no_delete BEFORE DELETE ON scope_scheduling_authorizations BEGIN SELECT RAISE(ABORT, 'Scheduling authorization is immutable'); END;
INSERT INTO audit_action_kinds(action, introduced_in_schema) VALUES ('scope.scheduling-authorized', 19);
INSERT INTO workspace_event_kinds(kind, introduced_in_schema) VALUES ('scope-scheduling-authorized', 19);
CREATE TRIGGER phase_reservation_identity_immutable BEFORE UPDATE ON phase_reservations
WHEN NEW.id IS NOT OLD.id OR NEW.workspace_id IS NOT OLD.workspace_id OR NEW.worktree_id IS NOT OLD.worktree_id
 OR NEW.owner_id IS NOT OLD.owner_id OR NEW.phase IS NOT OLD.phase OR NEW.resource_key IS NOT OLD.resource_key
 OR NEW.capacity IS NOT OLD.capacity OR NEW.acquired_at IS NOT OLD.acquired_at
 OR OLD.released_at IS NOT NULL OR NEW.released_at IS NULL
BEGIN SELECT RAISE(ABORT, 'Reservation identity and released history are immutable'); END;
CREATE TRIGGER phase_reservation_no_delete BEFORE DELETE ON phase_reservations BEGIN SELECT RAISE(ABORT, 'Reservation history is immutable'); END;
