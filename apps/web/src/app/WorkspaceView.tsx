import { lazy, type ReactElement, Suspense, useCallback, useEffect, useMemo, useRef } from 'react';
import { NeedsYou } from '../components/NeedsYou.js';
import { ProjectCards } from '../features/planning/ProjectCards.js';
import type { Route } from '../lib/route.js';
import { seededWorkspaceId, type WorkspaceProjectionState } from '../lib/workspace-projection.js';
import { PageBoundary } from './PageBoundary.js';
import { DashboardRoute } from './pages/DashboardRoute.js';
import { useAttention, useCycles } from './reads.js';
import { useGo, useSession, useWorkspaceScope } from './session.js';

/*
 * Pages loaded with their routes (R-D5, PERF-20): the dashboard comes with the app; every other
 * page is its own chunk, fetched the first time its route opens.
 */
const ConcurrencyImports = lazy(() =>
  import('../features/planning/ConcurrencyImports.js').then((m) => ({
    default: m.ConcurrencyImports,
  })),
);
const RoadmapsPage = lazy(() =>
  import('../features/planning/RoadmapsPage.js').then((m) => ({ default: m.RoadmapsPage })),
);
const RoadmapPage = lazy(() =>
  import('../features/planning/RoadmapsPage.js').then((m) => ({ default: m.RoadmapPage })),
);
const ImportRoute = lazy(() =>
  import('./pages/ImportRoute.js').then((m) => ({ default: m.ImportRoute })),
);
const InboxRoute = lazy(() =>
  import('./pages/InboxRoute.js').then((m) => ({ default: m.InboxRoute })),
);
const AgendaRoute = lazy(() =>
  import('./pages/ListRoutes.js').then((m) => ({ default: m.AgendaRoute })),
);
const RunsRoute = lazy(() =>
  import('./pages/ListRoutes.js').then((m) => ({ default: m.RunsRoute })),
);
const ProjectRoute = lazy(() =>
  import('./pages/ProjectRoute.js').then((m) => ({ default: m.ProjectRoute })),
);
const PlanVersionRoute = lazy(() =>
  import('./pages/ProjectRoute.js').then((m) => ({ default: m.PlanVersionRoute })),
);
const RepositoriesRoute = lazy(() =>
  import('./pages/RepositoriesRoute.js').then((m) => ({ default: m.RepositoriesRoute })),
);
const RunRoute = lazy(() => import('./pages/RunRoute.js').then((m) => ({ default: m.RunRoute })));
const SettingsRoute = lazy(() =>
  import('./pages/SettingsRoute.js').then((m) => ({ default: m.SettingsRoute })),
);
const WorkItemRoute = lazy(() =>
  import('./pages/WorkItemRoute.js').then((m) => ({ default: m.WorkItemRoute })),
);

/**
 * One workspace's pages (R-D4 increment 4b). Each page reads its own data through the store;
 * this view gates them on the workspace's snapshot and shows what every page shares. It is keyed
 * by the workspace, so nothing a page holds survives a change of workspace.
 */
