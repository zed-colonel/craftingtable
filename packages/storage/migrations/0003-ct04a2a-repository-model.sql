-- CT-04A2a schema version 3: repository identity, evidence, and project binding.
--
-- The browser, server, and Git inspector are deliberately absent here. This
-- migration owns durable vocabulary and structural invariants only.

INSERT INTO audit_action_kinds (action, introduced_in_schema) VALUES
  ('repository.register',       3),
  ('repository.inspect',        3),
  ('repository.reaffirm',       3),
  ('repository.retire',         3),
  ('repository.bind-project',   3),
  ('repository.unbind-project', 3);

-- The inspection table is declared first so a registration inspection can be
-- inserted before its repository. Its one circular parent key is checked only
-- at the outermost COMMIT. Repository-to-inspection links declared below are
-- immediate.
CREATE TABLE repository_inspections (
  sequence                       INTEGER PRIMARY KEY AUTOINCREMENT,
  id                             TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
  workspace_id                   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  repository_id                  TEXT NOT NULL CHECK (length(repository_id) > 0),
  actor_user_id                  TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind                           TEXT NOT NULL CHECK (kind IN ('registration', 'verification', 'reaffirmation')),
  outcome                        TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  created_at                     TEXT NOT NULL,
  observation_json               TEXT,
  observation_sha256             TEXT,
  observation_version            INTEGER,
  inspection_policy_version      INTEGER,
  observed_at                    TEXT,
  canonical_top_level            TEXT,
  canonical_git_directory        TEXT,
  canonical_common_git_directory TEXT,
  object_format                  TEXT,
  top_level_inode                TEXT,
  common_directory_inode         TEXT,
  core_fingerprint_sha256        TEXT,
  top_level_device               TEXT,
  common_directory_device        TEXT,
  risk_scan_scope_version        INTEGER,
  risk_scanned_key_pattern       TEXT,
  risk_classification            TEXT,
  risk_signals_json              TEXT,
  core_differences_json          TEXT,
  environmental_differences_json TEXT,
  risk_differences_json          TEXT,
  error_origin                   TEXT,
  error_code                     TEXT,
  error_subject                  TEXT,
  error_category                 TEXT,
  error_operation                TEXT,
  error_retryability             TEXT,
  error_evidence_json            TEXT,
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, repository_id, id),
  FOREIGN KEY (workspace_id, actor_user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, repository_id)
    REFERENCES registered_repositories(workspace_id, id) ON DELETE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (
    (outcome = 'succeeded'
      AND observation_json IS NOT NULL
      AND observation_sha256 IS NOT NULL
      AND observation_version IS NOT NULL
      AND inspection_policy_version IS NOT NULL
      AND observed_at IS NOT NULL
      AND canonical_top_level IS NOT NULL
      AND canonical_git_directory IS NOT NULL
      AND canonical_common_git_directory IS NOT NULL
      AND object_format IS NOT NULL
      AND top_level_inode IS NOT NULL
      AND common_directory_inode IS NOT NULL
      AND core_fingerprint_sha256 IS NOT NULL
      AND top_level_device IS NOT NULL
      AND common_directory_device IS NOT NULL
      AND risk_scan_scope_version IS NOT NULL
      AND risk_scanned_key_pattern IS NOT NULL
      AND risk_classification IS NOT NULL
      AND risk_signals_json IS NOT NULL
      AND error_origin IS NULL AND error_code IS NULL AND error_subject IS NULL
      AND error_category IS NULL AND error_operation IS NULL
      AND error_retryability IS NULL AND error_evidence_json IS NULL)
    OR
    (outcome = 'failed'
      AND kind <> 'registration'
      AND observation_json IS NULL
      AND observation_sha256 IS NULL
      AND observation_version IS NULL
      AND inspection_policy_version IS NULL
      AND observed_at IS NULL
      AND canonical_top_level IS NULL
      AND canonical_git_directory IS NULL
      AND canonical_common_git_directory IS NULL
      AND object_format IS NULL
      AND top_level_inode IS NULL
      AND common_directory_inode IS NULL
      AND core_fingerprint_sha256 IS NULL
      AND top_level_device IS NULL
      AND common_directory_device IS NULL
      AND risk_scan_scope_version IS NULL
      AND risk_scanned_key_pattern IS NULL
      AND risk_classification IS NULL
      AND risk_signals_json IS NULL
      AND core_differences_json IS NULL
      AND environmental_differences_json IS NULL
      AND risk_differences_json IS NULL
      AND error_origin IS NOT NULL AND error_code IS NOT NULL
      AND error_subject IS NOT NULL AND error_category IS NOT NULL
      AND error_operation IS NOT NULL AND error_retryability IS NOT NULL
      AND error_evidence_json IS NOT NULL)
  ),
  CHECK (
    outcome <> 'succeeded' OR (
      observation_version = 1
      AND inspection_policy_version BETWEEN 1 AND 9007199254740991
      AND risk_scan_scope_version = 1
      AND length(CAST(observation_json AS BLOB)) BETWEEN 1 AND 131072
      AND json_valid(observation_json)
      AND observation_sha256 GLOB replace(hex(zeroblob(32)), '00', '[0-9a-f][0-9a-f]')
      AND length(observation_sha256) = 64
      AND object_format IN ('sha1', 'sha256')
      AND length(CAST(risk_scanned_key_pattern AS BLOB)) BETWEEN 1 AND 2048
      AND risk_classification IN ('no-signals-in-scanned-set', 'signals-observed')
      AND json_valid(risk_signals_json)
      AND json_type(risk_signals_json) = 'array'
      AND ((json_array_length(risk_signals_json) = 0) = (risk_classification = 'no-signals-in-scanned-set'))
    )
  ),
  CHECK (
    outcome <> 'succeeded' OR (
      substr(canonical_top_level, 1, 1) = '/'
      AND substr(canonical_git_directory, 1, 1) = '/'
      AND substr(canonical_common_git_directory, 1, 1) = '/'
      AND instr(canonical_top_level, char(0)) = 0
      AND instr(canonical_git_directory, char(0)) = 0
      AND instr(canonical_common_git_directory, char(0)) = 0
      AND length(CAST(canonical_top_level AS BLOB)) BETWEEN 1 AND 4096
      AND length(CAST(canonical_git_directory AS BLOB)) BETWEEN 1 AND 4096
      AND length(CAST(canonical_common_git_directory AS BLOB)) BETWEEN 1 AND 4096
      AND (top_level_inode = '0' OR (substr(top_level_inode, 1, 1) BETWEEN '1' AND '9' AND top_level_inode NOT GLOB '*[^0-9]*'))
      AND (common_directory_inode = '0' OR (substr(common_directory_inode, 1, 1) BETWEEN '1' AND '9' AND common_directory_inode NOT GLOB '*[^0-9]*'))
      AND (top_level_device = '0' OR (substr(top_level_device, 1, 1) BETWEEN '1' AND '9' AND top_level_device NOT GLOB '*[^0-9]*'))
      AND (common_directory_device = '0' OR (substr(common_directory_device, 1, 1) BETWEEN '1' AND '9' AND common_directory_device NOT GLOB '*[^0-9]*'))
      AND length(core_fingerprint_sha256) = 64
      AND core_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  CHECK (
    outcome <> 'succeeded' OR
    (kind = 'registration'
      AND core_differences_json IS NULL
      AND environmental_differences_json IS NULL
      AND risk_differences_json IS NULL)
    OR
    (kind IN ('verification', 'reaffirmation')
      AND core_differences_json IS NOT NULL
      AND environmental_differences_json IS NOT NULL
      AND risk_differences_json IS NOT NULL)
  )
) STRICT;

CREATE TABLE registered_repositories (
  id                                 TEXT PRIMARY KEY CHECK (length(id) > 0),
  workspace_id                       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  display_name                       TEXT NOT NULL CHECK (
                                         display_name = trim(display_name)
                                         AND length(display_name) BETWEEN 1 AND 120
                                         AND instr(display_name, char(0)) = 0
                                         AND display_name NOT GLOB '*[' || char(1) || '-' || char(31) || char(127) || ']*'),
  canonical_top_level                TEXT NOT NULL CHECK (
                                         substr(canonical_top_level, 1, 1) = '/'
                                         AND instr(canonical_top_level, char(0)) = 0
                                         AND length(CAST(canonical_top_level AS BLOB)) BETWEEN 1 AND 4096),
  canonical_git_directory            TEXT NOT NULL CHECK (
                                         substr(canonical_git_directory, 1, 1) = '/'
                                         AND instr(canonical_git_directory, char(0)) = 0
                                         AND length(CAST(canonical_git_directory AS BLOB)) BETWEEN 1 AND 4096),
  canonical_common_git_directory     TEXT NOT NULL CHECK (
                                         substr(canonical_common_git_directory, 1, 1) = '/'
                                         AND instr(canonical_common_git_directory, char(0)) = 0
                                         AND length(CAST(canonical_common_git_directory AS BLOB)) BETWEEN 1 AND 4096),
  object_format                      TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
  top_level_inode                    TEXT NOT NULL CHECK (
                                         top_level_inode = '0' OR
                                         (substr(top_level_inode, 1, 1) BETWEEN '1' AND '9'
                                          AND top_level_inode NOT GLOB '*[^0-9]*')),
  common_directory_inode             TEXT NOT NULL CHECK (
                                         common_directory_inode = '0' OR
                                         (substr(common_directory_inode, 1, 1) BETWEEN '1' AND '9'
                                          AND common_directory_inode NOT GLOB '*[^0-9]*')),
  core_fingerprint_sha256            TEXT NOT NULL CHECK (
                                         length(core_fingerprint_sha256) = 64
                                         AND core_fingerprint_sha256 NOT GLOB '*[^0-9a-f]*'),
  observation_version                INTEGER NOT NULL CHECK (observation_version = 1),
  inspection_policy_version          INTEGER NOT NULL CHECK (inspection_policy_version BETWEEN 1 AND 9007199254740991),
  registration_inspection_id         TEXT NOT NULL,
  accepted_environment_inspection_id TEXT NOT NULL,
  status                             TEXT NOT NULL CHECK (status IN (
                                         'active', 'unavailable', 'identity-evidence-changed',
                                         'identity-mismatch', 'evidence-blocked', 'retired')),
  status_reason                      TEXT NOT NULL,
  registered_by_user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  registered_at                      TEXT NOT NULL,
  status_changed_by_user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status_changed_at                  TEXT NOT NULL,
  version                            INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, registered_by_user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, status_changed_by_user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, id, registration_inspection_id)
    REFERENCES repository_inspections(workspace_id, repository_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, id, accepted_environment_inspection_id)
    REFERENCES repository_inspections(workspace_id, repository_id, id) ON DELETE RESTRICT,
  CHECK (
    (status = 'active' AND status_reason IN ('registration-accepted', 'evidence-matches', 'environment-evidence-reaffirmed'))
    OR (status = 'unavailable' AND status_reason IN ('path-unavailable', 'metadata-unreadable'))
    OR (status = 'identity-evidence-changed' AND status_reason = 'environment-evidence-changed')
    OR (status = 'identity-mismatch' AND status_reason IN ('core-identity-changed', 'repository-class-changed'))
    OR (status = 'evidence-blocked' AND status_reason IN (
      'stored-evidence-digest-mismatch', 'stored-evidence-invalid',
      'unsupported-observation-version', 'inspection-policy-version-mismatch'))
    OR (status = 'retired' AND status_reason = 'operator-retired')
  )
) STRICT;

