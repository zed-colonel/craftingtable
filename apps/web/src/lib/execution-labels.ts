import type { MergeGate } from '@craftingtable/contracts';
import type {
  AgentBillingSource,
  AgentPermissionMode,
  AgentRunRole,
  AgentRunStatus,
  AgentRunVerdict,
} from '@craftingtable/domain';

/**
 * Visible vocabulary for delegation. Every status is rendered as text, never
 * as colour alone (docs/ui-principles.md).
 */

export const RUN_STATUS_LABELS: Readonly<Record<AgentRunStatus, string>> = {
  starting: 'Starting',
  running: 'Working',
  waiting: 'Awaiting your input',
  finished: 'Finished',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

export const RUN_STATUS_ACCENTS: Readonly<Record<AgentRunStatus, string>> = {
  starting: 'var(--color-active)',
  running: 'var(--color-active)',
  waiting: 'var(--color-attention)',
  finished: 'var(--color-ready)',
  failed: 'var(--color-blocked)',
  cancelled: 'var(--color-done)',
  interrupted: 'var(--color-blocked)',
};

export const RUN_ROLE_LABELS: Readonly<Record<AgentRunRole, string>> = {
  implement: 'Implement',
  review: 'Review',
  design: 'Design',
};

export const RUN_ROLE_DESCRIPTIONS: Readonly<Record<AgentRunRole, string>> = {
  implement: 'Build the work item in the worktree, run checks, and commit on the branch.',
  review:
    'Read-only review of the branch against its base. Ends with a verdict; a mergeable verdict opens the Merge action.',
  design: 'Explore the code and propose an approach without changing files.',
};

export const PERMISSION_MODE_LABELS: Readonly<Record<AgentPermissionMode, string>> = {
  auto: 'Auto: routine actions approved by the agent, risky ones denied',
  'edit-only': 'Edit only: file edits allowed, commands that need approval denied',
  unrestricted: 'Unrestricted: no permission checks',
};

export const VERDICT_LABELS: Readonly<Record<AgentRunVerdict, string>> = {
  mergeable: 'Mergeable',
  'changes-requested': 'Changes requested',
};

export const VERDICT_ACCENTS: Readonly<Record<AgentRunVerdict, string>> = {
  mergeable: 'var(--color-ready)',
  'changes-requested': 'var(--color-attention)',
};

export const BILLING_LABELS: Readonly<Record<AgentBillingSource, string>> = {
  subscription: 'subscription login',
  'api-key': 'API key',
  unknown: 'unknown billing',
};

export const MERGE_GATE_LABELS: Readonly<Record<MergeGate['reason'], string>> = {
  ready: 'Reviewed and mergeable',
  'no-review': 'Needs a review run',
  'changes-requested': 'Review requested changes',
  'automation-active': 'Automation has not reached merge approval',
  'review-pending': 'Review has no verdict yet',
  'superseded-by-later-run': 'A run started after the review; review again',
  'run-live': 'A run is live in this worktree',
  'branch-review-required': 'Fresh review of the integration target required',
  'worktree-removed': 'Worktree removed',
};

export function isLiveStatus(status: AgentRunStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'waiting';
}

/**
 * A subscription session's cost is what the same tokens would cost at API
 * list prices; it is shown as an estimate rather than a bill.
 */
export function formatCost(costUsd: number | undefined, billing?: AgentBillingSource): string {
  if (costUsd === undefined) {
    return '—';
  }
  const amount = `$${costUsd.toFixed(2)}`;
  return billing === 'subscription' ? `≈${amount} (est.)` : amount;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 10);
}

export function formatElapsed(fromIso: string, toIso: string | undefined, now: number): string {
  const start = Date.parse(fromIso);
  const end = toIso === undefined ? now : Date.parse(toIso);
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
