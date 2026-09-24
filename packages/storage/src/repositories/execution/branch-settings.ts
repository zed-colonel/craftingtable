import type {
  PlanBranchSettings,
  PlanVersionId,
  RepositoryPolicy,
  SourceRepositoryId,
  UserId,
  WorkItemId,
  WorkspaceId,
} from '@craftingtable/domain';
import type Database from 'better-sqlite3';
import { parseRecord, type RecordGuard, readRecord } from '../../records.js';

export const PLAN_BRANCH_SETTINGS_SELECT = `workspace_id AS workspaceId,
  plan_version_id AS planVersionId, repository_id AS repositoryId,
  integration_branch AS integrationBranch, updated_at AS updatedAt,
  updated_by_user_id AS updatedByUserId, manual_merge_branches_json AS manualMergeBranchesJson,
  version`;
export type PlanBranchSettingsRow = Omit<PlanBranchSettings, 'manualMergeBranches'> & {
  readonly manualMergeBranchesJson: string;
};
export function mapPlanBranchSettings(row: PlanBranchSettingsRow): PlanBranchSettings {
  const { manualMergeBranchesJson, ...settings } = row;
  const branches = JSON.parse(manualMergeBranchesJson) as string[];
  return readRecord('plan-branch-settings', {
    ...settings,
    ...(branches.length ? { manualMergeBranches: branches } : {}),
  });
}
export interface PlanBranchSettingsRepository {
  policy(workspaceId: WorkspaceId, planVersionId: PlanVersionId): RepositoryPolicy | undefined;
  savePolicy(policy: RepositoryPolicy, expectedVersion: number): boolean;
  list(): readonly PlanBranchSettings[];
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
  constructor(
    private readonly database: Database.Database,
    private readonly guard: RecordGuard,
  ) {}
  policy(workspaceId: WorkspaceId, planVersionId: PlanVersionId): RepositoryPolicy | undefined {
    const row = this.database
      .prepare(
        'SELECT state_json FROM plan_repository_policies WHERE workspace_id = ? AND plan_version_id = ? ORDER BY version DESC LIMIT 1',
      )
      .get(workspaceId, planVersionId) as { state_json: string } | undefined;
    return row ? parseRecord('repository-policy', row.state_json) : undefined;
  }
  savePolicy(policy: RepositoryPolicy, expectedVersion: number): boolean {
    if (
      (this.policy(policy.workspaceId, policy.planVersionId)?.version ?? 0) !== expectedVersion ||
      policy.version !== expectedVersion + 1
    )
      return false;
    this.guard('repository-policy', policy);
    this.database
      .prepare(
        'INSERT INTO plan_repository_policies (workspace_id, plan_version_id, version, state_json) VALUES (?, ?, ?, ?)',
      )
      .run(policy.workspaceId, policy.planVersionId, policy.version, JSON.stringify(policy));
    return true;
  }
  list(): readonly PlanBranchSettings[] {
    return (
      this.database
        .prepare('SELECT workspace_id, plan_version_id FROM plan_branch_settings')
        .all() as { workspace_id: WorkspaceId; plan_version_id: PlanVersionId }[]
    ).map((row) => this.find(row.workspace_id, row.plan_version_id) as PlanBranchSettings);
  }
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
    const row = this.database
      .prepare(`SELECT ${PLAN_BRANCH_SETTINGS_SELECT} FROM plan_branch_settings
      WHERE workspace_id = ? AND plan_version_id = ?`)
      .get(workspaceId, planVersionId) as PlanBranchSettingsRow | undefined;
    return row && mapPlanBranchSettings(row);
  }
  save(settings: PlanBranchSettings, expectedVersion: number): PlanBranchSettings | undefined {
    const current = this.find(settings.workspaceId, settings.planVersionId);
    if ((current?.version ?? 0) !== expectedVersion || settings.version !== expectedVersion + 1)
      return undefined;
    this.guard('plan-branch-settings', settings);
    this.database
      .prepare(`INSERT INTO plan_branch_settings
      (workspace_id, plan_version_id, repository_id, integration_branch, updated_at, updated_by_user_id, version, manual_merge_branches_json)
      VALUES (@workspaceId, @planVersionId, @repositoryId, @integrationBranch, @updatedAt, @updatedByUserId, @version, @manualMergeBranchesJson)
      ON CONFLICT(workspace_id, plan_version_id) DO UPDATE SET repository_id = excluded.repository_id,
      integration_branch = excluded.integration_branch, updated_at = excluded.updated_at,
      updated_by_user_id = excluded.updated_by_user_id, version = excluded.version, manual_merge_branches_json = excluded.manual_merge_branches_json`)
      .run({
        ...settings,
        manualMergeBranchesJson: JSON.stringify(settings.manualMergeBranches ?? []),
      });
    return this.find(settings.workspaceId, settings.planVersionId);
  }
}
