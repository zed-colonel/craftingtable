import type { AgentPermissionMode, AgentRunRole, AgentRunStatus } from '@craftingtable/domain';

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
  cancelled: 'var(--color-text-muted)',
  interrupted: 'var(--color-blocked)',
};

export const RUN_ROLE_LABELS: Readonly<Record<AgentRunRole, string>> = {
  implement: 'Implement',
  review: 'Review',
  design: 'Design',
};

export const RUN_ROLE_DESCRIPTIONS: Readonly<Record<AgentRunRole, string>> = {
  implement: 'Build the work item in the worktree, run checks, and commit on the branch.',
  review: 'Read-only review of the branch against its base with a numbered findings list.',
  design: 'Explore the code and propose an approach without changing files.',
};

export const PERMISSION_MODE_LABELS: Readonly<Record<AgentPermissionMode, string>> = {
  auto: 'Auto: the agent approves routine actions itself; risky ones are denied',
  'edit-only': 'Edit only: file edits allowed, commands that need approval are denied',
  unrestricted: 'Unrestricted: no permission checks inside the worktree',
};

export function isLiveStatus(status: AgentRunStatus): boolean {
  return status === 'starting' || status === 'running' || status === 'waiting';
}

export function formatCost(costUsd: number | undefined): string {
  return costUsd === undefined ? '—' : `$${costUsd.toFixed(2)}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 10);
}
