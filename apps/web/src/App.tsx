import type {
  AuthenticatedSessionResponse,
  WorkspaceEventEnvelope,
} from '@craftingtable/contracts';
import type { WorkspaceId, WorktreeId } from '@craftingtable/domain';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccountRoute, HomeRoute } from './app/pages/AccountRoutes.js';
import { useAttention, useWorkspaces } from './app/reads.js';
import {
  CycleFocusProvider,
  SessionProvider,
  type WorkspaceScope,
  WorkspaceProvider,
} from './app/session.js';
import { useWorkspaceProjection } from './app/workspace-projection.js';
import { WorkspaceView } from './app/WorkspaceView.js';
import { LoginPage } from './components/LoginPage.js';
import { WorkspaceShell } from './components/WorkspaceShell.js';
import { loadSession, login, logout } from './lib/api-client.js';
import { type AuthenticationStatus, authenticationMessage } from './lib/auth-state.js';
import {
  GIT_DERIVED_FAMILIES,
  invalidationsFor,
  workspaceScoped,
} from './lib/event-invalidations.js';
import { NavigationProvider, useRevealRouteFocus } from './lib/navigation.js';
import { createQueryStore, QueryStoreProvider, useQueryStore } from './lib/query-store.js';
import { documentHidden } from './lib/refresh-scheduler.js';
import { routeWorkspaceId } from './lib/route.js';
import {
  currentTheme,
  persistTheme,
  rememberedWorkspace,
  rememberWorkspace,
  type Theme,
} from './lib/theme.js';
import { useRoute } from './lib/use-route.js';
import { useWorkspaceEventStream } from './lib/use-workspace-event-stream.js';
import { seededWorkspaceId } from './lib/workspace-projection.js';

/**
 * Background refresh pacing (PERF-02). A transition's events arrive 0.3-6 s apart; a key is read
 * again after 400 ms without events, or 2 s after the first one at the latest.
 */
const REFRESH_DEBOUNCE_MS = 400;
const REFRESH_MAX_WAIT_MS = 2_000;
/**
 * Queries otherwise re-read only on the events that change them; Git-derived ones are also
 * re-read each minute while the tab is visible, for a branch that moved outside the daemon,
 * which no event reports (R-D4, operator decision 2026-10-01).
 */
const GIT_REFRESH_MS = 60_000;

/** The app's query store, which every read below it goes through (R-D4). */
export function App() {
  const [queries] = useState(() =>
    createQueryStore({
      debounceMs: REFRESH_DEBOUNCE_MS,
      maxWaitMs: REFRESH_MAX_WAIT_MS,
      hidden: documentHidden,
    }),
  );
  return (
    <QueryStoreProvider value={queries}>
      <AppShell />
    </QueryStoreProvider>
  );
}

/**
 * The app shell (R-D4 increment 4b): sign-in, the workspace list and selection, the event
 * stream into the event table, and route dispatch. Each page reads its own data.
 */
