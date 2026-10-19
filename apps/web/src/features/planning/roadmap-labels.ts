import type { Roadmap, RoadmapEntryProgress, RoadmapStatus } from '@craftingtable/domain';
import { roadmapStop } from '@craftingtable/domain';

/** A roadmap status as the roadmaps list and a roadmap's board name it. */
export const ROADMAP_STATUS_LABELS: Record<RoadmapStatus, string> = {
  draft: 'Draft',
  running: 'Scheduling enabled',
  paused: 'Paused',
  'needs-attention': 'Needs attention',
  stopped: 'Stopped',
  completed: 'Completed',
};
export function roadmapStatusLabel(roadmap: Roadmap, fallback: string) {
  return roadmapStop(roadmap)?.code === 'restart-resume'
    ? 'Resume required after restart'
    : fallback;
}

/** An entry's state as the status list and the board name it (R-E3a, R-E3b). */
export const ENTRY_STATE_LABELS: Readonly<Record<RoadmapEntryProgress['status'], string>> = {
  queued: 'Queued',
  'dependency-blocked': 'Waiting on prerequisites',
  'capacity-blocked': 'Waiting for capacity',
  'exclusion-blocked': 'Waiting for exclusion group',
  paused: 'Paused',
  running: 'Running',
  'awaiting-merge': 'Awaiting merge',
  'needs-attention': 'Needs attention',
  completed: 'Completed',
};
