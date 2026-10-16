import type { AgentProfile, AgentSelection, CycleProfiles } from './agent-profiles.js';
import {
  currentFinalizationStage,
  parkedFollowUp,
  stagedFollowUps,
} from './finalization-stages.js';
import type {
  AgentRunId,
  CycleInvestigationId,
  FinalizationId,
  ImportedArchiveId,
  ProjectId,
  RoadmapAttemptId,
  RoadmapEntryId,
  RoadmapId,
  UserId,
  WorkCycleId,
  WorkItemId,
  WorkspaceId,
  WorktreeId,
} from './ids.js';
import type { FindingSeverity, ReviewFinding, ReviewReportAssessment } from './review.js';

export const CYCLE_STEPS = ['design', 'implement', 'review', 'remediate'] as const;
export type CycleStep = (typeof CYCLE_STEPS)[number];
export const CYCLE_STATUSES = [
  'running',
  'paused',
  'needs-attention',
  'awaiting-merge',
  'stopped',
  'completed',
] as const;
export type CycleStatus = (typeof CYCLE_STATUSES)[number];
export interface CompletionPolicy {
  readonly maxNits: number;
  readonly maxRemediationRounds: number;
  readonly maxRunMinutes: number;
}
export const DEFAULT_COMPLETION_POLICY: CompletionPolicy = {
  maxNits: 3,
  maxRemediationRounds: 3,
  maxRunMinutes: 120,
};
export interface IntegrationResolution {
  readonly runIds?: readonly AgentRunId[];
  readonly id: string;
  readonly status:
    | 'detected'
    | 'preparing'
    | 'resolving'
    | 'committing'
    | 'completed'
    | 'abandoned';
  readonly headSha: string;
  readonly targetSha: string;
  readonly targetBranch: string;
  readonly paths: readonly string[];
  readonly diagnostics: string;
  readonly createdAt: string;
  readonly attempts: number;
  readonly profile?: AgentProfile;
  readonly instructions?: string;
  readonly treeSha?: string;
  readonly commitSha?: string;
}
export function ownsIntegrationResolution(cycle: WorkCycle | undefined): boolean {
  return (
    !!cycle?.integrationResolution &&
    ['preparing', 'resolving', 'committing'].includes(cycle.integrationResolution.status)
  );
}
export interface DesignRecoverySource {
  readonly planVersionId: import('./ids.js').PlanVersionId;
  readonly artifactId?: import('./ids.js').PlanArtifactId;
  readonly archiveId?: ImportedArchiveId;
  readonly archiveDigest?: string;
  readonly name: string;
  readonly digest: string;
}
interface DesignRecovery {
  readonly runId: AgentRunId;
  readonly sourceRunId: AgentRunId;
  readonly mode: 'investigate' | 'continue';
  /**
   * Started by the controller, not the operator: the investigation before it answered every
   * question with cited sources (R-C3a). At most one per operator-started investigation.
   */
  readonly automatic?: true;
  readonly profile: AgentSelection;
  readonly instructions: string;
  readonly snapshotDigest: string;
  readonly facts: string;
  readonly sources: readonly DesignRecoverySource[];
  readonly attachments: readonly { readonly name: string; readonly content: string }[];
}
/** One question's result in an investigation's `craftingtable-investigation` block (R-C16). */
interface InvestigationFinding {
  readonly question: string;
  /** `proposed`: an answer with cited sources; `open`: why the evidence does not settle it. */
  readonly status: 'proposed' | 'open';
  readonly answer: string;
  readonly sources: readonly string[];
  readonly reason?: string;
}
/**
 * The cycle's worktree as an investigation found it at its start (R-C16, TS-M3): the daemon
 * compares it once the run has ended and its agent has exited. Each digest covers one part.
 */
