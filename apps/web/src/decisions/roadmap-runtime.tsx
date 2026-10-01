import { runtimeEvidenceViewSchema, type RuntimeEvidenceView } from '@craftingtable/contracts';
import type { Roadmap, WorkspaceId } from '@craftingtable/domain';
import type { ReactNode } from 'react';
import { request } from '../lib/api-client.js';
import { Link } from '../lib/navigation.js';
import { queryKeys } from '../lib/event-invalidations.js';
import { useQuery, useQueryStore } from '../lib/query-store.js';
import { loadRoadmaps } from '../lib/roadmap-api.js';

/**
 * The map revision and binding whose dependency environment a roadmap uses: a cross-project
 * roadmap's own, or the one map every slice of a single-project roadmap comes from (LIVE-18).
 */
export function runtimeScope(
  roadmap: Roadmap,
): { readonly definitionId: string; readonly bindingRevision: number } | undefined {
  const crossProject = roadmap.definition.crossProject;
  if (crossProject)
    return {
      definitionId: crossProject.definitionId,
      bindingRevision: crossProject.bindingRevision,
    };
  const scopes = new Map(
    roadmap.definition.entries.flatMap((e) =>
      e.executionScope
        ? [
            [
              `${e.executionScope.definitionId}:${e.executionScope.bindingRevision}`,
              e.executionScope,
            ],
          ]
        : [],
    ),
  );
  const [scope] = scopes.values();
  return scopes.size === 1 && scope
    ? { definitionId: scope.definitionId, bindingRevision: scope.bindingRevision }
    : undefined;
}

/** The API base of a map's dependency environment and its decisions. */
export const runtimeBase = (workspaceId: WorkspaceId, definitionId: string) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/concurrency-definitions/${encodeURIComponent(definitionId)}/runtime`;

/** A roadmap by id, from the workspace's roadmaps, which the store re-reads on their events. */
function useRoadmap(workspaceId: WorkspaceId, roadmapId: string) {
  const query = useQuery(queryKeys.roadmaps(workspaceId), () => loadRoadmaps(workspaceId));
  const roadmap: Roadmap | null | undefined =
    query.data === undefined
      ? undefined
      : (query.data.roadmaps.find((r) => r.roadmap.id === roadmapId)?.roadmap ?? null);
  const error =
    query.error === undefined
      ? ''
      : query.error instanceof Error
        ? query.error.message
        : 'Could not load the roadmap.';
  return { roadmap, error };
}

/**
 * A setup-time decision's data, loaded by the decision itself (R-A6 increment 2b, operator
 * decision 2026-10-01): the roadmap, its map's dependency environment view, and where a saved
 * decision's new view goes. The same kind renders in its setup step with the step's view.
 */
export function RoadmapRuntime({
  workspaceId,
  roadmapId,
  children,
}: {
  workspaceId: WorkspaceId;
  roadmapId: string;
  children: (runtime: {
    readonly roadmap: Roadmap;
    readonly base: string;
    readonly view: RuntimeEvidenceView;
    readonly onSaved: (view: RuntimeEvidenceView) => void;
  }) => ReactNode;
}) {
  const { roadmap, error: roadmapError } = useRoadmap(workspaceId, roadmapId);
  const scope = roadmap ? runtimeScope(roadmap) : undefined;
  const base = scope ? runtimeBase(workspaceId, scope.definitionId) : undefined;
  // The map's environment, shared with its setup step and re-read on its events (R-D4).
  const store = useQueryStore();
  const key = scope ? queryKeys.runtime(workspaceId, scope.definitionId) : undefined;
  const runtime = useQuery(key, () => request(base!, runtimeEvidenceViewSchema));
  const view = runtime.data;
  const error =
    runtime.error === undefined
      ? ''
      : runtime.error instanceof Error
        ? runtime.error.message
        : 'Could not load the dependency environment.';
  const setView = (next: RuntimeEvidenceView) => {
    if (key) store.set(key, next);
  };
  const failed = roadmapError || error;
  if (roadmap === null) return <p className="empty-state">This roadmap no longer exists.</p>;
  // The roadmap's setup is always linked: where the item cannot decide, the setup can.
  const setupLink = (
    <p className="hint">
      <Link route={{ name: 'roadmap', workspaceId, roadmapId, tab: 'setup' }}>
        Open the roadmap's setup
      </Link>{' '}
      to change its pins or environments by hand.
    </p>
  );
  return (
    <>
      {failed ? (
        <p role="alert" className="error-state">
          {failed}
        </p>
      ) : roadmap && !scope ? (
        <p className="empty-state">
          This roadmap has no single map, so it has no dependency environment to decide here.
        </p>
      ) : !roadmap || !base || !view ? (
        <p role="status">Loading dependency environment…</p>
      ) : (
        children({ roadmap, base, view, onSaved: setView })
      )}
      {setupLink}
    </>
  );
}

/** A roadmap's map amendments, loaded by id (R-A6 increment 2b). */
export function RoadmapAmendments({
  workspaceId,
  roadmapId,
  children,
}: {
  workspaceId: WorkspaceId;
  roadmapId: string;
  children: (roadmap: Roadmap) => ReactNode;
}) {
  const { roadmap, error } = useRoadmap(workspaceId, roadmapId);
  if (error)
    return (
      <p role="alert" className="error-state">
        {error}
      </p>
    );
  if (roadmap === null) return <p className="empty-state">This roadmap no longer exists.</p>;
  if (!roadmap) return <p role="status">Loading the roadmap…</p>;
  if (!roadmap.definition.crossProject)
    return <p className="empty-state">Only a cross-project roadmap's map can be amended.</p>;
  return <>{children(roadmap)}</>;
}
