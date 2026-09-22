/** Controller work is separate from source defects and operator decisions. */
export interface WorkflowQuestion {
  readonly question: string;
  readonly destination: 'shared-decision' | 'work-item';
  readonly checkpointId?: string;
}
export interface CycleWorkflow {
  readonly reassessments: number;
  readonly questions: readonly WorkflowQuestion[];
  readonly securityRequired?: boolean;
  readonly activeReview?: {
    readonly kind: 'reassessment' | 'security' | 'checkpoint';
    readonly checkpointId?: string;
    readonly sourceRunId: string;
    readonly requirements: readonly string[];
    readonly caseIds: readonly string[];
    readonly roles: readonly string[];
    readonly contextDigest: string;
  } | null;
  readonly securityReceipt?: {
    readonly runId: string;
    readonly headSha: string;
    readonly targetSha: string;
  };
  readonly waiting?: string | null;
}
