import type {
  ProjectId,
  ProjectRepositoryBindingId,
  RepositoryId,
  RepositoryInspection,
  RepositoryInspectionId,
  SuccessfulRepositoryInspection,
  WorkspaceId,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import type {
  AppendRepositoryVerificationInput,
  ApplyRepositoryTransitionInput,
  BindingMutationResult,
  InsertProjectRepositoryBindingInput,
  InspectionAppendResult,
  InspectionWrite,
  ProjectRepositoryBindingInsertResult,
  ProjectRepositoryBindingRepository,
  ProjectRepositoryBindingSummaryRow,
  ReaffirmRepositoryEnvironmentInput,
  RegisterRepositoryInput,
  RegisteredRepositoryRepository,
  RepositoryMutationResult,
  RepositoryReaffirmationResult,
  RepositoryRegistryQueryRepository,
  RepositoryRegistryRepositories,
  RepositoryInspectionSummaryRow,
  RepositoryRegistrationResult,
  RepositoryRetirementResult,
  RepositorySummaryRow,
  RetireProjectRepositoryBindingInput,
  RetireRepositoryWithBindingsInput,
} from '../../repository-types.js';
import {
  mapProjectRepositoryBinding,
  mapRegisteredRepository,
  mapRepositoryInspection,
  type ProjectRepositoryBindingRow,
  type RegisteredRepositoryRow,
  type RepositoryInspectionRow,
} from './rows.js';

const INSPECTION_COLUMNS = `
  id, workspace_id, repository_id, actor_user_id, kind, outcome, created_at,
  observation_json, observation_sha256, observation_version, inspection_policy_version,
  observed_at, canonical_top_level, canonical_git_directory,
  canonical_common_git_directory, object_format, top_level_inode,
  common_directory_inode, core_fingerprint_sha256, top_level_device,
  common_directory_device, risk_scan_scope_version, risk_scanned_key_pattern,
  risk_classification, risk_signals_json, core_differences_json,
  environmental_differences_json, risk_differences_json, error_origin, error_code,
  error_subject, error_category, error_operation, error_retryability, error_evidence_json`;

function inspectionValues(inspection: InspectionWrite): readonly unknown[] {
  const common = [
    inspection.id,
    inspection.workspaceId,
    inspection.repositoryId,
    inspection.actorUserId,
    inspection.kind,
    inspection.outcome,
    inspection.createdAt,
  ];
  if (inspection.outcome === 'succeeded') {
    return [
      ...common,
      inspection.observationJson,
      inspection.observationSha256,
      inspection.observationVersion,
      inspection.inspectionPolicyVersion,
      inspection.observedAt,
      inspection.canonicalTopLevel,
      inspection.canonicalGitDirectory,
      inspection.canonicalCommonGitDirectory,
      inspection.objectFormat,
      inspection.topLevelInode,
      inspection.commonDirectoryInode,
      inspection.coreFingerprintSha256,
      inspection.topLevelDevice,
      inspection.commonDirectoryDevice,
      inspection.riskScanScopeVersion,
      inspection.riskScannedKeyPattern,
      inspection.riskClassification,
      JSON.stringify(inspection.riskSignals),
      inspection.kind === 'registration' ? null : JSON.stringify(inspection.coreDifferences),
      inspection.kind === 'registration'
        ? null
        : JSON.stringify(inspection.environmentalDifferences),
      inspection.kind === 'registration' ? null : JSON.stringify(inspection.riskDifferences),
      null,
      null,
      null,
      null,
      null,
      null,
      null,
    ];
  }
  return [
    ...common,
    ...Array.from({ length: 21 }, () => null),
    inspection.errorOrigin,
    inspection.errorCode,
    inspection.errorSubject,
    inspection.errorCategory,
    inspection.errorOperation,
    inspection.errorRetryability,
    JSON.stringify(inspection.errorEvidence),
  ];
}

function insertInspection(
  database: Database.Database,
  inspection: InspectionWrite,
): RepositoryInspection {
  database
    .prepare(
      `INSERT INTO repository_inspections (${INSPECTION_COLUMNS})
       VALUES (${Array.from({ length: 35 }, () => '?').join(', ')})`,
    )
    .run(...inspectionValues(inspection));
  const row = database
    .prepare(`SELECT * FROM repository_inspections WHERE id = ?`)
    .get(inspection.id) as RepositoryInspectionRow | undefined;
  if (row === undefined) {
    throw new Error('Inspection insert did not produce a readable row');
  }
  return mapRepositoryInspection(row);
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'SQLITE_CONSTRAINT_UNIQUE'
  );
}

