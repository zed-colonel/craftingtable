import type {
  AgentRunDetailResponse,
  AttentionItemView,
  AuditRecordSummary,
  AuthenticatedSessionResponse,
  ExecutionStatusResponse,
  PlanImportResponse,
  PlanVersionDetailResponse,
  ProjectDetailResponse,
  RunEventEnvelope,
  RunProfilesResponse,
  SessionSummary,
  SourceRepositorySummary,
  WorkItemDetailResponse,
  WorkItemExecutionResponse,
  WorkspaceEventEnvelope,
  WorkspaceOverview,
  WorkspaceRunsResponse,
  WorkspaceWorkItemListResponse,
  WorktreeDiffResponse,
} from '@craftingtable/contracts';
import type {
  AgentRunId,
  PlanArtifactId,
  PlanVersionId,
  SessionId,
  SourceRepositoryId,
  WorkCycle,
  WorkItemId,
  WorkspaceAgentProfile,
  WorkspaceId,
  WorktreeId,
} from '@craftingtable/domain';
import {
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
  Fragment,
} from 'react';
import { ActivityPanel } from './components/ActivityPanel.js';
import { NeedsYou } from './components/NeedsYou.js';
import { InboxPage } from './features/inbox/InboxPage.js';
import { AcknowledgeMoves } from './features/inbox/AcknowledgeMoves.js';
import { loadAttention } from './lib/attention-api.js';
import { CheckAdoption } from './decisions/checks/CheckAdoption.js';
import { CycleDecision } from './decisions/cycle/CycleDecision.js';
import { CheckpointPreparation } from './decisions/checkpoint/CheckpointPreparation.js';
import { MergeApproval, RetryMergeCleanup } from './decisions/merge/MergeApproval.js';
import { type Decision, decisionsFor, type RoadmapItemPart } from './decisions/registry.js';
import { AuditPanel } from './components/AuditPanel.js';
import { LoginPage } from './components/LoginPage.js';
import { PageHeader } from './components/PageHeader.js';
import { Section } from './components/Section.js';
import { StatusCards } from './components/StatusCards.js';
import { WorkspaceShell } from './components/WorkspaceShell.js';
import { AccountPage } from './features/account/AccountPage.js';
import { CyclePanel } from './features/execution/CyclePanel.js';
import { DelegationPanel, type LaunchInput } from './features/execution/DelegationPanel.js';
import { DiffView } from './features/execution/DiffView.js';
import { ExecutionScopesPanel } from './features/execution/ExecutionScopesPanel.js';
import { FinalizationPanel } from './features/execution/FinalizationPanel.js';
import { PlanBranchPanel } from './features/execution/PlanBranchPanel.js';
import { ProviderRetry } from './decisions/cycle/CycleDecisions.js';
import { RepositoriesPage } from './features/execution/RepositoriesPage.js';
import { RunPage } from './features/execution/RunPage.js';
import { RunList, RunsPage } from './features/execution/RunsPage.js';
import { WorktreeBranchPanel } from './features/execution/WorktreeBranchPanel.js';
import {
  type WorktreeChangesRefused,
  worktreeChangesRefused,
} from './features/execution/WorktreeChangesRefusal.js';
import { WorkspacesPage } from './features/home/WorkspacesPage.js';
import { AgendaPage } from './features/planning/AgendaPage.js';
import { ImportPlanPage } from './features/planning/ImportPlanPage.js';
import { PlanVersionPage } from './features/planning/PlanVersionPage.js';
import { ProjectCards } from './features/planning/ProjectCards.js';
import { ProjectPage } from './features/planning/ProjectPage.js';
import { ConcurrencyImports } from './features/planning/ConcurrencyImports.js';
import { RoadmapPage, RoadmapsPage } from './features/planning/RoadmapsPage.js';
import { SourceText } from './features/planning/SourceText.js';
import { WorkItemPage } from './features/planning/WorkItemPage.js';
import { HostSchedulingPanel } from './features/workspace/HostSchedulingPanel.js';
import { OperatorWaitSection } from './features/workspace/OperatorWaitSection.js';
import { NotificationPanel } from './features/workspace/NotificationPanel.js';
import { RoadmapAgentProfilesPanel } from './features/workspace/RoadmapAgentProfilesPanel.js';
import { SettingsPage } from './features/workspace/SettingsPage.js';
import { StoragePanel } from './features/workspace/StoragePanel.js';
import {
  ApiError,
  changePassword,
  createWorkspace,
  loadSession,
  loadSessions,
  loadWorkspaceAudit,
  loadWorkspaceSnapshot,
  loadWorkspaces,
  login,
  logout,
  renameWorkspace,
  revokeSession,
} from './lib/api-client.js';
import { type AuthenticationStatus, authenticationMessage } from './lib/auth-state.js';
import {
  cancelRun,
  createWorktree,
  endRun,
  loadExecutionStatus,
  loadRepositories,
  loadRun,
  loadRunEvents,
  loadRunProfiles,
  loadWorkItemExecution,
  loadWorkspaceRuns,
  loadWorktreeDiff,
  registerRepository,
  removeWorktree,
  retireRepository,
  saveRunProfiles,
  sendRunMessage,
  startRun,
} from './lib/execution-api.js';
import { isLiveStatus, MERGE_GATE_LABELS } from './lib/execution-labels.js';
import {
  admitWorkItem,
  completeWorkItem,
  importPlanBundle,
  loadArtifactText,
  loadPlanVersion,
  loadProject,
  loadWorkItem,
  loadWorkspaceWorkItems,
  type PlanImportUpload,
  removeFromAgenda,
} from './lib/planning-api.js';
import {
  ALL_REFRESH_TOPICS,
  createRefreshScheduler,
  type RefreshTopic,
} from './lib/refresh-scheduler.js';
import {
  createRefreshSignals,
  documentHidden,
  RefreshSignalsProvider,
} from './lib/refresh-signals.js';
import { type Route, routeWorkspaceId } from './lib/route.js';
import {
  currentTheme,
  persistTheme,
  rememberedWorkspace,
  rememberWorkspace,
  type Theme,
} from './lib/theme.js';
import { Link, NavigationProvider, useRevealRouteFocus } from './lib/navigation.js';
import { useRoute } from './lib/use-route.js';
import { useRunEventStream } from './lib/use-run-event-stream.js';
import { useWorkspaceEventStream } from './lib/use-workspace-event-stream.js';
import { loadWorkCycles, startWorkCycle } from './lib/work-cycle-api.js';
import {
  type ConnectionState,
  INITIAL_WORKSPACE_PROJECTION,
  reduceWorkspaceProjection,
} from './lib/workspace-projection.js';

/** Pages the initial run-event load walks before handing over to the stream. */
const RUN_EVENT_PAGE_LIMIT = 20;

/**
 * Background refresh pacing (PERF-02). A transition's events arrive 0.3-6 s
 * apart; a round starts after 400 ms without events, or 2 s after the first
 * one at the latest.
 */
const REFRESH_DEBOUNCE_MS = 400;
const REFRESH_MAX_WAIT_MS = 2_000;
/**
 * Self-loading panels otherwise refresh only on events; this catches state no
 * event announces (Git- and clock-derived), and only while the tab is visible.
 */
const SAFETY_REFRESH_MS = 60_000;
const SAFETY_CHECK_MS = 15_000;

