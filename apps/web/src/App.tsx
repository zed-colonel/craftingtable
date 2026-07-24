import type {
  AuditRecordSummary,
  AuthenticatedSessionResponse,
  SessionSummary,
  WorkspaceEventEnvelope,
  WorkspaceSummary,
} from '@craftingtable/contracts';
import type { SessionId, WorkspaceId } from '@craftingtable/domain';
import { useCallback, useEffect, useReducer, useState } from 'react';
import { ActivityPanel } from './components/ActivityPanel.js';
import { AuditPanel } from './components/AuditPanel.js';
import { LoginPage } from './components/LoginPage.js';
import { SessionPanel } from './components/SessionPanel.js';
import { StatusRegions } from './components/StatusRegions.js';
import { WorkspaceShell } from './components/WorkspaceShell.js';
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

  const establishSession = useCallback(async (session: AuthenticatedSessionResponse) => {
    setAuthenticated(session);
    setAuthenticationStatus('authenticated');
    const [workspaceResponse, sessionResponse] = await Promise.all([
      loadWorkspaces(),
      loadSessions(),
    ]);
    setWorkspaces(workspaceResponse.workspaces);
    setSessions(sessionResponse.sessions);
    setSelectedWorkspaceId((current) =>
      workspaceResponse.workspaces.some((workspace) => workspace.id === current)
        ? current
        : workspaceResponse.workspaces[0]?.id,
    );
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

  useEffect(() => {
    if (authenticationStatus !== 'authenticated' || selectedWorkspaceId === undefined) {
      return;
    }
    let canceled = false;
    dispatch({ type: 'snapshot-requested' });
    void Promise.all([
      loadWorkspaceSnapshot(selectedWorkspaceId),
      loadWorkspaceAudit(selectedWorkspaceId),
    ])
      .then(([snapshot, auditPage]) => {
        if (canceled) {
          return;
        }
        setStreamAfter(snapshot.asOfSequence);
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
        } else {
          dispatch({ type: 'snapshot-failed' });
        }
      });
    return () => {
      canceled = true;
    };
  }, [authenticationStatus, selectedWorkspaceId]);

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
      setAudit([]);
      setSelectedWorkspaceId(undefined);
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

  return (
    <WorkspaceShell
      username={authenticated.user.username}
      workspaces={workspaces}
      selectedWorkspaceId={selectedWorkspaceId}
      connection={projection.connection}
      onSelectWorkspace={setSelectedWorkspaceId}
      onLogout={() => void handleLogout()}
    >
      {workspaces.length === 0 ? (
        <p className="empty-state">This user has no authorized workspaces.</p>
      ) : projection.snapshotStatus === 'loading' ? (
        <p className="empty-state">Loading durable workspace snapshot…</p>
      ) : projection.snapshotStatus === 'error' ? (
        <p className="error-state" role="alert">
          The workspace snapshot could not be loaded.
        </p>
      ) : (
        <>
          <StatusRegions summary={projection.statusSummary} />
          <ActivityPanel
            connection={projection.connection}
            events={projection.events}
            invalidEventCount={projection.invalidEventCount}
          />
          <div className="utility-grid">
            <AuditPanel records={audit} />
            <SessionPanel sessions={sessions} onRevoke={(id) => void handleRevoke(id)} />
          </div>
        </>
      )}
    </WorkspaceShell>
  );
}