class SqliteRegisteredRepositoryRepository implements RegisteredRepositoryRepository {
  constructor(private readonly database: Database.Database) {}

  private classify(input: RegisterRepositoryInput): RepositoryRegistrationResult | undefined {
    const rows = this.database
      .prepare(
        `SELECT * FROM registered_repositories
         WHERE status <> 'retired'
           AND (canonical_top_level = ? OR canonical_common_git_directory = ?
                OR core_fingerprint_sha256 = ?)
         ORDER BY workspace_id, id`,
      )
      .all(
        input.inspection.canonicalTopLevel,
        input.inspection.canonicalCommonGitDirectory,
        input.inspection.coreFingerprintSha256,
      ) as RegisteredRepositoryRow[];
    if (rows.length === 0) {
      return undefined;
    }
    if (rows.some((row) => row.workspace_id !== input.workspaceId)) {
      return { kind: 'identity-reserved-elsewhere' };
    }
    const exact = rows.filter(
      (row) =>
        row.canonical_top_level === input.inspection.canonicalTopLevel &&
        row.canonical_common_git_directory === input.inspection.canonicalCommonGitDirectory &&
        row.core_fingerprint_sha256 === input.inspection.coreFingerprintSha256,
    );
    if (rows.length !== 1 || exact.length !== 1) {
      return { kind: 'local-identity-conflict' };
    }
    const repository = mapRegisteredRepository(exact[0] as RegisteredRepositoryRow);
    return repository.status === 'active'
      ? { kind: 'existing', repository }
      : { kind: 'conflicting-local-state', status: repository.status };
  }

  register(input: RegisterRepositoryInput): RepositoryRegistrationResult {
    const preclassified = this.classify(input);
    if (preclassified !== undefined) {
      return preclassified;
    }
    try {
      return this.database
        .transaction(() => {
          const raced = this.classify(input);
          if (raced !== undefined) {
            return raced;
          }
          if (
            input.inspection.workspaceId !== input.workspaceId ||
            input.inspection.repositoryId !== input.id ||
            input.inspection.actorUserId !== input.actorUserId
          ) {
            throw new Error('Registration input identities are incoherent');
          }
          insertInspection(this.database, input.inspection);
          this.database
            .prepare(
              `INSERT INTO registered_repositories (
               id, workspace_id, display_name, canonical_top_level,
               canonical_git_directory, canonical_common_git_directory, object_format,
               top_level_inode, common_directory_inode, core_fingerprint_sha256,
               observation_version, inspection_policy_version, registration_inspection_id,
               accepted_environment_inspection_id, status, status_reason,
               registered_by_user_id, registered_at, status_changed_by_user_id,
               status_changed_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active',
                     'registration-accepted', ?, ?, ?, ?, 1)`,
            )
            .run(
              input.id,
              input.workspaceId,
              input.displayName,
              input.inspection.canonicalTopLevel,
              input.inspection.canonicalGitDirectory,
              input.inspection.canonicalCommonGitDirectory,
              input.inspection.objectFormat,
              input.inspection.topLevelInode,
              input.inspection.commonDirectoryInode,
              input.inspection.coreFingerprintSha256,
              input.inspection.observationVersion,
              input.inspection.inspectionPolicyVersion,
              input.inspection.id,
              input.inspection.id,
              input.actorUserId,
              input.inspection.createdAt,
              input.actorUserId,
              input.inspection.createdAt,
            );
          const repository = this.find(input.workspaceId, input.id);
          if (repository === undefined) {
            throw new Error('Repository insert did not produce a readable row');
          }
          return { kind: 'created', repository } as const;
        })
        .immediate();
    } catch (error) {
      if (!isUniqueConstraint(error)) {
        throw error;
      }
      return this.classify(input) ?? { kind: 'identity-reserved-elsewhere' };
    }
  }

