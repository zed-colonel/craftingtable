-- Saved host limits take precedence over daemon environment defaults.
ALTER TABLE phase_resource_limits ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0);
ALTER TABLE phase_resource_limits ADD COLUMN updated_at TEXT;
ALTER TABLE phase_resource_limits ADD COLUMN updated_by_user_id TEXT REFERENCES users(id);
INSERT INTO audit_action_kinds(action, introduced_in_schema) VALUES ('host-scheduling.updated', 25);
