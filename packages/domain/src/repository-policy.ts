import type { PlanVersionId, SourceRepositoryId, UserId, WorkspaceId } from './ids.js';

/** Operator interpretation of repository administration, never a claim of remote enforcement. */
export interface RepositoryPolicy {
  readonly workspaceId: WorkspaceId;
  readonly planVersionId: PlanVersionId;
  readonly repositoryId: SourceRepositoryId;
  readonly integrationBranch: string;
  readonly branchSettingsVersion: number;
  readonly version: number;
  readonly controlMode: 'controller-local';
  readonly experimentalFreeze?: { readonly branch: string; readonly commitSha: string };
  readonly publicationRequirement: string;
  readonly interpretation: string;
  readonly adoptedAt: string;
  readonly adoptedByUserId: UserId;
}
