import type { Roadmap, WorkCycle } from '@craftingtable/domain';

/** Reorder only a running roadmap's own cycles; unrelated/manual work keeps its place. */
export function prioritizeRoadmapCycles(
  cycles: readonly WorkCycle[],
  roadmaps: readonly Roadmap[],
): readonly WorkCycle[] {
  const owners = new Map<string, { roadmapId: string; priority: number }>();
  for (const roadmap of roadmaps) {
    if (roadmap.status !== 'running' || roadmap.definition.scheduling?.mode !== 'parallel')
      continue;
    const priorities = new Map(roadmap.definition.entries.map((e, i) => [e.id, i]));
    for (const attempt of roadmap.attempts) {
      const priority = priorities.get(attempt.entryId);
      if (priority !== undefined && attempt.status !== 'completed')
        owners.set(attempt.cycleId, { roadmapId: roadmap.id, priority });
    }
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
