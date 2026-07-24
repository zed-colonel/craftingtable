-- CT-03 schema version 2: journal vocabulary catalogs + the planning model.
--
-- Runs inside the migration runner's single transaction. `PRAGMA foreign_keys`
-- is a no-op inside a transaction, so every statement here must be foreign-key
-- clean; the kind catalogs are therefore seeded before any journal row is
-- copied. See docs/decisions/ADR-013-journal-vocabulary-catalogs.md.

-- ---------------------------------------------------------------------------
-- 1. Journal vocabulary catalogs
-- ---------------------------------------------------------------------------

CREATE TABLE audit_action_kinds (
    action               TEXT PRIMARY KEY CHECK (length(action) BETWEEN 1 AND 64),
    introduced_in_schema INTEGER NOT NULL CHECK (introduced_in_schema >= 1)
) STRICT;

CREATE TABLE workspace_event_kinds (
    kind                 TEXT PRIMARY KEY CHECK (length(kind) BETWEEN 1 AND 64),
    introduced_in_schema INTEGER NOT NULL CHECK (introduced_in_schema >= 1)
) STRICT;

INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES
    ('admin.bootstrap',             1),
    ('admin.bootstrap.denied',      1),
    ('auth.login',                  1),
    ('auth.login.failed',           1),
    ('auth.logout',                 1),
    ('auth.session.revoked',        1),
    ('workspace.created',           1),
    ('workspace.access.denied',     1),
    ('plan.import.succeeded',       2),
    ('plan.import.failed',          2),
    ('plan.import.duplicate',       2),
    ('work-item.admitted',          2),
    ('work-contract-draft.created', 2);

INSERT INTO workspace_event_kinds (kind, introduced_in_schema) VALUES
    ('workspace-created',     1),
    ('project-created',       2),
    ('plan-version-imported', 2),
    ('work-item-admitted',    2);

-- Catalog entries are migration-owned history. Registering a new kind is one
-- INSERT in a future migration; changing or removing one would silently
-- reinterpret committed journal rows.
CREATE TRIGGER audit_action_kinds_no_update
BEFORE UPDATE ON audit_action_kinds
BEGIN
  SELECT RAISE(ABORT, 'audit action kinds are migration-owned');
END;

CREATE TRIGGER audit_action_kinds_no_delete
BEFORE DELETE ON audit_action_kinds
BEGIN
  SELECT RAISE(ABORT, 'audit action kinds are migration-owned');
END;

CREATE TRIGGER workspace_event_kinds_no_update
BEFORE UPDATE ON workspace_event_kinds
BEGIN
  SELECT RAISE(ABORT, 'workspace event kinds are migration-owned');
END;

CREATE TRIGGER workspace_event_kinds_no_delete
BEFORE DELETE ON workspace_event_kinds
BEGIN
  SELECT RAISE(ABORT, 'workspace event kinds are migration-owned');
END;

-- ---------------------------------------------------------------------------
-- 2. Planning model
--
-- Created before the journal rebuild so the rebuilt workspace_events table can
-- reference projects and work_items directly.
--
-- Workspace ownership is structural: every table carries workspace_id, and each
-- child uses a composite foreign key into its parent's (workspace_id, id), so a
-- row can never be attached to a parent in another workspace.
-- ---------------------------------------------------------------------------

CREATE TABLE projects (
    id                     TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    name                   TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
    slug                   TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 120),
    -- Forward reference: plan_versions is created below. SQLite resolves
    -- foreign keys at DML time, so the declaration order is safe.
    active_plan_version_id TEXT REFERENCES plan_versions(id) ON DELETE RESTRICT,
    created_at             TEXT NOT NULL,
    created_by_user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    version                INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (workspace_id, slug),
    UNIQUE (workspace_id, id)
) STRICT;

CREATE INDEX idx_projects_workspace ON projects(workspace_id, created_at);

