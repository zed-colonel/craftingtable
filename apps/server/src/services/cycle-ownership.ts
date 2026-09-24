import type { CycleOwner, Roadmap, RoadmapAttempt, WorkCycle } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { snapshotCalculation } from './map-read-snapshot.js';

/** The roadmap attempt that owns a cycle. */
export interface CycleOwnership {
  readonly roadmap: Roadmap;
  readonly attempt: RoadmapAttempt;
}

/**
 * The one answer to "which roadmap owns this cycle" (R-B3, CTRL-07). The cycle records its
 * owner when a roadmap creates it, so this is one roadmap read by primary key; callers then
 * apply their own conditions (running, cross-project, held) to that single owner.
 *
 * A cycle cannot belong to two attempts: each attempt reserves a fresh cycle id, and
 * migration 0029 refused any database where one did. Records written without `owner`
 * (before schema 29, or built by hand in tests) are resolved from the attempts. That is
 * the only remaining search over roadmaps for a cycle. Inside a read snapshot the answer is
 * memoized, so one projection resolves each cycle once.
 */
export function cycleOwnership(
  tx: StorageRepositories,
  cycle: Pick<WorkCycle, 'id' | 'workspaceId' | 'owner'>,
): CycleOwnership | undefined {
  return snapshotCalculation(tx, `cycle-ownership:${cycle.id}`, () => {
    if (cycle.owner === null) return undefined;
    if (cycle.owner !== undefined) {
      const roadmap = tx.roadmaps.find(cycle.workspaceId, cycle.owner.roadmapId);
      const attempt = roadmap?.attempts.find((a) => a.id === cycle.owner?.attemptId);
      return roadmap && attempt ? { roadmap, attempt } : undefined;
    }
    for (const roadmap of tx.roadmaps.list(cycle.workspaceId)) {
      const attempt = roadmap.attempts.find((a) => a.cycleId === cycle.id);
      if (attempt) return { roadmap, attempt };
    }
    return undefined;
  });
}

/** What a cycle created for `attempt` records as its owner. */
export function ownerOf(roadmap: Roadmap, attempt: RoadmapAttempt): CycleOwner {
  return {
    roadmapId: roadmap.id,
    attemptId: attempt.id,
    entryId: attempt.entryId,
    definitionRevision: attempt.definitionRevision,
  };
}