export interface InvestigationWorktree {
  readonly headSha: string;
  readonly branch: string;
  /** The tracked diff against HEAD. */
  readonly fingerprint: string;
  readonly trackedClean: boolean;
  /** Untracked files, by contents. */
  readonly untrackedDigest: string;
  /** Ignored files by contents, ignored directories by their own entries. */
  readonly ignoredDigest: string;
  /** The repository's config, hooks and info files. */
  readonly gitDigest: string;
  /** Files compared by size and modification time only, past the snapshot's bounds. */
  readonly metadataOnly?: number;
}
/** A part of the worktree an investigation found changed; `unreadable`: it could not be read. */
export const INVESTIGATION_WORKTREE_PARTS = [
  'head',
  'branch',
  'tracked',
  'untracked',
  'ignored',
  'git',
  'unreadable',
] as const;
export type InvestigationWorktreePart = (typeof INVESTIGATION_WORKTREE_PARTS)[number];
/** How the worktree differed from its record when the investigation ended. */
export interface InvestigationWorktreeChange {
  readonly parts: readonly InvestigationWorktreePart[];
  readonly headBefore: string;
  /** Absent when the worktree could not be read. */
  readonly headAfter?: string;
  /** What differs from HEAD at the end, tracked and untracked: the first 20. */
  readonly paths: readonly string[];
}
/**
 * A read-only investigation of a question stop (R-C16, ADR-059). Its run works beside the cycle
 * and is never its current run: the cycle keeps its stop, and the operator answers through the
 * stop's own control. Leaving the stop clears it.
 */
export interface CycleInvestigation {
  /** The run's `profileSelection.investigationId`, which keeps it out of the cycle's lineage. */
  readonly id: CycleInvestigationId;
  readonly runId: AgentRunId;
  /** The run whose report asked the questions. */
  readonly sourceRunId: AgentRunId;
  readonly code: import('./attention.js').CycleAttentionCode;
  /** SHA-256 of the questions as the run was briefed with them. */
  readonly questionsDigest: string;
  readonly profile: AgentSelection;
  readonly instructions: string;
  readonly minutes: number;
  readonly deadlineAt: string;
  readonly startedAt: string;
  readonly startedByUserId: UserId;
  /** The worktree at the start; a record without it (started before the check) is not compared. */
  readonly worktree?: InvestigationWorktree;
  /**
   * The operator asked a run with a recorded worktree to end; the result follows its process's
   * exit and the comparison (R-C16).
   */
  readonly endRequestedAt?: string;
  readonly endRequestedByUserId?: UserId;
  /** Written when the run ends, with what the daemon read from its report. */
  readonly result?: {
    readonly endedAt: string;
    readonly outcome: 'finished' | 'failed' | 'cancelled' | 'interrupted';
    /**
     * `worktree-changed`: the worktree differed from its record once the run had ended (outcome
     * `failed`). The stop's commands are refused until the operator acknowledges it, or the
     * tree matches the record again. The daemon never resets the tree.
     */
    readonly code?: 'worktree-changed';
    readonly worktreeChange?: InvestigationWorktreeChange;
    readonly acknowledgedAt?: string;
    readonly acknowledgedByUserId?: UserId;
    /** The daemon found the worktree matching its record again. */
    readonly restoredAt?: string;
    /** Why it failed, or why its report could not be read. */
    readonly message?: string;
    readonly findings?: readonly InvestigationFinding[];
  };
}
export interface BaselinePreparation {
  readonly id: string;
  readonly contextDigest: string;
  readonly createdAt: string;
  readonly createdByUserId: UserId;
  readonly status: 'preparing' | 'prepared' | 'failed';
  readonly directory: string;
  readonly sources: readonly {
    readonly alias: string;
    readonly repositoryId: import('./ids.js').SourceRepositoryId;
    readonly directoryName: string;
    readonly commitSha: string;
    readonly tag?: string;
  }[];
  readonly consumerAlias: string;
  readonly message: string;
}
/** The roadmap attempt that created a cycle (R-B3), fixed when the cycle is created. */
export interface CycleOwner {
  readonly roadmapId: RoadmapId;
  readonly attemptId: RoadmapAttemptId;
  readonly entryId: RoadmapEntryId;
  /** The definition revision the attempt was scheduled under. */
  readonly definitionRevision: number;
}
export interface WorkCycle {
  /**
   * Which roadmap attempt created this cycle, or `null` when no roadmap owns it (started by
   * hand, or a finalization). Absent only on records written before schema 29 that nothing
   * has backfilled; `cycleOwnership` derives those from the roadmaps' attempts.
   */
  readonly owner?: CycleOwner | null;
  readonly workflow?: import('./workflow.js').CycleWorkflow;
  readonly designDependencyContinuations?: number;
  readonly designWait?: {
    readonly startedAt: string;
    readonly requirements: readonly (
      | { readonly kind: 'work_item'; readonly id: string; readonly state: 'accepted' }
      | { readonly kind: 'slice'; readonly id: string; readonly state: 'merged' | 'verified' }
    )[];
  } | null;