CREATE TABLE project_repository_bindings (
  id                 TEXT PRIMARY KEY CHECK (length(id) > 0),
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  project_id         TEXT NOT NULL,
  repository_id      TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('active', 'retired')),
  bound_by_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bound_at           TEXT NOT NULL,
  retired_by_user_id TEXT REFERENCES users(id) ON DELETE RESTRICT,
  retired_at         TEXT,
  version            INTEGER NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, project_id, repository_id, id),
  FOREIGN KEY (workspace_id, project_id)
    REFERENCES projects(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, repository_id)
    REFERENCES registered_repositories(workspace_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, bound_by_user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, retired_by_user_id)
    REFERENCES workspace_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  CHECK (
    (status = 'active' AND retired_by_user_id IS NULL AND retired_at IS NULL)
    OR (status = 'retired' AND retired_by_user_id IS NOT NULL AND retired_at IS NOT NULL)
  )
) STRICT;

CREATE UNIQUE INDEX uq_registered_repositories_live_top
  ON registered_repositories(canonical_top_level) WHERE status <> 'retired';
CREATE UNIQUE INDEX uq_registered_repositories_live_common_git
  ON registered_repositories(canonical_common_git_directory) WHERE status <> 'retired';
CREATE UNIQUE INDEX uq_registered_repositories_live_fingerprint
  ON registered_repositories(core_fingerprint_sha256) WHERE status <> 'retired';
