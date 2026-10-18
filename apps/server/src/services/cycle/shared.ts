import { type AgentRunId } from '@craftingtable/domain';
import {
  type AgentRun,
  evaluateCycleCompletion,
  remediationAllowance,
  remediationUsed,
  type WorkCycle,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { scopedReviewIssue } from '../execution-scope.js';
import { type CommandFacts } from './core/commands.js';
import { type CycleDecision, type CycleGuard } from './core/machine.js';
import { turnTakesGrant } from './core/effect-decisions.js';
import { continuesLineage, latestReviewReport } from '../run-lineage.js';

/** The least time an automatic output-format repair turn gets (R-C2). */
export const OUTPUT_REPAIR_MINUTES = 20;

export const PREPARING_RECOVERY =
  'Preparing the requested recovery. Existing findings remain available.';

/** Statuses in which a cycle has ended; the browser treats them as history. */
export const TERMINAL_CYCLE_STATUSES: ReadonlySet<WorkCycle['status']> = new Set([
  'completed',
  'stopped',
]);

/** The statuses that stop for someone and carry typed attention (R-A3). */
export const ATTENTION_STATUSES: ReadonlySet<WorkCycle['status']> = new Set([
  'needs-attention',
  'awaiting-merge',
]);

/** An operator's grant of more remediation rounds, with its instructions. */
export interface RemediationGrant {
  readonly additionalRounds: number;
  readonly instructions: string;
  readonly agentOverride?: WorkCycle['finalizationAgentOverride'];
}

/**
 * The tree's newest run is newer than the cycle's own and outside its handoff lineage, so a
 * resume would refuse to adopt it (`decideResumeStep`); a lineage it cannot follow counts too.
 */
export function latestOutsideLineage(
  tx: StorageRepositories,
  cycle: WorkCycle,
  latestRunId: AgentRunId | undefined,
): boolean {
  if (!latestRunId || latestRunId === cycle.currentRunId || latestRunId === cycle.parentRunId)
    return false;
  const latest = tx.execution.runs.find(cycle.workspaceId, latestRunId);
  if (!latest) return false;
  try {
    return !continuesLineage(tx.execution, cycle, latest);
  } catch {
    return true;
  }
}

/** How often an open worktree change is compared with its record again (R-C16). */
export const RESTORED_CHECK_MS = 60_000;

/** How long past its deadline an unfinished investigation run is closed (R-C16 review M3). */
export const STUCK_INVESTIGATION_MS = 2 * 60_000;

/** The workspace-wide list leaves an investigation's proposals to the item's own read (PERF-05). */
export function withoutFindings(cycle: WorkCycle): WorkCycle {
  const result = cycle.investigation?.result;
  if (!result?.findings || !cycle.investigation) return cycle;
  const { findings: _omitted, ...rest } = result;
  return { ...cycle, investigation: { ...cycle.investigation, result: rest } };
}

/** What the cycles replay is told as a pass takes up each cycle (R-B4). */
export interface CyclePassObserver {
  /** What `decide` chose for this cycle, or the gate that threw and the guard it belongs to. */
  readonly decided?: (
    cycle: WorkCycle,
    result:
      | { readonly decision: CycleDecision }
      | { readonly failed: unknown; readonly guard: CycleGuard | undefined },
  ) => void;
  /** The pass is done with this cycle: reconciled, skipped, or stopped by an error. */
  readonly cycle: (cycle: WorkCycle) => void;
}

/**
 * What a finished review's report asks, and whether its turn can carry a grant, for the resume's
 * round-limit rule (R-B4, decision 14; NIT-4's turn half).
 */
export function reviewFacts(
  tx: StorageRepositories,
  cycle: WorkCycle,
): Pick<CommandFacts, 'reviewAsksRemediation' | 'reviewScopeIssue' | 'reviewTurnSucceeded'> {
  return {
    reviewAsksRemediation: (run) => {
      const assessment = latestReviewReport(tx.execution, run);
      return (
        assessment?.status === 'complete' &&
        evaluateCycleCompletion(cycle, assessment, run.reviewBranchContext).action === 'remediate'
      );
    },
    reviewScopeIssue: (run) => {
      const tree = tx.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
      return !!tree && !!scopedReviewIssue(tx, tree, latestReviewReport(tx.execution, run));
    },
    reviewTurnSucceeded: (run) =>
      turnTakesGrant(
        tx.execution.runEvents.latestOfKind(cycle.workspaceId, run.id, 'turn-completed'),
      ),
  };
}

/**
 * A stopped or paused review whose well-formed report asks for remediation the allowance has
 * spent: only Authorize more remediation can continue it (LIVE-33).
 */
export function reviewNeedsRounds(
  tx: StorageRepositories,
  cycle: WorkCycle,
  run?: AgentRun,
): boolean {
  if (
    !['needs-attention', 'paused'].includes(cycle.status) ||
    cycle.step !== 'review' ||
    run?.role !== 'review' ||
    run.status !== 'finished' ||
    remediationUsed(cycle) < remediationAllowance(cycle)
  )
    return false;
  const assessment = latestReviewReport(tx.execution, run);
  if (assessment?.status !== 'complete') return false;
  const tree = tx.execution.worktrees.find(cycle.workspaceId, cycle.worktreeId);
  return (
    !(tree && scopedReviewIssue(tx, tree, assessment)) &&
    evaluateCycleCompletion(cycle, assessment, run.reviewBranchContext).action === 'remediate'
  );
}
