import type { AgentRunProfile } from './execution.js';
import type {
  PlanVersionId,
  ProjectId,
  SourceRepositoryId,
  UserId,
  WorkspaceId,
  WorktreeId,
} from './ids.js';
import type { CompletionPolicy, WorkCycle } from './work-cycle.js';
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

/** Recovery changes the agent/model while retaining each configured step's permissions. */
export type FinalizationAgentSelection = Pick<AgentRunProfile, 'backend' | 'model'>;
export function finalizationProfile(
  value: Pick<Finalization, 'rounds' | 'finalReview'>,
  cycle: Pick<
    WorkCycle,
    'step' | 'profiles' | 'polishPhase' | 'polishRound' | 'finalizationAgentOverride'
  >,
): Omit<AgentRunProfile, 'role'> {
  const round = value.rounds[cycle.polishRound ?? 0];
  const configured =
    cycle.step === 'review'
      ? cycle.polishPhase === 'final-review'
        ? value.finalReview
        : (round?.review ?? value.finalReview)
      : (round?.polish ?? cycle.profiles.remediate);
  return cycle.finalizationAgentOverride
    ? { permissionMode: configured.permissionMode, ...cycle.finalizationAgentOverride }
    : configured;
}