CREATE INDEX idx_registered_repositories_workspace_status
  ON registered_repositories(workspace_id, status, registered_at, id);

CREATE UNIQUE INDEX uq_repository_registration_inspection
  ON repository_inspections(repository_id)
  WHERE kind = 'registration' AND outcome = 'succeeded';
CREATE INDEX idx_repository_inspections_history
  ON repository_inspections(workspace_id, repository_id, sequence DESC);
CREATE INDEX idx_repository_inspections_success_history
  ON repository_inspections(workspace_id, repository_id, sequence DESC)
  WHERE outcome = 'succeeded';

CREATE UNIQUE INDEX uq_project_repository_bindings_active_project
  ON project_repository_bindings(workspace_id, project_id) WHERE status = 'active';
CREATE INDEX idx_project_repository_bindings_repository
  ON project_repository_bindings(workspace_id, repository_id, status, bound_at, id);
CREATE INDEX idx_project_repository_bindings_project_history
  ON project_repository_bindings(workspace_id, project_id, bound_at, id);

CREATE TRIGGER registered_repositories_initial_state
BEFORE INSERT ON registered_repositories
WHEN NOT (
  NEW.version = 1
  AND NEW.status = 'active'
  AND NEW.status_reason = 'registration-accepted'
  AND NEW.registration_inspection_id = NEW.accepted_environment_inspection_id
  AND NEW.registered_by_user_id = NEW.status_changed_by_user_id
  AND NEW.registered_at = NEW.status_changed_at
  AND EXISTS (
    SELECT 1 FROM repository_inspections i
    WHERE i.workspace_id = NEW.workspace_id
      AND i.repository_id = NEW.id
      AND i.id = NEW.registration_inspection_id
      AND i.kind = 'registration' AND i.outcome = 'succeeded'
      AND i.actor_user_id = NEW.registered_by_user_id
      AND i.created_at = NEW.registered_at
      AND i.canonical_top_level = NEW.canonical_top_level
      AND i.canonical_git_directory = NEW.canonical_git_directory
      AND i.canonical_common_git_directory = NEW.canonical_common_git_directory
      AND i.object_format = NEW.object_format
      AND i.top_level_inode = NEW.top_level_inode
      AND i.common_directory_inode = NEW.common_directory_inode
      AND i.core_fingerprint_sha256 = NEW.core_fingerprint_sha256
      AND i.observation_version = NEW.observation_version
      AND i.inspection_policy_version = NEW.inspection_policy_version
  )
)
BEGIN
  SELECT RAISE(ABORT, 'repository registration graph is incoherent');
