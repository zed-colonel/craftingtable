import type { Roadmap, RoadmapStatus } from '@craftingtable/domain';
import { effectiveRoadmapAttention } from '@craftingtable/domain';

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
  return effectiveRoadmapAttention(roadmap)?.code === 'restart-resume'
    ? 'Resume required after restart'
    : fallback;
}
