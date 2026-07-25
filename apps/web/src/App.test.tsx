import type {
  AuthenticatedSessionResponse,
  WorkspaceAuditPageResponse,
  WorkspaceListResponse,
  WorkspaceSnapshotResponse,
} from '@craftingtable/contracts';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * CT03-RR4 regression cover.
 *
 * The re-review found that switching workspaces committed a render with the new
 * workspace selected and the *previous* workspace's projection, because the
 * clearing ran in a post-render effect. This drives the real selection path and
 * holds the second workspace's requests pending, so any leaked content from the
 * first workspace is visible to the assertions.
 */

const EMPTY_RISK_COUNTS = { low: 0, medium: 0, high: 0, critical: 0, unspecified: 0 };

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const SESSION = {
  user: { id: 'user-1', username: 'keith', status: 'active' },
  session: {
    id: 'session-1',
    createdAt: '2026-07-24T00:00:00.000Z',
    lastSeenAt: '2026-07-24T00:00:00.000Z',
    expiresAt: '2026-08-24T00:00:00.000Z',
    status: 'active',
    current: true,
  },
  csrfToken: 'csrf-token-value',
} as unknown as AuthenticatedSessionResponse;

const WORKSPACES = {
  workspaces: [
    {
      id: 'workspace-a',
      name: 'Workspace A',
      slug: 'workspace-a',
      status: 'active',
      role: 'owner',
    },
    {
      id: 'workspace-b',
      name: 'Workspace B',
      slug: 'workspace-b',
      status: 'active',
      role: 'owner',
    },
  ],
} as unknown as WorkspaceListResponse;

function snapshotFor(id: string, projectName: string, eventName: string) {
  return {
    workspace: {
      id,
      name: id === 'workspace-a' ? 'Workspace A' : 'Workspace B',
      slug: id,
      status: 'active',
      role: 'owner',
    },
    asOfSequence: id === 'workspace-a' ? 5 : 9,
    statusSummary: {
      needsAttention: 0,
      active: 0,
      planningReady: id === 'workspace-a' ? 7 : 3,
      dependencyBlocked: 0,
    },
    planningSummary: {
      projectCount: 1,
      importAttentionCount: 0,
      proposedCount: 0,
      admittedCount: 0,
      planningReadyCount: 0,
      dependencyBlockedCount: 0,
      riskCounts: EMPTY_RISK_COUNTS,
    },
    projects: [
      {
        id: `project-${id}`,
        name: projectName,
        slug: 'p',
        versionCount: 1,
        warningCount: 0,
        createdAt: '2026-07-24T00:00:00.000Z',
        proposedCount: 0,
        admittedCount: 0,
        planningReadyCount: 0,
        dependencyBlockedCount: 0,
        riskCounts: EMPTY_RISK_COUNTS,
      },
    ],
    recentActivity: [
      {
        id: `event-${id}`,
        sequence: id === 'workspace-a' ? 5 : 9,
        occurredAt: '2026-07-24T00:00:00.000Z',
        workspaceId: id,
        schemaVersion: 1,
        kind: 'project-created',
        payload: { projectId: `project-${id}`, name: eventName },
      },
    ],
  } as unknown as WorkspaceSnapshotResponse;
}

const SNAPSHOT_A = snapshotFor('workspace-a', 'Alpha Project', 'Alpha Activity');
const SNAPSHOT_B = snapshotFor('workspace-b', 'Beta Project', 'Beta Activity');

const AUDIT_A = {
  records: [
    {
      sequence: 1,
      id: 'audit-a',
      occurredAt: '2026-07-24T00:00:00.000Z',
      actorKind: 'user',
      action: 'plan.import.succeeded',
      outcome: 'succeeded',
    },
  ],
} as unknown as WorkspaceAuditPageResponse;

const snapshotCalls: string[] = [];
let pendingSnapshotB: Deferred<WorkspaceSnapshotResponse>;

