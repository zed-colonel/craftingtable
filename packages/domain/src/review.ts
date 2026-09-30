import type { AgentRunVerdict } from './execution.js';

export const FINDING_SEVERITIES = ['blocking', 'major', 'minor', 'nit'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_STATUSES = ['open', 'resolved', 'withdrawn'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Identity is stable within a worktree's review lineage, including closed findings. */
export interface ReviewFinding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly category?: Exclude<
    import('./finalization-stages.js').FinalizationStageKind,
    'final-review'
  >;
  readonly status: FindingStatus;
  readonly title: string;
  readonly location?: { readonly path: string; readonly line?: number };
  readonly explanation: string;
  readonly recommendation: string;
  /** Reviewer evidence for resolution, or the reason for withdrawal. */
  readonly disposition?: string;
  /** The parent's required slice that owns this finding's fix, as the reviewer names it. */
  readonly owningSlice?: string;
}

/** A reviewer's consolidated assertions, not independently proven correctness. */
export interface ReviewReport {
  readonly scopeEvidence?: import('./execution-scope.js').ScopeReviewEvidence;
  readonly version: 1;
  readonly complete: true;
  readonly verdict: AgentRunVerdict;
  readonly exitGate: { readonly met: boolean; readonly evidence: string };
  readonly findings: readonly ReviewFinding[];
  readonly finalization?: import('./finalization-stages.js').StageReviewReport;
}

/**
 * Why a report is invalid (R-C2). `format`: its structure is wrong (missing, truncated,
 * unparsable or schema-invalid block, a verdict line that disagrees with it), which the
 * reviewer can fix by restating what it already reported. `content`: it is well formed but
 * lacks something only more work or the operator can supply (required checks, obligation
 * dispositions, retained findings, scope evidence). Only format faults are repaired
 * automatically; content faults stop for the operator. Older records omit it; the reader
 * derives it from the report text.
 */
export type ReviewReportFault = 'format' | 'content';

/** Structural validity never implies that a reviewer found every possible defect. */
export type ReviewReportAssessment =
  | { readonly status: 'unstructured'; readonly issues: readonly string[] }
  | {
      readonly status: 'invalid';
      readonly issues: readonly string[];
      readonly fault?: ReviewReportFault;
    }
  | {
      readonly status: 'complete';
      readonly issues: readonly string[];
      readonly report: ReviewReport;
    };
