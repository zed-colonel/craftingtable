CREATE TABLE users (
    id                  TEXT PRIMARY KEY CHECK (length(id) > 0),
    username            TEXT NOT NULL CHECK (length(trim(username)) BETWEEN 1 AND 64),
    username_normalized TEXT NOT NULL UNIQUE CHECK (length(username_normalized) BETWEEN 1 AND 64),
    password_hash       TEXT NOT NULL CHECK (password_hash LIKE '$argon2id$%'),
    status              TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE TABLE workspaces (
    id                 TEXT PRIMARY KEY CHECK (length(id) > 0),
    name               TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    slug               TEXT NOT NULL UNIQUE CHECK (length(slug) BETWEEN 1 AND 120),
    status             TEXT NOT NULL CHECK (status IN ('active', 'archived')),
    created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL,
    version            INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;

CREATE TABLE workspace_memberships (
    id           TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    role         TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    status       TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at   TEXT NOT NULL,
    revoked_at   TEXT,
    version      INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (workspace_id, user_id),
    CHECK (
      (status = 'active' AND revoked_at IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL)
    )
) STRICT;

CREATE INDEX idx_workspace_memberships_user
    ON workspace_memberships(user_id, status, workspace_id);

CREATE TABLE sessions (
    id                TEXT PRIMARY KEY CHECK (length(id) > 0),
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    token_digest      TEXT NOT NULL UNIQUE CHECK (length(token_digest) = 64),
    csrf_token        TEXT NOT NULL CHECK (length(csrf_token) >= 32),
    status            TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    created_at        TEXT NOT NULL,
    expires_at        TEXT NOT NULL,
    last_seen_at      TEXT NOT NULL,
    revoked_at        TEXT,
    revocation_reason TEXT,
    user_agent        TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 256),
    version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK (
      (status = 'active' AND revoked_at IS NULL AND revocation_reason IS NULL)
      OR (status = 'revoked' AND revoked_at IS NOT NULL AND revocation_reason IS NOT NULL)
    )
) STRICT;

CREATE INDEX idx_sessions_user_status_expiry
    ON sessions(user_id, status, expires_at);

CREATE TABLE audit_events (
    sequence          INTEGER PRIMARY KEY AUTOINCREMENT,
    id                TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
    occurred_at       TEXT NOT NULL,
    actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('system', 'user')),
    actor_user_id     TEXT REFERENCES users(id) ON DELETE RESTRICT,
    session_id        TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
    workspace_id      TEXT REFERENCES workspaces(id) ON DELETE RESTRICT,
    request_id        TEXT CHECK (request_id IS NULL OR length(request_id) <= 128),
    action            TEXT NOT NULL CHECK (action IN (
      'admin.bootstrap',
      'admin.bootstrap.denied',
      'auth.login',
      'auth.login.failed',
      'auth.logout',
      'auth.session.revoked',
      'workspace.created',
      'workspace.access.denied'
    )),
    target_type       TEXT CHECK (target_type IS NULL OR length(target_type) <= 64),
    target_id         TEXT CHECK (target_id IS NULL OR length(target_id) <= 128),
    outcome           TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed')),
    prior_version     INTEGER CHECK (prior_version IS NULL OR prior_version >= 1),
    resulting_version INTEGER CHECK (resulting_version IS NULL OR resulting_version >= 1),
    metadata_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
) STRICT;

CREATE INDEX idx_audit_workspace_sequence
    ON audit_events(workspace_id, sequence DESC);
CREATE INDEX idx_audit_user_sequence
    ON audit_events(actor_user_id, sequence DESC);

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TABLE workspace_events (
    sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    occurred_at   TEXT NOT NULL,
    workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    actor_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    project_id    TEXT,
    work_item_id  TEXT,
    run_id        TEXT,
    kind          TEXT NOT NULL CHECK (kind IN ('workspace-created')),
    payload_json  TEXT NOT NULL CHECK (
      json_valid(payload_json)
      AND json_type(payload_json, '$.name') = 'text'
      AND json_type(payload_json, '$.slug') = 'text'
    )
) STRICT;

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
