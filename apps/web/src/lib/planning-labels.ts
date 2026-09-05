import type { WorkItemSummary } from '@craftingtable/contracts';

/**
 * Planning vocabulary. A bare "Ready" or "Blocked" never appears: readiness
 * here is about the agenda, and merge readiness is a separate, reviewed
 * decision on a worktree (docs/ui-principles.md).
 */

export type Readiness = WorkItemSummary['readiness'];

export const READINESS_LABELS: Record<Readiness, string> = {
  'planning-ready': 'Ready for admission',
  'dependency-blocked': 'Dependency-blocked',
  active: 'In agenda',
  completed: 'Completed',
};

export const READINESS_DESCRIPTIONS: Record<Readiness, string> = {
  'planning-ready': 'Proposed, with every required predecessor completed.',
  'dependency-blocked': 'Waiting on a required predecessor that is not completed.',
  active: 'Admitted into the agenda. Delegate it below, then merge or mark it complete.',
  completed: 'Done. Its dependents are no longer blocked by it.',
};

export const READINESS_ACCENTS: Record<Readiness, string> = {
  'planning-ready': 'var(--color-ready)',
  'dependency-blocked': 'var(--color-blocked)',
  active: 'var(--color-active)',
  completed: 'var(--color-done)',
};

export const STATUS_LABELS = {
  proposed: 'Proposed',
  admitted: 'In agenda',
  completed: 'Completed',
} as const;

export const RISK_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
  unspecified: 'Unspecified',
} as const;

export function readinessLabel(readiness: Readiness): string {
  return READINESS_LABELS[readiness];
}

/** Human summary of what is blocking an item, or why nothing is. */
export function blockerSummary(item: WorkItemSummary): string {
  if (item.status === 'completed') {
    return 'Completed.';
  }
  if (item.status === 'admitted') {
    return item.blockerSourceIds.length === 0
      ? 'In agenda with no unfinished predecessors.'
      : `In agenda; still waiting on ${item.blockerSourceIds.join(', ')}.`;
  }
  return item.blockerSourceIds.length === 0
    ? 'No unfinished required predecessors.'
    : `Waiting on ${item.blockerSourceIds.join(', ')}.`;
}

export function formatBytes(byteLength: number): string {
  if (byteLength < 1024) {
    return `${byteLength} B`;
  }
  if (byteLength < 1024 * 1024) {
    return `${(byteLength / 1024).toFixed(1)} KiB`;
  }
  return `${(byteLength / (1024 * 1024)).toFixed(2)} MiB`;
}

export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

export const IMPORT_OUTCOME_LABELS = {
  succeeded: 'Imported a new plan version',
  duplicate: 'Identical to an existing plan version',
  'failed-validation': 'Import failed validation',
} as const;
