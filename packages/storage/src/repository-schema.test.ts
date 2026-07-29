import { readFileSync } from 'node:fs';
import {
  A1_REPOSITORY_INSPECTION_ERROR_CODES,
  A1_REPOSITORY_INSPECTION_ERROR_SUBJECTS,
  A1_REPOSITORY_INSPECTION_OPERATIONS,
  asProjectRepositoryBindingId,
  asRepositoryId,
  STORED_CORE_EVIDENCE_DIFFERENCES,
  STORED_ENVIRONMENTAL_EVIDENCE_DIFFERENCES,
  STORED_REPOSITORY_INSPECTION_ERROR_CATEGORIES,
  STORED_REPOSITORY_INSPECTION_RETRYABILITIES,
  STORED_REPOSITORY_RISK_SIGNALS,
  STORED_RISK_EVIDENCE_DIFFERENCES,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { seedPlan, seedWorkspace, SEED_NOW } from './planning-test-support.js';
import { repositoryRegistrationInspection } from './repository-test-support.js';
import { temporaryStorage, type TemporaryStorage } from './test-support.js';

const temporaries: TemporaryStorage[] = [];
const databases: Database.Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const temporary of temporaries.splice(0)) temporary.cleanup();
});

function rawRegistered(suffix = 'schema') {
  const temporary = temporaryStorage();
  temporaries.push(temporary);
  const seed = seedWorkspace(temporary.storage, suffix);
  const inspection = repositoryRegistrationInspection({
    suffix,
    workspaceId: seed.workspaceId,
    actorUserId: seed.userId,
    createdAt: SEED_NOW,
  });
  const result = temporary.storage.repositoryRegistry.repositories.register({
    id: asRepositoryId(`repository-${suffix}`),
    workspaceId: seed.workspaceId,
    displayName: 'Schema repository',
    actorUserId: seed.userId,
    inspection,
  });
  if (result.kind !== 'created') throw new Error(result.kind);
  temporary.storage.close();
  const database = openDatabase(temporary.databasePath);
  databases.push(database);
  return { database, seed, repository: result.repository, inspection };
}

function rawRelationshipContext(suffix: string) {
  const temporary = temporaryStorage();
  temporaries.push(temporary);
  const primary = seedWorkspace(temporary.storage, `${suffix}-primary`);
  const primaryInspection = repositoryRegistrationInspection({
    suffix: `${suffix}-primary`,
    workspaceId: primary.workspaceId,
    actorUserId: primary.userId,
    createdAt: SEED_NOW,
  });
  const primaryRepository = temporary.storage.repositoryRegistry.repositories.register({
    id: primaryInspection.repositoryId,
    workspaceId: primary.workspaceId,
    displayName: 'Primary repository',
    actorUserId: primary.userId,
    inspection: primaryInspection,
  });
  if (primaryRepository.kind !== 'created') throw new Error(primaryRepository.kind);
  const primaryPlan = seedPlan(temporary.storage, primary, {
    suffix: `${suffix}-primary`,
    digest: 'a'.repeat(64),
  });
  const binding = temporary.storage.repositoryRegistry.bindings.insert({
    id: asProjectRepositoryBindingId(`binding-${suffix}`),
    workspaceId: primary.workspaceId,
    projectId: primaryPlan.projectId,
    repositoryId: primaryRepository.repository.id,
    expectedRepositoryVersion: 1,
    actorUserId: primary.userId,
    boundAt: SEED_NOW,
  });
  if (binding.kind !== 'created') throw new Error(binding.kind);

  const foreign = seedWorkspace(temporary.storage, `${suffix}-foreign`);
  const foreignInspection = repositoryRegistrationInspection({
    suffix: `${suffix}-foreign`,
    workspaceId: foreign.workspaceId,
    actorUserId: foreign.userId,
    createdAt: SEED_NOW,
  });
  const foreignRepository = temporary.storage.repositoryRegistry.repositories.register({
    id: foreignInspection.repositoryId,
    workspaceId: foreign.workspaceId,
    displayName: 'Foreign repository',
    actorUserId: foreign.userId,
    inspection: foreignInspection,
  });
  if (foreignRepository.kind !== 'created') throw new Error(foreignRepository.kind);
  const foreignPlan = seedPlan(temporary.storage, foreign, {
    suffix: `${suffix}-foreign`,
    digest: 'b'.repeat(64),
  });

  temporary.storage.close();
  const database = openDatabase(temporary.databasePath);
  databases.push(database);
  return {
    database,
    primary,
    primaryInspection,
    primaryRepository: primaryRepository.repository,
    primaryPlan,
    binding: binding.binding,
    foreign,
    foreignRepository: foreignRepository.repository,
    foreignPlan,
  };
}

