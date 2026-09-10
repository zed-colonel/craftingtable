import type {
  AgentRunDetailResponse,
  AuditRecordSummary,
  AuthenticatedSessionResponse,
  ExecutionStatusResponse,
  PlanImportResponse,
  PlanVersionDetailResponse,
  ProjectDetailResponse,
  RepositoryBranchesResponse,
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
  AgentRunProfile,
  PlanArtifactId,
  SessionId,
  SourceRepositoryId,
  WorkCycle,
  WorkItemId,
  WorkspaceId,
  WorktreeId,
} from '@craftingtable/domain';
import { type ReactElement, useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityPanel } from './components/ActivityPanel.js';
import { AuditPanel } from './components/AuditPanel.js';
import { LoginPage } from './components/LoginPage.js';
import { StatusCards } from './components/StatusCards.js';
import { WorkspaceShell } from './components/WorkspaceShell.js';
import { AccountPage } from './features/account/AccountPage.js';
import { CYCLE_STATUS_LABELS, CyclePanel } from './features/execution/CyclePanel.js';
import { DelegationPanel, type LaunchInput } from './features/execution/DelegationPanel.js';
import { DiffView } from './features/execution/DiffView.js';
import { PlanBranchPanel } from './features/execution/PlanBranchPanel.js';
import { RepositoriesPage } from './features/execution/RepositoriesPage.js';
import { RunPage } from './features/execution/RunPage.js';
import { RunList, RunsPage } from './features/execution/RunsPage.js';
import { WorktreeBranchPanel } from './features/execution/WorktreeBranchPanel.js';
import { WorkspacesPage } from './features/home/WorkspacesPage.js';
import { AgendaPage } from './features/planning/AgendaPage.js';
import { ImportPlanPage } from './features/planning/ImportPlanPage.js';
import { PlanVersionPage } from './features/planning/PlanVersionPage.js';
import { ProjectCards } from './features/planning/ProjectCards.js';
import { ProjectPage } from './features/planning/ProjectPage.js';
import { SourceText } from './features/planning/SourceText.js';
import { WorkItemPage } from './features/planning/WorkItemPage.js';
import { SettingsPage } from './features/workspace/SettingsPage.js';
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
  loadRepositoryBranches,
  loadRun,
  loadRunEvents,
  loadRunProfiles,
  loadWorkItemExecution,
  loadWorkspaceRuns,
  loadWorktreeDiff,
  mergeWorktree,
  registerRepository,
  removeWorktree,
  retireRepository,
  saveRunProfiles,
  sendRunMessage,
  startRun,
} from './lib/execution-api.js';
import { isLiveStatus } from './lib/execution-labels.js';
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
} from './lib/planning-api.js';
import { type Route, routeWorkspaceId } from './lib/route.js';
import {
  currentTheme,
  persistTheme,
  rememberedWorkspace,
  rememberWorkspace,
  type Theme,
} from './lib/theme.js';
import { useRoute } from './lib/use-route.js';
import { useRunEventStream } from './lib/use-run-event-stream.js';
import { useWorkspaceEventStream } from './lib/use-workspace-event-stream.js';
import { controlWorkCycle, loadWorkCycles, startWorkCycle } from './lib/work-cycle-api.js';
import {
  type ConnectionState,
  INITIAL_WORKSPACE_PROJECTION,
  reduceWorkspaceProjection,
} from './lib/workspace-projection.js';