  /** Explicit repair delegation, with immutable journal turns from related scope reviews. */
  readonly scopeRepair?: {
    readonly sourceCycleId: WorkCycleId;
    readonly sources: readonly {
      readonly runId: AgentRunId;
      readonly sequence: number;
      readonly label: string;
    }[];
  };
  readonly baselinePreparation?: BaselinePreparation;
  readonly designRecovery?: DesignRecovery;
  /** A read-only investigation of the current question stop (R-C16). */
  readonly investigation?: CycleInvestigation;

  readonly executionScope?: import('./execution-scope.js').ExecutionScope;
  readonly id: WorkCycleId;
  readonly workspaceId: WorkspaceId;
  readonly workItemId?: WorkItemId;
  readonly finalizationId?: FinalizationId;
  readonly finalizationProgress?: import('./finalization-stages.js').FinalizationProgress;
  readonly planVersionId?: import('./ids.js').PlanVersionId;
  readonly polishRound?: number;
  readonly polishPhase?: 'assess' | 'polish' | 'verify' | 'final-review';
  /**
   * The label the cycle is shown by: its work item's source id, its scope's source id, or
   * `Finalization` for a plan finalization.
   */
  readonly workItemSourceId: string;
  readonly workItemTitle: string;
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId;
  readonly createdByUserId: UserId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly status: CycleStatus;
  readonly step: CycleStep;
  readonly policy: CompletionPolicy;
  readonly profiles: CycleProfiles;
  /**
   * Cycle-scoped operator instructions given at start; every step receives them. Records written
   * before `stepGuidance` existed may also hold one-shot guidance appended here. That text cannot
   * be separated reliably, so it is kept as-is, but commands no longer append to it.
   */
  readonly instructions: string;
  /**
   * One-shot operator guidance for the step reserved by the command that supplied it (resume,
   * continue, retry, authorize remediation, review again, finalization decisions). Same-step
   * service retries and completion continuations keep it; any other transition clears it, so
   * later steps never inherit it. The run it applies to records it in its brief.
   */
  readonly stepGuidance?: string;
  /** Reserved durably before process launch. A missing run after restart needs operator attention. */
  readonly currentRunId: AgentRunId;
  readonly parentRunId?: AgentRunId;
  readonly runDeadlineAt: string;
  readonly phaseWait?: {
    readonly startedAt: string;
    readonly blockers: readonly import('./phase-scheduling.js').PhaseBlocker[];
  } | null;
  /** Automatic recovery attempts within the current step, independent of remediation. */
  readonly resultContinuations?: number;
  /**
   * Automatic output-format repair of the current step (R-C2): the run whose final report
   * failed validation, the stop it would have been, and the validator's issues. The next run
   * resumes that run's session and asks for the corrected report. Any other transition
   * clears it.
   */
  readonly outputRepair?: {
    readonly attempts: number;
    readonly sourceRunId: AgentRunId;
    readonly code: import('./attention.js').CycleAttentionCode;
    readonly issues: readonly string[];
  } | null;
  /** Same-step service retries, separate from remediation and background-result continuations. */
  readonly providerRecovery?: {
    readonly attempts: number;
    readonly sourceRunId: AgentRunId;
    readonly failure: import('./execution.js').ProviderFailure;
    readonly profile: AgentProfile;
    readonly nextRetryAt?: string;
  } | null;
  readonly remediationRounds: number;
  /** Extra attempts explicitly authorized after a cycle exhausts its initial allowance. */
  readonly additionalRemediationRounds?: number;
  readonly finalizationAgentOverride?: AgentSelection | null;
  readonly deferredNits?: readonly {
    readonly finding: ReviewFinding;
    readonly sourceRunId: AgentRunId;
    readonly headSha: string;
    readonly targetSha: string;
    readonly reason: string;
    readonly createdAt: string;
    readonly createdByUserId: UserId;
  }[];
  readonly findingFocus?: readonly string[];
  readonly stalledReviews: number;
  readonly previousFindingFingerprint?: string;
  readonly reviewHeadSha?: string;
  readonly housekeepingInstructions?: string;
  readonly checkpoint?: {
    readonly sourceRunId: AgentRunId;
    readonly previousHeadSha: string;
    readonly fingerprint: string;
    readonly paths: readonly string[];
    readonly createdAt: string;
    readonly commitSha?: string;
  };
  readonly integrationResolution?: IntegrationResolution;
  readonly integrationRefreshes?: number;
  /** Display text for the current state; never parsed. `attention` carries its meaning. */
  readonly reason: string;
  /**
   * Present while the cycle is `needs-attention` or `awaiting-merge`: the typed stop and who
   * resolves it, written with the transition (R-A3). Older records lack it; read it through
   * `effectiveCycleAttention`.
   */
  readonly attention?: import('./attention.js').CycleAttention;
}

