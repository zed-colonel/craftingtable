import { currentFinalizationStage } from './finalization-stages.js';
import type { Finalization } from './finalization.js';
import type { WorkCycle } from './work-cycle.js';

/**
 * The plan adjustments a finalization's current review proposes: the only ones
 * `approve-plan-change` accepts. A proposal an earlier review made, kept in the ledger because
 * a later report did not mention it, cannot be approved (R-A6 2b review).
 */
export function currentPlanChanges<
  O extends {
    readonly status: string;
    readonly proposedRequirement?: string;
    readonly runId?: string;
  },
>(cycle: {
  readonly currentRunId?: string;
  readonly finalizationProgress?: { readonly obligations: readonly O[] };
}): O[] {
  return (
    cycle.finalizationProgress?.obligations.filter(
      (o) =>
        o.status === 'change-requested' &&
        !!o.proposedRequirement &&
        o.runId !== undefined &&
        o.runId === cycle.currentRunId,
    ) ?? []
  );
}

/** The decisions a staged finalization can be given (R-A6 increment 2b). */
export const FINALIZATION_DECISIONS = [
  'resume',
  'select-stage-findings',
  'approve-plan-change',
  'remediate-findings',
  'authorize-remediation',
  'merge',
] as const;
export type FinalizationDecision = (typeof FINALIZATION_DECISIONS)[number];

/**
 * Which decisions a finalization offers now (R-A6 increment 2b, operator decision 2026-10-01):
 * one rule for what `finalizations/:id/control` accepts and what the browser offers. The
 * control command's own checks still apply; pause, stop and cleanup are manual controls,
 * decided elsewhere.
 *
 * - `merge`: the final review approved the candidate, or an approved promotion is reserved and
 *   must be recovered (nothing else is offered then).
 * - At a stopped or paused cycle with no integration resolution open: the plan adjustment the
 *   current review proposes, else its batch selection, else focused remediation of the checkpoint's
 *   findings and more attempts where the daemon allows them.
 * - `resume`: whenever the finalization is preparing or its cycle is not running.
 * - A retired, stage-less finalization: only `merge`, approved or reserved.
 */
export function finalizationActions(input: {
  readonly finalization: Pick<Finalization, 'status' | 'stages'>;
  readonly cycle?: Pick<
    WorkCycle,
    'status' | 'polishPhase' | 'integrationResolution' | 'finalizationProgress' | 'currentRunId'
  >;
  readonly mergeRecoveryPending: boolean;
  readonly checkpointFindings: number;
  readonly canAuthorizeRemediation: boolean;
}): FinalizationDecision[] {
  const { finalization, cycle } = input;
  if (!['active', 'preparing'].includes(finalization.status)) return [];
  if (input.mergeRecoveryPending) return ['merge'];
  // A retired improvement-round finalization can still be promoted once approved, or stopped
  // (a manual control); nothing else (R-A6 2b review).
  if (!finalization.stages) return cycle?.status === 'awaiting-merge' ? ['merge'] : [];
  const actions: FinalizationDecision[] = [];
  if (cycle?.status === 'awaiting-merge' && cycle.polishPhase === 'final-review')
    actions.push('merge');
  const idle = !cycle || ['paused', 'needs-attention'].includes(cycle.status);
  if (!idle) return actions;
  const resolving =
    !!cycle?.integrationResolution &&
    !['completed', 'abandoned'].includes(cycle.integrationResolution.status);
  if (!resolving) {
    if (cycle && currentPlanChanges(cycle).length) actions.push('approve-plan-change');
    else if (cycle && currentFinalizationStage(cycle)?.status === 'selecting')
      actions.push('select-stage-findings');
    else {
      if (input.checkpointFindings) actions.push('remediate-findings');
      if (input.canAuthorizeRemediation) actions.push('authorize-remediation');
    }
  }
  actions.push('resume');
  return actions;
}