function insertVerificationFromRegistration(
  database: Database.Database,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly repositoryId: string;
    readonly actorUserId: string;
    readonly sourceInspectionId: string;
  },
) {
  return database
    .prepare(
      `INSERT INTO repository_inspections (
         id, workspace_id, repository_id, actor_user_id, kind, outcome, created_at,
         observation_json, observation_sha256, observation_version,
         inspection_policy_version, observed_at, canonical_top_level,
         canonical_git_directory, canonical_common_git_directory, object_format,
         top_level_inode, common_directory_inode, core_fingerprint_sha256,
         top_level_device, common_directory_device, risk_scan_scope_version,
         risk_scanned_key_pattern, risk_classification, risk_signals_json,
         core_differences_json, environmental_differences_json, risk_differences_json)
       SELECT ?, ?, ?, ?, 'verification', outcome, created_at, observation_json,
         observation_sha256, observation_version, inspection_policy_version,
         observed_at, canonical_top_level, canonical_git_directory,
         canonical_common_git_directory, object_format, top_level_inode,
         common_directory_inode, core_fingerprint_sha256, top_level_device,
         common_directory_device, risk_scan_scope_version, risk_scanned_key_pattern,
         risk_classification, risk_signals_json, '[]', '[]', '[]'
       FROM repository_inspections WHERE id = ?`,
    )
    .run(
      input.id,
      input.workspaceId,
      input.repositoryId,
      input.actorUserId,
      input.sourceInspectionId,
    );
}

