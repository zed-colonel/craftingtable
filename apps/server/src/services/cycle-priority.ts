import type { WorkCycle } from '@craftingtable/domain';
import type { OwnerPolicy } from './roadmap/owner-policy.js';

/** Reorder only a running roadmap's own cycles; unrelated/manual work keeps its place. */
export function prioritizeRoadmapCycles(
  cycles: readonly WorkCycle[],
  ownership: (cycle: WorkCycle) => OwnerPolicy | undefined,
): readonly WorkCycle[] {
  const owners = new Map<string, { roadmapId: string; priority: number }>();
  for (const cycle of cycles) {
    const owner = ownership(cycle);
    if (!owner?.running || !owner.parallel || owner.attemptStatus === 'completed') continue;
    const priority = owner.entryIndex;
    if (priority >= 0) owners.set(cycle.id, { roadmapId: owner.roadmapId, priority });
  }
  const queues = new Map<string, WorkCycle[]>();
  for (const cycle of cycles) {
    const owner = owners.get(cycle.id);
    if (!owner) continue;
    const queue = queues.get(owner.roadmapId) ?? [];
    queue.push(cycle);
    queues.set(owner.roadmapId, queue);
  }
  for (const queue of queues.values())
    queue.sort((a, b) => owners.get(a.id)!.priority - owners.get(b.id)!.priority);
  return cycles.map((cycle) => {
    const owner = owners.get(cycle.id);
    return owner ? queues.get(owner.roadmapId)!.shift()! : cycle;
  });
}
