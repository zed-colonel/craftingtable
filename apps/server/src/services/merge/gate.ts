/**
 * The merge gate (R-B7; CTRL-13): whether a worktree's latest review lets it merge, and the
 * operator's text for each reason. Pure: it reads the records it is given, never Git or storage.
 */
import {
  type AgentRun,
  type AgentRunId,
  isInvestigationRun,
  isTerminalAgentRunStatus,
  type Worktree,
} from '@craftingtable/domain';

export type MergeGateReason =
  | 'ready'
  | 'no-review'
  | 'changes-requested'
  | 'automation-active'
  | 'review-pending'
  | 'superseded-by-later-run'
  | 'run-live'
  | 'worktree-removed'
  | 'branch-review-required'
  | 'merge-recovery-required'
  | 'scope-blocked'
  | 'scope-review-only'
  /** Mergeable by a person who approves the check definitions it adopts (R-G13). */
  | 'check-adoption';

export interface MergeGate {
  readonly mergeable: boolean;
  readonly reason: MergeGateReason;
  readonly reviewRunId?: AgentRunId;
  /** On an open gate: the primary checkout's branch (R-G10 D3); from Git, never stored. */
  readonly checkedOutBranch?: string;
}

/**
 * The pull-request rule: a worktree may be merged when its most recent run is
 * a review that returned `mergeable` and nothing is live in it. Any later run
 * of any role supersedes the review, because it may have changed the branch.
 */
export function mergeGateFor(worktree: Worktree, runs: readonly AgentRun[]): MergeGate {
  if (worktree.status !== 'active') {
    return { mergeable: false, reason: 'worktree-removed' };
  }
  const all = runs
    .filter((run) => run.worktreeId === worktree.id)
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  // A live investigation holds the worktree; a finished one changed nothing (R-C16).
  if (all.some((run) => !isTerminalAgentRunStatus(run.status))) {
    const live = all.find((run) => !isTerminalAgentRunStatus(run.status));
    return live?.role === 'review' && live.verdict === undefined
      ? { mergeable: false, reason: 'review-pending', reviewRunId: live.id }
      : { mergeable: false, reason: 'run-live' };
  }
  const forWorktree = all.filter((run) => !isInvestigationRun(run));
  const latest = forWorktree[0];
  const latestReview = forWorktree.find((run) => run.role === 'review');
  if (latestReview === undefined) {
    return { mergeable: false, reason: 'no-review' };
  }
  if (latest !== undefined && latest.id !== latestReview.id) {
    return { mergeable: false, reason: 'superseded-by-later-run', reviewRunId: latestReview.id };
  }
  if (latestReview.status !== 'finished') {
    return { mergeable: false, reason: 'review-pending', reviewRunId: latestReview.id };
  }
  if (
    worktree.integrationBranch === undefined ||
    latestReview.reviewBranchContext?.worktreeVersion !== worktree.version ||
    latestReview.reviewBranchContext.targetBranch !== worktree.integrationBranch
  ) {
    return { mergeable: false, reason: 'branch-review-required', reviewRunId: latestReview.id };
  }
  if (latestReview.verdict === 'mergeable') {
    return { mergeable: true, reason: 'ready', reviewRunId: latestReview.id };
  }
  return {
    mergeable: false,
    reason: latestReview.verdict === 'changes-requested' ? 'changes-requested' : 'review-pending',
    reviewRunId: latestReview.id,
  };
}

export const MERGE_GATE_MESSAGES: Readonly<Record<MergeGateReason, string>> = {
  'merge-recovery-required': 'Recover the reserved integration merge before continuing',
  'scope-blocked': 'Execution scope requirements or scoped review evidence are unresolved',
  'scope-review-only': 'This worktree records verification or parent acceptance; it does not merge',
  'check-adoption': 'Approve the check definitions this merge adopts, with the merge',
  'branch-review-required': 'Adopt an integration branch if needed and run a fresh review',
  ready: 'Ready to merge',
  'no-review': 'Merging requires a review run with a mergeable verdict; launch a review first',
  'changes-requested': 'The latest review requested changes; address them and review again',
  'automation-active':
    'The automated cycle has not reached merge approval; stop it to use the manual merge flow',
  'review-pending': 'The latest review has not returned a verdict yet',
  'superseded-by-later-run': 'A run started after the last review; review the branch again',
  'run-live': 'A run is still live in this worktree',
  'worktree-removed': 'The worktree has been removed',
};
