import type {
  PlanBranchSettings,
  PlanVersionId,
  SourceRepositoryId,
  UserId,
  WorkItemId,
  WorkspaceId,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';

export interface PlanBranchSettingsRepository {
  evidence(
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    repositoryId: SourceRepositoryId,
  ): string | undefined;
  recordEvidence(input: {
    workspaceId: WorkspaceId;
    workItemId: WorkItemId;
    repositoryId: SourceRepositoryId;
    commitSha: string;
    recordedAt: string;
    recordedByUserId: UserId;
  }): void;
  find(workspaceId: WorkspaceId, planVersionId: PlanVersionId): PlanBranchSettings | undefined;
  save(settings: PlanBranchSettings, expectedVersion: number): PlanBranchSettings | undefined;
}
export class SqlitePlanBranchSettingsRepository implements PlanBranchSettingsRepository {
  constructor(private readonly database: Database.Database) {}
  evidence(
    workspaceId: WorkspaceId,
    workItemId: WorkItemId,
    repositoryId: SourceRepositoryId,
  ): string | undefined {
    return (
      this.database
        .prepare(
          `SELECT commit_sha FROM work_item_integration_evidence WHERE workspace_id = ? AND work_item_id = ? AND repository_id = ?`,
        )
        .get(workspaceId, workItemId, repositoryId) as { commit_sha: string } | undefined
    )?.commit_sha;
  }
  recordEvidence(input: {
    workspaceId: WorkspaceId;
    workItemId: WorkItemId;
    repositoryId: SourceRepositoryId;
    commitSha: string;
    recordedAt: string;
    recordedByUserId: UserId;
  }): void {
    this.database
      .prepare(`INSERT INTO work_item_integration_evidence
      (workspace_id, work_item_id, repository_id, commit_sha, recorded_at, recorded_by_user_id)
      VALUES (@workspaceId, @workItemId, @repositoryId, @commitSha, @recordedAt, @recordedByUserId)
      ON CONFLICT(workspace_id, work_item_id, repository_id) DO UPDATE SET commit_sha = excluded.commit_sha,
      recorded_at = excluded.recorded_at, recorded_by_user_id = excluded.recorded_by_user_id`)
      .run(input);
  }
  find(workspaceId: WorkspaceId, planVersionId: PlanVersionId): PlanBranchSettings | undefined {
    return this.database
      .prepare(`SELECT workspace_id AS workspaceId, plan_version_id AS planVersionId,
      repository_id AS repositoryId, integration_branch AS integrationBranch, updated_at AS updatedAt,
      updated_by_user_id AS updatedByUserId, version FROM plan_branch_settings
      WHERE workspace_id = ? AND plan_version_id = ?`)
      .get(workspaceId, planVersionId) as PlanBranchSettings | undefined;
  }
  save(settings: PlanBranchSettings, expectedVersion: number): PlanBranchSettings | undefined {
    const current = this.find(settings.workspaceId, settings.planVersionId);
    if ((current?.version ?? 0) !== expectedVersion || settings.version !== expectedVersion + 1)
      return undefined;
    this.database
      .prepare(`INSERT INTO plan_branch_settings
      (workspace_id, plan_version_id, repository_id, integration_branch, updated_at, updated_by_user_id, version)
      VALUES (@workspaceId, @planVersionId, @repositoryId, @integrationBranch, @updatedAt, @updatedByUserId, @version)
      ON CONFLICT(workspace_id, plan_version_id) DO UPDATE SET repository_id = excluded.repository_id,
      integration_branch = excluded.integration_branch, updated_at = excluded.updated_at,
      updated_by_user_id = excluded.updated_by_user_id, version = excluded.version`)
      .run(settings);
    return this.find(settings.workspaceId, settings.planVersionId);
  }
}
