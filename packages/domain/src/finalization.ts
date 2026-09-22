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
/** Recorded promotion of one immutable plan version, independent of branch retention. */
export interface PlanCompletion {
  readonly finalizationId: string;
  readonly targetBranch: string;
  readonly mergeSha: string;
  readonly completedAt: string;
}
export interface Finalization {
  readonly mapContext?: {
    readonly definitionId: string;
    readonly bindingRevision: number;
    readonly runtimeId: string;
    readonly alias: string;
  };
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
  readonly stages?: readonly import('./finalization-stages.js').FinalizationStage[];
  readonly finalReview: Omit<AgentRunProfile, 'role'>;
  readonly policy: CompletionPolicy;
  readonly instructions: string;
  readonly status: 'preparing' | 'active' | 'stopped' | 'completed';
  readonly integrationCleanup?: {
    readonly status: 'pending' | 'blocked' | 'removed';
    readonly requestedAt: string;
    readonly requestedByUserId: UserId;
    readonly completedAt?: string;
    readonly error?: string;
  };
  readonly reason: string;
  readonly version: number;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}

/** Recovery changes the agent/model while retaining each configured step's permissions. */
export type FinalizationAgentSelection = Pick<
  AgentRunProfile,
  'backend' | 'model' | 'reasoningEffort'
>;
export function finalizationProfile(
  value: Pick<Finalization, 'rounds' | 'finalReview' | 'stages'>,
  cycle: Pick<
    WorkCycle,
    | 'step'
    | 'profiles'
    | 'polishPhase'
    | 'polishRound'
    | 'finalizationAgentOverride'
    | 'finalizationProgress'
  >,
): Omit<AgentRunProfile, 'role'> {
  const round = value.rounds[cycle.polishRound ?? 0];
  const stage = value.stages?.[cycle.finalizationProgress?.stageIndex ?? 0];
  const configured = stage
    ? cycle.step === 'review'
      ? stage.review
      : stage.implement
    : cycle.step === 'review'
      ? cycle.polishPhase === 'final-review'
        ? value.finalReview
        : (round?.review ?? value.finalReview)
      : (round?.polish ?? cycle.profiles.remediate);
  return cycle.finalizationAgentOverride
    ? { permissionMode: configured.permissionMode, ...cycle.finalizationAgentOverride }
    : configured;
}