CREATE TABLE plan_bundles (
    id           TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    project_id   TEXT NOT NULL,
    logical_name TEXT NOT NULL CHECK (length(trim(logical_name)) BETWEEN 1 AND 120),
    created_at   TEXT NOT NULL,
    UNIQUE (project_id, logical_name),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE plan_versions (
    id                    TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id          TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    project_id            TEXT NOT NULL,
    bundle_id             TEXT NOT NULL,
    version_number        INTEGER NOT NULL CHECK (version_number >= 1),
    content_digest        TEXT NOT NULL CHECK (length(content_digest) = 64),
    digest_algorithm      TEXT NOT NULL CHECK (digest_algorithm = 'sha-256'),
    digest_format_version INTEGER NOT NULL CHECK (digest_format_version = 1),
    source_profile        TEXT NOT NULL CHECK (source_profile = 'exo-work-breakdown-v1'),
    document              TEXT NOT NULL CHECK (length(trim(document)) BETWEEN 1 AND 300),
    normalized_source_json TEXT NOT NULL CHECK (json_valid(normalized_source_json)),
    item_count            INTEGER NOT NULL CHECK (item_count >= 0),
    required_dependency_count INTEGER NOT NULL CHECK (required_dependency_count >= 0),
    created_at            TEXT NOT NULL,
    created_by_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    UNIQUE (bundle_id, version_number),
    -- Bundle identity: byte-identical logical artifacts are one version.
    UNIQUE (workspace_id, content_digest),
    UNIQUE (workspace_id, id),
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, bundle_id) REFERENCES plan_bundles(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_plan_versions_project ON plan_versions(project_id, version_number DESC);

CREATE TRIGGER plan_versions_no_update
BEFORE UPDATE ON plan_versions
BEGIN
  SELECT RAISE(ABORT, 'plan versions are immutable');
END;

CREATE TRIGGER plan_versions_no_delete
BEFORE DELETE ON plan_versions
BEGIN
  SELECT RAISE(ABORT, 'plan versions are immutable');
END;

CREATE TABLE plan_import_attempts (
    id                     TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id           TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    actor_user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    outcome                TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed-validation', 'duplicate')),
    requested_project_name TEXT NOT NULL CHECK (length(requested_project_name) BETWEEN 1 AND 120),
    requested_project_id   TEXT,
    bundle_digest          TEXT CHECK (bundle_digest IS NULL OR length(bundle_digest) = 64),
    digest_format_version  INTEGER CHECK (digest_format_version IS NULL OR digest_format_version >= 1),
    project_id             TEXT,
    plan_version_id        TEXT,
    artifact_count         INTEGER NOT NULL CHECK (artifact_count >= 0),
    total_byte_length      INTEGER NOT NULL CHECK (total_byte_length >= 0),
    error_count            INTEGER NOT NULL CHECK (error_count >= 0),
    warning_count          INTEGER NOT NULL CHECK (warning_count >= 0),
    created_at             TEXT NOT NULL,
    UNIQUE (workspace_id, id),
    -- Only a failed validation lacks a resolved project and plan version.
    CHECK ((outcome = 'failed-validation') = (plan_version_id IS NULL)),
    CHECK ((outcome = 'failed-validation') = (project_id IS NULL)),
    CHECK (outcome = 'failed-validation' OR bundle_digest IS NOT NULL),
    CHECK ((outcome = 'failed-validation') = (error_count > 0)),
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, plan_version_id) REFERENCES plan_versions(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, requested_project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_plan_import_attempts_workspace
    ON plan_import_attempts(workspace_id, created_at DESC);

-- Exact source bytes. Bounded and immutable; retained for a failed validation
-- attempt with a null plan version so the failure stays diagnosable.
CREATE TABLE plan_artifacts (
    id                TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    import_attempt_id TEXT NOT NULL,
    plan_version_id   TEXT,
    logical_filename  TEXT NOT NULL CHECK (length(logical_filename) BETWEEN 1 AND 200),
    role              TEXT NOT NULL CHECK (role IN (
                        'implementation-plan', 'work-breakdown', 'assumption-ledger',
                        'validation-manifest', 'decision-log', 'supporting')),
    media_type        TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 100),
    byte_length       INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 2097152),
    sha256            TEXT NOT NULL CHECK (length(sha256) = 64),
    content           BLOB NOT NULL,
    created_at        TEXT NOT NULL,
    UNIQUE (import_attempt_id, logical_filename),
    UNIQUE (workspace_id, id),
    CHECK (length(content) = byte_length),
    FOREIGN KEY (workspace_id, import_attempt_id) REFERENCES plan_import_attempts(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, plan_version_id) REFERENCES plan_versions(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_plan_artifacts_version ON plan_artifacts(plan_version_id, role);

CREATE TRIGGER plan_artifacts_no_update
BEFORE UPDATE ON plan_artifacts
BEGIN
  SELECT RAISE(ABORT, 'plan artifacts are immutable');
END;

CREATE TRIGGER plan_artifacts_no_delete
BEFORE DELETE ON plan_artifacts
BEGIN
  SELECT RAISE(ABORT, 'plan artifacts are immutable');
END;

CREATE TABLE plan_import_diagnostics (
    id                  TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    import_attempt_id   TEXT NOT NULL,
    plan_version_id     TEXT,
    ordinal             INTEGER NOT NULL CHECK (ordinal >= 0),
    severity            TEXT NOT NULL CHECK (severity IN ('error', 'warning', 'info')),
    code                TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 64),
    artifact_name       TEXT CHECK (artifact_name IS NULL OR length(artifact_name) <= 200),
    path                TEXT CHECK (path IS NULL OR length(path) <= 200),
    work_item_source_id TEXT CHECK (work_item_source_id IS NULL OR length(work_item_source_id) <= 64),
    message             TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 500),
    UNIQUE (import_attempt_id, ordinal),
    FOREIGN KEY (workspace_id, import_attempt_id) REFERENCES plan_import_attempts(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, plan_version_id) REFERENCES plan_versions(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_plan_import_diagnostics_attempt
    ON plan_import_diagnostics(import_attempt_id, ordinal);

CREATE TABLE work_items (
    id                  TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    project_id          TEXT NOT NULL,
    plan_version_id     TEXT NOT NULL,
    -- Unique within a plan version only; deliberately not the primary key.
    source_id           TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 64),
    ordinal             INTEGER NOT NULL CHECK (ordinal >= 0),
    title               TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 300),
    -- CT-03 exposes exactly one transition: proposed -> admitted.
    status              TEXT NOT NULL CHECK (status IN ('proposed', 'admitted')),
    risk                TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical', 'unspecified')),
    phase               TEXT CHECK (phase IS NULL OR length(phase) <= 64),
    primary_areas_json  TEXT NOT NULL CHECK (
                          json_valid(primary_areas_json)
                          AND json_type(primary_areas_json) = 'array'),
    exit_gate           TEXT NOT NULL CHECK (length(exit_gate) BETWEEN 1 AND 1000),
    source_fields_json  TEXT NOT NULL CHECK (json_valid(source_fields_json)),
    admitted_at         TEXT,
    admitted_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
    version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (plan_version_id, source_id),
    UNIQUE (plan_version_id, ordinal),
    UNIQUE (plan_version_id, id),
    UNIQUE (workspace_id, id),
    CHECK (
      (status = 'admitted' AND admitted_at IS NOT NULL AND admitted_by_user_id IS NOT NULL)
      OR (status = 'proposed' AND admitted_at IS NULL AND admitted_by_user_id IS NULL)
    ),
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, plan_version_id) REFERENCES plan_versions(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_work_items_version_status ON work_items(plan_version_id, status);
CREATE INDEX idx_work_items_project ON work_items(project_id, plan_version_id);

-- The composite parent keys make a cross-version dependency edge impossible at
-- the database level rather than only by repository convention.
CREATE TABLE work_item_dependencies (
    id                       TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id             TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    plan_version_id          TEXT NOT NULL,
    predecessor_work_item_id TEXT NOT NULL,
    successor_work_item_id   TEXT NOT NULL,
    kind                     TEXT NOT NULL CHECK (kind IN ('required', 'recommended')),
    ordinal                  INTEGER NOT NULL CHECK (ordinal >= 0),
    CHECK (predecessor_work_item_id <> successor_work_item_id),
    UNIQUE (plan_version_id, predecessor_work_item_id, successor_work_item_id, kind),
    FOREIGN KEY (workspace_id, plan_version_id) REFERENCES plan_versions(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (plan_version_id, predecessor_work_item_id) REFERENCES work_items(plan_version_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (plan_version_id, successor_work_item_id) REFERENCES work_items(plan_version_id, id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX idx_work_item_dependencies_successor
    ON work_item_dependencies(successor_work_item_id, kind);
CREATE INDEX idx_work_item_dependencies_predecessor
    ON work_item_dependencies(predecessor_work_item_id, kind);

CREATE TABLE work_contract_drafts (
    id                 TEXT PRIMARY KEY CHECK (length(id) > 0),
    workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    project_id         TEXT NOT NULL,
    plan_version_id    TEXT NOT NULL,
    -- One draft per admitted work item, enforced here rather than in a service.
    work_item_id       TEXT NOT NULL UNIQUE,
    schema_version     INTEGER NOT NULL CHECK (schema_version = 1),
    status             TEXT NOT NULL CHECK (status = 'draft'),
    completeness       TEXT NOT NULL CHECK (completeness = 'incomplete'),
    document_json      TEXT NOT NULL CHECK (json_valid(document_json)),
    created_at         TEXT NOT NULL,
    created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, project_id) REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, plan_version_id) REFERENCES plan_versions(workspace_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (workspace_id, work_item_id) REFERENCES work_items(workspace_id, id) ON DELETE RESTRICT
) STRICT;

CREATE TRIGGER work_contract_drafts_no_update
BEFORE UPDATE ON work_contract_drafts
BEGIN
  SELECT RAISE(ABORT, 'work contract drafts are immutable in CT-03');
END;

CREATE TRIGGER work_contract_drafts_no_delete
BEFORE DELETE ON work_contract_drafts
BEGIN
  SELECT RAISE(ABORT, 'work contract drafts are immutable in CT-03');
END;

-- ---------------------------------------------------------------------------
-- 3. Journal rebuild
--
-- Both CT-02 journals are rebuilt exactly once so their vocabularies become
-- catalog-backed. Triggers are dropped before each rename so ALTER TABLE cannot
-- rewrite stale trigger bodies; the old table is dropped before its indexes are
-- recreated so the original index names are free; and the explicit-sequence
-- copy re-establishes sqlite_sequence under the new table name, which is what
-- keeps AUTOINCREMENT continuous.
-- ---------------------------------------------------------------------------

CREATE TABLE migration_0002_guard (
    checkpoint TEXT PRIMARY KEY,
    ok         INTEGER NOT NULL CHECK (ok = 1)
) STRICT;

DROP TRIGGER audit_events_no_update;
DROP TRIGGER audit_events_no_delete;
ALTER TABLE audit_events RENAME TO audit_events_schema1;

CREATE TABLE audit_events (
    sequence          INTEGER PRIMARY KEY AUTOINCREMENT,
    id                TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
    occurred_at       TEXT NOT NULL,
    actor_kind        TEXT NOT NULL CHECK (actor_kind IN ('system', 'user')),
    actor_user_id     TEXT REFERENCES users(id) ON DELETE RESTRICT,
    session_id        TEXT REFERENCES sessions(id) ON DELETE RESTRICT,
    workspace_id      TEXT REFERENCES workspaces(id) ON DELETE RESTRICT,
    request_id        TEXT CHECK (request_id IS NULL OR length(request_id) <= 128),
    action            TEXT NOT NULL REFERENCES audit_action_kinds(action) ON DELETE RESTRICT,
    target_type       TEXT CHECK (target_type IS NULL OR length(target_type) <= 64),
    target_id         TEXT CHECK (target_id IS NULL OR length(target_id) <= 128),
    outcome           TEXT NOT NULL CHECK (outcome IN ('succeeded', 'denied', 'failed')),
    prior_version     INTEGER CHECK (prior_version IS NULL OR prior_version >= 1),
    resulting_version INTEGER CHECK (resulting_version IS NULL OR resulting_version >= 1),
    metadata_json     TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json))
) STRICT;

INSERT INTO audit_events (
    sequence, id, occurred_at, actor_kind, actor_user_id, session_id, workspace_id,
    request_id, action, target_type, target_id, outcome, prior_version,
    resulting_version, metadata_json)
SELECT
    sequence, id, occurred_at, actor_kind, actor_user_id, session_id, workspace_id,
    request_id, action, target_type, target_id, outcome, prior_version,
    resulting_version, metadata_json
FROM audit_events_schema1
ORDER BY sequence;

-- A count or maximum-sequence discrepancy fails this CHECK and rolls the entire
-- migration back rather than leaving a silently truncated journal.
INSERT INTO migration_0002_guard (checkpoint, ok)
SELECT 'audit_events', CASE WHEN
    (SELECT COUNT(*) FROM audit_events) = (SELECT COUNT(*) FROM audit_events_schema1)
    AND COALESCE((SELECT MAX(sequence) FROM audit_events), 0)
      = COALESCE((SELECT MAX(sequence) FROM audit_events_schema1), 0)
  THEN 1 ELSE 0 END;

DROP TABLE audit_events_schema1;

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

DROP TRIGGER workspace_events_no_update;
DROP TRIGGER workspace_events_no_delete;
ALTER TABLE workspace_events RENAME TO workspace_events_schema1;

CREATE TABLE workspace_events (
    sequence       INTEGER PRIMARY KEY AUTOINCREMENT,
    id             TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    occurred_at    TEXT NOT NULL,
    workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
    actor_user_id  TEXT REFERENCES users(id) ON DELETE RESTRICT,
    project_id     TEXT REFERENCES projects(id) ON DELETE RESTRICT,
    work_item_id   TEXT REFERENCES work_items(id) ON DELETE RESTRICT,
    run_id         TEXT,
    kind           TEXT NOT NULL REFERENCES workspace_event_kinds(kind) ON DELETE RESTRICT,
    -- Kind-agnostic here; strict per-kind payload shape stays in the Zod
    -- contracts (ADR-003). A registered kind does not make a payload valid.
    payload_json   TEXT NOT NULL CHECK (
                     json_valid(payload_json)
                     AND json_type(payload_json) = 'object')
) STRICT;

INSERT INTO workspace_events (
    sequence, id, schema_version, occurred_at, workspace_id, actor_user_id,
    project_id, work_item_id, run_id, kind, payload_json)
SELECT
    sequence, id, schema_version, occurred_at, workspace_id, actor_user_id,
    project_id, work_item_id, run_id, kind, payload_json
FROM workspace_events_schema1
ORDER BY sequence;

INSERT INTO migration_0002_guard (checkpoint, ok)
SELECT 'workspace_events', CASE WHEN
    (SELECT COUNT(*) FROM workspace_events) = (SELECT COUNT(*) FROM workspace_events_schema1)
    AND COALESCE((SELECT MAX(sequence) FROM workspace_events), 0)
      = COALESCE((SELECT MAX(sequence) FROM workspace_events_schema1), 0)
  THEN 1 ELSE 0 END;

DROP TABLE workspace_events_schema1;

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

DROP TABLE migration_0002_guard;