function AppShell() {
  const queries = useQueryStore();
  const [status, setStatus] = useState<AuthenticationStatus>('checking');
  const [session, setSession] = useState<AuthenticatedSessionResponse>();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<WorkspaceId>();
  const [cycleWorktreeId, focusCycle] = useState<WorktreeId>();
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const { route, navigate } = useRoute();
  const authenticated = status === 'authenticated' && session !== undefined;
  const workspacesQuery = useWorkspaces(authenticated);
  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const workspacesLoaded = workspacesQuery.data !== undefined;
  /**
   * The workspace this render is about: the route's, when it names one the user belongs to, so
   * a deep link or popstate changes identity in the same render rather than one render later
   * through an effect (CT03-R2R4); otherwise the picker's selection.
   */
  const routed = routeWorkspaceId(route);
  const activeWorkspaceId =
    routed !== undefined && workspaces.some((workspace) => workspace.id === routed)
      ? routed
      : selectedWorkspaceId;
  const expire = useCallback(() => {
    setSession(undefined);
    setStatus('expired');
  }, []);
  const { projection, dispatch, streamAfter, reset } = useWorkspaceProjection(
    authenticated ? activeWorkspaceId : undefined,
    expire,
  );
  // The rail's count, read once the snapshot has seeded the stream, never alongside it (TS-H4).
  const seeded = seededWorkspaceId(projection);
  const attention = useAttention(
    authenticated && seeded === activeWorkspaceId ? seeded : undefined,
  ).data;

  // Signed out, or the session expired: nothing read for that session is shown again.
  useEffect(() => {
    if (status !== 'authenticated') queries.clear();
  }, [status, queries]);
  /**
   * Switches workspace in one transition: the projection is cleared with the selection, and
   * nothing read for another workspace is kept (CT03-RR4).
   */
  const selected = useRef(selectedWorkspaceId);
  selected.current = selectedWorkspaceId;
  const selectWorkspace = useCallback(
    (next: WorkspaceId) => {
      // The workspace already shown keeps its projection: its snapshot is not read again, so a
      // reset would wait on it forever (4b review).
      if (next === selected.current) return;
      setSelectedWorkspaceId(next);
      reset();
      queries.clear((key) => !workspaceScoped(key) || key[1] === next);
      rememberWorkspace(next);
    },
    [queries, reset],
  );
  useEffect(() => {
    void loadSession()
      .then((current) => {
        setSession(current);
        setStatus(current === undefined ? 'unauthenticated' : 'authenticated');
      })
      .catch(() => setStatus('error'));
  }, []);
  // The first selection: the remembered workspace, else the first.
  useEffect(() => {
    if (!workspacesLoaded || workspaces.some((w) => w.id === selectedWorkspaceId)) return;
    const remembered = rememberedWorkspace();
    setSelectedWorkspaceId((workspaces.find((w) => w.id === remembered) ?? workspaces[0])?.id);
  }, [workspacesLoaded, workspaces, selectedWorkspaceId]);
  // `/` is a bookmark, not a page: it resolves to the last used workspace.
  useEffect(() => {
    if (route.name !== 'root' || !authenticated || !workspacesLoaded) return;
    const target = workspaces.find((w) => w.id === selectedWorkspaceId) ?? workspaces[0];
    navigate(
      target === undefined ? { name: 'home' } : { name: 'dashboard', workspaceId: target.id },
      { replace: true },
    );
  }, [route.name, authenticated, workspacesLoaded, workspaces, selectedWorkspaceId, navigate]);
  // A deep link to another workspace is a workspace switch too.
  useEffect(() => {
    if (
      routed !== undefined &&
      routed !== selectedWorkspaceId &&
      workspaces.some((w) => w.id === routed)
    )
      selectWorkspace(routed);
  }, [routed, workspaces, selectedWorkspaceId, selectWorkspace]);
  // Hidden tabs read nothing; becoming visible catches up once (PERF-17). A visible tab re-reads
  // only its Git-derived queries each minute (R-D4).
  useEffect(() => {
    const gitRefresh = (): void => {
      if (!documentHidden()) queries.invalidate(GIT_DERIVED_FAMILIES);
    };
    const visibilityChanged = (): void => {
      queries.visibilityChanged();
      gitRefresh();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    const timer = setInterval(gitRefresh, GIT_REFRESH_MS);
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      clearInterval(timer);
    };
  }, [queries]);
  /** Events only say what to read again; they never become the model (CT03-A66). */
  const onEvent = useCallback(
    (event: WorkspaceEventEnvelope) => {
      dispatch({ type: 'event-received', event });
      queries.invalidate(invalidationsFor(event));
    },
    [dispatch, queries],
  );
  const onInvalidEvent = useCallback(() => {
    dispatch({ type: 'event-invalid' });
    // An event that could not be read may have changed anything: every query is stale.
    queries.invalidate([[]]);
  }, [dispatch, queries]);
  const onOpen = useCallback(() => dispatch({ type: 'stream-opened' }), [dispatch]);
  const onError = useCallback(
    (sourceClosed: boolean) => {
      dispatch({ type: 'stream-error', sourceClosed });
      void loadSession()
        .then((current) => {
          if (current === undefined) expire();
        })
        .catch(() => undefined);
    },
    [dispatch, expire],
  );
  useWorkspaceEventStream(
    projection.snapshotStatus === 'ready' ? selectedWorkspaceId : undefined,
    streamAfter,
    { onOpen, onError, onEvent, onInvalidEvent, onAuthenticationExpired: expire },
  );
  useRevealRouteFocus(route);
  const sessionValue = useMemo(
    () => session && { user: session.user, csrfToken: session.csrfToken, expire },
    [session, expire],
  );
  const focus = useMemo(
    () => ({ worktreeId: cycleWorktreeId, focus: focusCycle }),
    [cycleWorktreeId],
  );

  if (status === 'checking')
    return (
      <main className="center-state" aria-live="polite">
        Checking session…
      </main>
    );
  if (!authenticated || sessionValue === undefined)
    return (
      <LoginPage
        message={authenticationMessage(status)}
        onLogin={async (username, password) => {
          setSession(await login({ username, password }));
          setStatus('authenticated');
        }}
      />
    );
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  const scope: WorkspaceScope | undefined = activeWorkspace && {
    workspaceId: activeWorkspace.id,
    workspace: activeWorkspace,
    canMutate: activeWorkspace.role !== 'viewer',
    isOwner: activeWorkspace.role === 'owner',
  };
  const open = (id: WorkspaceId): void => {
    selectWorkspace(id);
    navigate({ name: 'dashboard', workspaceId: id });
  };
  return (
    <SessionProvider value={sessionValue}>
      <CycleFocusProvider value={focus}>
        <NavigationProvider value={{ route, navigate }}>
          <WorkspaceShell
            username={session.user.username}
            workspaces={workspaces}
            {...(activeWorkspaceId === undefined ? {} : { selectedWorkspaceId: activeWorkspaceId })}
            attentionCount={attention?.items.length ?? 0}
            connection={projection.connection}
            route={route}
            theme={theme}
            onSelectWorkspace={open}
            onToggleTheme={() => {
              const next: Theme = theme === 'dark' ? 'light' : 'dark';
              persistTheme(next);
              setTheme(next);
            }}
            onLogout={() =>
              void logout(session.csrfToken).finally(() => {
                setSession(undefined);
                setSelectedWorkspaceId(undefined);
                reset();
                setStatus('unauthenticated');
              })
            }
          >
            {route.name === 'home' && <HomeRoute workspaces={workspaces} onOpen={open} />}
            {route.name === 'account' && <AccountRoute />}
            {route.name === 'root' && <p className="empty-state">Opening your workspace…</p>}
            {routed !== undefined &&
              (workspaces.length === 0 ? (
                <p className="empty-state">This user has no authorized workspaces.</p>
              ) : scope === undefined ? (
                <p className="empty-state">Loading durable workspace snapshot…</p>
              ) : (
                <WorkspaceProvider value={scope}>
                  <WorkspaceView key={scope.workspaceId} route={route} projection={projection} />
                </WorkspaceProvider>
              ))}
          </WorkspaceShell>
        </NavigationProvider>
      </CycleFocusProvider>
    </SessionProvider>
  );
}
