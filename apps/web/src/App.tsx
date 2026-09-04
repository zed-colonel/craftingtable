import type {
  AgentRunDetailResponse,
  AuditRecordSummary,
  AuthenticatedSessionResponse,
  ExecutionStatusResponse,
  PlanImportResponse,
  PlanVersionDetailResponse,
  ProjectDetailResponse,
  RunEventEnvelope,
  SessionSummary,
  SourceRepositorySummary,
  WorkItemDetailResponse,
  WorkItemExecutionResponse,
  WorkspaceEventEnvelope,
  WorkspaceSummary,
  WorktreeDiffResponse,
} from '@craftingtable/contracts';
import type {
  AgentRunId,
  PlanArtifactId,
  SessionId,
  SourceRepositoryId,
  WorkItemId,
  WorkspaceId,
  WorktreeId,
} from '@craftingtable/domain';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityPanel } from './components/ActivityPanel.js';
import { AuditPanel } from './components/AuditPanel.js';
import { LoginPage } from './components/LoginPage.js';
import { SessionPanel } from './components/SessionPanel.js';
import { StatusRegions } from './components/StatusRegions.js';
import { WorkspaceShell } from './components/WorkspaceShell.js';
import { DelegationPanel, type LaunchInput } from './features/execution/DelegationPanel.js';
import { DiffView } from './features/execution/DiffView.js';
import { RepositoriesPage } from './features/execution/RepositoriesPage.js';
import { RunPage } from './features/execution/RunPage.js';
import { ImportPlanPage } from './features/planning/ImportPlanPage.js';
import { PlanVersionPage } from './features/planning/PlanVersionPage.js';
import { ProjectCards } from './features/planning/ProjectCards.js';
import { ProjectPage } from './features/planning/ProjectPage.js';
import { SourceText } from './features/planning/SourceText.js';
import { WorkItemPage } from './features/planning/WorkItemPage.js';
import {
  ApiError,
  loadSession,
  loadSessions,
  loadWorkspaceAudit,
  loadWorkspaceSnapshot,
  loadWorkspaces,
  login,
  logout,
  revokeSession,
} from './lib/api-client.js';
import { authenticationMessage, type AuthenticationStatus } from './lib/auth-state.js';
import {
  cancelRun,
  createWorktree,
  endRun,
  loadExecutionStatus,
  loadRepositories,
  loadRun,
  loadRunEvents,
  loadWorkItemExecution,
  loadWorktreeDiff,
  registerRepository,
  removeWorktree,
  retireRepository,
  sendRunMessage,
  startRun,
} from './lib/execution-api.js';
import {
  admitWorkItem,
  importPlanBundle,
  loadArtifactText,
  loadPlanVersion,
  loadProject,
  loadWorkItem,
  type PlanImportUpload,
} from './lib/planning-api.js';
import { buildPath, type Route } from './lib/route.js';
import { useRoute } from './lib/use-route.js';
import { useRunEventStream } from './lib/use-run-event-stream.js';
import { useWorkspaceEventStream } from './lib/use-workspace-event-stream.js';
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
  const [workspaces, setWorkspaces] = useState<readonly WorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<WorkspaceId>();
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);
  const [audit, setAudit] = useState<readonly AuditRecordSummary[]>([]);
  const [streamAfter, setStreamAfter] = useState(0);
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
  const routedWorkspaceId = route.workspaceId;
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
  const [admitting, setAdmitting] = useState(false);
  const [admitError, setAdmitError] = useState<string>();
  const [refreshToken, setRefreshToken] = useState(0);

  // Delegation state: repositories, the active work item's worktrees and runs,
  // one run being followed live, and one diff being inspected.
  const [repositories, setRepositories] = useState<readonly SourceRepositorySummary[]>([]);
  const [executionStatus, setExecutionStatus] = useState<ExecutionStatusResponse>();
  const [workItemExecution, setWorkItemExecution] = useState<WorkItemExecutionResponse>();
  const [run, setRun] = useState<AgentRunDetailResponse>();
  const [runEvents, setRunEvents] = useState<readonly RunEventEnvelope[]>([]);
  const [runStreamAfter, setRunStreamAfter] = useState<number>();
  const [runConnection, setRunConnection] = useState<ConnectionState>('connecting');
  const [diff, setDiff] = useState<WorktreeDiffResponse>();
  const [executionBusy, setExecutionBusy] = useState(false);
  const [executionError, setExecutionError] = useState<string>();

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
    setAdmitting(false);
    setProject(undefined);
    setPlanVersion(undefined);
    setWorkItem(undefined);
    setArtifact(undefined);
    setImportResult(undefined);
    setImportError(undefined);
    setAdmitError(undefined);
    setAudit([]);
    setStreamAfter(0);
    setRepositories([]);
    setWorkItemExecution(undefined);
    setRun(undefined);
    setRunEvents([]);
    setRunStreamAfter(undefined);
    setDiff(undefined);
    setExecutionBusy(false);
    setExecutionError(undefined);
    dispatch({ type: 'workspace-changed' });
  }, []);

  const establishSession = useCallback(async (session: AuthenticatedSessionResponse) => {
    setAuthenticated(session);
    setAuthenticationStatus('authenticated');
    const [workspaceResponse, sessionResponse] = await Promise.all([
      loadWorkspaces(),
      loadSessions(),
    ]);
    setWorkspaces(workspaceResponse.workspaces);
    setSessions(sessionResponse.sessions);
    setSelectedWorkspaceId((current) => {
      const keep = workspaceResponse.workspaces.some((workspace) => workspace.id === current);
      return keep ? current : workspaceResponse.workspaces[0]?.id;
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

  // A deep link selects the workspace it addresses.
  useEffect(() => {
    if (route.name !== 'dashboard' || route.workspaceId !== undefined) {
      const target = route.name === 'dashboard' ? route.workspaceId : route.workspaceId;
      if (
        target !== undefined &&
        target !== selectedWorkspaceId &&
        workspaces.some((workspace) => workspace.id === target)
      ) {
        // A deep link to another workspace is a workspace switch too.
        selectWorkspace(target);
      }
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
    ])
      .then(([snapshot, auditPage]) => {
        if (canceled) {
          return;
        }
        setStreamAfter((current) => Math.max(current, snapshot.asOfSequence));
        setAudit(auditPage.records);
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

  // Detail views refetch whenever their route or the refresh token changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate refetch trigger
  useEffect(() => {
    if (workspaceId === undefined || authenticationStatus !== 'authenticated') {
      return;
    }
    let canceled = false;
    const requestedFor = workspaceId;
    const current = (): boolean => !canceled && activeWorkspaceIdRef.current === requestedFor;
    const fail = (): void => {
      if (current()) {
        dispatch({ type: 'refresh-failed' });
      }
    };
    if (route.name === 'project') {
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
      ])
        .then(([detail, execution, repositoryList, status]) => {
          if (current()) {
            setWorkItem(detail);
            setWorkItemExecution(execution);
            setRepositories(repositoryList.repositories);
            setExecutionStatus(status);
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
      void loadRun(workspaceId, route.runId)
        .then((detail) => {
          if (current()) {
            setRun(detail);
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
    if (event.kind === 'run-finished' || event.kind === 'turn-completed') {
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

  const handleAdmit = (workItemId: WorkItemId): void => {
    if (workspaceId === undefined || authenticated === undefined) {
      return;
    }
    const requestedFor = workspaceId;
    setAdmitting(true);
    setAdmitError(undefined);
    void admitWorkItem(workspaceId, workItemId, authenticated.csrfToken)
      .then(() => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setRefreshToken((current) => current + 1);
        }
      })
      .catch((error: unknown) => {
        if (activeWorkspaceIdRef.current !== requestedFor) {
          return;
        }
        setAdmitError(error instanceof ApiError ? error.message : 'Admission failed');
      })
      .finally(() => {
        if (activeWorkspaceIdRef.current === requestedFor) {
          setAdmitting(false);
        }
      });
  };

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

  const canMutate =
    workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.role !== 'viewer';

  return (
    <WorkspaceShell
      username={authenticated.user.username}
      workspaces={workspaces}
      selectedWorkspaceId={activeWorkspaceId}
      connection={projection.connection}
      onSelectWorkspace={(id) => {
        selectWorkspace(id);
        go({ name: 'dashboard', workspaceId: id });
      }}
      onLogout={() => void handleLogout()}
      navigation={
        selectedWorkspaceId === undefined ? undefined : (
          <nav className="planning-nav" aria-label="Planning">
            <a
              href={buildPath({ name: 'dashboard', workspaceId: selectedWorkspaceId })}
              onClick={(event) => {
                event.preventDefault();
                go({ name: 'dashboard', workspaceId: selectedWorkspaceId });
              }}
            >
              Dashboard
            </a>
            <a
              href={buildPath({ name: 'import', workspaceId: selectedWorkspaceId })}
              onClick={(event) => {
                event.preventDefault();
                go({ name: 'import', workspaceId: selectedWorkspaceId });
              }}
            >
              Import plan
            </a>
            <a
              href={buildPath({ name: 'repositories', workspaceId: selectedWorkspaceId })}
              onClick={(event) => {
                event.preventDefault();
                go({ name: 'repositories', workspaceId: selectedWorkspaceId });
              }}
            >
              Repositories
            </a>
          </nav>
        )
      }
    >
      {workspaces.length === 0 ? (
        <p className="empty-state">This user has no authorized workspaces.</p>
      ) : projection.snapshotStatus === 'loading' ? (
        <p className="empty-state">Loading durable workspace snapshot…</p>
      ) : projection.snapshotStatus === 'error' ? (
        <p className="error-state" role="alert">
          The workspace snapshot could not be loaded.
        </p>
      ) : projection.workspace?.id !== activeWorkspaceId ? (
        // Never render one workspace's projection under another's identity,
        // whatever order the state updates arrive in, and whether the change
        // came from the picker or the URL (CT03-RR4, CT03-R2R4, CT03-I14).
        <p className="empty-state">Loading durable workspace snapshot…</p>
      ) : (
        <>
          {projection.refreshFailed && (
            <p className="warning-state" role="alert">
              The latest refresh failed. The last committed planning state remains visible.
            </p>
          )}

          {route.name === 'import' && workspaceId !== undefined && (
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
              onOpenWorkItem={(workItemId) =>
                workspaceId !== undefined && go({ name: 'work-item', workspaceId, workItemId })
              }
              onOpenVersion={(planVersionId) =>
                workspaceId !== undefined &&
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
              onOpenWorkItem={(workItemId) =>
                workspaceId !== undefined && go({ name: 'work-item', workspaceId, workItemId })
              }
              onViewArtifact={viewArtifact}
            />
          )}

          {route.name === 'work-item' && workItem?.workItem.id === route.workItemId && (
            <>
              <WorkItemPage
                detail={workItem}
                onAdmit={() => handleAdmit(workItem.workItem.id)}
                admitting={admitting}
                canAdmit={canMutate}
                {...(admitError === undefined ? {} : { admitError })}
              />
              {workItemExecution?.workItemId === route.workItemId && (
                <DelegationPanel
                  repositories={repositories}
                  worktrees={workItemExecution.worktrees}
                  runs={workItemExecution.runs}
                  canMutate={canMutate}
                  busy={executionBusy}
                  {...(executionError === undefined ? {} : { error: executionError })}
                  backendAvailable={
                    executionStatus?.backends.some((backend) => backend.available) ?? true
                  }
                  onCreateWorktree={(repositoryId) =>
                    handleCreateWorktree(workItem.workItem.id, repositoryId)
                  }
                  onRemoveWorktree={handleRemoveWorktree}
                  onLaunch={(input) => handleLaunch(workItem.workItem.id, input)}
                  onOpenRun={(runId) =>
                    workspaceId !== undefined && go({ name: 'run', workspaceId, runId })
                  }
                  onOpenDiff={handleLoadDiff}
                />
              )}
              {diff !== undefined &&
                workItemExecution?.worktrees.some(
                  (worktree) => worktree.id === diff.worktree.id,
                ) && <DiffView diff={diff} onClose={() => setDiff(undefined)} />}
            </>
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

          {route.name === 'run' && run?.run.id === route.runId && workspaceId !== undefined && (
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
            />
          )}

          {artifact !== undefined && (
            <section className="panel" aria-label="Source artifact">
              <h3>{artifact.filename}</h3>
              <SourceText text={artifact.text} label={`Source of ${artifact.filename}`} />
            </section>
          )}

          {route.name === 'dashboard' && (
            <>
              <StatusRegions summary={projection.statusSummary} />
              <ProjectCards
                projects={projection.projects}
                onOpen={(projectId) =>
                  workspaceId !== undefined && go({ name: 'project', workspaceId, projectId })
                }
              />
              <ActivityPanel
                connection={projection.connection}
                events={projection.events}
                invalidPayloadCount={projection.invalidPayloadCount}
                foreignWorkspaceEventCount={projection.foreignWorkspaceEventCount}
              />
              <div className="utility-grid">
                <AuditPanel records={audit} />
                <SessionPanel sessions={sessions} onRevoke={(id) => void handleRevoke(id)} />
              </div>
            </>
          )}
        </>
      )}
    </WorkspaceShell>
  );
}
