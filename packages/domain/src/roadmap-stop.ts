import type { RoadmapAttention } from './attention.js';
import type { Roadmap, RoadmapEntryHold } from './roadmap.js';

/**
 * A roadmap's stop and an entry's hold, as stored (R-B4b increment 3). Every record is coded:
 * the writers declare a code with each stop, and migration 0047 coded the ones written before
 * codes, so nothing reads the reason. Records from before codes are decoded only where the
 * audit trail is read (`@craftingtable/domain/attention-legacy`).
 */
export function roadmapStop(
  roadmap: Pick<Roadmap, 'status' | 'attention'>,
): RoadmapAttention | undefined {
  return roadmap.status === 'needs-attention' ? roadmap.attention : undefined;
}

export function holdStop(hold: RoadmapEntryHold): RoadmapAttention | undefined {
  return hold.status === 'needs-attention' ? hold.attention : undefined;
}