vi.mock('./lib/api-client.js', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
  loadSession: () => Promise.resolve(SESSION),
  loadSessions: () => Promise.resolve({ sessions: [] }),
  loadWorkspaces: () => Promise.resolve(WORKSPACES),
  loadWorkspaceSnapshot: (id: string) => {
    snapshotCalls.push(id);
    return id === 'workspace-a' ? Promise.resolve(SNAPSHOT_A) : pendingSnapshotB.promise;
  },
  loadWorkspaceAudit: (id: string) =>
    Promise.resolve(id === 'workspace-a' ? AUDIT_A : { records: [] }),
  login: () => Promise.resolve(SESSION),
  logout: () => Promise.resolve(),
  revokeSession: () => Promise.resolve(false),
  request: () => Promise.reject(new Error('not used')),
}));

// The event stream is irrelevant to this transition; keep it inert.
vi.mock('./lib/use-workspace-event-stream.js', () => ({
  useWorkspaceEventStream: () => undefined,
}));

vi.mock('./lib/planning-api.js', () => ({
  loadProjects: () => new Promise(() => undefined),
  loadProject: () => new Promise(() => undefined),
  loadPlanVersion: () => new Promise(() => undefined),
  loadWorkItem: () => new Promise(() => undefined),
  loadImportAttempts: () => new Promise(() => undefined),
  loadArtifactText: () => new Promise(() => undefined),
  admitWorkItem: () => new Promise(() => undefined),
  importPlanBundle: () => new Promise(() => undefined),
}));

const { App } = await import('./App.js');

beforeEach(() => {
  snapshotCalls.length = 0;
  pendingSnapshotB = deferred<WorkspaceSnapshotResponse>();
  window.history.replaceState(null, '', '/');
});

afterEach(cleanup);

describe('workspace switching in the app (CT03-RR4)', () => {
  it('never renders the previous workspace projection under the new selection', async () => {
    render(<App />);

    // Workspace A is fully loaded and visible.
    await screen.findByText('Alpha Project');
    expect(screen.getByText('Project created: Alpha Activity')).toBeDefined();
    expect(screen.getByText('7')).toBeDefined();

    // Select workspace B and hold its snapshot pending.
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: 'workspace-b' },
    });

    await waitFor(() => expect(snapshotCalls).toContain('workspace-b'));

    // With B selected and its data still in flight, nothing from A may render.
    expect(screen.queryByText('Alpha Project')).toBeNull();
    expect(screen.queryByText('Project created: Alpha Activity')).toBeNull();
    expect(screen.queryByText('7')).toBeNull();
    expect(screen.getByText('Loading durable workspace snapshot…')).toBeDefined();

    // Once B resolves, only B's content appears.
    pendingSnapshotB.resolve(SNAPSHOT_B);
    await screen.findByText('Beta Project');
    expect(screen.getByText('Project created: Beta Activity')).toBeDefined();
    expect(screen.queryByText('Alpha Project')).toBeNull();
    expect(screen.queryByText('Project created: Alpha Activity')).toBeNull();
  });

  it('keeps the previous workspace hidden when the new snapshot fails', async () => {
    render(<App />);
    await screen.findByText('Alpha Project');

    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: 'workspace-b' },
    });
    await waitFor(() => expect(snapshotCalls).toContain('workspace-b'));

    pendingSnapshotB.reject(new Error('snapshot unavailable'));

    // A failed switch must degrade visibly, never fall back to workspace A.
    await screen.findByText('The workspace snapshot could not be loaded.');
    expect(screen.queryByText('Alpha Project')).toBeNull();
    expect(screen.queryByText('Project created: Alpha Activity')).toBeNull();
  });

  it('clears the audit panel belonging to the previous workspace', async () => {
    render(<App />);
    await screen.findByText('Alpha Project');
    expect(screen.getByText('plan.import.succeeded')).toBeDefined();

    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: 'workspace-b' },
    });
    await waitFor(() => expect(snapshotCalls).toContain('workspace-b'));
    expect(screen.queryByText('plan.import.succeeded')).toBeNull();

    pendingSnapshotB.resolve(SNAPSHOT_B);
    await screen.findByText('Beta Project');
    expect(screen.queryByText('plan.import.succeeded')).toBeNull();
  });
});