/**
 * What the daemon derives for a cycle when it reads one (CTRL-22, R-D5). It is never stored,
 * and it travels beside the stored cycle (`CycleView`), never inside it, so a reader can tell
 * the controller's record from what was computed for this response.
 */
export interface CycleProjection {
  /** The model selections the next steps would launch with, from the cycle's profiles now. */
  readonly nextAgentSelections: import('./agent-profiles.js').AgentSelections;
  /**
   * The same future agents for every purpose, each with its source and its base step's
   * permissions (R-E5a): the browser shows these and derives none. Like `nextAgentSelections`,
   * they are the cycle's standing choice; a step's one-off agent (a service retry, a recovery's
   * choice, finalization's) is not among them.
   */
  readonly agents?: Readonly<
    Record<
      import('./agent-profiles.js').AgentProfilePurpose,
      import('./agent-profiles.js').EffectiveAgent
    >
  >;
  /** The operator actions the daemon offers now, from `cycleActions` (R-A6). */
  readonly actions: readonly import('./cycle-actions.js').CycleAction[];
  /** The shared decisions a `shared-decision-required` stop still waits on (LIVE-18). */
  readonly unsettledDecisions?: readonly string[];
  /** An older review waits for current prerequisite work. */
  readonly scopeReviewWait?: string;
  /** A slice's merge waits for its merge requirements. */
  readonly mergeRequirementsWait?: string;
  /**
   * Where a slice's open questions at its stop go, read from the current turn's report. Absent
   * when they route nowhere; the cycle's own `workflow.questions` stay as recorded.
   */
  readonly questionRoutes?: readonly import('./workflow.js').WorkflowQuestion[];
}
/** A cycle as a read returns it: the stored record and its projection, side by side. */
export interface CycleView {
  readonly cycle: WorkCycle;
  readonly projection: CycleProjection;
}
export function remediationAllowance(
  cycle: Pick<WorkCycle, 'policy' | 'additionalRemediationRounds' | 'finalizationProgress'>,
): number {
  return (
    cycle.policy.maxRemediationRounds +
    (currentFinalizationStage(cycle)?.additionalRemediationRounds ??
      cycle.additionalRemediationRounds ??
      0)
  );
}

export function remediationUsed(
  cycle: Pick<WorkCycle, 'remediationRounds' | 'finalizationProgress'>,
): number {
  return currentFinalizationStage(cycle)?.remediationRounds ?? cycle.remediationRounds;
}

interface CompletionDecision {
  readonly action: 'awaiting-merge' | 'remediate' | 'needs-attention';
  readonly reason: string;
  readonly openCounts: Readonly<Record<FindingSeverity, number>>;
}

