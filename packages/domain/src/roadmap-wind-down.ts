import type { AttentionItemCode } from './attention-item.js';
import type {
  AgentRunId,
  AttentionItemId,
  DecisionPreparationId,
  MapAmendmentId,
  PlanVersionId,
  ProjectId,
  RepositoryCleanupId,
  RoadmapEntryId,
  RoadmapId,
  RoadmapWindDownId,
  SourceRepositoryId,
  UserId,
  WorkCycleId,
  WorkspaceId,
  WorktreeId,
} from './ids.js';
import type { RoadmapStatus } from './roadmap.js';
import type { CycleStatus } from './work-cycle.js';

/**
 * Winding down a roadmap (R-B11, ADR-073): settling it (a Stop is a wind-down that retires
 * nothing), retiring its plan versions, and cleaning up its repositories.
 */

/** Why a plan version is retired: replaced by other work, or to be resumed later as a fresh one. */
export const RETIREMENT_DISPOSITIONS = ['superseded', 'parked'] as const;
export type RetirementDisposition = (typeof RETIREMENT_DISPOSITIONS)[number];

export interface RetirementChoice {
  readonly planVersionId: PlanVersionId;
  readonly disposition: RetirementDisposition;
}

/** A retired plan version: written once by the wind-down that retired it, never changed. */
export interface PlanVersionRetirement extends RetirementChoice {
  readonly workspaceId: WorkspaceId;
  readonly windDownId: RoadmapWindDownId;
  readonly retiredAt: string;
  readonly retiredByUserId: UserId;
}

/** The settle steps, in order. A step that cannot finish is recorded by its name. */
export const WIND_DOWN_STEPS = ['cycles', 'preparations', 'amendment', 'settle'] as const;
export type WindDownStep = (typeof WIND_DOWN_STEPS)[number];

/**
 * A roadmap's settlement record, one per roadmap. `settling` is the hold the scheduler and the
 * cycle worker honour until every step has finished; `settled` means the roadmap is wound down.
 * A settled record is entered again only to add retirements.
 */
export interface RoadmapWindDown {
  readonly id: RoadmapWindDownId;
  readonly workspaceId: WorkspaceId;
  readonly roadmapId: RoadmapId;
  readonly version: number;
  readonly status: 'settling' | 'settled';
  /** Every version this roadmap's commands retired, with its disposition. */
  readonly retire: readonly RetirementChoice[];
  /** The cycles whose own integration resolution the preview named for abandoning. */
  readonly abandonResolutions: readonly WorkCycleId[];
  /** The preview the latest command was given (ADR-073). */
  readonly previewDigest: string;
  readonly requestedAt: string;
  readonly requestedByUserId: UserId;
  readonly startedAt: string;
  readonly settledAt?: string;
  /** The step the latest attempt could not finish; raises `wind-down-incomplete`. */
  readonly incomplete?: {
    readonly step: WindDownStep;
    readonly at: string;
    readonly message: string;
  };
}

/** Why a wind-down or a cleanup is refused before anything is written. */
export const WIND_DOWN_REFUSALS = [
  'merge-in-flight',
  'finalization-active',
  'version-in-use',
  'preview-stale',
  'version-conflict',
  'wind-down-in-progress',
  'roadmap-not-wound-down',
] as const;
export type WindDownRefusal = (typeof WIND_DOWN_REFUSALS)[number];

export interface WindDownRefusalDetail {
  readonly code: WindDownRefusal;
  readonly message: string;
}

/**
 * Why activating a plan, saving or starting a roadmap, or importing a bundle is refused around
 * retired versions (R-B11, ADR-073). A retired version is ignored by the activation gate, so its
 * started items and worktrees no longer hold the project.
 */
export const RETIREMENT_REFUSALS = [
  'plan-version-retired',
  'project-has-admitted-work',
  'project-has-unmerged-worktrees',
  'project-has-delegated-roadmap',
  'project-has-open-finalization',
] as const;
export type RetirementRefusal = (typeof RETIREMENT_REFUSALS)[number];

/** What settling would do to one of the roadmap's cycles. */
export interface WindDownCycle {
  readonly cycleId: WorkCycleId;
  readonly entryId?: RoadmapEntryId;
  readonly label: string;
  readonly status: CycleStatus;
  readonly liveRunId?: AgentRunId;
  readonly investigation: boolean;
  /** The cycle owns an integration resolution, which settling abandons. */
  readonly abandonsResolution: boolean;
  readonly reservedMerge: boolean;
}

