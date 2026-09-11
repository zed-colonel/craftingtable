import type { AgentRunProfile } from './execution.js';
import type { AgentRunId, ProjectId, UserId, WorkItemId, WorkspaceId, WorktreeId } from './ids.js';
import type { FindingSeverity, ReviewReportAssessment } from './review.js';

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
export type CycleProfiles = Readonly<Record<CycleStep, Omit<AgentRunProfile, 'role'>>>;
export interface WorkCycle {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly workItemId: WorkItemId;
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
  readonly instructions: string;
  /** Reserved durably before process launch. A missing run after restart needs operator attention. */
  readonly currentRunId: AgentRunId;
  readonly parentRunId?: AgentRunId;
  readonly runDeadlineAt: string;
  readonly remediationRounds: number;
  readonly stalledReviews: number;
  readonly previousFindingFingerprint?: string;
  readonly reviewHeadSha?: string;
  readonly integrationRefreshes?: number;
  readonly reason: string;
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
