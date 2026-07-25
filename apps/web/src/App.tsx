import type {
  AuditRecordSummary,
  AuthenticatedSessionResponse,
  PlanImportResponse,
  PlanVersionDetailResponse,
  ProjectDetailResponse,
  SessionSummary,
  WorkItemDetailResponse,
  WorkspaceEventEnvelope,
  WorkspaceSummary,
} from '@craftingtable/contracts';
import type { PlanArtifactId, SessionId, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { ActivityPanel } from './components/ActivityPanel.js';
import { AuditPanel } from './components/AuditPanel.js';
import { LoginPage } from './components/LoginPage.js';
import { SessionPanel } from './components/SessionPanel.js';
import { StatusRegions } from './components/StatusRegions.js';
import { WorkspaceShell } from './components/WorkspaceShell.js';
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
import { useWorkspaceEventStream } from './lib/use-workspace-event-stream.js';
import {
  INITIAL_WORKSPACE_PROJECTION,
  reduceWorkspaceProjection,
} from './lib/workspace-projection.js';

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
    setProject(undefined);
    setPlanVersion(undefined);
    setWorkItem(undefined);
    setArtifact(undefined);
    setImportResult(undefined);
    setImportError(undefined);
    setAdmitError(undefined);
    setAudit([]);
    setStreamAfter(0);
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
    if (authenticationStatus !== 'authenticated' || selectedWorkspaceId === undefined) {
      return;
    }
    let canceled = false;
    if (projection.snapshotStatus === 'idle') {
      dispatch({ type: 'snapshot-requested' });
    }
    void Promise.all([
      loadWorkspaceSnapshot(selectedWorkspaceId),
      loadWorkspaceAudit(selectedWorkspaceId),
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
  }, [authenticationStatus, selectedWorkspaceId, refreshToken, projection.snapshotStatus]);

  /**
   * Relevant events mark scopes stale; the app then refetches the authoritative
   * queries. Event payloads are never treated as the planning model (CT03-A66).
   */
  useEffect(() => {
    if (!projection.stale.workspaceSummary && projection.stale.workItemIds.length === 0) {
      return;
    }
    dispatch({ type: 'stale-consumed' });
    setRefreshToken((current) => current + 1);
  }, [projection.stale]);

  const workspaceId = selectedWorkspaceId;

  // Detail views refetch whenever their route or the refresh token changes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate refetch trigger
  useEffect(() => {
    if (workspaceId === undefined || authenticationStatus !== 'authenticated') {
      return;
    }
    let canceled = false;
    const fail = (): void => {
      if (!canceled) {
        dispatch({ type: 'refresh-failed' });
      }
    };
    if (route.name === 'project') {
      void loadProject(workspaceId, route.projectId)
        .then((detail) => {
          if (!canceled) {
            setProject(detail);
          }
        })
        .catch(fail);
    } else if (route.name === 'plan-version') {
      void loadPlanVersion(workspaceId, route.projectId, route.planVersionId)
        .then((detail) => {
          if (!canceled) {
            setPlanVersion(detail);
          }
        })
        .catch(fail);
    } else if (route.name === 'work-item') {
      void loadWorkItem(workspaceId, route.workItemId)
        .then((detail) => {
          if (!canceled) {
            setWorkItem(detail);
          }
        })
        .catch(fail);
    }
    return () => {
      canceled = true;
    };
  }, [route, workspaceId, authenticationStatus, refreshToken]);

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
    setImportBusy(true);
    setImportError(undefined);
    void importPlanBundle(workspaceId, upload, authenticated.csrfToken)
      .then((response) => {
        setImportResult(response);
        setRefreshToken((current) => current + 1);
        if (response.outcome !== 'failed-validation') {
          go({ name: 'project', workspaceId, projectId: response.projectId });
        }
      })
      .catch((error: unknown) => {
        setImportError(
          error instanceof ApiError ? error.message : 'The plan import request failed',
        );
      })
      .finally(() => setImportBusy(false));
  };

  const handleAdmit = (workItemId: WorkItemId): void => {
    if (workspaceId === undefined || authenticated === undefined) {
      return;
    }
    setAdmitting(true);
    setAdmitError(undefined);
    void admitWorkItem(workspaceId, workItemId, authenticated.csrfToken)
      .then(() => setRefreshToken((current) => current + 1))
      .catch((error: unknown) => {
        setAdmitError(error instanceof ApiError ? error.message : 'Admission failed');
      })
      .finally(() => setAdmitting(false));
  };

  const viewArtifact = (artifactId: PlanArtifactId, filename: string): void => {
    if (workspaceId === undefined) {
      return;
    }
    void loadArtifactText(workspaceId, artifactId)
      .then((text) => setArtifact({ filename, text }))
      .catch(() => setArtifact({ filename, text: 'The source artifact could not be loaded.' }));
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
      selectedWorkspaceId={selectedWorkspaceId}
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
      ) : projection.workspace?.id !== selectedWorkspaceId ? (
        // Never render one workspace's projection under another's identity,
        // whatever order the state updates arrive in (CT03-RR4, CT03-I14).
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
            <WorkItemPage
              detail={workItem}
              onAdmit={() => handleAdmit(workItem.workItem.id)}
              admitting={admitting}
              canAdmit={canMutate}
              {...(admitError === undefined ? {} : { admitError })}
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
