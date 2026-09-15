import type { AgentRunProfile } from './execution.js';
import type { AgentRunId, UserId } from './ids.js';
import type { ReviewFinding } from './review.js';
import type { CompletionPolicy, WorkCycle } from './work-cycle.js';

export const FINALIZATION_STAGE_KINDS = [
  'correctness',
  'conformance',
  'simplification',
  'polish',
  'final-review',
] as const;
export type FinalizationStageKind = (typeof FINALIZATION_STAGE_KINDS)[number];
export const FINALIZATION_STAGE_LABELS: Record<FinalizationStageKind, string> = {
  correctness: 'Correctness',
  conformance: 'Conformance',
  simplification: 'Simplification',
  polish: 'Polish',
  'final-review': 'Final independent review',
};
export interface FinalizationStage {
  readonly id: string;
  readonly kind: FinalizationStageKind;
  readonly name: string;
  /** Empty means the whole plan; slices use imported work-item source IDs. */
  readonly workItemSourceIds: readonly string[];
  readonly instructions: string;
  readonly review: Omit<AgentRunProfile, 'role'>;
  readonly implement: Omit<AgentRunProfile, 'role'>;
  readonly policy: CompletionPolicy;
  readonly requiredChecks: readonly string[];
}
export interface ObligationReport {
  readonly id: string;
  readonly source?: string;
  readonly requirement?: string;
  readonly workItemSourceId?: string;
  readonly status: 'met' | 'gap' | 'change-requested';
  readonly evidence: string;
  readonly proposedRequirement?: string;
  readonly reusedFromRunId?: AgentRunId;
}
export interface StageReviewReport {
  readonly stageId: string;
  readonly fullChecks: boolean;
  readonly checks: readonly {
    readonly name: string;
    readonly status: 'passed' | 'failed' | 'not-run';
    readonly evidence: string;
  }[];
  readonly obligations: readonly ObligationReport[];
}
export interface FinalizationObligation extends Omit<ObligationReport, 'status'> {
  readonly source: string;
  readonly requirement: string;
  readonly status: ObligationReport['status'] | 'unverified';
  readonly runId?: AgentRunId;
  readonly headSha?: string;
  readonly targetSha?: string;
  readonly approvedChange?: {
    readonly previousRequirement: string;
    readonly rationale: string;
    readonly userId: UserId;
    readonly createdAt: string;
  };
}
export interface FinalizationStageState {
  readonly id: string;
  readonly status: 'pending' | 'reviewing' | 'selecting' | 'verifying' | 'completed';
  readonly remediationRounds: number;
  readonly additionalRemediationRounds: number;
  readonly selectedFindingIds: readonly string[];
  readonly completedRunId?: AgentRunId;
  readonly headSha?: string;
  readonly targetSha?: string;
}
export interface FinalizationProgress {
  readonly stageIndex: number;
  readonly stages: readonly FinalizationStageState[];
  readonly obligations: readonly FinalizationObligation[];
  readonly followUps: readonly ReviewFinding[];
  readonly decisions: readonly {
    readonly stageId: string;
    readonly runId: AgentRunId;
    readonly selectedIds: readonly string[];
    readonly rationale: string;
    readonly userId: UserId;
    readonly createdAt: string;
  }[];
}
export function currentFinalizationStage(cycle: Pick<WorkCycle, 'finalizationProgress'>) {
  const p = cycle.finalizationProgress;
  return p?.stages[p.stageIndex];
}
export function optionalFinding(finding: ReviewFinding): boolean {
  return (
    (finding.category === 'simplification' || finding.category === 'polish') &&
    (finding.severity === 'minor' || finding.severity === 'nit')
  );
}
export function stageStoppingRule(kind: FinalizationStageKind): string {
  return kind === 'simplification' || kind === 'polish'
    ? 'Discover once, select a batch, then verify selected findings; new optional ideas become follow-up work.'
    : kind === 'final-review'
      ? 'Whole-candidate checks and every adopted obligation verified; explicit operator merge approval.'
      : 'Required checks pass and all correctness/conformance findings are addressed, regardless of severity.';
}
export function stagedFollowUpIds(cycle: WorkCycle): ReadonlySet<string> {
  const selected = new Set([
    ...(cycle.findingFocus ?? []),
    ...(cycle.finalizationProgress?.stages.flatMap((s) => s.selectedFindingIds) ?? []),
  ]);
  return new Set(
    cycle.finalizationProgress?.followUps
      .filter((f) => optionalFinding(f) && !selected.has(f.id))
      .map((f) => f.id),
  );
}
