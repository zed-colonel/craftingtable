import type { RoadmapView } from '@craftingtable/domain';
import { vi } from 'vitest';
import { ApiError } from '../../lib/api-client.js';

/** A roadmap page's region as the daemon answers it for one roadmap's view (R-D5). */
export function roadmapPageOf(view: RoadmapView) {
  const { definition, ...roadmap } = view.roadmap;
  return {
    view: { ...view, roadmap },
    definitionRevision: definition.revision,
    status: {
      roadmapId: roadmap.id,
      name: definition.name,
      status: roadmap.status,
      reason: roadmap.reason,
      completed: 0,
      entries: [],
    },
  };
}

/**
 * A roadmap API whose reads all answer from one mocked `loadRoadmaps` (R-D5): the list page's
 * light rows, a roadmap page's region and a definition by revision, as the daemon derives each
 * from its records. A test sets what `loadRoadmaps` resolves to; each read awaits it, so a read
 * left pending there stays pending in all of them.
 */
export function roadmapApiFromList() {
  const loadRoadmaps = vi.fn<(workspaceId: string) => Promise<{ roadmaps: RoadmapView[] }>>();
  const listed = async (workspaceId: string) => (await loadRoadmaps(workspaceId)).roadmaps;
  const find = async (workspaceId: string, id: string) => {
    const view = (await listed(workspaceId)).find((r) => r.roadmap.id === id);
    if (!view) throw new ApiError(404, 'not-found', 'Roadmap not found');
    return view;
  };
  return {
    loadRoadmaps,
    loadRoadmapSummaries: vi.fn(async (workspaceId: string) => ({
      roadmaps: (await listed(workspaceId)).map(({ roadmap, progress }) => ({
        id: roadmap.id,
        name: roadmap.definition.name,
        status: roadmap.status,
        reason: roadmap.reason,
        completed: progress.filter((p) => p.status === 'completed').length,
        entries: progress.length,
      })),
    })),
    loadRoadmapPage: vi.fn(async (workspaceId: string, id: string) =>
      roadmapPageOf(await find(workspaceId, id)),
    ),
    loadRoadmapDefinition: vi.fn(
      async (workspaceId: string, id: string) => (await find(workspaceId, id)).roadmap.definition,
    ),
  };
}
