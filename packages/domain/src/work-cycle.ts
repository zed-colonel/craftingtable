import type { AgentRunProfile } from './execution.js';
import type { FinalizationAgentSelection } from './finalization.js';
import {
  currentFinalizationStage,
  optionalFinding,
  stagedFollowUpIds,
} from './finalization-stages.js';
import type { AgentRunId, ProjectId, UserId, WorkItemId, WorkspaceId, WorktreeId } from './ids.js';
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
export type CycleProfiles = Readonly<
  Record<CycleStep, Omit<AgentRunProfile, 'role'>> &
    Partial<
      Record<
        import('./agent-profiles.js').SpecialistProfile,
        import('./agent-profiles.js').AgentSelection
      >
    >
>;
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
  readonly profile?: Omit<AgentRunProfile, 'role'>;
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
  readonly archiveId?: string;
  readonly archiveDigest?: string;
  readonly name: string;
  readonly digest: string;
}
export interface DesignRecovery {
  readonly runId: AgentRunId;
  readonly sourceRunId: AgentRunId;
  readonly mode: 'investigate' | 'continue';
  /**
   * Started by the controller, not the operator: the investigation before it answered every
   * question with cited sources (R-C3a). At most one per operator-started investigation.
   */
  readonly automatic?: true;
  readonly profile: FinalizationAgentSelection;
  readonly instructions: string;
  readonly snapshotDigest: string;
  readonly facts: string;
  readonly sources: readonly DesignRecoverySource[];
  readonly attachments: readonly { readonly name: string; readonly content: string }[];
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
  readonly roadmapId: string;
  readonly attemptId: string;
  readonly entryId: string;
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
  /** Read projection: future model selections, never persisted as original settings. */
  readonly nextAgentSelections?: import('./agent-profiles.js').AgentSelections;
  readonly workflow?: import('./workflow.js').CycleWorkflow;
  readonly designDependencyContinuations?: number;
  readonly designWait?: {
    readonly startedAt: string;
    readonly requirements: readonly (
      | { readonly kind: 'work_item'; readonly id: string; readonly state: 'accepted' }
      | { readonly kind: 'slice'; readonly id: string; readonly state: 'merged' | 'verified' }
    )[];
  } | null;

  /** Read projection only: an older review waits for current prerequisite work. */
  readonly scopeReviewWait?: string;
  readonly mergeRequirementsWait?: string;
  /** Explicit repair delegation, with immutable journal turns from related scope reviews. */
  readonly scopeRepair?: {
    readonly sourceCycleId: string;
    readonly sources: readonly {
      readonly runId: AgentRunId;
      readonly sequence: number;
      readonly label: string;
    }[];
  };
  readonly baselinePreparation?: BaselinePreparation;
  readonly designRecovery?: DesignRecovery;

  readonly executionScope?: import('./execution-scope.js').ExecutionScope;
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly workItemId?: WorkItemId;
  readonly finalizationId?: string;
  readonly finalizationProgress?: import('./finalization-stages.js').FinalizationProgress;
  readonly planVersionId?: import('./ids.js').PlanVersionId;
  readonly polishRound?: number;
  readonly polishPhase?: 'assess' | 'polish' | 'verify' | 'final-review';
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
    readonly profile: Omit<AgentRunProfile, 'role'>;
    readonly nextRetryAt?: string;
  } | null;
  readonly remediationRounds: number;
  /** Extra attempts explicitly authorized after a cycle exhausts its initial allowance. */
  readonly additionalRemediationRounds?: number;
  readonly finalizationAgentOverride?: FinalizationAgentSelection | null;
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

export interface CompletionDecision {
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
    return {
      action: 'needs-attention',
      reason: 'A complete, valid structured review report is required.',
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

/** Automatic output-format repairs per step before the controller stops for the operator. */
export const OUTPUT_REPAIR_LIMIT = 2;

/**
 * The shape of a final report's "## Open questions" checkpoint (R-C2). `questions` means
 * the section exists once and lists something for the operator. `malformed` is a format
 * fault the agent can repair itself: no section, a repeated section, an empty one, or a
 * "none" followed by more text.
 */
export function openQuestionsCheckpoint(text: string): 'none' | 'questions' | 'malformed' {
  let fence: string | undefined;
  let collecting = false;
  let count = 0;
  const body: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      if (collecting) body.push(line);
      continue;
    }
    if (fence === undefined && /^## /.test(line)) {
      collecting = /^## Open questions[ \t]*$/.test(line);
      if (collecting) count += 1;
    } else if (collecting) body.push(line);
  }
  const content = body.join('\n').trim().toLowerCase();
  if (count !== 1 || !content) return 'malformed';
  if (content === 'none') return 'none';
  return /^none\b/.test(content) ? 'malformed' : 'questions';
}

/** Deliberately strict: missing, ambiguous, or truncated design conclusions pause automation. */
export function designHasNoOpenQuestions(text: string, truncated = false): boolean {
  if (truncated) return false;
  const lines = text.split(/\r?\n/);
  let fence: string | undefined;
  const headings: number[] = [];
  for (const [index, line] of lines.entries()) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence === undefined && /^## Open questions[ \t]*$/.test(line)) headings.push(index);
  }
  return (
    headings.length === 1 &&
    lines
      .slice((headings[0] ?? -1) + 1)
      .join('\n')
      .trim()
      .toLowerCase() === 'none'
  );
}

/**
 * The completion decision for a cycle's review. A staged finalization parks optional
 * follow-ups outside the nit count; deferring nits by operator decision was part of the
 * retired improvement-round finalization (R-B10). `_context` keeps the callers' signature.
 */
export function evaluateCycleCompletion(
  cycle: WorkCycle,
  assessment?: ReviewReportAssessment,
  _context?: { headSha: string; targetSha: string },
): CompletionDecision {
  if (assessment?.status !== 'complete') return evaluateCompletion(cycle.policy, assessment);
  const parked = stagedFollowUpIds(cycle);
  const followUps = new Set(
    assessment.report.findings
      .filter((f) => parked.has(f.id) && optionalFinding(f))
      .map((f) => f.id),
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