describe('schema 3 repository model', () => {
  it('keeps machine-readable SQL allowlists equal to domain vocabulary (A2-SCOPE-004)', () => {
    const sql = readFileSync(
      new URL('../migrations/0003-ct04a2a-repository-model.sql', import.meta.url),
      'utf8',
    );
    const literalSet = (name: string) => {
      const begin = `-- DOMAIN-LITERAL-SET ${name} BEGIN`;
      const end = `-- DOMAIN-LITERAL-SET ${name} END`;
      const start = sql.indexOf(begin);
      const finish = sql.indexOf(end);
      if (start < 0 || finish < start) throw new Error(`missing ${name}`);
      return sql
        .slice(start + begin.length, finish)
        .replaceAll('--', '')
        .trim()
        .split(/\s+/)
        .toSorted();
    };
    expect(literalSet('repository-risk-signals')).toEqual(
      [...STORED_REPOSITORY_RISK_SIGNALS].toSorted(),
    );
    expect(literalSet('core-differences')).toEqual(
      [...STORED_CORE_EVIDENCE_DIFFERENCES].toSorted(),
    );
    expect(literalSet('environmental-differences')).toEqual(
      [...STORED_ENVIRONMENTAL_EVIDENCE_DIFFERENCES].toSorted(),
    );
    expect(literalSet('risk-differences')).toEqual(
      [...STORED_RISK_EVIDENCE_DIFFERENCES].toSorted(),
    );
    expect(literalSet('error-codes')).toEqual([...A1_REPOSITORY_INSPECTION_ERROR_CODES].toSorted());
    expect(literalSet('error-subjects')).toEqual(
      [...A1_REPOSITORY_INSPECTION_ERROR_SUBJECTS].toSorted(),
    );
    expect(literalSet('error-categories')).toEqual(
      [...STORED_REPOSITORY_INSPECTION_ERROR_CATEGORIES].toSorted(),
    );
    expect(literalSet('error-operations')).toEqual(
      [...A1_REPOSITORY_INSPECTION_OPERATIONS].toSorted(),
    );
    expect(literalSet('error-retryabilities')).toEqual(
      [...STORED_REPOSITORY_INSPECTION_RETRYABILITIES].toSorted(),
    );
  });

  it('creates exactly three strict tables with the exact inspection columns (A2A-MIG-001 A2A-INSP-018)', () => {
    const { database } = rawRegistered();
    const tables = database
      .prepare(
        `SELECT name, sql FROM sqlite_master
           WHERE type = 'table' AND name IN (
             'registered_repositories', 'repository_inspections',
             'project_repository_bindings') ORDER BY name`,
      )
      .all() as { name: string; sql: string }[];
    expect(tables.map((row) => row.name)).toEqual([
      'project_repository_bindings',
      'registered_repositories',
      'repository_inspections',
    ]);
    expect(tables.every((row) => row.sql.endsWith('STRICT'))).toBe(true);
    expect(
      (
        database.prepare(`PRAGMA table_info(registered_repositories)`).all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    ).toHaveLength(21);
    expect(
      (
        database.prepare(`PRAGMA table_info(repository_inspections)`).all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    ).toEqual([
      'sequence',
      'id',
      'workspace_id',
      'repository_id',
      'actor_user_id',
      'kind',
      'outcome',
      'created_at',
      'observation_json',
      'observation_sha256',
      'observation_version',
      'inspection_policy_version',
      'observed_at',
      'canonical_top_level',
      'canonical_git_directory',
      'canonical_common_git_directory',
      'object_format',
      'top_level_inode',
      'common_directory_inode',
      'core_fingerprint_sha256',
      'top_level_device',
      'common_directory_device',
      'risk_scan_scope_version',
      'risk_scanned_key_pattern',
      'risk_classification',
      'risk_signals_json',
      'core_differences_json',
      'environmental_differences_json',
      'risk_differences_json',
      'error_origin',
      'error_code',
      'error_subject',
      'error_category',
      'error_operation',
      'error_retryability',
      'error_evidence_json',
    ]);
    expect(
      (
        database.prepare(`PRAGMA table_info(project_repository_bindings)`).all() as {
          name: string;
        }[]
      ).map((row) => row.name),
    ).toHaveLength(10);
    expect(
      (
        database
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'index' AND (
               name LIKE 'uq_registered_repositories_%'
               OR name LIKE 'idx_registered_repositories_%'
               OR name LIKE 'uq_repository_registration_%'
               OR name LIKE 'idx_repository_inspections_%'
               OR name LIKE 'uq_project_repository_bindings_%'
               OR name LIKE 'idx_project_repository_bindings_%')
             ORDER BY name`,
          )
          .all() as { name: string }[]
      ).map((row) => row.name),
    ).toEqual([
      'idx_project_repository_bindings_project_history',
      'idx_project_repository_bindings_repository',
      'idx_registered_repositories_workspace_status',
      'idx_repository_inspections_history',
      'idx_repository_inspections_success_history',
      'uq_project_repository_bindings_active_project',
      'uq_registered_repositories_live_common_git',
      'uq_registered_repositories_live_fingerprint',
      'uq_registered_repositories_live_top',
      'uq_repository_registration_inspection',
    ]);
  });

  it('installs the exact reviewed trigger inventory (A2A-MIG-001)', () => {
    const { database } = rawRegistered('triggers');
    const names = (
      database
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'trigger'
           AND (tbl_name = 'registered_repositories'
             OR tbl_name = 'repository_inspections'
             OR tbl_name = 'project_repository_bindings')
           ORDER BY name`,
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
    expect(names).toEqual(
      [
        'registered_repositories_initial_state',
        'registered_repositories_transition_only',
        'registered_repositories_retirement_requires_closed_bindings',
        'registered_repositories_no_delete',
        'repository_inspections_record_shape',
        'repository_inspections_parent_state',
        'repository_inspections_arrays_valid',
        'repository_inspections_failure_taxonomy',
        'repository_inspections_no_update',
        'repository_inspections_no_delete',
        'project_repository_bindings_initial_state',
        'project_repository_bindings_retirement_only',
        'project_repository_bindings_no_delete',
      ].toSorted(),
    );
  });

  it('defers only the inspection parent and rejects an orphan at outer commit (A2A-REP-002/003/004 A2A-BASE-003)', () => {
    const { database, inspection } = rawRegistered('deferred');
    const deferred = (
      database.prepare(`PRAGMA foreign_key_list(repository_inspections)`).all() as {
        table: string;
      }[]
    ).filter((row) => row.table === 'registered_repositories');
    expect(deferred).toHaveLength(2);
    const migrationSql = readFileSync(
      new URL('../migrations/0003-ct04a2a-repository-model.sql', import.meta.url),
      'utf8',
    );
    expect(migrationSql.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(1);

    database.exec('BEGIN IMMEDIATE');
    database
      .prepare(
        `INSERT INTO repository_inspections (
           id, workspace_id, repository_id, actor_user_id, kind, outcome, created_at,
           observation_json, observation_sha256, observation_version,
           inspection_policy_version, observed_at, canonical_top_level,
           canonical_git_directory, canonical_common_git_directory, object_format,
           top_level_inode, common_directory_inode, core_fingerprint_sha256,
           top_level_device, common_directory_device, risk_scan_scope_version,
           risk_scanned_key_pattern, risk_classification, risk_signals_json,
           core_differences_json, environmental_differences_json, risk_differences_json)
         SELECT 'orphan-inspection', workspace_id, 'orphan-repository', actor_user_id,
           'registration', outcome, created_at, observation_json, observation_sha256,
           observation_version, inspection_policy_version, observed_at,
           '/source/orphan', '/source/orphan/.git', '/source/orphan/.git', object_format,
           '200', '201', ?, top_level_device, common_directory_device,
           risk_scan_scope_version, risk_scanned_key_pattern, risk_classification,
           risk_signals_json, NULL, NULL, NULL
         FROM repository_inspections WHERE id = ?`,
      )
      .run('e'.repeat(64), inspection.id);
    expect(() => database.exec('COMMIT')).toThrow(/FOREIGN KEY/);
    database.exec('ROLLBACK');
  });

  it('rejects immutable rewrites, delete, wrong version increments, and bare version bumps (A2A-REP-009..012 A2A-INSP-008/009)', () => {
    const { database, repository, inspection } = rawRegistered('immutable');
    expect(() =>
      database
        .prepare(`UPDATE repository_inspections SET created_at = created_at WHERE id = ?`)
        .run(inspection.id),
    ).toThrow(/append-only/);
    expect(() =>
      database.prepare(`DELETE FROM repository_inspections WHERE id = ?`).run(inspection.id),
    ).toThrow(/append-only/);
    expect(() =>
      database
        .prepare(`UPDATE registered_repositories SET display_name = 'Rewritten' WHERE id = ?`)
        .run(repository.id),
    ).toThrow(/invalid repository transition/);
    expect(() =>
      database
        .prepare(
          `UPDATE registered_repositories SET status = 'unavailable',
             status_reason = 'path-unavailable', version = version + 2
           WHERE id = ?`,
        )
        .run(repository.id),
    ).toThrow(/invalid repository transition/);
    expect(() =>
      database
        .prepare(`UPDATE registered_repositories SET version = version + 1 WHERE id = ?`)
        .run(repository.id),
    ).toThrow(/invalid repository transition/);
    expect(() =>
      database.prepare(`DELETE FROM registered_repositories WHERE id = ?`).run(repository.id),
    ).toThrow(/cannot be deleted/);
  });

  it('rejects partial status attribution and records the direct-SQL stale-pair limitation (A2A-REP-013)', () => {
    const { database, repository } = rawRegistered('status-attribution');
    expect(() =>
      database
        .prepare(
          `UPDATE registered_repositories
           SET status = 'unavailable', status_reason = 'path-unavailable',
               status_changed_by_user_id = NULL, version = version + 1
           WHERE id = ?`,
        )
        .run(repository.id),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `UPDATE registered_repositories
           SET status = 'unavailable', status_reason = 'path-unavailable',
               status_changed_at = NULL, version = version + 1
           WHERE id = ?`,
        )
        .run(repository.id),
    ).toThrow();
    expect(() =>
      database
        .prepare(
          `UPDATE registered_repositories
           SET status = 'unavailable', version = version + 1 WHERE id = ?`,
        )
        .run(repository.id),
    ).toThrow(/invalid repository transition/);

    // Accepted limitation, deliberately admitted rather than rejected. A direct
    // UPDATE that omits the attribution columns leaves them at their prior
    // values, and the resulting row is indistinguishable from a genuine second
    // action by the same actor inside the same millisecond. A trigger sees only
    // OLD and NEW values, so it cannot separate the two; rejecting the pair
    // would also reject legitimate same-millisecond transitions. No storage API
    // path can produce a stale pair: applyTransition, reaffirmEnvironment, and
    // retireWithBindings always write both attribution columns from their
    // arguments. The durable per-action record is the append-only inspection
    // journal and, from A2b, the audit event.
    database
      .prepare(
        `UPDATE registered_repositories
         SET status = 'unavailable', status_reason = 'path-unavailable',
             version = version + 1 WHERE id = ?`,
      )
      .run(repository.id);
    expect(
      database
        .prepare(
          `SELECT status, status_changed_by_user_id, status_changed_at, version
           FROM registered_repositories WHERE id = ?`,
        )
        .get(repository.id),
    ).toEqual({
      status: 'unavailable',
      status_changed_by_user_id: repository.registeredByUserId,
      status_changed_at: repository.registeredAt,
      version: 2,
    });

    // Equal-millisecond transitions remain valid for the same actor, which is
    // what accepted plan section 11.1 requires.
    database
      .prepare(
        `UPDATE registered_repositories
         SET status = 'active', status_reason = 'evidence-matches',
             status_changed_by_user_id = ?, status_changed_at = ?,
             version = version + 1
         WHERE id = ?`,
      )
      .run(repository.registeredByUserId, repository.registeredAt, repository.id);
    expect(
      database
        .prepare(
          `SELECT status, status_changed_at, version FROM registered_repositories WHERE id = ?`,
        )
        .get(repository.id),
    ).toEqual({
      status: 'active',
      status_changed_at: repository.registeredAt,
      version: 3,
    });
  });

  it('rejects unsorted, duplicate, and unknown evidence arrays (A2A-INSP-010/011/014 A2A-INSP-017)', () => {
    const { database, repository, inspection } = rawRegistered('arrays');
    for (const riskSignals of [
      '["filter-smudge","filter-clean"]',
      '["filter-clean","filter-clean"]',
      '["unknown"]',
    ]) {
      expect(() =>
        database
          .prepare(
            `INSERT INTO repository_inspections (
               id, workspace_id, repository_id, actor_user_id, kind, outcome, created_at,
               observation_json, observation_sha256, observation_version,
               inspection_policy_version, observed_at, canonical_top_level,
               canonical_git_directory, canonical_common_git_directory, object_format,
               top_level_inode, common_directory_inode, core_fingerprint_sha256,
               top_level_device, common_directory_device, risk_scan_scope_version,
               risk_scanned_key_pattern, risk_classification, risk_signals_json,
               core_differences_json, environmental_differences_json, risk_differences_json)
             SELECT ?, workspace_id, repository_id, actor_user_id, 'verification',
               outcome, created_at, observation_json, observation_sha256,
               observation_version, inspection_policy_version, observed_at,
               canonical_top_level, canonical_git_directory,
               canonical_common_git_directory, object_format, top_level_inode,
               common_directory_inode, core_fingerprint_sha256, top_level_device,
               common_directory_device, risk_scan_scope_version,
               risk_scanned_key_pattern, 'signals-observed', ?, '[]', '[]', '[]'
             FROM repository_inspections WHERE id = ?`,
          )
          .run(`invalid-${riskSignals.length}`, riskSignals, inspection.id),
      ).toThrow(/sorted unique allowlisted/);
    }
    expect(repository.status).toBe('active');
  });

  it('rejects cross-workspace inspection parents and non-member actors (A2A-INSP-006/007)', () => {
    const context = rawRelationshipContext('inspection-relationships');
    expect(() =>
      insertVerificationFromRegistration(context.database, {
        id: 'inspection-foreign-parent',
        workspaceId: context.primary.workspaceId,
        repositoryId: context.foreignRepository.id,
        actorUserId: context.primary.userId,
        sourceInspectionId: context.primaryInspection.id,
      }),
    ).toThrow(/repository state|FOREIGN KEY/);
    expect(() =>
      insertVerificationFromRegistration(context.database, {
        id: 'inspection-non-member',
        workspaceId: context.primary.workspaceId,
        repositoryId: context.primaryRepository.id,
        actorUserId: context.foreign.userId,
        sourceInspectionId: context.primaryInspection.id,
      }),
    ).toThrow(/FOREIGN KEY/);
  });

  it('rejects cross-workspace and missing binding projects (A2A-BIND-002/003)', () => {
    const context = rawRelationshipContext('binding-parents');
    const statement = context.database.prepare(
      `INSERT INTO project_repository_bindings (
         id, workspace_id, project_id, repository_id, status, bound_by_user_id,
         bound_at, retired_by_user_id, retired_at, version)
       VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, NULL, 1)`,
    );
    expect(() =>
      statement.run(
        'binding-cross-workspace',
        context.primary.workspaceId,
        context.foreignPlan.projectId,
        context.primaryRepository.id,
        context.primary.userId,
        SEED_NOW,
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      statement.run(
        'binding-missing-project',
        context.primary.workspaceId,
        'project-never-created',
        context.primaryRepository.id,
        context.primary.userId,
        SEED_NOW,
      ),
    ).toThrow(/FOREIGN KEY/);
  });

  it('rejects partial retirement, retarget, unretire, and delete (A2A-BIND-009/010/011)', () => {
    const context = rawRelationshipContext('binding-lifecycle');
    expect(() =>
      context.database
        .prepare(
          `UPDATE project_repository_bindings
           SET status = 'retired', retired_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(SEED_NOW, context.binding.id),
    ).toThrow(/active-to-retired|CHECK constraint/);
    expect(() =>
      context.database
        .prepare(
          `UPDATE project_repository_bindings
           SET repository_id = ?, version = version + 1 WHERE id = ?`,
        )
        .run(context.foreignRepository.id, context.binding.id),
    ).toThrow(/active-to-retired|FOREIGN KEY/);
    context.database
      .prepare(
        `UPDATE project_repository_bindings
         SET status = 'retired', retired_by_user_id = ?, retired_at = ?,
             version = version + 1 WHERE id = ?`,
      )
      .run(context.primary.userId, SEED_NOW, context.binding.id);
    expect(() =>
      context.database
        .prepare(
          `UPDATE project_repository_bindings
           SET status = 'active', retired_by_user_id = NULL, retired_at = NULL,
               version = version + 1 WHERE id = ?`,
        )
        .run(context.binding.id),
    ).toThrow(/active-to-retired/);
    expect(() =>
      context.database
        .prepare(`DELETE FROM project_repository_bindings WHERE id = ?`)
        .run(context.binding.id),
    ).toThrow(/cannot be deleted/);
  });

  it('retains structural attribution for a revoked binding actor (A2A-BIND-012)', () => {
    const context = rawRelationshipContext('binding-attribution');
    context.database
      .prepare(
        `UPDATE workspace_memberships
         SET status = 'revoked', revoked_at = ?, version = version + 1
         WHERE workspace_id = ? AND user_id = ?`,
      )
      .run(SEED_NOW, context.primary.workspaceId, context.primary.userId);
    expect(() =>
      context.database
        .prepare(`DELETE FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`)
        .run(context.primary.workspaceId, context.primary.userId),
    ).toThrow(/FOREIGN KEY/);
    expect(
      context.database
        .prepare(`SELECT status FROM workspace_memberships WHERE workspace_id = ? AND user_id = ?`)
        .get(context.primary.workspaceId, context.primary.userId),
    ).toEqual({ status: 'revoked' });
  });

  it('keeps all structural foreign keys clean (A2A-MIG-006)', () => {
    const { database } = rawRegistered('fk');
    expect(database.pragma('foreign_key_check')).toEqual([]);
    expect(database.pragma('integrity_check', { simple: true })).toBe('ok');
  });
});