export function App() {
  const [authenticationStatus, setAuthenticationStatus] =
    useState<AuthenticationStatus>('checking');
  const [authenticated, setAuthenticated] = useState<AuthenticatedSessionResponse>();
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceOverview[]>([]);
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<WorkspaceId>();
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [audit, setAudit] = useState<readonly AuditRecordSummary[]>([]);
  const [streamAfter, setStreamAfter] = useState(0);
  const [theme, setTheme] = useState<Theme>(() => currentTheme());
  const [now, setNow] = useState(() => Date.now());
  const [projection, dispatch] = useReducer(
    reduceWorkspaceProjection,
    INITIAL_WORKSPACE_PROJECTION,
  );
  const { route, navigate } = useRoute();

  /**
   * The workspace this render is about.
   *
   * Derived from the route when it names a workspace the user belongs to, so a
   * deep link or popstate changes identity in the *same* render rather than one
   * render later through an effect (CT03-R2R4). Falls back to the picker
   * selection, and ignores a route naming a workspace the user cannot see.
   */
  const routedWorkspaceId = routeWorkspaceId(route);
  const activeWorkspaceId =
    routedWorkspaceId !== undefined &&
    workspaces.some((workspace) => workspace.id === routedWorkspaceId)
      ? routedWorkspaceId
      : selectedWorkspaceId;

  /**
   * A mirror of the active workspace that asynchronous callbacks can read.
   *
   * Every request captures the workspace it was made for and compares against
   * this before writing state or navigating, so a deferred artifact, import
   * outcome, or admission from the previous workspace is discarded rather than
   * surfacing in the new one (CT03-R2R3). Assigned during render so it is
   * current even for a route-driven change, which no effect has reacted to yet.
   */
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  activeWorkspaceIdRef.current = activeWorkspaceId;

  const [project, setProject] = useState<ProjectDetailResponse>();
  const [planVersion, setPlanVersion] = useState<PlanVersionDetailResponse>();
  const [workItem, setWorkItem] = useState<WorkItemDetailResponse>();
  const [artifact, setArtifact] = useState<{ filename: string; text: string }>();
  const [importResult, setImportResult] = useState<PlanImportResponse>();
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string>();
  const [itemBusy, setItemBusy] = useState(false);
  const [itemError, setItemError] = useState<string>();
  /**
   * One refresh round re-runs every App-level load keyed on this token. The
   * round is in flight until those loads settle (`roundDone`), and the
   * scheduler keeps at most one round in flight.
   */
  const [refreshToken, setRefreshToken] = useState(0);
  const roundLoads = useRef<Promise<unknown>[]>([]);
  const roundDone = useRef<(() => void) | undefined>(undefined);
  /** Registers an App-level load with the round that is being opened, if any. */
  const trackLoad = useCallback((load: Promise<unknown>): void => {
    if (roundDone.current !== undefined) roundLoads.current.push(load);
  }, []);
  const [signals] = useState(createRefreshSignals);
  const lastSignalled = useRef<Record<RefreshTopic, number>>({
    workspace: Date.now(),
    roadmaps: Date.now(),
    notifications: Date.now(),
  });
  const signalPanels = useCallback(
    (topics: Iterable<RefreshTopic>): void => {
      const list = [...topics];
      for (const topic of list) lastSignalled.current[topic] = Date.now();
      signals.emit(list);
    },
    [signals],
  );
  const [scheduler] = useState(() =>
    createRefreshScheduler({
      debounceMs: REFRESH_DEBOUNCE_MS,
      maxWaitMs: REFRESH_MAX_WAIT_MS,
      hidden: documentHidden,
      run: (topics) =>
        new Promise<void>((resolve) => {
          signalPanels(topics);
          if (!topics.has('workspace')) {
            resolve();
            return;
          }
          roundDone.current?.();
          roundDone.current = resolve;
          setRefreshToken((value) => value + 1);
        }),
    }),
  );
  /** After the operator's own command: refresh now rather than after the debounce. */
  const refreshNow = useCallback(() => scheduler.refreshNow(), [scheduler]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: discard pending refreshes on workspace changes.
  useEffect(() => () => scheduler.reset(), [activeWorkspaceId, scheduler]);
  // Hidden tabs read nothing; becoming visible catches up once (PERF-17).
  useEffect(() => {
    const safetyRefresh = (): void => {
      if (documentHidden()) return;
      const now = Date.now();
      const due = ALL_REFRESH_TOPICS.filter(
        (topic) => now - lastSignalled.current[topic] >= SAFETY_REFRESH_MS,
      );
      if (due.length > 0) signalPanels(due);
    };
    const visibilityChanged = (): void => {
      scheduler.visibilityChanged();
      safetyRefresh();
    };
    document.addEventListener('visibilitychange', visibilityChanged);
    const timer = setInterval(safetyRefresh, SAFETY_CHECK_MS);
    return () => {
      document.removeEventListener('visibilitychange', visibilityChanged);
      clearInterval(timer);
    };
  }, [scheduler, signalPanels]);
  const [cycleState, setCycleState] = useState<{
    workspaceId: WorkspaceId;
    cycles: readonly WorkCycle[];
  }>();
  const [cycleLoadError, setCycleLoadError] = useState<WorkspaceId>();
  /** The daemon's open attention items: the one list of what needs the operator (R-A5). */
  const [attentionState, setAttentionState] = useState<{
    workspaceId: WorkspaceId;
    items: readonly AttentionItemView[];
  }>();
  /** The work-item page's own cycles, history and design recovery included. */
  const [itemCycleState, setItemCycleState] = useState<{
    workspaceId: WorkspaceId;
    workItemId: WorkItemId;
    cycles: readonly WorkCycle[];
  }>();
  const [itemCycleLoadError, setItemCycleLoadError] = useState<WorkItemId>();

  // Delegation state: repositories, the active work item's worktrees and runs,
  // one run being followed live, and one diff being inspected.
  const [repositories, setRepositories] = useState<readonly SourceRepositorySummary[]>([]);
  const [executionStatus, setExecutionStatus] = useState<ExecutionStatusResponse>();
  const [runProfiles, setRunProfiles] = useState<RunProfilesResponse>();
  const [profilesBusy, setProfilesBusy] = useState(false);
  const [profilesError, setProfilesError] = useState<string>();
  const [profilesNotice, setProfilesNotice] = useState<string>();
  const [selectedCycleWorktreeId, setSelectedCycleWorktreeId] = useState<WorktreeId>();
  const [workItemExecution, setWorkItemExecution] = useState<WorkItemExecutionResponse>();
  /** The dashboard reads only live runs; the runs page reads the recent list. */
  const [runsState, setRunsState] = useState<{
    scope: 'live' | 'recent';
    response: WorkspaceRunsResponse;
  }>();
  const [agenda, setAgenda] = useState<WorkspaceWorkItemListResponse>();
  const [run, setRun] = useState<AgentRunDetailResponse>();
  const [runEvents, setRunEvents] = useState<readonly RunEventEnvelope[]>([]);
  const [runStreamAfter, setRunStreamAfter] = useState<number>();
  const [runConnection, setRunConnection] = useState<ConnectionState>('connecting');
  const [diff, setDiff] = useState<WorktreeDiffResponse>();
  const [executionBusy, setExecutionBusy] = useState(false);
  const [executionError, setExecutionError] = useState<string>();
  const [removalRefused, setRemovalRefused] = useState<
    WorktreeChangesRefused & { readonly worktreeId: WorktreeId }
  >();

  // Workspace and account commands.
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string>();
  const [workspaceNotice, setWorkspaceNotice] = useState<string>();
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string>();
  const [accountNotice, setAccountNotice] = useState<string>();

  /**
   * Switches workspace in one synchronous transition.
   *
   * Clearing in a `useEffect` ran *after* the render committed, so a single
   * frame could show the new workspace selected while still rendering the
   * previous workspace's summaries, projects, activity, and audit (CT03-RR4).
   * These updates are batched with the selection itself, so no such frame
   * exists. The render guard below is the structural backstop.
   */
  const selectWorkspace = useCallback((next: WorkspaceId | undefined) => {
    setSelectedWorkspaceId(next);
    setImportBusy(false);
    setItemBusy(false);
    setProject(undefined);
    setPlanVersion(undefined);
    setWorkItem(undefined);
    setArtifact(undefined);
    setImportResult(undefined);
    setImportError(undefined);
    setItemError(undefined);
    setAudit([]);
    setStreamAfter(0);
    setRepositories([]);
    setWorkItemExecution(undefined);
    setRunsState(undefined);
    setAgenda(undefined);
    setRun(undefined);
    setRunEvents([]);
    setRunStreamAfter(undefined);
    setDiff(undefined);
    setExecutionBusy(false);
    setExecutionError(undefined);
    setRemovalRefused(undefined);
    setWorkspaceError(undefined);
    setWorkspaceNotice(undefined);
    dispatch({ type: 'workspace-changed' });
    if (next !== undefined) {
      rememberWorkspace(next);
    }
  }, []);

  const establishSession = useCallback(async (session: AuthenticatedSessionResponse) => {
    setAuthenticated(session);
    setAuthenticationStatus('authenticated');
    const [workspaceResponse, sessionResponse] = await Promise.all([
      loadWorkspaces(),
      loadSessions(),
    ]);
    setWorkspaces(workspaceResponse.workspaces);
    setWorkspacesLoaded(true);
    setSessions(sessionResponse.sessions);
    setSelectedWorkspaceId((current) => {
      const keep = workspaceResponse.workspaces.some((workspace) => workspace.id === current);
      if (keep) {
        return current;
      }
      const remembered = rememberedWorkspace();
      const candidate =
        workspaceResponse.workspaces.find((workspace) => workspace.id === remembered) ??
        workspaceResponse.workspaces[0];
      return candidate?.id;
    });
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const session = await loadSession();
        if (session === undefined) {
          setAuthenticationStatus('unauthenticated');
          return;
        }
        await establishSession(session);
      } catch {
        setAuthenticationStatus('error');
      }
    })();
  }, [establishSession]);

  // Elapsed times on run rows tick without a stream event, while visible.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!documentHidden()) setNow(Date.now());
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  // `/` is a bookmark, not a page: it resolves to the last used workspace once
  // the workspace list is known.
  useEffect(() => {
    if (route.name !== 'root' || authenticationStatus !== 'authenticated' || !workspacesLoaded) {
      return;
    }
    if (workspaces.length === 0) {
      navigate({ name: 'home' }, { replace: true });
      return;
    }
    const target =
      workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0];
    if (target !== undefined) {
      navigate({ name: 'dashboard', workspaceId: target.id }, { replace: true });
    }
  }, [
    route.name,
    authenticationStatus,
    workspacesLoaded,
    workspaces,
    selectedWorkspaceId,
    navigate,
  ]);

  // A deep link selects the workspace it addresses.
  useEffect(() => {
    const target = routeWorkspaceId(route);
    if (
      target !== undefined &&
      target !== selectedWorkspaceId &&
      workspaces.some((workspace) => workspace.id === target)
    ) {
      // A deep link to another workspace is a workspace switch too.
      selectWorkspace(target);
    }
  }, [route, workspaces, selectedWorkspaceId, selectWorkspace]);

  // An invalidating event bumps refreshToken so this effect re-reads the
  // authoritative snapshot (CT03-A66); it is a trigger, not a read value.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate refetch trigger
  useEffect(() => {
    if (authenticationStatus !== 'authenticated' || activeWorkspaceId === undefined) {
      return;
    }
    let canceled = false;
    if (projection.snapshotStatus === 'idle') {
      dispatch({ type: 'snapshot-requested' });
    }
    // The owner-only audit page loads on its own below: a member who may not
    // read it must still get the snapshot (PERF-15).
    const load = Promise.all([loadWorkspaceSnapshot(activeWorkspaceId), loadWorkspaces()])
      .then(([snapshot, workspaceList]) => {
        if (canceled) {
          return;
        }
        // Seed the stream once. Background snapshots must not reconnect it or skip
        // invalidations that arrived while their requests were in flight.
        if (projection.snapshotStatus !== 'ready') setStreamAfter(snapshot.asOfSequence);
        setWorkspaces(workspaceList.workspaces);
        dispatch({ type: 'snapshot-loaded', snapshot });
      })
      .catch((error: unknown) => {
        if (canceled) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          setAuthenticationStatus('expired');
          setAuthenticated(undefined);
        } else if (projection.snapshotStatus === 'ready') {
          // Keep the last good projection; only mark it stale (CT03-A67).
          dispatch({ type: 'refresh-failed' });
        } else {
          dispatch({ type: 'snapshot-failed' });
        }
      });
    trackLoad(load);
    return () => {
      canceled = true;
    };
    // `refreshToken` re-runs this effect when an event invalidates the summary.
  }, [authenticationStatus, activeWorkspaceId, refreshToken]);

  // The audit log is owner-only and shown only on the dashboard (PERF-12, PERF-15).
  const auditVisible =
    route.name === 'dashboard' &&
    workspaces.some(
      (workspace) => workspace.id === activeWorkspaceId && workspace.role === 'owner',
    );
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate refetch trigger
  useEffect(() => {
    if (authenticationStatus !== 'authenticated' || activeWorkspaceId === undefined) return;
    if (!auditVisible) return;
    let canceled = false;
    const requestedFor = activeWorkspaceId;
    trackLoad(
      loadWorkspaceAudit(requestedFor)
        .then((page) => {
          if (!canceled && activeWorkspaceIdRef.current === requestedFor) setAudit(page.records);
        })
        // A failed audit read keeps the last page; it never fails the workspace.
        .catch(() => undefined),
    );
    return () => {
      canceled = true;
    };
  }, [authenticationStatus, activeWorkspaceId, auditVisible, refreshToken]);

  /**
   * Relevant events mark scopes stale; the app then refetches the authoritative
   * queries. Event payloads are never treated as the planning model (CT03-A66).
   */
  useEffect(() => {
    const stale = projection.stale;
    const page =
      stale.workspaceSummary ||
      stale.projectIds.length > 0 ||
      stale.workItemIds.length > 0 ||
      stale.repositoryList;
    if (!page && !stale.roadmaps && !stale.notifications) {
      return;
    }
    dispatch({
      type: 'stale-consumed',
      consumed: {
        ...(projection.stale.workspaceSummary ? { workspaceSummary: true } : {}),
        ...(stale.roadmaps ? { roadmaps: true } : {}),
        ...(stale.notifications ? { notifications: true } : {}),
        ...(projection.stale.repositoryList ? { repositoryList: true } : {}),
        ...(projection.stale.projectIds.length === 0
          ? {}
          : { projectIds: projection.stale.projectIds }),
        ...(projection.stale.workItemIds.length === 0
          ? {}
          : { workItemIds: projection.stale.workItemIds }),
      },
    });
    scheduler.invalidate([
      ...(page ? (['workspace'] as const) : []),
      ...(stale.roadmaps ? (['roadmaps'] as const) : []),
      ...(stale.notifications ? (['notifications'] as const) : []),
    ]);
  }, [projection.stale, scheduler]);

  const workspaceId = activeWorkspaceId;
  const cycles =
    cycleState !== undefined && cycleState.workspaceId === workspaceId ? cycleState.cycles : [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspace events explicitly refresh persisted cycle status
  useEffect(() => {
    if (authenticationStatus !== 'authenticated' || workspaceId === undefined) return;
    let cancelled = false;
    trackLoad(
      loadWorkCycles(workspaceId)
        .then((result) => {
          if (!cancelled && activeWorkspaceIdRef.current === workspaceId) {
            setCycleState({ workspaceId, cycles: result.cycles });
            setCycleLoadError(undefined);
          }
        })
        .catch(() => {
          if (!cancelled) setCycleLoadError(workspaceId);
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, authenticationStatus, refreshToken]);

  const attentionItems =
    attentionState !== undefined && attentionState.workspaceId === workspaceId
      ? attentionState.items
      : [];
  const attentionLoaded = attentionState?.workspaceId === workspaceId;
  const [attentionLoadError, setAttentionLoadError] = useState<WorkspaceId>();
  // biome-ignore lint/correctness/useExhaustiveDependencies: attention-changed events refresh the feed
  useEffect(() => {
    if (authenticationStatus !== 'authenticated' || workspaceId === undefined) return;
    let cancelled = false;
    trackLoad(
      loadAttention(workspaceId)
        .then((feed) => {
          if (!cancelled && activeWorkspaceIdRef.current === workspaceId) {
            setAttentionState({ workspaceId, items: feed.items });
            setAttentionLoadError(undefined);
          }
        })
        .catch(() => {
          if (!cancelled) setAttentionLoadError(workspaceId);
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [workspaceId, authenticationStatus, refreshToken]);
  /** An inbox item hosts its work item's controls, so it loads that item like its page. */
  const inboxItem =
    route.name === 'inbox' && route.itemId !== undefined
      ? attentionItems.find((item) => item.id === route.itemId)
      : undefined;
  const focusWorkItemId: WorkItemId | undefined =
    route.name === 'work-item'
      ? route.workItemId
      : (inboxItem?.refs.workItemId as WorkItemId | undefined);

  // Detail views refetch whenever their route or the refresh token changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate refetch trigger
  useEffect(() => {
    if (authenticationStatus !== 'authenticated') {
      return;
    }
    let canceled = false;
    if (route.name === 'account') {
      void loadSessions()
        .then((response) => {
          if (!canceled) setSessions(response.sessions);
        })
        .catch(() => undefined);
      return () => {
        canceled = true;
      };
    }
    if (workspaceId === undefined) {
      return;
    }
    const requestedFor = workspaceId;
    const current = (): boolean => !canceled && activeWorkspaceIdRef.current === requestedFor;
    const fail = (): void => {
      if (current()) {
        dispatch({ type: 'refresh-failed' });
      }
    };
    let load: Promise<unknown> | undefined;
    if (route.name === 'dashboard' || route.name === 'runs') {
      // The dashboard shows only live runs; the runs page the recent list (PERF-12).
      const scope = route.name === 'dashboard' ? 'live' : 'recent';
      load = loadWorkspaceRuns(workspaceId, { live: scope === 'live' })
        .then((response) => {
          if (current()) {
            setRunsState({ scope, response });
          }
        })
        .catch(fail);
    } else if (route.name === 'agenda') {
      load = loadWorkspaceWorkItems(workspaceId, route.filter)
        .then((response) => {
          if (current()) {
            setAgenda(response);
          }
        })
        .catch(fail);
    } else if (route.name === 'project') {
      load = loadProject(workspaceId, route.projectId)
        .then((detail) => {
          if (current()) {
            setProject(detail);
          }
        })
        .catch(fail);
    } else if (route.name === 'plan-version') {
      load = loadPlanVersion(workspaceId, route.projectId, route.planVersionId)
        .then((detail) => {
          if (current()) {
            setPlanVersion(detail);
          }
        })
        .catch(fail);
    } else if (
      focusWorkItemId !== undefined &&
      (route.name === 'work-item' || route.name === 'inbox')
    ) {
      const workItemId = focusWorkItemId;
      // The item's own cycles, history and design recovery included (PERF-05).
      const itemCycles = loadWorkCycles(workspaceId, workItemId)
        .then((result) => {
          if (current()) {
            setItemCycleState({ workspaceId: requestedFor, workItemId, cycles: result.cycles });
            setItemCycleLoadError(undefined);
          }
        })
        .catch(() => {
          if (current()) setItemCycleLoadError(workItemId);
        });
      const detail = Promise.all([
        loadWorkItem(workspaceId, workItemId),
        loadWorkItemExecution(workspaceId, workItemId),
        loadRepositories(workspaceId),
        loadExecutionStatus(),
        loadRunProfiles(workspaceId),
      ])
        .then(([detail, execution, repositoryList, status, profiles]) => {
          if (current()) {
            setWorkItem(detail);
            setWorkItemExecution(execution);
            setRepositories(repositoryList.repositories);
            setExecutionStatus(status);
            setRunProfiles(profiles);
          }
        })
        .catch(fail);
      load = Promise.all([itemCycles, detail]);
    } else if (route.name === 'settings') {
      load = Promise.all([loadExecutionStatus(), loadRunProfiles(workspaceId)])
        .then(([status, profiles]) => {
          if (current()) {
            setExecutionStatus(status);
            setRunProfiles(profiles);
          }
        })
        .catch(fail);
    } else if (route.name === 'repositories') {
      load = Promise.all([loadRepositories(workspaceId), loadExecutionStatus()])
        .then(([repositoryList, status]) => {
          if (current()) {
            setRepositories(repositoryList.repositories);
            setExecutionStatus(status);
          }
        })
        .catch(fail);
    } else if (route.name === 'run') {
      load = Promise.all([
        loadRun(workspaceId, route.runId).then((detail) =>
          Promise.all([
            detail,
            detail.run.workItemId
              ? loadWorkItemExecution(workspaceId, detail.run.workItemId)
              : Promise.resolve(undefined),
          ]),
        ),
        loadExecutionStatus(),
        loadRunProfiles(workspaceId),
      ])
        .then(([[detail, execution], status, profiles]) => {
          if (current()) {
            setRun(detail);
            setWorkItemExecution(execution);
            setExecutionStatus(status);
            setRunProfiles(profiles);
          }
        })
        .catch(fail);
    }
    if (load !== undefined) trackLoad(load);
    return () => {
      canceled = true;
    };
  }, [route, workspaceId, authenticationStatus, refreshToken, focusWorkItemId]);

  // Closes the round opened by this refresh token once every load registered
  // above has settled, so the scheduler never starts a second round meanwhile.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per round
  useEffect(() => {
    const done = roundDone.current;
    const loads = roundLoads.current.splice(0);
    roundDone.current = undefined;
    if (done !== undefined) void Promise.allSettled(loads).then(() => done());
  }, [refreshToken]);

  // Following a run: load the committed events once per run, then stream the
  // tail from the last committed sequence. Leaving the run page drops both.
  const followedRunId = route.name === 'run' ? route.runId : undefined;
  useEffect(() => {
    if (workspaceId === undefined || followedRunId === undefined) {
      setRun(undefined);
      setRunEvents([]);
      setRunStreamAfter(undefined);
      setDiff(undefined);
      return;
    }
    let canceled = false;
    const requestedFor = workspaceId;
    void (async () => {
      const collected: RunEventEnvelope[] = [];
      let after = 0;
      for (let page = 0; page < RUN_EVENT_PAGE_LIMIT; page += 1) {
        const response = await loadRunEvents(requestedFor, followedRunId, after);
        collected.push(...response.events);
        if (response.events.length === 0 || response.nextAfter === after) {
          break;
        }
        after = response.nextAfter;
      }
      if (!canceled && activeWorkspaceIdRef.current === requestedFor) {
        setRunEvents(collected);
        setRunStreamAfter(after);
        setRunConnection('connecting');
      }
    })().catch(() => {
      if (!canceled) {
        setRunConnection('disconnected');
      }
    });
    return () => {
      canceled = true;
    };
  }, [workspaceId, followedRunId]);

  const onRunStreamOpen = useCallback(() => setRunConnection('open'), []);
  const onRunStreamError = useCallback((sourceClosed: boolean) => {
    setRunConnection(sourceClosed ? 'disconnected' : 'reconnecting');
  }, []);
  const receiveRunEvent = useCallback(
    (event: RunEventEnvelope) => {
      setRunEvents((current) =>
        current.some((existing) => existing.sequence >= event.sequence)
          ? current
          : [...current, event],
      );
      if (
        event.kind === 'run-finished' ||
        event.kind === 'turn-completed' ||
        event.kind === 'session-started'
      ) {
        scheduler.invalidate(['workspace']);
      }
    },
    [scheduler],
  );
  const onRunStreamInvalid = useCallback(() => undefined, []);
  const onRunAuthenticationExpired = useCallback(() => {
    setAuthenticated(undefined);
    setAuthenticationStatus('expired');
  }, []);
  useRunEventStream(
    runStreamAfter === undefined ? undefined : workspaceId,
    runStreamAfter === undefined ? undefined : followedRunId,
    runStreamAfter ?? 0,
    {
      onOpen: onRunStreamOpen,
      onError: onRunStreamError,
      onEvent: receiveRunEvent,
      onInvalidEvent: onRunStreamInvalid,
      onAuthenticationExpired: onRunAuthenticationExpired,
    },
  );

  const onStreamOpen = useCallback(() => dispatch({ type: 'stream-opened' }), []);
  const onStreamError = useCallback((sourceClosed: boolean) => {
    dispatch({ type: 'stream-error', sourceClosed });
    void loadSession()
      .then((session) => {
        if (session === undefined) {
          setAuthenticated(undefined);
          setAuthenticationStatus('expired');
        }
      })
      .catch(() => undefined);
  }, []);
  const receiveWorkspaceEvent = useCallback(
    (event: WorkspaceEventEnvelope) => dispatch({ type: 'event-received', event }),
    [],
  );
  const onInvalidEvent = useCallback(() => dispatch({ type: 'event-invalid' }), []);
  const onAuthenticationExpired = useCallback(() => {
    setAuthenticated(undefined);
    setAuthenticationStatus('expired');
  }, []);

  useWorkspaceEventStream(
    projection.snapshotStatus === 'ready' ? selectedWorkspaceId : undefined,
    streamAfter,
    {
      onOpen: onStreamOpen,
      onError: onStreamError,
      onEvent: receiveWorkspaceEvent,
      onInvalidEvent,
      onAuthenticationExpired,
    },
  );

  const handleLogin = async (username: string, password: string): Promise<void> => {
    const response = await login({ username, password });
    await establishSession(response);
  };

  const handleLogout = async (): Promise<void> => {
    if (authenticated === undefined) {
      return;
    }
    try {
      await logout(authenticated.csrfToken);
    } finally {
      setAuthenticated(undefined);
      setWorkspaces([]);
      setWorkspacesLoaded(false);
      setSessions([]);
      selectWorkspace(undefined);
      setAuthenticationStatus('unauthenticated');
    }
  };

  const handleRevoke = async (sessionId: SessionId): Promise<void> => {
    if (authenticated === undefined) {
      return;
    }
    const currentRevoked = await revokeSession(sessionId, authenticated.csrfToken);
    if (currentRevoked) {
      setAuthenticated(undefined);
      setAuthenticationStatus('expired');
      return;
    }
    setSessions((await loadSessions()).sessions);
  };

  const go = (next: Route): void => {
    setArtifact(undefined);
    navigate(next);
  };

  useRevealRouteFocus(route);

  const toggleTheme = (): void => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    persistTheme(next);
    setTheme(next);
  };

  const handleImport = (upload: PlanImportUpload): void => {
    if (workspaceId === undefined || authenticated === undefined) {
      return;
    }
    const requestedFor = workspaceId;
    setImportBusy(true);
    setImportResult(undefined);
    setImportError(undefined);
    void importPlanBundle(workspaceId, upload, authenticated.csrfToken)
      .then((response) => {
        if (activeWorkspaceIdRef.current !== requestedFor) {
          return;
        }
        setImportResult(response);
        refreshNow();
        if (response.outcome === 'succeeded') {
          go({ name: 'project', workspaceId: requestedFor, projectId: response.projectId });
        }
      })
      .catch((error: unknown) => {
        if (activeWorkspaceIdRef.current !== requestedFor) {
          return;
        }
        setImportError(
          error instanceof ApiError ? error.message : 'The plan import request failed',
        );
      })
      .finally(() => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setImportBusy(false);
        }
      });
  };

  /** Work item lifecycle commands share one busy flag and one error slot. */
  const itemCommand = (
    operation: (csrfToken: string, forWorkspace: WorkspaceId) => Promise<void>,
    fallback: string,
  ): void => {
    if (workspaceId === undefined || authenticated === undefined) {
      return;
    }
    const requestedFor = workspaceId;
    setItemBusy(true);
    setItemError(undefined);
    void operation(authenticated.csrfToken, requestedFor)
      .then(() => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          refreshNow();
        }
      })
      .catch((error: unknown) => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setItemError(error instanceof ApiError ? error.message : fallback);
        }
      })
      .finally(() => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setItemBusy(false);
        }
      });
  };
  const handleAdmit = (workItemId: WorkItemId): void =>
    itemCommand(async (csrfToken, forWorkspace) => {
      await admitWorkItem(forWorkspace, workItemId, csrfToken);
    }, 'Admission failed');
  const handleComplete = (workItemId: WorkItemId): void =>
    itemCommand(async (csrfToken, forWorkspace) => {
      await completeWorkItem(forWorkspace, workItemId, csrfToken);
    }, 'Completion failed');

  /**
   * Delegation commands. Each captures the workspace it was made for, reports
   * the daemon's own message on failure, and lets the event stream drive the
   * refresh rather than patching local state from the response.
   */
  const executionCommand = (
    operation: (csrfToken: string, forWorkspace: WorkspaceId) => Promise<void>,
  ): void => {
    if (workspaceId === undefined || authenticated === undefined) {
      return;
    }
    const requestedFor = workspaceId;
    setExecutionBusy(true);
    setExecutionError(undefined);
    void operation(authenticated.csrfToken, requestedFor)
      .then(() => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          refreshNow();
        }
      })
      .catch((error: unknown) => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setExecutionError(error instanceof ApiError ? error.message : 'The request failed');
        }
      })
      .finally(() => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setExecutionBusy(false);
        }
      });
  };

  const handleRegisterRepository = (input: { rootPath: string; displayName?: string }): void =>
    executionCommand(async (csrfToken, forWorkspace) => {
      await registerRepository(forWorkspace, input, csrfToken);
    });
  const handleRetireRepository = (repositoryId: SourceRepositoryId): void =>
    executionCommand(async (csrfToken, forWorkspace) => {
      await retireRepository(forWorkspace, repositoryId, csrfToken);
    });
  const handleCreateWorktree = (workItemId: WorkItemId, repositoryId: SourceRepositoryId): void =>
    executionCommand(async (csrfToken, forWorkspace) => {
      await createWorktree(forWorkspace, workItemId, { repositoryId }, csrfToken);
    });
  const handleRemoveWorktree = (
    worktreeId: WorktreeId,
    input: { readonly discardChanges?: true } = {},
  ): void =>
    executionCommand(async (csrfToken, forWorkspace) => {
      setRemovalRefused(undefined);
      try {
        await removeWorktree(forWorkspace, worktreeId, csrfToken, input);
      } catch (error) {
        const refused = worktreeChangesRefused(error);
        if (refused !== undefined && activeWorkspaceIdRef.current === forWorkspace)
          setRemovalRefused({ ...refused, worktreeId });
        throw error;
      }
      setDiff((current) => (current?.worktree.id === worktreeId ? undefined : current));
    });
  const handleSaveProfiles = (profiles: readonly WorkspaceAgentProfile[]): void => {
    if (authenticated === undefined || workspaceId === undefined) {
      return;
    }
    const requestedFor = workspaceId;
    setProfilesBusy(true);
    setProfilesError(undefined);
    setProfilesNotice(undefined);
    void saveRunProfiles(requestedFor, { profiles: [...profiles] }, authenticated.csrfToken)
      .then((response) => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setRunProfiles(response);
          setProfilesNotice('Profiles saved.');
        }
      })
      .catch((error: unknown) => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setProfilesError(
            error instanceof ApiError ? error.message : 'The profiles could not be saved',
          );
        }
      })
      .finally(() => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setProfilesBusy(false);
        }
      });
  };
  const handleLaunch = (workItemId: WorkItemId, input: LaunchInput): void =>
    executionCommand(async (csrfToken, forWorkspace) => {
      const response = await startRun(forWorkspace, workItemId, input, csrfToken);
      if (activeWorkspaceIdRef.current === forWorkspace) {
        go({ name: 'run', workspaceId: forWorkspace, runId: response.run.id });
      }
    });
  const handleSendMessage = (runId: AgentRunId, text: string): void =>
    executionCommand(async (csrfToken, forWorkspace) => {
      const response = await sendRunMessage(forWorkspace, runId, text, csrfToken);
      if (!response.accepted) {
        throw new ApiError(409, 'conflict', 'The run is no longer accepting messages');
      }
    });
  const handleEndRun = (runId: AgentRunId): void =>
    executionCommand(async (csrfToken, forWorkspace) => {
      await endRun(forWorkspace, runId, csrfToken);
    });
  const handleCancelRun = (runId: AgentRunId): void =>
    executionCommand(async (csrfToken, forWorkspace) => {
      await cancelRun(forWorkspace, runId, csrfToken);
    });
  const handleLoadDiff = (worktreeId: WorktreeId): void => {
    if (workspaceId === undefined) {
      return;
    }
    const requestedFor = workspaceId;
    setExecutionError(undefined);
    void loadWorktreeDiff(workspaceId, worktreeId)
      .then((response) => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setDiff(response);
        }
      })
      .catch((error: unknown) => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setExecutionError(
            error instanceof ApiError ? error.message : 'The diff could not be loaded',
          );
        }
      });
  };

  const handleCreateWorkspace = (name: string): void => {
    if (authenticated === undefined) {
      return;
    }
    setWorkspaceBusy(true);
    setWorkspaceError(undefined);
    void createWorkspace(name, authenticated.csrfToken)
      .then(async (response) => {
        const list = await loadWorkspaces();
        setWorkspaces(list.workspaces);
        selectWorkspace(response.workspace.id);
        go({ name: 'dashboard', workspaceId: response.workspace.id });
      })
      .catch((error: unknown) => {
        setWorkspaceError(
          error instanceof ApiError ? error.message : 'The workspace could not be created',
        );
      })
      .finally(() => setWorkspaceBusy(false));
  };

  const handleRenameWorkspace = (name: string): void => {
    if (authenticated === undefined || workspaceId === undefined) {
      return;
    }
    setWorkspaceBusy(true);
    setWorkspaceError(undefined);
    setWorkspaceNotice(undefined);
    void renameWorkspace(workspaceId, name, authenticated.csrfToken)
      .then(async () => {
        const list = await loadWorkspaces();
        setWorkspaces(list.workspaces);
        setWorkspaceNotice('Workspace renamed.');
        refreshNow();
      })
      .catch((error: unknown) => {
        setWorkspaceError(
          error instanceof ApiError ? error.message : 'The workspace could not be renamed',
        );
      })
      .finally(() => setWorkspaceBusy(false));
  };

  const handleChangePassword = (input: { currentPassword: string; newPassword: string }): void => {
    if (authenticated === undefined) {
      return;
    }
    setAccountBusy(true);
    setAccountError(undefined);
    setAccountNotice(undefined);
    void changePassword(input, authenticated.csrfToken)
      .then(async (response) => {
        setAccountNotice(
          response.revokedSessionCount === 0
            ? 'Password changed.'
            : `Password changed; ${response.revokedSessionCount} other session${
                response.revokedSessionCount === 1 ? '' : 's'
              } signed out.`,
        );
        setSessions((await loadSessions()).sessions);
      })
      .catch((error: unknown) => {
        setAccountError(
          error instanceof ApiError
            ? error.status === 401
              ? 'The current password is not correct.'
              : error.message
            : 'The password could not be changed',
        );
      })
      .finally(() => setAccountBusy(false));
  };

  const viewArtifact = (artifactId: PlanArtifactId, filename: string): void => {
    if (workspaceId === undefined) {
      return;
    }
    const requestedFor = workspaceId;
    void loadArtifactText(workspaceId, artifactId)
      .then((text) => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setArtifact({ filename, text });
        }
      })
      .catch(() => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setArtifact({ filename, text: 'The source artifact could not be loaded.' });
        }
      });
  };

  if (authenticationStatus === 'checking') {
    return (
      <main className="center-state" aria-live="polite">
        Checking session…
      </main>
    );
  }
  if (authenticationStatus !== 'authenticated' || authenticated === undefined) {
    return (
      <LoginPage message={authenticationMessage(authenticationStatus)} onLogin={handleLogin} />
    );
  }

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  const canMutate = activeWorkspace?.role !== 'viewer';
  const workspaceRoute = routeWorkspaceId(route) !== undefined;
  const liveRuns = (runsState?.response.runs ?? []).filter((entry) => isLiveStatus(entry.status));
  const recentRuns = runsState?.scope === 'recent' ? runsState.response : undefined;
  const itemCycles =
    itemCycleState !== undefined &&
    focusWorkItemId !== undefined &&
    itemCycleState.workspaceId === workspaceId &&
    itemCycleState.workItemId === focusWorkItemId
      ? itemCycleState.cycles
      : undefined;
  const itemInProgress =
    route.name === 'work-item' &&
    workItemExecution?.workItemId === route.workItemId &&
    (workItemExecution.worktrees.some((worktree) => worktree.status === 'active') ||
      workItemExecution.runs.some((entry) => isLiveStatus(entry.status)));
  /** The work item's automated cycle controls: its page and its inbox items host them (R-A5). */
  const cycleControls = (
    workItemId: WorkItemId,
    /** The worktree whose cycle to show: an inbox item's own, else the page's selection. */
    worktreeId?: WorktreeId,
    /** In the inbox the item's own decision renders; elsewhere a stop links to its item. */
    inInbox = false,
  ): ReactElement | undefined => {
    if (
      workspaceId === undefined ||
      authenticated === undefined ||
      workItem?.workItem.id !== workItemId ||
      workItemExecution?.workItemId !== workItemId ||
      itemCycles === undefined
    )
      return undefined;
    return (
      <CyclePanel
        key={worktreeId === undefined ? workItemId : `${workItemId}:${worktreeId}`}
        {...((worktreeId ?? selectedCycleWorktreeId)
          ? { selectedWorktreeId: worktreeId ?? selectedCycleWorktreeId }
          : {})}
        onSelectWorktree={setSelectedCycleWorktreeId}
        cycles={itemCycles}
        worktrees={workItemExecution.worktrees}
        runs={workItemExecution.runs}
        backends={executionStatus?.backends ?? []}
        profiles={runProfiles?.profiles ?? []}
        canMutate={canMutate}
        busy={executionBusy}
        admitted={workItem.workItem.status === 'admitted'}
        onStart={(input) =>
          executionCommand(async (csrfToken, forWorkspace) => {
            await startWorkCycle(forWorkspace, workItem.workItem.id, input, csrfToken);
          })
        }
        csrfToken={authenticated.csrfToken}
        refreshToken={refreshToken}
        onChanged={refreshNow}
        {...(inInbox
          ? {}
          : {
              decisionItemFor: (cycleId: string) =>
                attentionItems.find((item) => item.subjectKey === `cycle:${cycleId}`)?.id,
            })}
        onOpenRun={(runId) => go({ name: 'run', workspaceId, runId })}
      />
    );
  };
  /** Where a roadmap part opens: the held entry, the step's own form, or the amendments (LIVE-11). */
  const roadmapPartFocus = (roadmapId: string, part: RoadmapItemPart): string | undefined => {
    const runtime = `runtime-evidence-roadmap-${roadmapId}`;
    if (part.kind === 'amendments') return `map-amendments-${roadmapId}`;
    if (part.kind === 'controls')
      return part.entryId === undefined ? undefined : `roadmap-entry-${roadmapId}-${part.entryId}`;
    return {
      dependency: runtime,
      verification: `${runtime}-native`,
      decisions: `${runtime}-decisions`,
      evidence: `${runtime}-evidence`,
      'plan-acceptance': `${runtime}-plan-acceptance`,
    }[part.step as string];
  };
  /** After a merge or a cleanup retry: the merged worktree's diff closes and the page reloads. */
  const merged = (worktreeId: WorktreeId) => {
    setDiff((current) => (current?.worktree.id === worktreeId ? undefined : current));
    refreshNow();
  };
  /** The open inbox item that carries a worktree's merge (R-A6). */
  const mergeItemFor = (worktreeId: string) =>
    attentionItems.find(
      (item) =>
        item.refs.worktreeId === worktreeId &&
        decisionsFor(item).some((decision) => decision.kind === 'merge'),
    );
  /** The work item's worktrees, runs and merges. */
  const delegationControls = (workItemId: WorkItemId): ReactElement | undefined => {
    if (
      workspaceId === undefined ||
      authenticated === undefined ||
      workItem?.workItem.id !== workItemId ||
      workItemExecution?.workItemId !== workItemId
    )
      return undefined;
    return (
      <DelegationPanel
        repositories={repositories}
        hideCreateWorktree
        automationActive={cycles.some(
          (cycle) =>
            cycle.workItemId === workItemId && !['stopped', 'completed'].includes(cycle.status),
        )}
        renderBranchControls={(worktree) => (
          <WorktreeBranchPanel
            key={worktree.id}
            workspaceId={workspaceId}
            worktree={worktree}
            csrfToken={authenticated.csrfToken}
            canMutate={canMutate}
            refreshToken={refreshToken}
            onChanged={() => refreshNow()}
          />
        )}
        worktrees={workItemExecution.worktrees}
        runs={workItemExecution.runs}
        mergeGates={workItemExecution.mergeGates}
        backends={executionStatus?.backends ?? []}
        itemCompleted={workItem.workItem.status === 'completed'}
        canMutate={canMutate}
        busy={executionBusy}
        {...(executionError === undefined ? {} : { error: executionError })}
        onCreateWorktree={(repositoryId) =>
          handleCreateWorktree(workItem.workItem.id, repositoryId)
        }
        onRemoveWorktree={handleRemoveWorktree}
        {...(removalRefused === undefined ? {} : { removalRefused })}
        onKeepWorktree={() => {
          setRemovalRefused(undefined);
          setExecutionError(undefined);
        }}
        workspaceId={workspaceId}
        csrfToken={authenticated.csrfToken}
        onMerged={merged}
        decisionItemFor={(worktreeId) => mergeItemFor(worktreeId)?.id}
        onLaunch={(input) => handleLaunch(workItem.workItem.id, input)}
        {...(runProfiles === undefined ? {} : { profiles: runProfiles.profiles })}
        onOpenRun={(runId) => go({ name: 'run', workspaceId, runId })}
        onOpenDiff={handleLoadDiff}
      />
    );
  };

  /** The work item's execution slices: phase requirements and scope evidence. */
  const scopeControls = (
    workItemId: WorkItemId,
    /** In the inbox the item's own decision renders; elsewhere a merge links to its item. */
    inInbox = false,
  ): ReactElement | undefined => {
    if (
      workspaceId === undefined ||
      authenticated === undefined ||
      workItem?.workItem.id !== workItemId
    )
      return undefined;
    return (
      <ExecutionScopesPanel
        key={`scopes-${workspaceId}-${workItemId}`}
        cycles={itemCycles ?? []}
        onOpenCycle={(id) => {
          setSelectedCycleWorktreeId(id);
          const element = document.getElementById('automation');
          element?.scrollIntoView({ block: 'start' });
          if (element) {
            element.tabIndex = -1;
            element.focus({ preventScroll: true });
          }
        }}
        workspaceId={workspaceId}
        workItemId={workItem.workItem.id}
        worktrees={workItemExecution?.workItemId === workItemId ? workItemExecution.worktrees : []}
        csrfToken={authenticated.csrfToken}
        canMutate={canMutate}
        itemStatus={workItem.workItem.status}
        refreshToken={refreshToken}
        onChanged={() => refreshNow()}
        {...(inInbox
          ? {}
          : {
              decisionItemFor: (id: string) =>
                attentionItems.find(
                  (item) =>
                    item.refs.worktreeId === id &&
                    decisionsFor(item).some((d) => d.kind === 'checkpoint-preparation'),
                )?.id,
            })}
      />
    );
  };
  /**
   * The decisions that resolve one inbox item, chosen by its code through the registry (R-A6
   * increment 2a): each kind's own component, or one part of a roadmap.
   */
  const renderInboxHost = (item: AttentionItemView): ReactElement => {
    const { workItemId, roadmapId, planVersionId, projectId, runId, cycleId } = item.refs;
    const loading = <p className="empty-state">Loading controls…</p>;
    const render = (decision: Decision): ReactNode => {
      switch (decision.kind) {
        case 'cycle': {
          // The cycle's decision alone, chosen from its state (R-A6 increment 2a).
          // The item's cycles in full: the workspace list leaves out design-recovery detail.
          const cycle = itemCycles?.find((c) => c.id === cycleId);
          const worktree = workItemExecution?.worktrees.find((t) => t.id === cycle?.worktreeId);
          if (!cycle || !worktree || authenticated === undefined || workspaceId === undefined)
            return loading;
          return (
            <CycleDecision
              cycle={cycle}
              runs={workItemExecution?.runs ?? []}
              readOnly={!!worktree.executionScope && worktree.executionScope.kind !== 'slice'}
              backends={executionStatus?.backends ?? []}
              csrfToken={authenticated.csrfToken}
              canMutate={canMutate}
              busy={executionBusy}
              refreshToken={refreshToken}
              onChanged={refreshNow}
              inInbox
              onOpenRun={(id) => go({ name: 'run', workspaceId, runId: id })}
              onOpenWorktree={(id) => {
                setSelectedCycleWorktreeId(id);
                if (workItemId)
                  go({ name: 'work-item', workspaceId, workItemId: workItemId as WorkItemId });
              }}
            />
          );
        }
        case 'merge': {
          const worktree = workItemExecution?.worktrees.find((t) => t.id === item.refs.worktreeId);
          const gate = worktree && workItemExecution?.mergeGates[worktree.id];
          if (!worktree || workspaceId === undefined || authenticated === undefined) return loading;
          return worktree.mergeCleanupError ? (
            <RetryMergeCleanup
              workspaceId={workspaceId}
              worktree={worktree}
              csrfToken={authenticated.csrfToken}
              disabled={!canMutate}
              onDone={merged}
            />
          ) : (
            <>
              <p>
                <code>{worktree.branchName}</code>:{' '}
                {gate ? MERGE_GATE_LABELS[gate.reason] : 'Loading the merge gate…'}
              </p>
              {gate && canMutate && (
                <MergeApproval
                  workspaceId={workspaceId}
                  worktree={worktree}
                  gate={gate}
                  csrfToken={authenticated.csrfToken}
                  disabled={false}
                  onMerged={merged}
                />
              )}
            </>
          );
        }
        case 'checkpoint-preparation': {
          const worktree = workItemExecution?.worktrees.find((t) => t.id === item.refs.worktreeId);
          return worktree?.executionScope?.kind === 'slice' &&
            workspaceId !== undefined &&
            authenticated !== undefined ? (
            <CheckpointPreparation
              workspaceId={workspaceId}
              definitionId={worktree.executionScope.definitionId}
              worktreeId={worktree.id}
              csrfToken={authenticated.csrfToken}
              canMutate={canMutate}
              onChanged={refreshNow}
            />
          ) : undefined;
        }
        case 'worktrees':
          return (workItemId && delegationControls(workItemId as WorkItemId)) || loading;
        case 'scope-evidence':
          return (workItemId && scopeControls(workItemId as WorkItemId, true)) || loading;
        case 'check-adoption': {
          const repositoryId =
            cycles.find((c) => c.id === cycleId)?.attention?.refs?.repositoryId ??
            workItemExecution?.worktrees.find((t) => t.id === item.refs.worktreeId)?.repositoryId;
          const repository = repositories.find((r) => r.id === repositoryId);
          const worktree = workItemExecution?.worktrees.find((t) => t.id === item.refs.worktreeId);
          return repository && workspaceId !== undefined && authenticated !== undefined ? (
            <CheckAdoption
              key={`checks-${item.id}`}
              workspaceId={workspaceId}
              repository={repository}
              {...(item.refs.worktreeId ? { worktreeId: item.refs.worktreeId as WorktreeId } : {})}
              {...(worktree?.integrationBranch
                ? { integrationBranch: worktree.integrationBranch }
                : {})}
              csrfToken={authenticated.csrfToken}
              editable={canMutate}
              onAdopted={refreshNow}
            />
          ) : (
            loading
          );
        }
        case 'finalization':
          return planVersionId !== undefined &&
            projectId !== undefined &&
            workspaceId !== undefined &&
            authenticated !== undefined ? (
            <FinalizationPanel
              key={`finalize-${planVersionId}`}
              workspaceId={workspaceId}
              planVersionId={planVersionId as PlanVersionId}
              csrfToken={authenticated.csrfToken}
              canMutate={canMutate}
              onOpenRun={(id) => go({ name: 'run', workspaceId, runId: id })}
            />
          ) : undefined;
        case 'run':
          return runId !== undefined && workspaceId !== undefined ? (
            <p>
              <Link
                className="text-button"
                route={{ name: 'run', workspaceId, runId: runId as AgentRunId }}
              >
                Open the run
              </Link>
            </p>
          ) : undefined;
        case 'storage':
          return activeWorkspace?.role === 'owner' && authenticated !== undefined ? (
            <StoragePanel workspaceId={activeWorkspace.id} csrfToken={authenticated.csrfToken} />
          ) : undefined;
        case 'acknowledge':
          return workspaceId !== undefined && authenticated !== undefined ? (
            <AcknowledgeMoves
              workspaceId={workspaceId}
              moveIds={item.members ?? []}
              csrfToken={authenticated.csrfToken}
              canMutate={canMutate}
              onDone={() => setRefreshToken((value) => value + 1)}
            />
          ) : undefined;
        case 'roadmap':
          return roadmapId !== undefined &&
            workspaceId !== undefined &&
            activeWorkspace !== undefined &&
            authenticated !== undefined ? (
            <RoadmapPage
              key={`inbox-${item.id}`}
              workspaceId={workspaceId}
              roadmapId={roadmapId}
              tab="all"
              part={decision.part}
              csrfToken={authenticated.csrfToken}
              canMutate={['owner', 'editor'].includes(activeWorkspace.role)}
              onOpenWorkItem={(id) => go({ name: 'work-item', workspaceId, workItemId: id })}
              attention={attentionItems}
              onOpenAttention={(id) => go({ name: 'inbox', workspaceId, itemId: id })}
              {...(roadmapPartFocus(roadmapId, decision.part)
                ? { focus: roadmapPartFocus(roadmapId, decision.part)! }
                : {})}
            />
          ) : undefined;
      }
    };
    return (
      <Fragment key={item.id}>
        {decisionsFor(item).map((decision, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: an item's decisions are fixed by its code.
          <Fragment key={index}>{render(decision)}</Fragment>
        ))}
      </Fragment>
    );
  };

  const workspaceContent = (): ReactElement | undefined => {
    if (workspaces.length === 0) {
      return <p className="empty-state">This user has no authorized workspaces.</p>;
    }
    if (projection.snapshotStatus === 'loading' || projection.snapshotStatus === 'idle') {
      return <p className="empty-state">Loading durable workspace snapshot…</p>;
    }
    if (projection.snapshotStatus === 'error') {
      return (
        <p className="error-state" role="alert">
          The workspace snapshot could not be loaded.
        </p>
      );
    }
    const shown = projection.workspace;
    if (shown === undefined || shown.id !== activeWorkspaceId || workspaceId === undefined) {
      // Never render one workspace's projection under another's identity,
      // whatever order the state updates arrive in, and whether the change
      // came from the picker or the URL (CT03-RR4, CT03-R2R4, CT03-I14).
      return <p className="empty-state">Loading durable workspace snapshot…</p>;
    }
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

        {(cycleLoadError === workspaceId ||
          (route.name === 'work-item' && itemCycleLoadError === route.workItemId)) && (
          <p className="warning-state" role="alert">
            Cycle status could not be loaded. Refresh before controlling automation.
          </p>
        )}
        {attentionLoadError === workspaceId && (
          <p className="warning-state" role="alert">
            Needs you could not be loaded, so this list may be incomplete. Refresh to retry.
          </p>
        )}
        {route.name !== 'dashboard' && route.name !== 'inbox' && (
          <NeedsYou
            items={attentionItems}
            workspaceId={workspaceId}
            variant="strip"
            onNavigate={go}
          />
        )}

        {route.name === 'dashboard' && (
          <div className="page">
            <PageHeader
              title={shown.name}
              subtitle={`${projection.planningSummary.projectCount} project${
                projection.planningSummary.projectCount === 1 ? '' : 's'
              }`}
              actions={
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => go({ name: 'import', workspaceId })}
                >
                  Import plan
                </button>
              }
            />
            <NeedsYou
              items={attentionItems}
              workspaceId={workspaceId}
              variant="section"
              onNavigate={go}
            />
            <OperatorWaitSection
              workspaceId={workspaceId}
              refreshKey={cycles
                .map(
                  (cycle) =>
                    `${cycle.id}:${cycle.status}:${cycle.attention?.code ?? ''}:${cycle.attention?.owner ?? ''}`,
                )
                .join(',')}
            />
            <StatusCards
              summary={projection.statusSummary}
              onOpen={(target) => {
                if (target.kind === 'runs') go({ name: 'runs', workspaceId });
                else if (target.kind === 'import') go({ name: 'import', workspaceId });
                else go({ name: 'agenda', workspaceId, filter: target.filter });
              }}
            />
            <Section
              title="Live runs"
              count={liveRuns.length}
              summary={
                liveRuns.length === 0
                  ? 'No agent is working right now.'
                  : `${liveRuns.filter((entry) => entry.status === 'waiting').length} waiting for you.`
              }
              actions={
                <button
                  type="button"
                  className="text-button"
                  onClick={() => go({ name: 'runs', workspaceId })}
                >
                  All runs
                </button>
              }
            >
              <RunList
                runs={liveRuns}
                now={now}
                onOpenRun={(runId) => go({ name: 'run', workspaceId, runId })}
                onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
              />
            </Section>
            <ProjectCards
              projects={projection.projects}
              onOpen={(projectId) => go({ name: 'project', workspaceId, projectId })}
              onImport={() => go({ name: 'import', workspaceId })}
            />
            <ActivityPanel
              events={projection.events}
              invalidPayloadCount={projection.invalidPayloadCount}
              foreignWorkspaceEventCount={projection.foreignWorkspaceEventCount}
            />
            <AuditPanel records={audit} />
          </div>
        )}

        {route.name === 'runs' && (
          <RunsPage
            runs={recentRuns?.runs ?? []}
            liveCount={recentRuns?.liveCount ?? 0}
            now={now}
            onOpenRun={(runId) => go({ name: 'run', workspaceId, runId })}
            onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
          />
        )}

        {route.name === 'agenda' && (
          <AgendaPage
            filter={route.filter}
            {...(agenda === undefined ? {} : { listing: agenda })}
            onSelectFilter={(filter) => go({ name: 'agenda', workspaceId, filter })}
            onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
            onOpenProject={(projectId) => go({ name: 'project', workspaceId, projectId })}
          />
        )}

        {route.name === 'roadmaps' && activeWorkspace && (
          <RoadmapsPage
            key={workspaceId}
            workspaceId={workspaceId}
            csrfToken={authenticated.csrfToken}
            canMutate={['owner', 'editor'].includes(activeWorkspace.role)}
            attention={attentionItems}
          />
        )}

        {route.name === 'roadmap' && activeWorkspace && (
          <RoadmapPage
            key={`${workspaceId}:${route.roadmapId}:${route.tab}`}
            workspaceId={workspaceId}
            roadmapId={route.roadmapId}
            tab={route.tab}
            csrfToken={authenticated.csrfToken}
            canMutate={['owner', 'editor'].includes(activeWorkspace.role)}
            onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
            attention={attentionItems}
            onOpenAttention={(itemId) => go({ name: 'inbox', workspaceId, itemId })}
          />
        )}

        {route.name === 'roadmap-map' && activeWorkspace && (
          <ConcurrencyImports
            key={`${workspaceId}:${route.definitionId}`}
            workspaceId={workspaceId}
            csrfToken={authenticated.csrfToken}
            canMutate={['owner', 'editor'].includes(activeWorkspace.role)}
            definitionId={route.definitionId}
          />
        )}

        {route.name === 'inbox' && (
          <InboxPage
            workspaceId={workspaceId}
            items={attentionItems}
            loaded={attentionLoaded}
            {...(route.itemId === undefined ? {} : { selectedId: route.itemId })}
            now={now}
            onNavigate={go}
            renderHost={renderInboxHost}
          />
        )}

        {route.name === 'settings' && activeWorkspace !== undefined && (
          <SettingsPage
            key={activeWorkspace.id}
            workspace={activeWorkspace}
            canEdit={activeWorkspace.role === 'owner'}
            busy={workspaceBusy}
            {...(workspaceError === undefined ? {} : { error: workspaceError })}
            {...(workspaceNotice === undefined ? {} : { notice: workspaceNotice })}
            roadmapProfiles={
              <RoadmapAgentProfilesPanel
                workspaceId={activeWorkspace.id}
                csrfToken={authenticated.csrfToken}
                profiles={runProfiles?.profiles ?? []}
                backends={executionStatus?.backends ?? []}
                canEdit={activeWorkspace.role !== 'viewer'}
              />
            }
            hostScheduling={
              activeWorkspace.role !== 'viewer' ? (
                <HostSchedulingPanel
                  canManageHost={activeWorkspace.role === 'owner'}
                  workspaceId={activeWorkspace.id}
                  csrfToken={authenticated.csrfToken}
                />
              ) : undefined
            }
            storage={
              activeWorkspace.role === 'owner' ? (
                <StoragePanel
                  workspaceId={activeWorkspace.id}
                  csrfToken={authenticated.csrfToken}
                />
              ) : undefined
            }
            notifications={
              activeWorkspace.role === 'owner' ? (
                <NotificationPanel
                  workspaceId={activeWorkspace.id}
                  csrfToken={authenticated.csrfToken}
                />
              ) : undefined
            }
            onRename={handleRenameWorkspace}
            {...(executionStatus === undefined ? {} : { backends: executionStatus.backends })}
            {...(runProfiles === undefined ? {} : { profiles: runProfiles.profiles })}
            profilesBusy={profilesBusy}
            {...(profilesError === undefined ? {} : { profilesError })}
            {...(profilesNotice === undefined ? {} : { profilesNotice })}
            onSaveProfiles={handleSaveProfiles}
          />
        )}

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
        {route.name === 'import' && (
          <ImportPlanPage
            key={workspaceId}
            workspaceId={workspaceId}
            csrfToken={authenticated.csrfToken}
            onZipImported={() => refreshNow()}
            projects={projection.projects}
            onImport={handleImport}
            busy={importBusy}
            {...(importResult === undefined ? {} : { result: importResult })}
            {...(importError === undefined ? {} : { error: importError })}
          />
        )}

        {route.name === 'project' && project?.project.id === route.projectId && (
          <ProjectPage
            detail={project}
            branchSettings={
              project.activeVersion && (
                <PlanBranchPanel
                  key={project.activeVersion.version.id}
                  workspaceId={workspaceId}
                  planVersionId={project.activeVersion.version.id}
                  csrfToken={authenticated.csrfToken}
                  editable={canMutate}
                  refreshToken={refreshToken}
                  onChanged={() => refreshNow()}
                />
              )
            }
            onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
            onOpenVersion={(planVersionId) =>
              go({
                name: 'plan-version',
                workspaceId,
                projectId: project.project.id,
                planVersionId,
              })
            }
            onViewArtifact={viewArtifact}
          />
        )}

        {route.name === 'plan-version' && planVersion?.version.id === route.planVersionId && (
          <PlanVersionPage
            workspaceId={workspaceId}
            detail={planVersion}
            branchSettings={
              <>
                <PlanBranchPanel
                  key={planVersion.version.id}
                  workspaceId={workspaceId}
                  planVersionId={planVersion.version.id}
                  csrfToken={authenticated.csrfToken}
                  editable={canMutate}
                  refreshToken={refreshToken}
                  onChanged={() => refreshNow()}
                />
                <FinalizationPanel
                  key={`finalize-${planVersion.version.id}`}
                  workspaceId={workspaceId}
                  planVersionId={planVersion.version.id}
                  csrfToken={authenticated.csrfToken}
                  canMutate={canMutate}
                  onOpenRun={(runId) => go({ name: 'run', workspaceId, runId })}
                />
              </>
            }
            onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
            onViewArtifact={viewArtifact}
          />
        )}

        {route.name === 'work-item' && workItem?.workItem.id === route.workItemId && (
          <div className="page">
            <WorkItemPage
              detail={workItem}
              inProgress={itemInProgress}
              sections={[
                { id: 'overview', label: 'Overview' },
                { id: 'branches', label: 'Branches' },
                ...(workItemExecution?.workItemId === route.workItemId
                  ? [
                      { id: 'automation', label: 'Automation' },
                      {
                        id: 'delegation',
                        label: 'Delegation',
                        count: workItemExecution.runs.length,
                      },
                    ]
                  : []),
                ...(diff !== undefined &&
                workItemExecution?.worktrees.some((worktree) => worktree.id === diff.worktree.id)
                  ? [{ id: 'diff', label: 'Diff' }]
                  : []),
              ]}
              onAdmit={() => handleAdmit(workItem.workItem.id)}
              onRemoveFromAgenda={() => {
                const version = workItem.agendaRemoval?.expectedVersion;
                if (version !== undefined)
                  itemCommand(async (csrf, ws) => {
                    await removeFromAgenda(ws, workItem.workItem.id, version, csrf);
                  }, 'Agenda removal failed');
              }}
              onComplete={() => handleComplete(workItem.workItem.id)}
              onOpenProject={() =>
                go({ name: 'project', workspaceId, projectId: workItem.workItem.projectId })
              }
              busy={itemBusy}
              canMutate={canMutate}
              {...(itemError === undefined ? {} : { error: itemError })}
            />
            <PlanBranchPanel
              key={workItem.workItem.planVersionId}
              workspaceId={workspaceId}
              planVersionId={workItem.workItem.planVersionId}
              csrfToken={authenticated.csrfToken}
              editable={false}
              refreshToken={refreshToken}
              onChanged={() => refreshNow()}
              collapsible
              defaultOpen={!itemInProgress && workItem.workItem.status !== 'completed'}
              {...(canMutate &&
              workItem.workItem.status !== 'completed' &&
              !workItemExecution?.worktrees.some((t) => t.executionScope)
                ? {
                    onCreateWorktree: (repositoryId: SourceRepositoryId) =>
                      handleCreateWorktree(workItem.workItem.id, repositoryId),
                  }
                : {})}
              creating={executionBusy}
              onOpenSettings={() =>
                go({
                  name: 'plan-version',
                  workspaceId,
                  projectId: workItem.workItem.projectId,
                  planVersionId: workItem.workItem.planVersionId,
                })
              }
            />
            {cycleControls(route.workItemId)}
            {delegationControls(route.workItemId)}
            {scopeControls(route.workItemId)}
            {diff !== undefined &&
              workItemExecution?.worktrees.some((worktree) => worktree.id === diff.worktree.id) && (
                <div id="diff">
                  <DiffView diff={diff} onClose={() => setDiff(undefined)} />
                </div>
              )}
          </div>
        )}

        {route.name === 'repositories' && (
          <RepositoriesPage
            repositories={repositories}
            {...(executionStatus === undefined ? {} : { status: executionStatus })}
            canMutate={canMutate}
            busy={executionBusy}
            {...(executionError === undefined ? {} : { error: executionError })}
            onRegister={handleRegisterRepository}
            onRetire={handleRetireRepository}
            checks={{
              workspaceId: route.workspaceId,
              csrfToken: authenticated.csrfToken,
              refreshToken,
            }}
          />
        )}

        {route.name === 'run' && run?.run.id === route.runId && (
          <RunPage
            detail={run}
            providerRecovery={cycles
              .filter(
                (c) =>
                  c.worktreeId === run.worktree.id &&
                  c.currentRunId === run.run.id &&
                  c.providerRecovery,
              )
              .map(
                (cycle) =>
                  authenticated !== undefined && (
                    <ProviderRetry
                      key={cycle.id}
                      cycle={cycle}
                      csrfToken={authenticated.csrfToken}
                      disabled={!canMutate || executionBusy}
                      onChanged={refreshNow}
                    />
                  ),
              )}
            events={runEvents}
            connection={runConnection}
            {...(diff?.worktree.id === run.worktree.id ? { diff } : {})}
            canMutate={canMutate}
            busy={executionBusy}
            {...(executionError === undefined ? {} : { error: executionError })}
            onSend={(text) => handleSendMessage(run.run.id, text)}
            onEnd={() => handleEndRun(run.run.id)}
            onCancel={() => handleCancelRun(run.run.id)}
            onOpenWorkItem={() =>
              run.run.workItemId
                ? go({ name: 'work-item', workspaceId, workItemId: run.run.workItemId })
                : run.run.planVersionId &&
                  go({
                    name: 'plan-version',
                    workspaceId,
                    projectId: run.run.projectId,
                    planVersionId: run.run.planVersionId,
                  })
            }
            onLoadDiff={() => handleLoadDiff(run.worktree.id)}
            onCloseDiff={() => setDiff(undefined)}
            {...(executionStatus === undefined ? {} : { backends: executionStatus.backends })}
            {...(runProfiles === undefined ? {} : { profiles: runProfiles.profiles })}
            {...(canMutate &&
            run.run.workItemId &&
            cycles.some(
              (cycle) =>
                cycle.worktreeId === run.worktree.id &&
                cycle.step === 'design' &&
                ['paused', 'needs-attention'].includes(cycle.status),
            )
              ? {
                  onResolveDesign: () => {
                    setSelectedCycleWorktreeId(run.worktree.id);
                    if (run.run.workItemId)
                      go({ name: 'work-item', workspaceId, workItemId: run.run.workItemId });
                  },
                }
              : {})}
            {...(workItemExecution && workItemExecution.workItemId === run.run.workItemId
              ? { runs: workItemExecution.runs }
              : {})}
            {...(canMutate && run.run.workItemId && run.worktree.status === 'active'
              ? {
                  onHandoff: (input: LaunchInput) => {
                    if (run.run.workItemId) handleLaunch(run.run.workItemId, input);
                  },
                }
              : {})}
          />
        )}

        {artifact !== undefined && (
          <section className="panel" aria-label="Source artifact">
            <h3>{artifact.filename}</h3>
            <SourceText text={artifact.text} label={`Source of ${artifact.filename}`} />
          </section>
        )}
      </>
    );
  };

  return (
    <NavigationProvider value={{ route, navigate: go }}>
      <WorkspaceShell
        username={authenticated.user.username}
        workspaces={workspaces}
        {...(activeWorkspaceId === undefined ? {} : { selectedWorkspaceId: activeWorkspaceId })}
        attentionCount={attentionItems.length}
        connection={projection.connection}
        route={route}
        theme={theme}
        onSelectWorkspace={(id) => {
          selectWorkspace(id);
          go({ name: 'dashboard', workspaceId: id });
        }}
        onToggleTheme={toggleTheme}
        onLogout={() => void handleLogout()}
      >
        {route.name === 'home' && (
          <WorkspacesPage
            workspaces={workspaces}
            busy={workspaceBusy}
            {...(workspaceError === undefined ? {} : { error: workspaceError })}
            onOpen={(id) => {
              selectWorkspace(id);
              go({ name: 'dashboard', workspaceId: id });
            }}
            onCreate={handleCreateWorkspace}
          />
        )}
        {route.name === 'account' && (
          <AccountPage
            user={authenticated.user}
            sessions={sessions}
            busy={accountBusy}
            {...(accountError === undefined ? {} : { error: accountError })}
            {...(accountNotice === undefined ? {} : { notice: accountNotice })}
            onRevoke={(id) => void handleRevoke(id)}
            onChangePassword={handleChangePassword}
          />
        )}
        {route.name === 'root' && <p className="empty-state">Opening your workspace…</p>}
        <RefreshSignalsProvider value={signals}>
          {workspaceRoute && workspaceContent()}
        </RefreshSignalsProvider>
      </WorkspaceShell>
    </NavigationProvider>
  );
}