export function WorkspaceView({
  route,
  projection,
}: {
  route: Route;
  projection: WorkspaceProjectionState;
}): ReactElement {
  const { workspaceId, canMutate } = useWorkspaceScope();
  const { csrfToken } = useSession();
  const go = useGo();
  // Read once the snapshot has seeded the stream, never alongside it (TS-H4).
  const seeded = seededWorkspaceId(projection) === workspaceId ? workspaceId : undefined;
  const attentionQuery = useAttention(seeded);
  const cyclesQuery = useCycles(seeded);
  const attention = attentionQuery.data?.items ?? [];
  // The pages that share the workspace's open cycles read the stored records; the projections
  // they need come with each work item's own cycles (CTRL-22).
  const cycleViews = cyclesQuery.data?.cycles;
  const cycles = useMemo(() => (cycleViews ?? []).map((view) => view.cycle), [cycleViews]);
  // Every item this workspace has listed, by id: a page links the item it last read, which may
  // have resolved since; the inbox then offers the subject's current item (TS-M1).
  const subjects = useRef(new Map<string, string>());
  useEffect(() => {
    for (const item of attentionQuery.data?.items ?? [])
      subjects.current.set(item.id, item.subjectKey);
  }, [attentionQuery.data]);
  const subjectOf = useCallback((itemId: string) => subjects.current.get(itemId), []);
  if (projection.snapshotStatus === 'loading' || projection.snapshotStatus === 'idle')
    return <p className="empty-state">Loading durable workspace snapshot…</p>;
  if (projection.snapshotStatus === 'error')
    return (
      <p className="error-state" role="alert">
        The workspace snapshot could not be loaded.
      </p>
    );
  const shown = projection.workspace;
  // Never render one workspace's projection under another's identity, whatever order the
  // updates arrive in, and whether the change came from the picker or the URL (CT03-RR4,
  // CT03-R2R4, CT03-I14).
  if (shown === undefined || shown.id !== workspaceId)
    return <p className="empty-state">Loading durable workspace snapshot…</p>;
  const cyclesFailed = cyclesQuery.error !== undefined;
  return (
    <>
      {projection.refreshFailed && (
        <p className="warning-state" role="alert">
          The latest refresh failed. The last committed state remains visible.
        </p>
      )}
      {projection.connection === 'disconnected' && (
        <p className="warning-state" role="alert">
          The event stream is unreachable. Your last committed workspace state remains visible;
          reconnection continues automatically.
        </p>
      )}
      {cyclesFailed && (
        <p className="warning-state" role="alert">
          Cycle status could not be loaded. Refresh before controlling automation.
        </p>
      )}
      {attentionQuery.error !== undefined && (
        <p className="warning-state" role="alert">
          Needs you could not be loaded, so this list may be incomplete. Refresh to retry.
        </p>
      )}
      {route.name !== 'dashboard' && route.name !== 'inbox' && (
        <NeedsYou items={attention} workspaceId={workspaceId} variant="strip" onNavigate={go} />
      )}
      {route.name === 'dashboard' && (
        <DashboardRoute projection={projection} attention={attention} cycles={cycles} />
      )}
      <PageBoundary key={route.name}>
        <Suspense fallback={<p className="empty-state">Loading page…</p>}>
          {route.name === 'runs' && <RunsRoute />}
          {route.name === 'agenda' && <AgendaRoute filter={route.filter} />}
          {route.name === 'roadmaps' && (
            <RoadmapsPage
              workspaceId={workspaceId}
              csrfToken={csrfToken}
              canMutate={canMutate}
              attention={attention}
            />
          )}
          {route.name === 'roadmap' && (
            <RoadmapPage
              key={`${route.roadmapId}:${route.tab}`}
              workspaceId={workspaceId}
              roadmapId={route.roadmapId}
              tab={route.tab}
              csrfToken={csrfToken}
              canMutate={canMutate}
              onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
              attention={attention}
              onOpenAttention={(itemId) => go({ name: 'inbox', workspaceId, itemId })}
            />
          )}
          {route.name === 'roadmap-map' && (
            <ConcurrencyImports
              key={route.definitionId}
              workspaceId={workspaceId}
              csrfToken={csrfToken}
              canMutate={canMutate}
              definitionId={route.definitionId}
            />
          )}
          {route.name === 'inbox' && (
            <InboxRoute
              attention={attention}
              loaded={attentionQuery.data !== undefined}
              subjectOf={subjectOf}
              cycles={cycles}
              {...(route.itemId === undefined ? {} : { selectedId: route.itemId })}
            />
          )}
          {route.name === 'settings' && <SettingsRoute />}
          {route.name === 'projects' && (
            <div className="page">
              <header className="page-header">
                <h1>Projects</h1>
              </header>
              <ProjectCards
                projects={projection.projects}
                onOpen={(projectId) => go({ name: 'project', workspaceId, projectId })}
                onImport={() => go({ name: 'import', workspaceId })}
              />
            </div>
          )}
          {route.name === 'import' && <ImportRoute projects={projection.projects} />}
          {route.name === 'project' && <ProjectRoute projectId={route.projectId} />}
          {route.name === 'plan-version' && (
            <PlanVersionRoute
              projectId={route.projectId}
              planVersionId={route.planVersionId}
              attention={attention}
            />
          )}
          {route.name === 'work-item' && (
            <WorkItemRoute
              key={route.workItemId}
              workItemId={route.workItemId}
              attention={attention}
              cycles={cycles}
              workspaceCyclesFailed={cyclesFailed}
            />
          )}
          {route.name === 'repositories' && <RepositoriesRoute />}
          {route.name === 'run' && (
            <RunRoute key={route.runId} runId={route.runId} cycles={cycles} />
          )}
        </Suspense>
      </PageBoundary>
    </>
  );
}
