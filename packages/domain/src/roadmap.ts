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
  /** The typed stop for a `needs-attention` hold (R-A3); see `effectiveHoldAttention`. */
  readonly attention?: import('./attention.js').RoadmapAttention;
}
/**
 * A typed reason the scheduler recorded for an entry it evaluated and left as it was (R-C12).
 * Rewritten only when it changes; `since` is when this code first applied.
 */
export interface RoadmapEntryWait {
  readonly code: import('./attention.js').EntryWaitCode;
  readonly reason: string;
  readonly since: string;
  readonly refs?: {
    readonly cycleId?: string;
    readonly entryId?: string;
    readonly blockers?: readonly import('./attention.js').PhaseBlockerCode[];
  };
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
  /** One fresh review explicitly queued by a reviewed dependency refresh; no source repair. */
  readonly dependencyRefresh?: {
    readonly runtimeId: string;
    readonly generation: number;
    readonly sourceRunId: import('./ids.js').AgentRunId;
  };
  /**
   * One fresh review in the same cycle, requested by the operator because this entry's evidence
   * is no longer current. Existing code and reviewer assignment are retained.
   */
  readonly reverification?: {
    readonly requestedAt: string;
    readonly requestedByUserId: UserId;
    readonly sourceRunId: import('./ids.js').AgentRunId;
  };
  /** Additional owning-slice attempt; the original entry and reviewer assignments stay intact. */
  readonly recovery?: {
    readonly sourceEntryId: string;
    readonly sourceRunId: import('./ids.js').AgentRunId;
    readonly sourceSequence: number;
    readonly findingFingerprint: string;
    readonly phase: 'repair' | 'verification' | 'parent-review' | 'completed';
    readonly reviewRunIds: Readonly<Record<string, string>>;
    readonly reviewRestarts?: Readonly<Record<string, number>>;
    /**
     * Set when the operator delegated this repair from the work item. The roadmap carries the
     * round through even with automatic recovery off, and it does not use the automatic
     * allowance.
     */
    readonly requestedByUserId?: UserId;
  };
  readonly id: string;
  readonly entryId: string;
  readonly definitionRevision: number;
  readonly worktreeId: WorktreeId;
  readonly cycleId: string;
  readonly status: 'preparing' | 'active' | 'completed';
  readonly createdAt: string;
  readonly completedAt?: string;
}
/** An attempt the operator replaced with a fresh one; kept for its history, never scheduled. */
export interface RetiredRoadmapAttempt extends RoadmapAttempt {
  readonly retiredAt: string;
  readonly retiredByUserId: UserId;
  readonly reason: string;
}
export interface DecisionPreparation {
  readonly id: string;
  readonly definitionId: string;
  readonly bindingRevision: number;
  readonly bindingDigest: string;
  readonly checkpointId: string;
  readonly workspaceId: WorkspaceId;
  readonly repositoryId: SourceRepositoryId;
  readonly projectId: ProjectId;
  readonly planVersionId: PlanVersionId;
  readonly integrationBranch: string;
  readonly integrationSha: string;
  readonly worktreeId: WorktreeId;
  readonly runId: import('./ids.js').AgentRunId;
  readonly profile: import('./agent-profiles.js').AgentSelection;
  readonly deadlineAt: string;
  readonly instructions: string;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
  readonly failure?: string;
}
export interface Roadmap {
  readonly decisionPreparations?: readonly DecisionPreparation[];
  /** Explicit operational authority for future actions; adopted definitions remain immutable. */
  readonly delegationAssignments?: readonly {
    readonly id: string;
    readonly entryIds: readonly string[];
    readonly automation: RoadmapAutomation;
    readonly reviewerRoles: readonly string[];
    readonly rationale: string;
    readonly appliedAt: string;
    readonly appliedByUserId: UserId;
  }[];
  /** Append-only model choices, independent of plan authority and definition revisions. */
  readonly agentAssignments?: readonly {
    readonly id: string;
    readonly entryIds: readonly string[];
    readonly selections: import('./agent-profiles.js').AgentSelections;
    readonly appliedAt: string;
    readonly appliedByUserId: UserId;
  }[];
  /** Separate, explicit execution delegation. Changing it never changes the accepted plan. */
  readonly scopeRecovery?: {
    readonly enabled: boolean;
    readonly maxRoundsPerParent: number;
    readonly grantedByUserId: UserId;
    readonly grantedAt: string;
  };
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly version: number;
  readonly definition: RoadmapDefinition;
  readonly status: RoadmapStatus;
  readonly reason: string;
  /** The typed stop while `needs-attention` (R-A3); see `effectiveRoadmapAttention`. */
  readonly attention?: import('./attention.js').RoadmapAttention;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly createdByUserId: UserId;
  readonly delegatedByUserId?: UserId;
  readonly attempts: readonly RoadmapAttempt[];
  readonly retiredAttempts?: readonly RetiredRoadmapAttempt[];
  readonly entryHolds?: Readonly<Record<string, RoadmapEntryHold>>;
  /** Why the last pass left each evaluated entry waiting (R-C12); absent means none recorded. */
  readonly entryWaits?: Readonly<Record<string, RoadmapEntryWait>>;
}
export interface RoadmapEntryProgress {
  readonly phase?: import('./phase-scheduling.js').ExecutionPhase;
  readonly blockers?: readonly import('./phase-scheduling.js').PhaseBlocker[];
  readonly effectiveAutomation?: RoadmapAutomation;
  /** The entry's evidence is not current and its review has ended: Re-verify is offered. */
  readonly reverifiable?: true;
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
/** Who moves a roadmap entry on next (R-E3a). */
export type RoadmapActor = 'operator' | 'controller' | 'agent' | 'none';
/**
 * One open entry of a roadmap's status list (R-E3a): its state, what it waits on and who
 * acts next. Each part is read from what the daemon recorded (an attention item, an entry
 * hold, a scheduler wait, the entry's progress), never derived again.
 */
export interface RoadmapStatusEntry {
  readonly entryId: string;
  readonly sourceId: string;
  readonly scope: 'item' | import('./execution-scope.js').ExecutionScope['kind'];
  readonly title: string;
  readonly workItemId: WorkItemId;
  readonly state: RoadmapEntryProgress['status'];
  readonly actor: RoadmapActor;
  readonly waitsOn?: {
    /** The record this reason is read from. */
    readonly source: 'attention-item' | 'entry-hold' | 'entry-wait' | 'progress';
    readonly code?: string;
    readonly reason: string;
    readonly since?: string;
    readonly attentionItemId?: string;
    readonly cycleId?: string;
    readonly runId?: string;
    readonly entryId?: string;
  };
}
export interface RoadmapStatusList {
  readonly roadmapId: string;
  readonly name: string;
  readonly status: RoadmapStatus;
  readonly reason: string;
  readonly attentionCode?: import('./attention.js').RoadmapAttentionCode;
  readonly completed: number;
  /** Every entry that is not completed, in roadmap order. */
  readonly entries: readonly RoadmapStatusEntry[];
}
export interface RoadmapView {
  readonly roadmap: Roadmap;
  readonly progress: readonly RoadmapEntryProgress[];
  readonly hostCapacity?: {
    readonly development: { readonly limit: number; readonly inUse: number };
    readonly verification: { readonly limit: number; readonly inUse: number };
  };
}

/**
 * Every attempt a roadmap has made, including ones the operator retired for re-verification
 * (R-C10). Whether an entry has started, which freezes its settings and reviewer assignment,
 * counts both.
 */
export function startedAttempts(
  roadmap: Pick<Roadmap, 'attempts' | 'retiredAttempts'>,
): readonly RoadmapAttempt[] {
  return [...roadmap.attempts, ...(roadmap.retiredAttempts ?? [])];
}
