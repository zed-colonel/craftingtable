-- R-A4 (ADR-070): attention as durable occurrences, and an append-only push log.
-- An item is one subject stopped at one code for the operator. It is opened and resolved in
-- the transaction that changes its subject, and never reopened: a subject that stops again
-- gets a new row. Deliveries record every push attempt and are never changed or deleted.
CREATE TABLE attention_items (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 scope_key TEXT NOT NULL,
 subject_key TEXT NOT NULL,
 code TEXT NOT NULL,
 state TEXT NOT NULL CHECK (state IN ('open', 'resolved')),
 opened_at TEXT NOT NULL,
 resolved_at TEXT,
 resolved_by TEXT CHECK (resolved_by IN ('operator', 'automation', 'superseded')),
 state_json TEXT NOT NULL CHECK (json_valid(state_json)),
 CHECK ((state = 'open') = (resolved_at IS NULL AND resolved_by IS NULL))
) STRICT;
CREATE UNIQUE INDEX attention_items_open_subject
 ON attention_items(workspace_id, subject_key, code) WHERE state = 'open';
CREATE INDEX attention_items_scope ON attention_items(workspace_id, scope_key, state);
CREATE INDEX attention_items_recent ON attention_items(workspace_id, subject_key, code, opened_at);
CREATE TRIGGER attention_items_resolved_immutable BEFORE UPDATE ON attention_items
 WHEN OLD.state = 'resolved'
 BEGIN SELECT RAISE(ABORT, 'A resolved attention item is history and cannot change'); END;
CREATE TRIGGER attention_items_no_delete BEFORE DELETE ON attention_items
 BEGIN SELECT RAISE(ABORT, 'Attention items are history and cannot be deleted'); END;

CREATE TABLE notification_deliveries (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
 attempted_at TEXT NOT NULL,
 result TEXT NOT NULL CHECK (result IN ('accepted', 'retry', 'blocked')),
 state_json TEXT NOT NULL CHECK (json_valid(state_json))
) STRICT;
CREATE INDEX notification_deliveries_recent ON notification_deliveries(workspace_id, attempted_at);
CREATE TRIGGER notification_deliveries_no_update BEFORE UPDATE ON notification_deliveries
 BEGIN SELECT RAISE(ABORT, 'Notification deliveries are append-only'); END;
CREATE TRIGGER notification_deliveries_no_delete BEFORE DELETE ON notification_deliveries
 BEGIN SELECT RAISE(ABORT, 'Notification deliveries are append-only'); END;

INSERT INTO workspace_event_kinds (kind, introduced_in_schema) VALUES ('attention-changed', 32);

-- Who last acted in a workspace: resolves items (operator or automation) and presence.
CREATE INDEX audit_events_user_actions ON audit_events(workspace_id, occurred_at)
 WHERE actor_kind = 'user';