/** One of the roadmap's plan versions, as a candidate for retirement. */
export interface WindDownVersion {
  readonly planVersionId: PlanVersionId;
  readonly projectId: ProjectId;
  readonly projectName: string;
  readonly versionNumber: number;
  readonly active: boolean;
  readonly admittedItems: number;
  readonly activeWorktrees: number;
  readonly retired?: RetirementDisposition;
  /** Why it cannot be retired now; it can still be kept. */
  readonly refusal?: WindDownRefusalDetail;
}

/**
 * What a wind-down would do now, read from stored state (ADR-073). `digest` covers everything
 * the command would act on; the POST recomputes it and refuses `preview-stale` on a difference.
 */
export interface WindDownPreview {
  readonly roadmapId: RoadmapId;
  readonly status: RoadmapStatus;
  readonly digest: string;
  readonly cycles: readonly WindDownCycle[];
  readonly preparations: readonly {
    readonly preparationId: DecisionPreparationId;
    readonly checkpointId: string;
    readonly runId: AgentRunId;
    readonly live: boolean;
  }[];
  readonly amendmentId?: MapAmendmentId;
  /** The open attention items settling resolves. */
  readonly attention: readonly {
    readonly itemId: AttentionItemId;
    readonly code: AttentionItemCode;
    readonly title: string;
  }[];
  readonly versions: readonly WindDownVersion[];
  /** Why the whole command is refused now, if it is. */
  readonly refusals: readonly WindDownRefusalDetail[];
}

export interface RoadmapWindDownView {
  readonly record?: RoadmapWindDown;
  readonly preview: WindDownPreview;
}

/** Why a cleanup action keeps something, or what refused it. */
export const CLEANUP_CODES = [
  'dirty',
  'in-use',
  'checked-out',
  'protected',
  'tag-exists',
  'ref-moved',
  'git-failed',
] as const;
type CleanupCode = (typeof CLEANUP_CODES)[number];

/** `planned` until the action is authorized; then `done`, or `kept` or `refused` with a code. */
type CleanupActionState = 'planned' | 'authorized' | 'done' | 'kept' | 'refused';

/** What keeps a deleted branch's commits: its integration branch at a pinned commit, or a tag. */
type CleanupKeeper =
  | { readonly kind: 'integration'; readonly branch: string; readonly pinnedSha: string }
  | { readonly kind: 'parked-tag'; readonly tag: string };

export type CleanupAction =
  | {
      readonly kind: 'remove-worktree';
      readonly worktreeId: WorktreeId;
      readonly repositoryId: SourceRepositoryId;
      readonly branchName: string;
      readonly state: CleanupActionState;
      readonly code?: CleanupCode;
      readonly note?: string;
    }
  | {
      readonly kind: 'delete-branch';
      readonly repositoryId: SourceRepositoryId;
      readonly branchName: string;
      readonly tipSha: string;
      readonly keeper: CleanupKeeper;
      readonly state: CleanupActionState;
      readonly code?: CleanupCode;
      readonly note?: string;
    };

/**
 * A cleanup's persisted plan and each action's state. Repeating the command resumes this plan,
 * never a recomputed one; `done` is final.
 */
export interface RepositoryCleanup {
  readonly id: RepositoryCleanupId;
  readonly workspaceId: WorkspaceId;
  readonly roadmapId: RoadmapId;
  readonly version: number;
  readonly status: 'running' | 'done';
  readonly planDigest: string;
  readonly discardDirty: boolean;
  readonly actions: readonly CleanupAction[];
  readonly requestedAt: string;
  readonly requestedByUserId: UserId;
  readonly finishedAt?: string;
  /** The latest attempt stopped here; raises `wind-down-incomplete`. */
  readonly incomplete?: { readonly at: string; readonly message: string };
}

/**
 * What a cleanup would do now (ADR-073), with its digest. A dirty worktree is `kept` with code
 * `dirty`; the command's discard choice removes it, and frees its branch, instead.
 */
export interface CleanupPreview {
  readonly roadmapId: RoadmapId;
  readonly digest: string;
  readonly actions: readonly CleanupAction[];
  readonly refusals: readonly WindDownRefusalDetail[];
}

export interface RepositoryCleanupView {
  /** A cleanup still running: repeating the command resumes it. */
  readonly running?: RepositoryCleanup;
  readonly latest?: RepositoryCleanup;
  /** Absent while a cleanup is running. */
  readonly preview?: CleanupPreview;
}
