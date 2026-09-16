import type { CrossProjectConfiguration } from './cross-project.js';
import type { Roadmap } from './roadmap.js';
import type { ExecutionScope } from './execution-scope.js';
import type { WorkspaceId, UserId, WorktreeId, WorkItemId } from './ids.js';
export type MapSelection = Pick<
  CrossProjectConfiguration,
  'definitionId' | 'bindingRevision' | 'targetId' | 'selection'
>;
export interface MapAmendment {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly roadmapId: string;
  readonly baseRevision: number;
  readonly candidate: MapSelection;
  readonly summary: string;
  readonly sourceRunId?: string;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
  readonly decision?: {
    readonly outcome: 'applied' | 'rejected';
    readonly rationale: string;
    readonly decidedAt: string;
    readonly decidedByUserId: UserId;
    readonly impactDigest: string;
    readonly previous: Roadmap;
    readonly resultingRevision?: number;
    readonly reusedIntegrationIds: readonly string[];
  };
}
/** Code provenance only. Never transfers review, parent acceptance or checkpoint approval. */
export interface ScopeIntegrationReuse {
  readonly id: string;
  readonly amendmentId: string;
  readonly workspaceId: WorkspaceId;
  readonly workItemId: WorkItemId;
  readonly scope: ExecutionScope;
  readonly sourceWorktreeId: WorktreeId;
  readonly mergeSha: string;
  readonly recordedAt: string;
}
