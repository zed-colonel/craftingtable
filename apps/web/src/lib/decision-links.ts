import type { WorkCycle } from '@craftingtable/domain';
import type { Route } from './route.js';

/**
 * Where a cycle's shared architecture decisions are decided (R-E2): the setup page of the
 * roadmap that owns the cycle, else the page of the map its scope comes from.
 */
export function sharedDecisionsRoute(cycle: WorkCycle): Route {
  const workspaceId = cycle.workspaceId;
  const roadmapId = cycle.owner?.roadmapId;
  if (roadmapId !== undefined)
    return {
      name: 'roadmap',
      workspaceId,
      roadmapId,
      tab: 'setup',
      focus: `runtime-evidence-roadmap-${roadmapId}-decisions`,
    };
  const definitionId = cycle.executionScope?.definitionId;
  return definitionId === undefined
    ? { name: 'roadmaps', workspaceId }
    : {
        name: 'roadmap-map',
        workspaceId,
        definitionId,
        focus: `runtime-evidence-${definitionId}-decisions`,
      };
}
