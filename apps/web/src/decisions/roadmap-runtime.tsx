import { runtimeEvidenceViewSchema, type RuntimeEvidenceView } from '@craftingtable/contracts';
import type { Roadmap, WorkspaceId } from '@craftingtable/domain';
import { type ReactNode, useState } from 'react';
import { ActionBar } from '../components/ActionBar.js';
import { request } from '../lib/api-client.js';
import { Link } from '../lib/navigation.js';
import { queryKeys } from '../lib/event-invalidations.js';
import { useQuery, useQueryStore } from '../lib/query-store.js';
import { controlRoadmap, loadRoadmaps } from '../lib/roadmap-api.js';

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

/** A map's dependency environment view, shared with its setup step and re-read on its events. */
function useMapRuntime(workspaceId: WorkspaceId, definitionId: string | undefined) {
  const store = useQueryStore();
  const base = definitionId ? runtimeBase(workspaceId, definitionId) : undefined;
  const key = definitionId ? queryKeys.runtime(workspaceId, definitionId) : undefined;
  const runtime = useQuery(key, () => request(base!, runtimeEvidenceViewSchema));
  const error =
    runtime.error === undefined
      ? ''
      : runtime.error instanceof Error
        ? runtime.error.message
        : 'Could not load the dependency environment.';
  const setView = (next: RuntimeEvidenceView) => {
    if (key) store.set(key, next);
  };
  return { base, view: runtime.data, error, setView };
}

/**
 * A decision's map data when the item names a map but no roadmap (R-A6 rest): a shared-decision
 * stop of a cycle that no roadmap owns.
 */
export function MapRuntime({
  workspaceId,
  definitionId,
  children,
}: {
  workspaceId: WorkspaceId;
  definitionId: string;
  children: (runtime: {
    readonly definitionId: string;
    readonly base: string;
    readonly view: RuntimeEvidenceView;
    readonly onSaved: (view: RuntimeEvidenceView) => void;
  }) => ReactNode;
}) {
  const { base, view, error, setView } = useMapRuntime(workspaceId, definitionId);
  if (error)
    return (
      <p role="alert" className="error-state">
        {error}
      </p>
    );
  if (!base || !view) return <p role="status">Loading dependency environment…</p>;
  return <>{children({ definitionId, base, view, onSaved: setView })}</>;
}

/**
 * A setup-time decision's data, loaded by the decision itself (R-A6 increment 2b, operator
 * decision 2026-10-01): the roadmap, its map's dependency environment view, and where a saved
 * decision's new view goes. The same kind renders in its setup step with the step's view.
 */
export function RoadmapRuntime({
  workspaceId,
  roadmapId,
  setupFor = 'to change its pins or environments by hand.',
  children,
}: {
  workspaceId: WorkspaceId;
  roadmapId: string;
  /** What the link to the roadmap's setup is for. */
  setupFor?: string;
  children: (runtime: {
    readonly roadmap: Roadmap;
    readonly definitionId: string;
    readonly base: string;
    readonly view: RuntimeEvidenceView;
    readonly onSaved: (view: RuntimeEvidenceView) => void;
  }) => ReactNode;
}) {
  const { roadmap, error: roadmapError } = useRoadmap(workspaceId, roadmapId);
  const scope = roadmap ? runtimeScope(roadmap) : undefined;
  const { base, view, error, setView } = useMapRuntime(workspaceId, scope?.definitionId);
  const failed = roadmapError || error;
  if (roadmap === null) return <p className="empty-state">This roadmap no longer exists.</p>;
  // The roadmap's setup is always linked: where the item cannot decide, the setup can.
  const setupLink = (
    <p className="hint">
      <Link route={{ name: 'roadmap', workspaceId, roadmapId, tab: 'setup' }}>
        Open the roadmap's setup
      </Link>{' '}
      {setupFor}
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
      ) : !roadmap || !scope || !base || !view ? (
        <p role="status">Loading dependency environment…</p>
      ) : (
        children({ roadmap, definitionId: scope.definitionId, base, view, onSaved: setView })
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

/**
 * The roadmap's own Pause, beside a decision its running scheduling holds (operator decision
 * 2026-10-09, after R-A6's review M1): approving a shared decision needs scheduling paused.
 * Shown from the roadmap's typed status, never from the decision's blocker text. A manual
 * control: pausing approves nothing, and Resume stays the operator's.
 */
export function PauseForDecision({
  workspaceId,
  roadmapId,
  csrfToken,
  canMutate,
}: {
  workspaceId: WorkspaceId;
  roadmapId: string;
  csrfToken: string;
  canMutate: boolean;
}) {
  const { roadmap } = useRoadmap(workspaceId, roadmapId);
  const store = useQueryStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const running = roadmap?.status === 'running' ? roadmap : undefined;
  if (!running) return null;
  const pause = async () => {
    setBusy(true);
    setError('');
    try {
      await controlRoadmap(running, 'pause', csrfToken);
      store.refreshNow([queryKeys.roadmaps(workspaceId), queryKeys.attention(workspaceId)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not pause the roadmap.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <ActionBar label="Pause for this decision">
      <button
        type="button"
        className="secondary-button"
        disabled={!canMutate || busy}
        onClick={() => void pause()}
      >
        Pause roadmap
      </button>
      <span className="hint">
        Approval waits while {running.definition.name} runs. Running steps finish; Resume stays
        yours.
      </span>
      {error && (
        <span role="alert" className="error-state">
          {error}
        </span>
      )}
    </ActionBar>
  );
}