  find(workspaceId: WorkspaceId, repositoryId: RepositoryId) {
    const row = this.database
      .prepare(`SELECT * FROM registered_repositories WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, repositoryId) as RegisteredRepositoryRow | undefined;
    return row === undefined ? undefined : mapRegisteredRepository(row);
  }

  list(workspaceId: WorkspaceId, limit: number) {
    return (
      this.database
        .prepare(
          `SELECT * FROM registered_repositories WHERE workspace_id = ?
           ORDER BY registered_at, id LIMIT ?`,
        )
        .all(workspaceId, limit) as RegisteredRepositoryRow[]
    ).map(mapRegisteredRepository);
  }

  applyTransition(input: ApplyRepositoryTransitionInput): RepositoryMutationResult {
    const current = this.find(input.workspaceId, input.repositoryId);
    if (current === undefined) {
      return { kind: 'not-found' };
    }
    if (current.version !== input.expectedVersion) {
      return { kind: 'version-conflict' };
    }
    if (current.status !== input.reduction.fromStatus) {
      return { kind: 'state-conflict', status: current.status };
    }
    const result = this.database
      .prepare(
        `UPDATE registered_repositories
         SET status = ?, status_reason = ?, status_changed_by_user_id = ?,
             status_changed_at = ?, version = version + 1
         WHERE workspace_id = ? AND id = ? AND status = ? AND version = ?`,
      )
      .run(
        input.reduction.toStatus,
        input.reduction.reason,
        input.actorUserId,
        input.changedAt,
        input.workspaceId,
        input.repositoryId,
        input.reduction.fromStatus,
        input.expectedVersion,
      );
    if (result.changes !== 1) {
      return { kind: 'version-conflict' };
    }
    const repository = this.find(input.workspaceId, input.repositoryId);
    if (repository === undefined) {
      throw new Error('Repository disappeared after transition');
    }
    return { kind: 'changed', repository };
  }

  reaffirmEnvironment(input: ReaffirmRepositoryEnvironmentInput): RepositoryReaffirmationResult {
    return this.database
      .transaction(() => {
        const current = this.find(input.workspaceId, input.repositoryId);
        if (current === undefined) {
          return { kind: 'not-found' } as const;
        }
        if (current.version !== input.expectedVersion) {
          return { kind: 'version-conflict' } as const;
        }
        if (current.status !== 'identity-evidence-changed') {
          return { kind: 'repository-not-reaffirmable', status: current.status } as const;
        }
        const latest = this.database
          .prepare(
            `SELECT id FROM repository_inspections
           WHERE workspace_id = ? AND repository_id = ? AND outcome = 'succeeded'
           ORDER BY sequence DESC LIMIT 1`,
          )
          .get(input.workspaceId, input.repositoryId) as { id: string } | undefined;
        if (latest?.id !== input.expectedLatestSuccessfulInspectionId) {
          return { kind: 'latest-successful-conflict' } as const;
        }
        if (
          input.inspection.workspaceId !== input.workspaceId ||
          input.inspection.repositoryId !== input.repositoryId ||
          input.inspection.actorUserId !== input.actorUserId
        ) {
          throw new Error('Reaffirmation input identities are incoherent');
        }
        const duplicate = this.database
          .prepare(`SELECT 1 FROM repository_inspections WHERE id = ?`)
          .get(input.inspection.id);
        if (duplicate !== undefined) {
          return { kind: 'duplicate-id' } as const;
        }
        const inspection = insertInspection(
          this.database,
          input.inspection,
        ) as SuccessfulRepositoryInspection;
        const updated = this.database
          .prepare(
            `UPDATE registered_repositories
           SET accepted_environment_inspection_id = ?, status = 'active',
               status_reason = 'environment-evidence-reaffirmed',
               status_changed_by_user_id = ?, status_changed_at = ?, version = version + 1
           WHERE workspace_id = ? AND id = ? AND status = 'identity-evidence-changed'
             AND version = ?`,
          )
          .run(
            inspection.id,
            input.actorUserId,
            input.changedAt,
            input.workspaceId,
            input.repositoryId,
            input.expectedVersion,
          );
        if (updated.changes !== 1) {
          return { kind: 'version-conflict' } as const;
        }
        const repository = this.find(input.workspaceId, input.repositoryId);
        if (repository === undefined) {
          throw new Error('Repository disappeared after reaffirmation');
        }
        return { kind: 'changed', repository, inspection } as const;
      })
      .immediate();
  }

  retireWithBindings(input: RetireRepositoryWithBindingsInput): RepositoryRetirementResult {
    return this.database
      .transaction(() => {
        const current = this.find(input.workspaceId, input.repositoryId);
        if (current === undefined) {
          return { kind: 'not-found' } as const;
        }
        if (current.status === 'retired') {
          return { kind: 'unchanged', repository: current, retiredBindingIds: [] } as const;
        }
        if (current.version !== input.expectedVersion) {
          return { kind: 'version-conflict' } as const;
        }
        const rows = this.database
          .prepare(
            `SELECT * FROM project_repository_bindings
           WHERE workspace_id = ? AND repository_id = ? AND status = 'active'
           ORDER BY bound_at, id`,
          )
          .all(input.workspaceId, input.repositoryId) as ProjectRepositoryBindingRow[];
        for (const row of rows) {
          this.database
            .prepare(
              `UPDATE project_repository_bindings
             SET status = 'retired', retired_by_user_id = ?, retired_at = ?,
                 version = version + 1
             WHERE workspace_id = ? AND id = ? AND status = 'active' AND version = ?`,
            )
            .run(input.actorUserId, input.changedAt, input.workspaceId, row.id, row.version);
        }
        const result = this.database
          .prepare(
            `UPDATE registered_repositories
           SET status = 'retired', status_reason = 'operator-retired',
               status_changed_by_user_id = ?, status_changed_at = ?, version = version + 1
           WHERE workspace_id = ? AND id = ? AND status <> 'retired' AND version = ?`,
          )
          .run(
            input.actorUserId,
            input.changedAt,
            input.workspaceId,
            input.repositoryId,
            input.expectedVersion,
          );
        if (result.changes !== 1) {
          return { kind: 'version-conflict' } as const;
        }
        const repository = this.find(input.workspaceId, input.repositoryId);
        if (repository === undefined) {
          throw new Error('Repository disappeared after retirement');
        }
        return {
          kind: 'changed',
          repository,
          retiredBindingIds: rows.map((row) => row.id as ProjectRepositoryBindingId),
        } as const;
      })
      .immediate();
  }
}

class SqliteRepositoryInspectionRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly repositories: SqliteRegisteredRepositoryRepository,
  ) {}

  appendVerification(input: AppendRepositoryVerificationInput): InspectionAppendResult {
    return this.database.transaction(() => this.appendVerificationInTransaction(input)).immediate();
  }

  private appendVerificationInTransaction(
    input: AppendRepositoryVerificationInput,
  ): InspectionAppendResult {
    const duplicate = this.database
      .prepare(`SELECT 1 FROM repository_inspections WHERE id = ?`)
      .get(input.inspection.id);
    if (duplicate !== undefined) {
      return { kind: 'duplicate-id' };
    }
    const repository = this.repositories.find(input.workspaceId, input.repositoryId);
    if (repository === undefined) {
      return { kind: 'repository-not-inspectable', status: 'retired' };
    }
    if (repository.version !== input.expectedVersion) {
      return { kind: 'version-conflict' };
    }
    if (!['active', 'unavailable', 'identity-evidence-changed'].includes(repository.status)) {
      return { kind: 'repository-not-inspectable', status: repository.status };
    }
    if (
      input.inspection.workspaceId !== input.workspaceId ||
      input.inspection.repositoryId !== input.repositoryId
    ) {
      throw new Error('Verification input identities are incoherent');
    }
    try {
      return {
        kind: 'appended',
        inspection: insertInspection(this.database, input.inspection),
      };
    } catch (error) {
      if (isUniqueConstraint(error)) {
        return { kind: 'duplicate-id' };
      }
      throw error;
    }
  }

  find(workspaceId: WorkspaceId, inspectionId: RepositoryInspectionId) {
    const row = this.database
      .prepare(`SELECT * FROM repository_inspections WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, inspectionId) as RepositoryInspectionRow | undefined;
    return row === undefined ? undefined : mapRepositoryInspection(row);
  }

