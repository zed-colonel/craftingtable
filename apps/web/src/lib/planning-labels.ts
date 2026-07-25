import type { WorkItemSummary } from '@craftingtable/contracts';

/**
 * Honest planning vocabulary.
 *
 * CT-03 owns planning readiness only. A bare "Ready" is indistinguishable from
 * executable readiness and merge readiness, neither of which this system can
 * determine, so those words never appear (CT-03 §5.11, ADR-015).
 */

export type Readiness = WorkItemSummary['readiness'];

export const READINESS_LABELS: Record<Readiness, string> = {
  'planning-ready': 'Ready for admission',
  'dependency-blocked': 'Dependency-blocked',
  active: 'Admitted',
};

export const READINESS_DESCRIPTIONS: Record<Readiness, string> = {
  'planning-ready': 'Proposed, with every required predecessor satisfied.',
  'dependency-blocked': 'Waiting on a required predecessor that is not finished.',
  active: 'Accepted into the agenda. Admission is not execution readiness.',
};

export const READINESS_ACCENTS: Record<Readiness, string> = {
  'planning-ready': 'var(--color-ready)',
  'dependency-blocked': 'var(--color-blocked)',
  active: 'var(--color-active)',
};

export const STATUS_LABELS = {
  proposed: 'Proposed',
  admitted: 'Admitted',
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
  if (item.status === 'admitted') {
    return item.blockerSourceIds.length === 0
      ? 'Admitted with no unfinished predecessors.'
      : `Admitted; still waiting on ${item.blockerSourceIds.join(', ')}.`;
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