/** Verdict and quality policy are independent gates. A budget never weakens either. */
export function evaluateCompletion(
  policy: CompletionPolicy,
  assessment?: ReviewReportAssessment,
): CompletionDecision {
  const openCounts = { blocking: 0, major: 0, minor: 0, nit: 0 };
  if (assessment?.status !== 'complete') {
    // The stop names why, or the operator retries the same report blind (LIVE-32). Bounded
    // below the cycle reason's 4,000 characters, leaving room for a stop's prefix.
    const issues = assessment?.issues.join(' ') ?? '';
    return {
      action: 'needs-attention',
      reason:
        `A complete, valid structured review report is required.${issues ? ` ${issues}` : ''}`.slice(
          0,
          3000,
        ),
      openCounts,
    };
  }
  const report = assessment.report;
  for (const finding of report.findings)
    if (finding.status === 'open') openCounts[finding.severity] += 1;
  if (
    !report.exitGate.met ||
    report.verdict !== 'mergeable' ||
    openCounts.blocking > 0 ||
    openCounts.major > 0 ||
    openCounts.minor > 0 ||
    openCounts.nit > policy.maxNits
  ) {
    return {
      action: 'remediate',
      reason: `Review requires remediation: ${openCounts.blocking} blocking, ${openCounts.major} major, ${openCounts.minor} minor, ${openCounts.nit} nits (allowance ${policy.maxNits}); exit gate ${report.exitGate.met ? 'met' : 'not met'}, verdict ${report.verdict}.`,
      openCounts,
    };
  }
  return {
    action: 'awaiting-merge',
    reason: `Review meets the completion policy (${openCounts.nit} open nits, allowance ${policy.maxNits}). Operator merge approval required.`,
    openCounts,
  };
}

/**
 * R-C7 D7: a slice verification passes when its report is complete, its exit gate is met, its
 * verdict is mergeable and no blocking or major finding is open. Returns the minor and nit
 * findings it leaves open, which become follow-ups on its scope evidence, or `undefined` when
 * it does not pass.
 */
export function verificationFollowUps(
  assessment?: ReviewReportAssessment,
): readonly ReviewFinding[] | undefined {
  if (assessment?.status !== 'complete') return;
  const { exitGate, verdict, findings } = assessment.report;
  const open = findings.filter((f) => f.status === 'open');
  if (
    !exitGate.met ||
    verdict !== 'mergeable' ||
    open.some((f) => f.severity === 'blocking' || f.severity === 'major')
  )
    return;
  return open;
}

/** Automatic output-format repairs per step before the controller stops for the operator. */
export const OUTPUT_REPAIR_LIMIT = 2;

/**
 * The completion decision for a cycle's review. A staged finalization parks optional
 * follow-ups, and nits parked at a spent stage allowance (R-C7 D5), outside the nit count; deferring nits by operator decision was part of the
 * retired improvement-round finalization (R-B10). `_context` keeps the callers' signature.
 */
export function evaluateCycleCompletion(
  cycle: WorkCycle,
  assessment?: ReviewReportAssessment,
  _context?: { headSha: string; targetSha: string },
): CompletionDecision {
  if (assessment?.status !== 'complete') return evaluateCompletion(cycle.policy, assessment);
  const parked = stagedFollowUps(cycle);
  const followUps = new Set(
    assessment.report.findings.filter((f) => parkedFollowUp(parked, f)).map((f) => f.id),
  );
  // Required categories and selected batches cannot be waived by severity thresholds.
  if (
    cycle.finalizationProgress &&
    assessment.report.findings.some((f) => f.status === 'open' && !followUps.has(f.id))
  )
    return {
      ...evaluateCompletion({ ...cycle.policy, maxNits: 0 }, assessment),
      action: 'remediate',
      reason: 'Required findings or selected batch findings remain open.',
    };
  const decision = evaluateCompletion(cycle.policy, {
    ...assessment,
    report: {
      ...assessment.report,
      findings: assessment.report.findings.filter((f) => !followUps.has(f.id)),
    },
  });
  return followUps.size
    ? {
        ...decision,
        reason: `${decision.reason} ${followUps.size} optional suggestion(s) remain open as follow-up work.`,
      }
    : decision;
}