  listForRepository(workspaceId: WorkspaceId, repositoryId: RepositoryId, limit: number) {
    return (
      this.database
        .prepare(
          `SELECT * FROM repository_inspections
           WHERE workspace_id = ? AND repository_id = ?
           ORDER BY sequence DESC LIMIT ?`,
        )
        .all(workspaceId, repositoryId, limit) as RepositoryInspectionRow[]
    ).map(mapRepositoryInspection);
  }

  latestForRepository(workspaceId: WorkspaceId, repositoryId: RepositoryId) {
    const row = this.database
      .prepare(
        `SELECT * FROM repository_inspections
         WHERE workspace_id = ? AND repository_id = ?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(workspaceId, repositoryId) as RepositoryInspectionRow | undefined;
    if (row === undefined) {
      throw new Error('Existing repository has no inspection');
    }
    return mapRepositoryInspection(row);
  }

  latestSuccessfulForRepository(workspaceId: WorkspaceId, repositoryId: RepositoryId) {
    const row = this.database
      .prepare(
        `SELECT * FROM repository_inspections
         WHERE workspace_id = ? AND repository_id = ? AND outcome = 'succeeded'
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(workspaceId, repositoryId) as RepositoryInspectionRow | undefined;
    if (row === undefined) {
      throw new Error('Existing repository has no successful inspection');
    }
    return mapRepositoryInspection(row) as SuccessfulRepositoryInspection;
  }
}

class SqliteProjectRepositoryBindingRepository implements ProjectRepositoryBindingRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly repositories: SqliteRegisteredRepositoryRepository,
  ) {}

  insert(input: InsertProjectRepositoryBindingInput): ProjectRepositoryBindingInsertResult {
    return this.database.transaction(() => this.insertInTransaction(input)).immediate();
  }

  private insertInTransaction(
    input: InsertProjectRepositoryBindingInput,
  ): ProjectRepositoryBindingInsertResult {
    const repository = this.repositories.find(input.workspaceId, input.repositoryId);
    if (repository === undefined) {
      return { kind: 'repository-not-found' };
    }
    if (repository.version !== input.expectedRepositoryVersion) {
      return { kind: 'repository-version-conflict' };
    }
    if (repository.status !== 'active') {
      return { kind: 'repository-not-active', status: repository.status };
    }
    const existing = this.findActiveForProject(input.workspaceId, input.projectId);
    if (existing !== undefined) {
      return existing.repositoryId === input.repositoryId
        ? { kind: 'existing', binding: existing }
        : { kind: 'project-already-bound' };
    }
    try {
      this.database
        .prepare(
          `INSERT INTO project_repository_bindings (
             id, workspace_id, project_id, repository_id, status, bound_by_user_id,
             bound_at, retired_by_user_id, retired_at, version)
           SELECT ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, 1
           WHERE EXISTS (
             SELECT 1 FROM registered_repositories r
             WHERE r.workspace_id = ? AND r.id = ? AND r.status = 'active' AND r.version = ?
           )`,
        )
        .run(
          input.id,
          input.workspaceId,
          input.projectId,
          input.repositoryId,
          input.actorUserId,
          input.boundAt,
          input.workspaceId,
          input.repositoryId,
          input.expectedRepositoryVersion,
        );
    } catch (error) {
      if (!isUniqueConstraint(error)) {
        throw error;
      }
    }
    const created = this.find(input.workspaceId, input.id);
    if (created !== undefined) {
      return { kind: 'created', binding: created };
    }
    const raced = this.findActiveForProject(input.workspaceId, input.projectId);
    if (raced !== undefined) {
      return raced.repositoryId === input.repositoryId
        ? { kind: 'existing', binding: raced }
        : { kind: 'project-already-bound' };
    }
    const after = this.repositories.find(input.workspaceId, input.repositoryId);
    if (after === undefined) {
      return { kind: 'repository-not-found' };
    }
    return after.status !== 'active'
      ? { kind: 'repository-not-active', status: after.status }
      : { kind: 'repository-version-conflict' };
  }

  find(workspaceId: WorkspaceId, bindingId: ProjectRepositoryBindingId) {
    const row = this.database
      .prepare(`SELECT * FROM project_repository_bindings WHERE workspace_id = ? AND id = ?`)
      .get(workspaceId, bindingId) as ProjectRepositoryBindingRow | undefined;
    return row === undefined ? undefined : mapProjectRepositoryBinding(row);
  }

  findActiveForProject(workspaceId: WorkspaceId, projectId: ProjectId) {
    const row = this.database
      .prepare(
        `SELECT * FROM project_repository_bindings
         WHERE workspace_id = ? AND project_id = ? AND status = 'active'`,
      )
      .get(workspaceId, projectId) as ProjectRepositoryBindingRow | undefined;
    return row === undefined ? undefined : mapProjectRepositoryBinding(row);
  }

  listForProject(workspaceId: WorkspaceId, projectId: ProjectId) {
    return (
      this.database
        .prepare(
          `SELECT * FROM project_repository_bindings
           WHERE workspace_id = ? AND project_id = ? ORDER BY bound_at, id`,
        )
        .all(workspaceId, projectId) as ProjectRepositoryBindingRow[]
    ).map(mapProjectRepositoryBinding);
  }

  listForRepository(workspaceId: WorkspaceId, repositoryId: RepositoryId) {
    return (
      this.database
        .prepare(
          `SELECT * FROM project_repository_bindings
           WHERE workspace_id = ? AND repository_id = ? ORDER BY bound_at, id`,
        )
        .all(workspaceId, repositoryId) as ProjectRepositoryBindingRow[]
    ).map(mapProjectRepositoryBinding);
  }

  retire(input: RetireProjectRepositoryBindingInput): BindingMutationResult {
    const binding = this.find(input.workspaceId, input.bindingId);
    if (binding === undefined) {
      return { kind: 'not-found' };
    }
    if (binding.status === 'retired') {
      return { kind: 'unchanged', binding };
    }
    if (binding.version !== input.expectedVersion) {
      return { kind: 'version-conflict' };
    }
    const result = this.database
      .prepare(
        `UPDATE project_repository_bindings
         SET status = 'retired', retired_by_user_id = ?, retired_at = ?,
             version = version + 1
         WHERE workspace_id = ? AND id = ? AND status = 'active' AND version = ?`,
      )
      .run(
        input.actorUserId,
        input.retiredAt,
        input.workspaceId,
        input.bindingId,
        input.expectedVersion,
      );
    if (result.changes !== 1) {
      return { kind: 'version-conflict' };
    }
    const retired = this.find(input.workspaceId, input.bindingId);
    if (retired === undefined) {
      throw new Error('Binding disappeared after retirement');
    }
    return { kind: 'changed', binding: retired };
  }
}

