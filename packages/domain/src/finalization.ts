import type { AgentRunProfile } from './execution.js';
import type { CompletionPolicy } from './work-cycle.js';
import type {
  PlanVersionId,
  ProjectId,
  SourceRepositoryId,
  UserId,
  WorkspaceId,
  WorktreeId,
} from './ids.js';
export interface FinalizationRound {
  readonly review: Omit<AgentRunProfile, 'role'>;
  readonly polish: Omit<AgentRunProfile, 'role'>;
  readonly instructions: string;
}
export interface Finalization {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly planVersionId: PlanVersionId;
  readonly projectId: ProjectId;
  readonly repositoryId: SourceRepositoryId;
  readonly integrationBranch: string;
  readonly integrationSha: string;
  readonly targetBranch: string;
  readonly targetSha: string;
  readonly worktreeId: WorktreeId;
  readonly cycleId: string;
  readonly rounds: readonly FinalizationRound[];
  readonly finalReview: Omit<AgentRunProfile, 'role'>;
  readonly policy: CompletionPolicy;
  readonly instructions: string;
  readonly status: 'preparing' | 'active' | 'stopped' | 'completed';
  readonly reason: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}
