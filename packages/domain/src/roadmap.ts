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
export interface RoadmapEntry {
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
}
/** Immutable adopted definition; draft changes also create new revisions. */
export interface RoadmapDefinition {
  readonly roadmapId: string;
  readonly revision: number;
  readonly name: string;
  readonly entries: readonly RoadmapEntry[];
  readonly createdAt: string;
  readonly createdByUserId: UserId;
}
/** A whole-item execution attempt has its own identity and frozen definition binding. */
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
}
export interface RoadmapEntryProgress {
  readonly entryId: string;
  readonly status:
    | 'queued'
    | 'dependency-blocked'
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