class SqliteRepositoryRegistryQueryRepository implements RepositoryRegistryQueryRepository {
  constructor(
    private readonly repositories: SqliteRegisteredRepositoryRepository,
    private readonly inspections: SqliteRepositoryInspectionRepository,
    private readonly bindings: SqliteProjectRepositoryBindingRepository,
  ) {}

  repositorySummary(
    workspaceId: WorkspaceId,
    repositoryId: RepositoryId,
  ): RepositorySummaryRow | undefined {
    const repository = this.repositories.find(workspaceId, repositoryId);
    if (repository === undefined) {
      return undefined;
    }
    return {
      repository,
      latestInspection: this.inspections.latestForRepository(workspaceId, repositoryId),
      latestSuccessfulInspection: this.inspections.latestSuccessfulForRepository(
        workspaceId,
        repositoryId,
      ),
    };
  }

  repositorySummaries(workspaceId: WorkspaceId, limit: number) {
    return this.repositories
      .list(workspaceId, limit)
      .map((repository) => this.repositorySummary(workspaceId, repository.id))
      .filter((summary): summary is RepositorySummaryRow => summary !== undefined);
  }

  projectBindingSummaries(
    workspaceId: WorkspaceId,
    projectId: ProjectId,
  ): readonly ProjectRepositoryBindingSummaryRow[] {
    return this.bindings.listForProject(workspaceId, projectId).map((binding) => {
      const repository = this.repositories.find(workspaceId, binding.repositoryId);
      if (repository === undefined) {
        throw new Error('Binding repository is missing');
      }
      return {
        binding,
        repositoryStatus: repository.status,
        repositoryStatusReason: repository.statusReason,
      };
    });
  }

  inspectionSummaries(
    workspaceId: WorkspaceId,
    repositoryId: RepositoryId,
    limit: number,
  ): readonly RepositoryInspectionSummaryRow[] {
    const repository = this.repositories.find(workspaceId, repositoryId);
    if (repository === undefined) {
      return [];
    }
    return this.inspections
      .listForRepository(workspaceId, repositoryId, limit)
      .map((inspection) => ({
        inspection,
        acceptedAsEnvironmentBaseline: inspection.id === repository.acceptedEnvironmentInspectionId,
      }));
  }
}

export function repositoryRegistryRepositories(
  database: Database.Database,
): RepositoryRegistryRepositories {
  const repositories = new SqliteRegisteredRepositoryRepository(database);
  const inspections = new SqliteRepositoryInspectionRepository(database, repositories);
  const bindings = new SqliteProjectRepositoryBindingRepository(database, repositories);
  return {
    repositories,
    inspections,
    bindings,
    queries: new SqliteRepositoryRegistryQueryRepository(repositories, inspections, bindings),
  };
}
