import { runtimeEvidenceViewSchema, type RuntimeEvidenceView } from '@craftingtable/contracts';
import type { Roadmap, WorkspaceId } from '@craftingtable/domain';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { request } from '../lib/api-client.js';
import { Link } from '../lib/navigation.js';
import { useRefreshOn } from '../lib/refresh-signals.js';
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

/** A roadmap by id, reloaded when roadmaps change. */
function useRoadmap(workspaceId: WorkspaceId, roadmapId: string) {
  const [roadmap, setRoadmap] = useState<Roadmap | null>();
  const [error, setError] = useState('');
  const load = useCallback(
    () =>
      loadRoadmaps(workspaceId).then(
        (result) => {
          setRoadmap(result.roadmaps.find((r) => r.roadmap.id === roadmapId)?.roadmap ?? null);
          setError('');
        },
        (e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the roadmap.'),
      ),
    [workspaceId, roadmapId],
  );
  useEffect(() => void load(), [load]);
  useRefreshOn('roadmaps', () => void load());
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
  const [view, setView] = useState<RuntimeEvidenceView>();
  const [error, setError] = useState('');
  const requested = useRef(base);
  requested.current = base;
  const load = useCallback(() => {
    if (!base) return;
    void request(base, runtimeEvidenceViewSchema).then(
      (next) => {
        if (requested.current !== base) return;
        setView(next);
        setError('');
      },
      (e: unknown) => {
        if (requested.current === base)
          setError(e instanceof Error ? e.message : 'Could not load the dependency environment.');
      },
    );
  }, [base]);
  useEffect(() => {
    setView(undefined);
    load();
  }, [load]);
  useRefreshOn('roadmaps', load);
  const failed = roadmapError || error;
  if (failed)
    return (
      <p role="alert" className="error-state">
        {failed}
      </p>
    );
  if (roadmap === null) return <p className="empty-state">This roadmap no longer exists.</p>;
  if (roadmap && !scope)
    return (
      <p className="empty-state">
        This roadmap has no single map, so it has no dependency environment to decide here.
      </p>
    );
  if (!roadmap || !base || !view) return <p role="status">Loading dependency environment…</p>;
  return (
    <>
      {children({ roadmap, base, view, onSaved: setView })}
      <p className="hint">
        <Link route={{ name: 'roadmap', workspaceId, roadmapId, tab: 'setup' }}>
          Open the roadmap's setup
        </Link>{' '}
        to change its pins or environments by hand.
      </p>
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