END;

CREATE TRIGGER registered_repositories_transition_only
BEFORE UPDATE ON registered_repositories
WHEN NOT (
  OLD.workspace_id IS NEW.workspace_id
  AND OLD.display_name IS NEW.display_name
  AND OLD.canonical_top_level IS NEW.canonical_top_level
  AND OLD.canonical_git_directory IS NEW.canonical_git_directory
  AND OLD.canonical_common_git_directory IS NEW.canonical_common_git_directory
  AND OLD.object_format IS NEW.object_format
  AND OLD.top_level_inode IS NEW.top_level_inode
  AND OLD.common_directory_inode IS NEW.common_directory_inode
  AND OLD.core_fingerprint_sha256 IS NEW.core_fingerprint_sha256
  AND OLD.observation_version IS NEW.observation_version
  AND OLD.inspection_policy_version IS NEW.inspection_policy_version
  AND OLD.registration_inspection_id IS NEW.registration_inspection_id
  AND OLD.registered_by_user_id IS NEW.registered_by_user_id
  AND OLD.registered_at IS NEW.registered_at
  AND NEW.version = OLD.version + 1
  AND NEW.status_changed_at >= OLD.status_changed_at
  AND (
    (OLD.status = 'active' AND (
      (NEW.status = 'identity-evidence-changed' AND NEW.status_reason = 'environment-evidence-changed' AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
      OR (NEW.status = 'identity-mismatch' AND NEW.status_reason IN ('core-identity-changed', 'repository-class-changed') AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
      OR (NEW.status = 'unavailable' AND NEW.status_reason IN ('path-unavailable', 'metadata-unreadable') AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
      OR (NEW.status = 'evidence-blocked' AND NEW.status_reason IN ('stored-evidence-digest-mismatch', 'stored-evidence-invalid', 'unsupported-observation-version', 'inspection-policy-version-mismatch') AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
      OR (NEW.status = 'retired' AND NEW.status_reason = 'operator-retired' AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
    ))
    OR (OLD.status = 'unavailable' AND (
      (NEW.status = 'active' AND NEW.status_reason = 'evidence-matches' AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
      OR (NEW.status = 'identity-evidence-changed' AND NEW.status_reason = 'environment-evidence-changed' AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
      OR (NEW.status = 'identity-mismatch' AND NEW.status_reason IN ('core-identity-changed', 'repository-class-changed') AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
      OR (NEW.status = 'evidence-blocked' AND NEW.status_reason IN ('stored-evidence-digest-mismatch', 'stored-evidence-invalid', 'unsupported-observation-version', 'inspection-policy-version-mismatch') AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
      OR (NEW.status = 'retired' AND NEW.status_reason = 'operator-retired' AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
    ))
    OR (OLD.status = 'identity-evidence-changed' AND (
      (NEW.status = 'active' AND NEW.status_reason = 'evidence-matches' AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
      OR (NEW.status = 'active' AND NEW.status_reason = 'environment-evidence-reaffirmed'
        AND NEW.accepted_environment_inspection_id <> OLD.accepted_environment_inspection_id
        AND EXISTS (
          SELECT 1 FROM repository_inspections i
          WHERE i.workspace_id = NEW.workspace_id AND i.repository_id = NEW.id
            AND i.id = NEW.accepted_environment_inspection_id
            AND i.kind = 'reaffirmation' AND i.outcome = 'succeeded'
            AND i.actor_user_id = NEW.status_changed_by_user_id
            AND i.sequence = (
              SELECT MAX(s.sequence) FROM repository_inspections s
              WHERE s.workspace_id = NEW.workspace_id AND s.repository_id = NEW.id
                AND s.outcome = 'succeeded')
            AND i.canonical_top_level = NEW.canonical_top_level
            AND i.canonical_git_directory = NEW.canonical_git_directory
            AND i.canonical_common_git_directory = NEW.canonical_common_git_directory
            AND i.object_format = NEW.object_format
            AND i.top_level_inode = NEW.top_level_inode
            AND i.common_directory_inode = NEW.common_directory_inode
            AND i.core_fingerprint_sha256 = NEW.core_fingerprint_sha256
            AND i.observation_version = NEW.observation_version
            AND i.inspection_policy_version = NEW.inspection_policy_version
            AND json_array_length(i.environmental_differences_json) > 0
        ))
      OR (NEW.status = 'unavailable' AND NEW.status_reason IN ('path-unavailable', 'metadata-unreadable') AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
      OR (NEW.status = 'identity-mismatch' AND NEW.status_reason IN ('core-identity-changed', 'repository-class-changed') AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
      OR (NEW.status = 'evidence-blocked' AND NEW.status_reason IN ('stored-evidence-digest-mismatch', 'stored-evidence-invalid', 'unsupported-observation-version', 'inspection-policy-version-mismatch') AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
      OR (NEW.status = 'retired' AND NEW.status_reason = 'operator-retired' AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
    ))
    OR (OLD.status IN ('identity-mismatch', 'evidence-blocked')
      AND NEW.status = 'retired' AND NEW.status_reason = 'operator-retired'
      AND NEW.accepted_environment_inspection_id = OLD.accepted_environment_inspection_id)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid repository transition');
END;

CREATE TRIGGER registered_repositories_retirement_requires_closed_bindings
BEFORE UPDATE ON registered_repositories
WHEN NEW.status = 'retired'
 AND EXISTS (
   SELECT 1 FROM project_repository_bindings b
   WHERE b.workspace_id = OLD.workspace_id AND b.repository_id = OLD.id AND b.status = 'active'
 )
BEGIN
  SELECT RAISE(ABORT, 'active bindings must be retired first');
END;

CREATE TRIGGER registered_repositories_no_delete
BEFORE DELETE ON registered_repositories
BEGIN
  SELECT RAISE(ABORT, 'registered repositories cannot be deleted');
END;

CREATE TRIGGER repository_inspections_record_shape
BEFORE INSERT ON repository_inspections
WHEN
  (NEW.outcome = 'succeeded' AND (
    json_valid(NEW.risk_signals_json) = 0
    OR json_type(NEW.risk_signals_json) <> 'array'
    OR json_array_length(NEW.risk_signals_json) > 14
    OR (NEW.kind <> 'registration' AND (
      json_valid(NEW.core_differences_json) = 0
      OR json_valid(NEW.environmental_differences_json) = 0
      OR json_valid(NEW.risk_differences_json) = 0
      OR json_type(NEW.core_differences_json) <> 'array'
      OR json_type(NEW.environmental_differences_json) <> 'array'
      OR json_type(NEW.risk_differences_json) <> 'array'
    ))
  ))
  OR
  (NEW.outcome = 'failed' AND (
    json_valid(NEW.error_evidence_json) = 0
    OR json_type(NEW.error_evidence_json) <> 'object'
    OR length(CAST(NEW.error_evidence_json AS BLOB)) > 8192
    OR (SELECT COUNT(*) FROM json_each(NEW.error_evidence_json)) > 16
  ))
BEGIN
  SELECT RAISE(ABORT, 'repository inspection record shape is invalid');
END;

CREATE TRIGGER repository_inspections_parent_state
BEFORE INSERT ON repository_inspections
WHEN
  (NEW.kind = 'registration' AND EXISTS (
    SELECT 1 FROM registered_repositories r
    WHERE r.workspace_id = NEW.workspace_id AND r.id = NEW.repository_id
  ))
  OR
  (NEW.kind = 'verification' AND NOT EXISTS (
    SELECT 1 FROM registered_repositories r
    WHERE r.workspace_id = NEW.workspace_id AND r.id = NEW.repository_id
      AND r.status IN ('active', 'unavailable', 'identity-evidence-changed')
  ))
  OR
  (NEW.kind = 'reaffirmation' AND NOT EXISTS (
    SELECT 1 FROM registered_repositories r
    WHERE r.workspace_id = NEW.workspace_id AND r.id = NEW.repository_id
      AND r.status = 'identity-evidence-changed'
  ))
BEGIN
  SELECT RAISE(ABORT, 'repository state does not admit this inspection');
END;

-- DOMAIN-LITERAL-SET repository-risk-signals BEGIN
-- core-hooks-path core-fsmonitor core-worktree-redirection diff-external
-- diff-driver-command diff-driver-textconv filter-clean filter-smudge filter-process
-- config-include conditional-config-include worktree-config-enabled
-- hooks-directory-symlink hook-entry
-- DOMAIN-LITERAL-SET repository-risk-signals END
-- DOMAIN-LITERAL-SET core-differences BEGIN
-- canonical-top-level canonical-git-directory canonical-common-git-directory
-- object-format top-level-inode common-directory-inode fingerprint
-- DOMAIN-LITERAL-SET core-differences END
-- DOMAIN-LITERAL-SET environmental-differences BEGIN
-- top-level-device common-directory-device
-- DOMAIN-LITERAL-SET environmental-differences END
-- DOMAIN-LITERAL-SET risk-differences BEGIN
-- scan-scope-version scanned-key-pattern signals
-- DOMAIN-LITERAL-SET risk-differences END
CREATE TRIGGER repository_inspections_arrays_valid
BEFORE INSERT ON repository_inspections
WHEN NEW.outcome = 'succeeded' AND (
  EXISTS (
    SELECT 1 FROM json_each(NEW.risk_signals_json) j
    WHERE j.type <> 'text'
       OR j.value NOT IN (
         'core-hooks-path', 'core-fsmonitor', 'core-worktree-redirection',
         'diff-external', 'diff-driver-command', 'diff-driver-textconv',
         'filter-clean', 'filter-smudge', 'filter-process', 'config-include',
         'conditional-config-include', 'worktree-config-enabled',
         'hooks-directory-symlink', 'hook-entry')
       OR (j.key > 0 AND j.value <= json_extract(NEW.risk_signals_json, '$[' || (j.key - 1) || ']'))
  )
  OR (NEW.kind <> 'registration' AND (
    json_array_length(NEW.core_differences_json) > 7
    OR json_array_length(NEW.environmental_differences_json) > 2
    OR json_array_length(NEW.risk_differences_json) > 3
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.core_differences_json) j
      WHERE j.type <> 'text'
         OR j.value NOT IN (
           'canonical-top-level', 'canonical-git-directory',
           'canonical-common-git-directory', 'object-format', 'top-level-inode',
           'common-directory-inode', 'fingerprint')
         OR (j.key > 0 AND j.value <= json_extract(NEW.core_differences_json, '$[' || (j.key - 1) || ']'))
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.environmental_differences_json) j
      WHERE j.type <> 'text'
         OR j.value NOT IN ('top-level-device', 'common-directory-device')
         OR (j.key > 0 AND j.value <= json_extract(NEW.environmental_differences_json, '$[' || (j.key - 1) || ']'))
    )
    OR EXISTS (
      SELECT 1 FROM json_each(NEW.risk_differences_json) j
      WHERE j.type <> 'text'
         OR j.value NOT IN ('scan-scope-version', 'scanned-key-pattern', 'signals')
         OR (j.key > 0 AND j.value <= json_extract(NEW.risk_differences_json, '$[' || (j.key - 1) || ']'))
    )
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'repository inspection arrays must be sorted unique allowlisted values');
END;

-- DOMAIN-LITERAL-SET error-codes BEGIN
-- invalid-options unsupported-platform root-daemon-refused invalid-root-policy
-- git-not-found git-not-executable git-executable-changed unsupported-git-version
-- invalid-path outside-allowed-root reserved-root-overlap path-unavailable
-- symlink-rejected ownership-refused repository-metadata-unreadable
-- not-primary-repository not-git-repository unsupported-object-format
-- unsupported-repository-extension spawn-failed aborted timed-out stdout-overflow
-- stderr-overflow signal-terminated git-command-failed invalid-output-encoding
-- malformed-version-output malformed-identity-output malformed-feature-output
-- feature-count-exceeded observation-raced recorded-observation-invalid
-- unsupported-observation-version inspection-policy-version-mismatch
-- DOMAIN-LITERAL-SET error-codes END
-- DOMAIN-LITERAL-SET error-subjects BEGIN
-- caller-input policy-configuration host-environment repository-unavailable
-- repository-class-changed git-boundary-fault recorded-evidence-invalid
-- evidence-not-comparable
-- DOMAIN-LITERAL-SET error-subjects END
-- DOMAIN-LITERAL-SET error-categories BEGIN
-- configuration path-policy git-process observation
-- DOMAIN-LITERAL-SET error-categories END
-- DOMAIN-LITERAL-SET error-operations BEGIN
-- create-inspector inspect-path parse-recorded-observation compare-observations
-- DOMAIN-LITERAL-SET error-operations END
-- DOMAIN-LITERAL-SET error-retryabilities BEGIN
-- retryable configuration-required not-retryable
-- DOMAIN-LITERAL-SET error-retryabilities END
CREATE TRIGGER repository_inspections_failure_taxonomy
BEFORE INSERT ON repository_inspections
WHEN NEW.outcome = 'failed' AND NOT (
  (NEW.error_origin = 'storage-integrity'
    AND NEW.kind = 'verification'
    AND NEW.error_code = 'stored-evidence-digest-mismatch'
    AND NEW.error_subject = 'stored-evidence-integrity'
    AND NEW.error_category = 'observation'
    AND NEW.error_operation = 'verify-stored-record'
    AND NEW.error_retryability = 'not-retryable')
  OR
  (NEW.error_origin = 'a1'
    AND NEW.error_operation IN (
      'create-inspector', 'inspect-path', 'parse-recorded-observation', 'compare-observations')
    AND (
      (NEW.error_code = 'invalid-path' AND NEW.error_subject = 'caller-input'
        AND NEW.error_category = 'path-policy' AND NEW.error_retryability = 'not-retryable')
      OR (NEW.error_code IN ('invalid-options', 'invalid-root-policy', 'outside-allowed-root', 'reserved-root-overlap')
        AND NEW.error_subject = 'policy-configuration'
        AND NEW.error_category = 'configuration' AND NEW.error_retryability = 'configuration-required')
      OR (NEW.error_code IN ('unsupported-platform', 'root-daemon-refused', 'git-not-found', 'git-not-executable', 'git-executable-changed', 'unsupported-git-version', 'aborted')
        AND NEW.error_subject = 'host-environment'
        AND NEW.error_category = 'configuration' AND NEW.error_retryability = 'retryable')
      OR (NEW.error_code IN ('path-unavailable', 'repository-metadata-unreadable', 'observation-raced')
        AND NEW.error_subject = 'repository-unavailable'
        AND NEW.error_category = 'path-policy' AND NEW.error_retryability = 'retryable')
      OR (NEW.error_code IN ('symlink-rejected', 'ownership-refused', 'not-primary-repository', 'not-git-repository', 'unsupported-object-format', 'unsupported-repository-extension')
        AND NEW.error_subject = 'repository-class-changed'
        AND NEW.error_category = 'path-policy' AND NEW.error_retryability = 'not-retryable')
      OR (NEW.error_code IN ('spawn-failed', 'timed-out', 'stdout-overflow', 'stderr-overflow', 'signal-terminated', 'git-command-failed', 'invalid-output-encoding', 'malformed-version-output', 'malformed-identity-output', 'malformed-feature-output', 'feature-count-exceeded')
        AND NEW.error_subject = 'git-boundary-fault'
        AND NEW.error_category = 'git-process' AND NEW.error_retryability = 'retryable')
      OR (NEW.error_code IN ('recorded-observation-invalid', 'unsupported-observation-version')
        AND NEW.error_subject = 'recorded-evidence-invalid'
        AND NEW.error_category = 'observation' AND NEW.error_retryability = 'not-retryable')
      OR (NEW.error_code = 'inspection-policy-version-mismatch'
        AND NEW.error_subject = 'evidence-not-comparable'
        AND NEW.error_category = 'observation' AND NEW.error_retryability = 'not-retryable')
    )
  )
)
OR (
  NEW.outcome = 'failed' AND EXISTS (
    SELECT 1 FROM json_each(NEW.error_evidence_json) j
    WHERE length(j.key) NOT BETWEEN 1 AND 64
       OR substr(j.key, 1, 1) NOT GLOB '[A-Za-z]'
       OR j.key GLOB '*[^A-Za-z0-9]*'
       OR j.type NOT IN ('text', 'integer', 'real', 'true', 'false')
       OR (j.type = 'text' AND length(CAST(j.value AS BLOB)) > 2048)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'repository inspection failure taxonomy is invalid');
END;

CREATE TRIGGER repository_inspections_no_update
BEFORE UPDATE ON repository_inspections
BEGIN
  SELECT RAISE(ABORT, 'repository inspections are append-only');
END;

CREATE TRIGGER repository_inspections_no_delete
BEFORE DELETE ON repository_inspections
BEGIN
  SELECT RAISE(ABORT, 'repository inspections are append-only');
END;

CREATE TRIGGER project_repository_bindings_initial_state
BEFORE INSERT ON project_repository_bindings
WHEN NOT (
  NEW.status = 'active' AND NEW.version = 1
  AND NEW.retired_by_user_id IS NULL AND NEW.retired_at IS NULL
  AND EXISTS (
    SELECT 1 FROM registered_repositories r
    WHERE r.workspace_id = NEW.workspace_id AND r.id = NEW.repository_id
      AND r.status = 'active'
  )
)
BEGIN
  SELECT RAISE(ABORT, 'binding requires an active repository and initial state');
END;

CREATE TRIGGER project_repository_bindings_retirement_only
BEFORE UPDATE ON project_repository_bindings
WHEN NOT (
  OLD.workspace_id IS NEW.workspace_id
  AND OLD.project_id IS NEW.project_id
  AND OLD.repository_id IS NEW.repository_id
  AND OLD.bound_by_user_id IS NEW.bound_by_user_id
  AND OLD.bound_at IS NEW.bound_at
  AND OLD.status = 'active' AND NEW.status = 'retired'
  AND OLD.retired_by_user_id IS NULL AND OLD.retired_at IS NULL
  AND NEW.retired_by_user_id IS NOT NULL AND NEW.retired_at IS NOT NULL
  AND NEW.version = OLD.version + 1
)
BEGIN
  SELECT RAISE(ABORT, 'binding accepts only active-to-retired with exact version increment');
END;

CREATE TRIGGER project_repository_bindings_no_delete
BEFORE DELETE ON project_repository_bindings
BEGIN
  SELECT RAISE(ABORT, 'project repository bindings cannot be deleted');
END;
