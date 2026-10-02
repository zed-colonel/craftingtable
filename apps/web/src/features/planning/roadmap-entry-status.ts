import type { RoadmapEntry, RoadmapEntryProgress } from '@craftingtable/domain';

/** A roadmap entry's state as its row names it. */
export function entryStatusLabel(
  entry: RoadmapEntry,
  state: RoadmapEntryProgress | undefined,
): string {
  switch (state?.status) {
    case 'awaiting-merge':
      return entry.executionScope && entry.executionScope.kind !== 'slice'
        ? 'Ready for scope acceptance'
        : 'Awaiting merge approval';
    case 'paused':
      return 'Item paused';
    case 'capacity-blocked':
      return 'Waiting for capacity';
    case 'exclusion-blocked':
      return 'Waiting for exclusion group';
    case 'dependency-blocked':
      return 'Waiting on prerequisites';
    case 'needs-attention':
      return 'Needs attention';
    case 'completed':
      return 'Completed';
    case 'running':
      return 'Running';
    default:
      return 'Queued';
  }
}