/** Pages the initial run-event load walks before handing over to the stream. */
const RUN_EVENT_PAGE_LIMIT = 20;

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
  const [refreshToken, setRefreshToken] = useState(0);
  const [cycleState, setCycleState] = useState<{
    workspaceId: WorkspaceId;
    cycles: readonly WorkCycle[];
  }>();
  const [cycleLoadError, setCycleLoadError] = useState<WorkspaceId>();

  // Delegation state: repositories, the active work item's worktrees and runs,
  // one run being followed live, and one diff being inspected.
  const [repositories, setRepositories] = useState<readonly SourceRepositorySummary[]>([]);
  const [executionStatus, setExecutionStatus] = useState<ExecutionStatusResponse>();
  const [runProfiles, setRunProfiles] = useState<RunProfilesResponse>();
  const [profilesBusy, setProfilesBusy] = useState(false);
  const [profilesError, setProfilesError] = useState<string>();
  const [profilesNotice, setProfilesNotice] = useState<string>();
  const [workItemExecution, setWorkItemExecution] = useState<WorkItemExecutionResponse>();
  const [runsOverview, setRunsOverview] = useState<WorkspaceRunsResponse>();
  const [branches, setBranches] = useState<RepositoryBranchesResponse>();
  const [agenda, setAgenda] = useState<WorkspaceWorkItemListResponse>();
  const [run, setRun] = useState<AgentRunDetailResponse>();
  const [runEvents, setRunEvents] = useState<readonly RunEventEnvelope[]>([]);
  const [runStreamAfter, setRunStreamAfter] = useState<number>();
  const [runConnection, setRunConnection] = useState<ConnectionState>('connecting');
  const [diff, setDiff] = useState<WorktreeDiffResponse>();
  const [executionBusy, setExecutionBusy] = useState(false);
  const [executionError, setExecutionError] = useState<string>();

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
    setRunsOverview(undefined);
    setBranches(undefined);
    setAgenda(undefined);
    setRun(undefined);
    setRunEvents([]);
    setRunStreamAfter(undefined);
    setDiff(undefined);
    setExecutionBusy(false);
    setExecutionError(undefined);
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

  // Elapsed times on run rows tick without a stream event.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
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
    void Promise.all([
      loadWorkspaceSnapshot(activeWorkspaceId),
      loadWorkspaceAudit(activeWorkspaceId),
      loadWorkspaces(),
    ])
      .then(([snapshot, auditPage, workspaceList]) => {
        if (canceled) {
          return;
        }
        setStreamAfter((current) => Math.max(current, snapshot.asOfSequence));
        setAudit(auditPage.records);
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
    return () => {
      canceled = true;
    };
    // `refreshToken` re-runs this effect when an event invalidates the summary.
  }, [authenticationStatus, activeWorkspaceId, refreshToken, projection.snapshotStatus]);

  /**
   * Relevant events mark scopes stale; the app then refetches the authoritative
   * queries. Event payloads are never treated as the planning model (CT03-A66).
   */
  useEffect(() => {
    if (
      !projection.stale.workspaceSummary &&
      projection.stale.projectIds.length === 0 &&
      projection.stale.workItemIds.length === 0 &&
      !projection.stale.repositoryList
    ) {
      return;
    }
    dispatch({
      type: 'stale-consumed',
      consumed: {
        ...(projection.stale.workspaceSummary ? { workspaceSummary: true } : {}),
        ...(projection.stale.repositoryList ? { repositoryList: true } : {}),
        ...(projection.stale.projectIds.length === 0
          ? {}
          : { projectIds: projection.stale.projectIds }),
        ...(projection.stale.workItemIds.length === 0
          ? {}
          : { workItemIds: projection.stale.workItemIds }),
      },
    });
    setRefreshToken((current) => current + 1);
  }, [projection.stale]);

  const workspaceId = activeWorkspaceId;
  const cycles =
    cycleState !== undefined && cycleState.workspaceId === workspaceId ? cycleState.cycles : [];
  // biome-ignore lint/correctness/useExhaustiveDependencies: workspace events explicitly refresh persisted cycle status
  useEffect(() => {
    if (authenticationStatus !== 'authenticated' || workspaceId === undefined) return;
    let cancelled = false;
    void loadWorkCycles(workspaceId)
      .then((result) => {
        if (!cancelled && activeWorkspaceIdRef.current === workspaceId) {
          setCycleState({ workspaceId, cycles: result.cycles });
          setCycleLoadError(undefined);
        }
      })
      .catch(() => {
        if (!cancelled) setCycleLoadError(workspaceId);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, authenticationStatus, refreshToken]);

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
    if (route.name === 'dashboard' || route.name === 'runs') {
      void loadWorkspaceRuns(workspaceId)
        .then((response) => {
          if (current()) {
            setRunsOverview(response);
          }
        })
        .catch(fail);
    } else if (route.name === 'agenda') {
      void loadWorkspaceWorkItems(workspaceId, route.filter)
        .then((response) => {
          if (current()) {
            setAgenda(response);
          }
        })
        .catch(fail);
    } else if (route.name === 'project') {
      void loadProject(workspaceId, route.projectId)
        .then((detail) => {
          if (current()) {
            setProject(detail);
          }
        })
        .catch(fail);
    } else if (route.name === 'plan-version') {
      void loadPlanVersion(workspaceId, route.projectId, route.planVersionId)
        .then((detail) => {
          if (current()) {
            setPlanVersion(detail);
          }
        })
        .catch(fail);
    } else if (route.name === 'work-item') {
      void Promise.all([
        loadWorkItem(workspaceId, route.workItemId),
        loadWorkItemExecution(workspaceId, route.workItemId),
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
    } else if (route.name === 'settings') {
      void Promise.all([loadExecutionStatus(), loadRunProfiles(workspaceId)])
        .then(([status, profiles]) => {
          if (current()) {
            setExecutionStatus(status);
            setRunProfiles(profiles);
          }
        })
        .catch(fail);
    } else if (route.name === 'repositories') {
      void Promise.all([loadRepositories(workspaceId), loadExecutionStatus()])
        .then(([repositoryList, status]) => {
          if (current()) {
            setRepositories(repositoryList.repositories);
            setExecutionStatus(status);
          }
        })
        .catch(fail);
    } else if (route.name === 'run') {
      void Promise.all([
        loadRun(workspaceId, route.runId).then((detail) =>
          Promise.all([detail, loadWorkItemExecution(workspaceId, detail.run.workItemId)]),
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
    return () => {
      canceled = true;
    };
  }, [route, workspaceId, authenticationStatus, refreshToken]);

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
  const receiveRunEvent = useCallback((event: RunEventEnvelope) => {
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
      setRefreshToken((current) => current + 1);
    }
  }, []);
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
    setImportError(undefined);
    void importPlanBundle(workspaceId, upload, authenticated.csrfToken)
      .then((response) => {
        if (activeWorkspaceIdRef.current !== requestedFor) {
          return;
        }
        setImportResult(response);
        setRefreshToken((current) => current + 1);
        if (response.outcome !== 'failed-validation') {
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
          setRefreshToken((current) => current + 1);
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
          setRefreshToken((current) => current + 1);
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
  const handleRemoveWorktree = (worktreeId: WorktreeId): void =>
    executionCommand(async (csrfToken, forWorkspace) => {
      await removeWorktree(forWorkspace, worktreeId, csrfToken);
      setDiff((current) => (current?.worktree.id === worktreeId ? undefined : current));
    });
  const handleMergeWorktree = (worktreeId: WorktreeId, targetBranch: string): void =>
    executionCommand(async (csrfToken, forWorkspace) => {
      await mergeWorktree(forWorkspace, worktreeId, { targetBranch }, csrfToken);
      setDiff((current) => (current?.worktree.id === worktreeId ? undefined : current));
    });
  const handleLoadBranches = (repositoryId: SourceRepositoryId): void => {
    if (workspaceId === undefined) {
      return;
    }
    const requestedFor = workspaceId;
    void loadRepositoryBranches(workspaceId, repositoryId)
      .then((response) => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setBranches(response);
        }
      })
      .catch(() => undefined);
  };
  const handleSaveProfiles = (profiles: readonly AgentRunProfile[]): void => {
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
        setRefreshToken((current) => current + 1);
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

        {route.name === 'dashboard' && (
          <>
            <header className="page-header">
              <div>
                <h1>{shown.name}</h1>
                <p className="subtitle">
                  {projection.planningSummary.projectCount} project
                  {projection.planningSummary.projectCount === 1 ? '' : 's'} · signed in as{' '}
                  {authenticated.user.username}
                </p>
              </div>
              <div className="page-header-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => go({ name: 'import', workspaceId })}
                >
                  Import plan
                </button>
              </div>
            </header>
            <StatusCards
              summary={projection.statusSummary}
              onOpen={(target) => {
                if (target.kind === 'runs') go({ name: 'runs', workspaceId });
                else if (target.kind === 'import') go({ name: 'import', workspaceId });
                else go({ name: 'agenda', workspaceId, filter: target.filter });
              }}
            />
            <section className="panel" aria-label="Live runs">
              <div className="panel-header">
                <h3>Live runs</h3>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => go({ name: 'runs', workspaceId })}
                >
                  All runs
                </button>
              </div>
              <RunList
                runs={(runsOverview?.runs ?? []).filter((entry) => isLiveStatus(entry.status))}
                now={now}
                onOpenRun={(runId) => go({ name: 'run', workspaceId, runId })}
                onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
              />
            </section>
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
          </>
        )}

        {cycleLoadError === workspaceId && (
          <p role="alert">
            Cycle status could not be loaded. Refresh before controlling automation.
          </p>
        )}
        {cycles.some((cycle) => ['needs-attention', 'awaiting-merge'].includes(cycle.status)) && (
          <section className="panel cycle-notices" aria-label="Cycles needing attention">
            <h2>Cycles needing your attention</h2>
            {cycles
              .filter((cycle) => ['needs-attention', 'awaiting-merge'].includes(cycle.status))
              .map((cycle) => (
                <div key={cycle.id}>
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      go({ name: 'work-item', workspaceId, workItemId: cycle.workItemId })
                    }
                  >
                    {cycle.workItemSourceId}: {CYCLE_STATUS_LABELS[cycle.status]}
                  </button>
                  <p>{cycle.reason}</p>
                </div>
              ))}
          </section>
        )}

        {route.name === 'runs' && (
          <RunsPage
            runs={runsOverview?.runs ?? []}
            liveCount={runsOverview?.liveCount ?? 0}
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

        {route.name === 'settings' && activeWorkspace !== undefined && (
          <SettingsPage
            key={activeWorkspace.id}
            workspace={activeWorkspace}
            canEdit={activeWorkspace.role === 'owner'}
            busy={workspaceBusy}
            {...(workspaceError === undefined ? {} : { error: workspaceError })}
            {...(workspaceNotice === undefined ? {} : { notice: workspaceNotice })}
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
                  onChanged={() => setRefreshToken((v) => v + 1)}
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
            detail={planVersion}
            branchSettings={
              <PlanBranchPanel
                key={planVersion.version.id}
                workspaceId={workspaceId}
                planVersionId={planVersion.version.id}
                csrfToken={authenticated.csrfToken}
                editable={canMutate}
                refreshToken={refreshToken}
                onChanged={() => setRefreshToken((v) => v + 1)}
              />
            }
            onOpenWorkItem={(workItemId) => go({ name: 'work-item', workspaceId, workItemId })}
            onViewArtifact={viewArtifact}
          />
        )}

        {route.name === 'work-item' && workItem?.workItem.id === route.workItemId && (
          <div className="page">
            <WorkItemPage
              detail={workItem}
              inProgress={
                workItemExecution?.workItemId === route.workItemId &&
                (workItemExecution.worktrees.some((worktree) => worktree.status === 'active') ||
                  workItemExecution.runs.some((entry) => isLiveStatus(entry.status)))
              }
              onAdmit={() => handleAdmit(workItem.workItem.id)}
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
              onChanged={() => setRefreshToken((v) => v + 1)}
              {...(canMutate && workItem.workItem.status !== 'completed'
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
            {workItemExecution?.workItemId === route.workItemId &&
              cycleState?.workspaceId === workspaceId && (
                <CyclePanel
                  key={route.workItemId}
                  cycles={cycles.filter((cycle) => cycle.workItemId === route.workItemId)}
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
                  onControl={(cycle, action) =>
                    executionCommand(async (csrfToken) => {
                      await controlWorkCycle(cycle, action, csrfToken);
                    })
                  }
                  onOpenRun={(runId) => go({ name: 'run', workspaceId, runId })}
                />
              )}
            {workItemExecution?.workItemId === route.workItemId && (
              <DelegationPanel
                repositories={repositories}
                hideCreateWorktree
                renderBranchControls={(worktree) => (
                  <WorktreeBranchPanel
                    key={worktree.id}
                    workspaceId={workspaceId}
                    worktree={worktree}
                    csrfToken={authenticated.csrfToken}
                    canMutate={canMutate}
                    refreshToken={refreshToken}
                    onChanged={() => setRefreshToken((v) => v + 1)}
                  />
                )}
                worktrees={workItemExecution.worktrees}
                runs={workItemExecution.runs}
                mergeGates={workItemExecution.mergeGates}
                {...(branches === undefined ? {} : { branches })}
                backends={executionStatus?.backends ?? []}
                itemCompleted={workItem.workItem.status === 'completed'}
                canMutate={canMutate}
                busy={executionBusy}
                {...(executionError === undefined ? {} : { error: executionError })}
                onCreateWorktree={(repositoryId) =>
                  handleCreateWorktree(workItem.workItem.id, repositoryId)
                }
                onRemoveWorktree={handleRemoveWorktree}
                onMergeWorktree={handleMergeWorktree}
                onLoadBranches={handleLoadBranches}
                onLaunch={(input) => handleLaunch(workItem.workItem.id, input)}
                {...(runProfiles === undefined ? {} : { profiles: runProfiles.profiles })}
                onOpenRun={(runId) => go({ name: 'run', workspaceId, runId })}
                onOpenDiff={handleLoadDiff}
              />
            )}
            {diff !== undefined &&
              workItemExecution?.worktrees.some((worktree) => worktree.id === diff.worktree.id) && (
                <DiffView diff={diff} onClose={() => setDiff(undefined)} />
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
          />
        )}

        {route.name === 'run' && run?.run.id === route.runId && (
          <RunPage
            detail={run}
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
              go({ name: 'work-item', workspaceId, workItemId: run.run.workItemId })
            }
            onLoadDiff={() => handleLoadDiff(run.worktree.id)}
            onCloseDiff={() => setDiff(undefined)}
            {...(executionStatus === undefined ? {} : { backends: executionStatus.backends })}
            {...(runProfiles === undefined ? {} : { profiles: runProfiles.profiles })}
            {...(workItemExecution?.workItemId === run.run.workItemId
              ? { runs: workItemExecution.runs }
              : {})}
            {...(canMutate && run.worktree.status === 'active'
              ? { onHandoff: (input: LaunchInput) => handleLaunch(run.run.workItemId, input) }
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
    <WorkspaceShell
      username={authenticated.user.username}
      workspaces={workspaces}
      {...(activeWorkspaceId === undefined ? {} : { selectedWorkspaceId: activeWorkspaceId })}
      connection={projection.connection}
      route={route}
      theme={theme}
      onNavigate={go}
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
      {workspaceRoute && workspaceContent()}
    </WorkspaceShell>
  );
}
