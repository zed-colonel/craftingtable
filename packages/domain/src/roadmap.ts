import type { CycleProfiles, CompletionPolicy } from './work-cycle.js';
import type {
  WorkspaceId,
  WorkItemId,
  ProjectId,
  PlanVersionId,
  SourceRepositoryId,
  UserId,
  WorktreeId,
} from './ids.js';

export const ROADMAP_STATUSES = [
  'draft',
  'running',
  'paused',
  'needs-attention',
  'stopped',
  'completed',
] as const;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];
export interface RoadmapAutomation {
  readonly integrationMerge: 'manual' | 'automatic';
  readonly integrationConflicts: 'manual' | 'automatic';
  readonly resolutionProfile?: Omit<import('./execution.js').AgentRunProfile, 'role'>;
}
export const DEFAULT_ROADMAP_AUTOMATION: RoadmapAutomation = {
  integrationMerge: 'manual',
  integrationConflicts: 'manual',
};
export interface RoadmapScheduling {
  readonly mode: 'sequential' | 'parallel';
  readonly maxInFlight: number;
  readonly maxPerRepository: number;
  readonly maxIntegrationRefreshes: number;
}
export const DEFAULT_ROADMAP_SCHEDULING: RoadmapScheduling = {
  mode: 'sequential',
  maxInFlight: 2,
  maxPerRepository: 2,
  maxIntegrationRefreshes: 3,
};
export interface RoadmapEntryHold {
  readonly status: 'paused' | 'needs-attention';
  readonly reason: string;
}
export interface RoadmapEntry {
  readonly reviewerRoles?: readonly string[];
  readonly executionScope?: import('./execution-scope.js').ExecutionScope;
  readonly id: string;
  readonly workItemId: WorkItemId;
  readonly projectId: ProjectId;
  readonly planVersionId: PlanVersionId;
  readonly sourceId: string;
  readonly title: string;
  readonly repositoryId: SourceRepositoryId;
  readonly integrationBranch: string;
  readonly profiles: CycleProfiles;
  readonly policy: CompletionPolicy;
  readonly instructions: string;
  readonly automation?: RoadmapAutomation;
  readonly exclusionGroups?: readonly string[];
}
/** Immutable adopted definition; draft changes also create new revisions. */
export interface RoadmapDefinition {
  readonly crossProject?: import('./cross-project.js').CrossProjectConfiguration;
  readonly roadmapId: string;
  readonly revision: number;
  readonly name: string;
  readonly entries: readonly RoadmapEntry[];
  readonly scheduling?: RoadmapScheduling;
  readonly automation?: RoadmapAutomation;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}
/** A whole-item or slice execution attempt has its own identity and frozen definition binding. */
export interface RoadmapAttempt {
  readonly id: string;
  readonly entryId: string;
  readonly definitionRevision: number;
  readonly worktreeId: WorktreeId;
  readonly cycleId: string;
  readonly status: 'preparing' | 'active' | 'completed';
  readonly createdAt: string;
  readonly completedAt?: string;
}
export interface Roadmap {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly version: number;
  readonly definition: RoadmapDefinition;
  readonly status: RoadmapStatus;
  readonly reason: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdByUserId: UserId;
  readonly delegatedByUserId?: UserId;
  readonly attempts: readonly RoadmapAttempt[];
  readonly entryHolds?: Readonly<Record<string, RoadmapEntryHold>>;
}
export interface RoadmapEntryProgress {
  readonly phase?: import('./phase-scheduling.js').ExecutionPhase;
  readonly blockers?: readonly import('./phase-scheduling.js').PhaseBlocker[];
  readonly effectiveAutomation?: RoadmapAutomation;
  readonly entryId: string;
  readonly status:
    | 'queued'
    | 'dependency-blocked'
    | 'capacity-blocked'
    | 'exclusion-blocked'
    | 'paused'
    | 'running'
    | 'awaiting-merge'
    | 'needs-attention'
    | 'completed';
  readonly reason: string;
}
export interface RoadmapView {
  readonly roadmap: Roadmap;
  readonly progress: readonly RoadmapEntryProgress[];
}
