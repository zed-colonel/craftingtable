import type {
  AuthenticatedSessionResponse,
  WorkspaceAuditPageResponse,
  WorkspaceEventEnvelope,
  WorkspaceListResponse,
  WorkspaceSnapshotResponse,
} from '@craftingtable/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceEventStream } from './lib/use-workspace-event-stream.js';
import { asEventId } from '@craftingtable/domain';

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
      completed: 0,
      liveRuns: 0,
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

function projectDetailFor(workspaceId: string) {
  const label = workspaceId === 'workspace-a' ? 'Alpha' : 'Beta';
  return {
    project: {
      id: `project-${workspaceId}`,
      name: `${label} Project`,
      slug: 'p',
      activePlanVersionId: `version-${workspaceId}`,
      document: `${label} Plan`,
      versionCount: 1,
      warningCount: 0,
      createdAt: '2026-07-24T00:00:00.000Z',
      proposedCount: 1,
      admittedCount: 0,
      planningReadyCount: 1,
      dependencyBlockedCount: 0,
      riskCounts: EMPTY_RISK_COUNTS,
    },
    versions: [],
    activeVersion: {
      version: {
        id: `version-${workspaceId}`,
        versionNumber: 1,
        contentDigest: 'd'.repeat(64),
        document: `${label} Plan`,
        itemCount: 1,
        requiredDependencyCount: 0,
        createdAt: '2026-07-24T00:00:00.000Z',
        isActive: true,
        sourceProfile: 'exo-work-breakdown-v1',
        digestAlgorithm: 'sha-256',
        digestFormatVersion: 1,
      },
      projectId: `project-${workspaceId}`,
      counts: {
        proposedCount: 1,
        admittedCount: 0,
        planningReadyCount: 1,
        dependencyBlockedCount: 0,
        riskCounts: EMPTY_RISK_COUNTS,
      },
      artifacts: [
        {
          id: `artifact-${workspaceId}`,
          logicalFilename: `${label.toLowerCase()}-source.yaml`,
          role: 'work-breakdown',
          mediaType: 'application/yaml',
          byteLength: 10,
          sha256: 'a'.repeat(64),
        },
      ],
      diagnostics: [],
      workItems: [],
    },
  } as never;
}

function workItemDetailFor(workspaceId: string) {
  const label = workspaceId === 'workspace-a' ? 'Alpha' : 'Beta';
  return {
    workItem: {
      id: `item-${workspaceId}`,
      sourceId: label === 'Alpha' ? 'AQ-01' : 'BQ-01',
      ordinal: 0,
      title: `${label} work item`,
      status: 'proposed',
      risk: 'medium',
      primaryAreas: [],
      exitGate: 'Green.',
      requiredPredecessorCount: 0,
      recommendedPredecessorCount: 0,
      blockerSourceIds: [],
      readiness: 'planning-ready',
      projectId: `project-${workspaceId}`,
      planVersionId: `version-${workspaceId}`,
    },
    projectName: `${label} Project`,
    requiredPredecessors: [],
    recommendedPredecessors: [],
    dependents: [],
  } as never;
}

const snapshotCalls: string[] = [];
/** The page's other reads: its cycles and its attention items. */
const readCalls: string[] = [];
/** The settings page's notification status, a store query (R-D4). */
const notificationCalls: string[] = [];
/** When set, the next notification reads wait for it: a read still under way. */
let notificationGate: Promise<void> | undefined;
let pendingSnapshotB: Deferred<WorkspaceSnapshotResponse>;
/** When set, workspace A's snapshot waits for it: a slow round on the daemon. */
let snapshotAGate: Promise<void> | undefined;
const auditCalls: string[] = [];
/** The signed-in user's workspaces; tests may change the role. */
let workspaceList: WorkspaceListResponse = WORKSPACES;

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
  loadWorkspaces: () => Promise.resolve(workspaceList),
  loadWorkspaceSnapshot: (id: string) => {
    snapshotCalls.push(id);
    if (id !== 'workspace-a') return pendingSnapshotB.promise;
    // Each read of A is later in the journal than the one before, as on the daemon.
    const snapshot = {
      ...SNAPSHOT_A,
      asOfSequence: SNAPSHOT_A.asOfSequence + snapshotCalls.length,
    };
    return snapshotAGate === undefined
      ? Promise.resolve(snapshot)
      : snapshotAGate.then(() => snapshot);
  },
  loadWorkspaceAudit: (id: string) => {
    auditCalls.push(id);
    // Like the daemon: the audit log is owner-only and hidden from other members.
    const role = workspaceList.workspaces.find((workspace) => workspace.id === id)?.role;
    return role === 'owner'
      ? Promise.resolve(id === 'workspace-a' ? AUDIT_A : { records: [] })
      : Promise.reject(new Error('not found'));
  },
  login: () => Promise.resolve(SESSION),
  logout: () => Promise.resolve(),
  revokeSession: () => Promise.resolve(false),
  createWorkspace: () => new Promise(() => undefined),
  renameWorkspace: () => new Promise(() => undefined),
  changePassword: () => new Promise(() => undefined),
  request: () => Promise.reject(new Error('not used')),
}));

// The event streams are irrelevant to this transition; keep them inert.
vi.mock('./lib/use-workspace-event-stream.js', () => ({
  useWorkspaceEventStream: vi.fn(),
}));
vi.mock('./lib/use-run-event-stream.js', () => ({
  useRunEventStream: () => undefined,
}));

// Delegation reads resolve empty so the work item page renders; commands are unused here.
vi.mock('./lib/execution-scope-api.js', () => ({
  loadExecutionScopes: () => Promise.resolve({ choices: [] }),
}));

vi.mock('./lib/branch-api.js', () => ({
  loadPlanBranchSettings: () => Promise.resolve({ issues: [], missingEvidence: [] }),
}));

vi.mock('./lib/notification-api.js', async () => {
  const { DEFAULT_NOTIFICATION_PREFERENCES } = await import('@craftingtable/domain');
  return {
    loadNotifications: async () => {
      notificationCalls.push('status');
      if (notificationGate) await notificationGate;
      return Promise.resolve({
        preferences: DEFAULT_NOTIFICATION_PREFERENCES,
        version: 1,
        credentialsConfigured: false,
        blockedReason: null,
        retryAt: null,
        records: [
          {
            id: 'record',
            kind: 'attention',
            title: 'Earlier session record',
            message: '',
            path: '/',
            state: 'active',
            createdAt: '2026-09-30T00:00:00.000Z',
            lastSentAt: null,
            nextAttemptAt: '2026-09-30T00:00:00.000Z',
            deliveredCount: 0,
            lastError: null,
          },
        ],
      });
    },
    saveNotifications: () => new Promise(() => undefined),
    testNotifications: () => new Promise(() => undefined),
  };
});
vi.mock('./lib/attention-api.js', () => ({
  loadAttention: () => {
    readCalls.push('attention');
    return Promise.resolve({ items: [] });
  },
}));
vi.mock('./lib/work-cycle-api.js', () => ({
  loadWorkCycles: () => {
    readCalls.push('cycles');
    return Promise.resolve({ cycles: [] });
  },
  startWorkCycle: () => new Promise(() => undefined),
}));

vi.mock('./lib/execution-api.js', () => ({
  loadExecutionStatus: () => Promise.resolve({ git: { available: true }, backends: [] }),
  loadRunProfiles: () => Promise.resolve({ profiles: [] }),
  loadRepositories: () => Promise.resolve({ repositories: [] }),
  loadWorkItemExecution: (_workspaceId: string, workItemId: string) => {
    readCalls.push('execution');
    return Promise.resolve({ workItemId, worktrees: [], runs: [], mergeGates: {} });
  },
  loadWorkspaceRuns: () => Promise.resolve({ runs: [], liveCount: 0 }),
  loadRepositoryBranches: () => Promise.resolve({ branches: [] }),
  loadRun: () => new Promise(() => undefined),
  loadRunEvents: () => Promise.resolve({ events: [], nextAfter: 0 }),
  loadWorktreeDiff: () => new Promise(() => undefined),
  registerRepository: () => new Promise(() => undefined),
  retireRepository: () => new Promise(() => undefined),
  createWorktree: () => new Promise(() => undefined),
  removeWorktree: () => new Promise(() => undefined),
  startRun: () => new Promise(() => undefined),
  sendRunMessage: () => new Promise(() => undefined),
  endRun: () => new Promise(() => undefined),
  cancelRun: () => new Promise(() => undefined),
}));

/** Deferreds for the requests whose results must never cross workspaces. */
const planning = {
  artifact: deferred<string>(),
  admit: deferred<unknown>(),
  import: deferred<unknown>(),
};

vi.mock('./lib/planning-api.js', () => ({
  loadProjects: () => new Promise(() => undefined),
  loadProject: (workspaceId: string) => Promise.resolve(projectDetailFor(workspaceId)),
  loadPlanVersion: () => new Promise(() => undefined),
  loadWorkItem: (workspaceId: string) => {
    readCalls.push('work-item');
    return Promise.resolve(workItemDetailFor(workspaceId));
  },
  loadImportAttempts: () => new Promise(() => undefined),
  loadArtifactText: () => planning.artifact.promise,
  admitWorkItem: () => planning.admit.promise,
  completeWorkItem: () => new Promise(() => undefined),
  loadWorkspaceWorkItems: () => Promise.resolve({ filter: 'all', items: [] }),
  importPlanBundle: () => planning.import.promise,
}));

const { App } = await import('./App.js');

interface RenderSample {
  readonly turn: number;
  readonly pathname: string;
  readonly text: string;
}

function renderApp() {
  return render(<App />);
}

/**
 * Samples the URL and the committed DOM once per microtask turn.
 *
 * `waitFor` and `act` both only ever expose the *settled* state, so neither can
 * see a workspace switch that renders correctly only once a passive effect has
 * caught up. React commits a state update within one microtask turn but
 * schedules passive effects on a later macrotask, so sampling per turn is what
 * distinguishes "correct by construction" from "corrected by an effect"
 * (CT03-R2R4).
 *
 * Turn 0 is recorded but never asserted on: it is read before React has been
 * given any turn in which to respond, so every implementation looks identical
 * there.
 */
async function sampleMicrotaskTurns(turns: number): Promise<RenderSample[]> {
  const samples: RenderSample[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    samples.push({
      turn,
      pathname: window.location.pathname,
      text: document.body.textContent ?? '',
    });
    await Promise.resolve();
  }
  return samples;
}

/**
 * Lets every pending promise callback, state update, and passive effect run.
 *
 * Asserting absence through `waitFor` is worthless: its first check succeeds
 * immediately, before the leaked update has even been committed. Absence must
 * be asserted only after the work that would produce the leak has fully run.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  vi.mocked(useWorkspaceEventStream).mockClear();
  // The remembered-workspace bookmark must not leak between tests.
  window.localStorage.clear();
  snapshotCalls.length = 0;
  auditCalls.length = 0;
  snapshotAGate = undefined;
  workspaceList = WORKSPACES;
  pendingSnapshotB = deferred<WorkspaceSnapshotResponse>();
  planning.artifact = deferred<string>();
  planning.admit = deferred<unknown>();
  planning.import = deferred<unknown>();
  window.history.replaceState(null, '', '/');
});

afterEach(cleanup);

/** A workspace event of `kind` for workspace A, as the stream delivers it. */
function streamEvent(sequence: number, kind: string, extra: object = {}): WorkspaceEventEnvelope {
  return {
    id: asEventId(`event-${sequence}`),
    sequence,
    occurredAt: '2026-07-24T00:00:00.000Z',
    workspaceId: 'workspace-a',
    schemaVersion: 1,
    kind,
    payload: {},
    ...extra,
  } as unknown as WorkspaceEventEnvelope;
}

/**
 * Delivers `events` at their offsets (ms from the first) through the real
 * stream callback, then lets every pending timer and read finish.
 */
async function replay(events: readonly (readonly [number, WorkspaceEventEnvelope])[]) {
  const onEvent = vi.mocked(useWorkspaceEventStream).mock.lastCall![2].onEvent;
  let elapsed = 0;
  for (const [at, event] of events) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(at - elapsed);
    });
    elapsed = at;
    act(() => onEvent(event));
  }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
}

/**
 * The run-finished -> next-run transition recorded in the live journal as
 * seq 3248-3254 (PERF-02): seven events over 11.4 s, 0.3-6 s apart.
 */
const RECORDED_TRANSITION = [
  [0, streamEvent(3248, 'agent-run-status-changed')],
  [339, streamEvent(3249, 'agent-run-status-changed')],
  [2_948, streamEvent(3250, 'work-cycle-changed')],
  [4_368, streamEvent(3251, 'work-cycle-changed')],
  [4_844, streamEvent(3252, 'work-cycle-changed')],
  [10_848, streamEvent(3253, 'agent-run-started')],
  [11_381, streamEvent(3254, 'agent-run-status-changed')],
] as const;

describe('background refresh rounds (PERF-02, PERF-03, PERF-17)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  async function loaded(): Promise<number> {
    renderApp();
    await screen.findByText('Alpha Project');
    await settle();
    vi.useFakeTimers();
    return snapshotCalls.length;
  }

  it('batches a burst of events into one round and retains the stream cursor', async () => {
    const initial = await loaded();
    expect(initial).toBe(1);
    const cursor = vi.mocked(useWorkspaceEventStream).mock.lastCall![1];
    const onEvent = vi.mocked(useWorkspaceEventStream).mock.lastCall![2].onEvent;
    for (let sequence = 6; sequence <= 8; sequence++) {
      act(() => onEvent(streamEvent(sequence, 'work-cycle-changed')));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(150);
      });
    }
    // Still inside the quiet period after the last event.
    expect(snapshotCalls.length).toBe(initial);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(snapshotCalls.length).toBe(initial + 1);
    expect(vi.mocked(useWorkspaceEventStream).mock.lastCall?.[1]).toBe(cursor);
    expect(screen.getByText('Alpha Project')).toBeDefined();
  });

  it('refreshes a recorded transition in fewer rounds than it has events', async () => {
    const initial = await loaded();
    await replay(RECORDED_TRANSITION);
    // The fixed 200 ms window made this 7 rounds (one per event). Events closer
    // than the debounce now share a round; the remaining rounds are the
    // controller's multi-second gaps inside one transition (PERF-18).
    expect(snapshotCalls.length - initial).toBe(6);
  });

  it('never refreshes the page for notification bookkeeping', async () => {
    const initial = await loaded();
    await replay([
      [0, streamEvent(20, 'notifications-changed', { payload: { action: 'delivery' } })],
      [1_000, streamEvent(21, 'notifications-changed', { payload: { action: 'attention' } })],
    ]);
    expect(snapshotCalls.length).toBe(initial);
  });

  it('reloads the page round, and with it the Needs you feed, when attention changes', async () => {
    const initial = await loaded();
    await replay([[0, streamEvent(22, 'attention-changed', { payload: { open: 1 } })]]);
    expect(snapshotCalls.length).toBe(initial + 1);
  });

  it('keeps one round in flight and follows up exactly once', async () => {
    const initial = await loaded();
    const slow = deferred<void>();
    snapshotAGate = slow.promise;
    // Each event is past the previous debounce, so each would start a round.
    await replay([
      [0, streamEvent(30, 'work-cycle-changed')],
      [1_000, streamEvent(31, 'work-cycle-changed')],
      [2_000, streamEvent(32, 'work-cycle-changed')],
      [3_000, streamEvent(33, 'agent-run-status-changed')],
    ]);
    expect(snapshotCalls.length - initial).toBe(1);
    snapshotAGate = undefined;
    await act(async () => {
      slow.resolve();
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(snapshotCalls.length - initial).toBe(2);
  });

  it('reads nothing while visible and idle: no event, so no request, for minutes (R-D4)', async () => {
    const initial = await loaded();
    const reads = readCalls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(snapshotCalls.length).toBe(initial);
    expect(readCalls.length).toBe(reads);
  });

  it("reads a page's store queries again when an event names them, and every one after an unreadable event (R-D4)", async () => {
    window.history.pushState(null, '', '/workspaces/workspace-a/settings');
    // Faked from the start, so the app's minute timer runs on the test's clock.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp();
    await waitFor(() => expect(notificationCalls.length).toBeGreaterThan(0));
    await settle();
    const before = notificationCalls.length;
    // Idle and visible: the minute's refresh reads only Git-derived queries, not this one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2 * 60_000);
    });
    expect(notificationCalls.length).toBe(before);
    const callbacks = vi.mocked(useWorkspaceEventStream).mock.lastCall![2];
    act(() => callbacks.onEvent(streamEvent(9, 'repository-registered', { repositoryId: 'repo' })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(notificationCalls.length).toBe(before);
    act(() =>
      callbacks.onEvent(
        streamEvent(10, 'notifications-changed', { payload: { action: 'delivery' } }),
      ),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(notificationCalls.length).toBe(before + 1);
    act(() => callbacks.onInvalidEvent());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(notificationCalls.length).toBe(before + 2);
  });

  it("never shows a signed-out session's data to the next one, while the next one's read is under way (R-D4 review M16)", async () => {
    window.history.pushState(null, '', '/workspaces/workspace-a/settings');
    renderApp();
    expect(await screen.findByText('Earlier session record')).toBeTruthy();
    notificationGate = new Promise(() => undefined);
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Log out' }));
      fireEvent.change(await screen.findByLabelText('Username'), { target: { value: 'operator' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'secret' } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      window.history.pushState(null, '', '/workspaces/workspace-a/settings');
      await waitFor(() => expect(notificationCalls.length).toBeGreaterThan(1));
      expect(screen.queryByText('Earlier session record')).toBeNull();
    } finally {
      notificationGate = undefined;
    }
  });

  // R-D4 increment 4b: each page reads its own data, on the events that name it.
  it("reads a work item's page again only for events that name its item (R-D4 done-when)", async () => {
    window.history.pushState(null, '', '/workspaces/workspace-a/work-items/item-workspace-a');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp();
    await screen.findByRole('heading', { name: /AQ-01 · Alpha work item/ });
    await settle();
    const count = (name: string) => readCalls.filter((call) => call === name).length;
    const [item, execution] = [count('work-item'), count('execution')];
    const onEvent = vi.mocked(useWorkspaceEventStream).mock.lastCall![2].onEvent;
    for (const unrelated of [
      streamEvent(40, 'work-cycle-changed', { workItemId: 'item-other' }),
      streamEvent(41, 'notifications-changed', { payload: { action: 'delivery' } }),
      streamEvent(42, 'repository-registered', { repositoryId: 'repo' }),
    ])
      act(() => onEvent(unrelated));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect([count('work-item'), count('execution')]).toEqual([item, execution]);
    act(() => onEvent(streamEvent(43, 'work-cycle-changed', { workItemId: 'item-workspace-a' })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect([count('work-item'), count('execution')]).toEqual([item + 1, execution + 1]);
  });

  it('refreshes what its own command changed, at once, and nothing else (R-D4 increment 4b)', async () => {
    window.history.pushState(null, '', '/workspaces/workspace-a/work-items/item-workspace-a');
    renderApp();
    await screen.findByRole('heading', { name: /AQ-01 · Alpha work item/ });
    await settle();
    const count = (name: string) => readCalls.filter((call) => call === name).length;
    const before = {
      item: count('work-item'),
      snapshot: snapshotCalls.length,
      attention: count('attention'),
    };
    fireEvent.click(screen.getByRole('button', { name: 'Admit into agenda' }));
    await act(async () => {
      planning.admit.resolve(undefined);
    });
    await waitFor(() => expect(count('work-item')).toBe(before.item + 1));
    expect(snapshotCalls.length).toBe(before.snapshot + 1);
    expect(count('attention')).toBe(before.attention);
  });

  it('reads nothing while the tab is hidden and catches up once when shown', async () => {
    const initial = await loaded();
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    try {
      await replay(RECORDED_TRANSITION.map(([at, event]) => [at, event] as const));
      expect(snapshotCalls.length).toBe(initial);
      visibility.mockReturnValue('visible');
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(snapshotCalls.length - initial).toBe(1);
    } finally {
      visibility.mockRestore();
    }
  });
});

describe('non-owner members (PERF-15)', () => {
  it('load the workspace without requesting the owner-only audit log', async () => {
    workspaceList = {
      workspaces: WORKSPACES.workspaces.map((workspace) => ({ ...workspace, role: 'editor' })),
    } as unknown as WorkspaceListResponse;
    renderApp();
    await screen.findByText('Alpha Project');
    await settle();
    expect(screen.queryByText('The workspace snapshot could not be loaded.')).toBeNull();
    expect(
      screen.queryByText('The latest refresh failed. The last committed state remains visible.'),
    ).toBeNull();
    expect(auditCalls).toEqual([]);
  });

  it('still show owners their audit log on the dashboard', async () => {
    renderApp();
    await screen.findByText('plan.import.succeeded');
    expect(auditCalls).toContain('workspace-a');
  });
});

describe('workspace switching in the app (CT03-RR4)', () => {
  it('never renders the previous workspace projection under the new selection', async () => {
    renderApp();

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
    renderApp();
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
    renderApp();
    await screen.findByText('Alpha Project');
    await screen.findByText('plan.import.succeeded');

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

/**
 * CT03-R2R3 and CT03-R2R4.
 *
 * The previous remediation cleared state in the selection transition, but
 * requests already in flight still wrote their results afterwards, and a
 * route-driven change still went through a post-render effect.
 */
describe('in-flight results across a workspace change (CT03-R2R3)', () => {
  async function loadWorkspaceA(): Promise<void> {
    renderApp();
    await screen.findByText('Alpha Project');
  }

  function switchToB(): void {
    fireEvent.change(screen.getByLabelText('Workspace'), {
      target: { value: 'workspace-b' },
    });
  }

  it('discards an artifact fetched for the previous workspace', async () => {
    await loadWorkspaceA();

    // Open workspace A's project and request one of its source artifacts.
    fireEvent.click(screen.getByRole('button', { name: 'Alpha Project' }));
    await screen.findByRole('heading', { name: 'Alpha Project' });
    fireEvent.click(screen.getByRole('button', { name: 'alpha-source.yaml' }));

    switchToB();
    pendingSnapshotB.resolve(SNAPSHOT_B);
    await screen.findByText('Beta Project');

    // Workspace A's artifact resolves only now. It must not appear under B.
    planning.artifact.resolve('document: Alpha secret\n');
    await settle();
    expect(screen.queryByText(/Alpha secret/)).toBeNull();
    expect(screen.queryByTestId('source-text')).toBeNull();
    expect(screen.queryByText('alpha-source.yaml')).toBeNull();
  });

  it('discards an admission error raised for the previous workspace', async () => {
    await loadWorkspaceA();

    window.history.pushState(null, '', '/workspaces/workspace-a/work-items/item-workspace-a');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: /AQ-01 · Alpha work item/ });

    fireEvent.click(screen.getByRole('button', { name: 'Admit into agenda' }));
    expect(screen.getByRole('button', { name: 'Admitting…' })).toBeDefined();

    switchToB();
    pendingSnapshotB.resolve(SNAPSHOT_B);
    await screen.findByText('Beta Project');

    // Stand on workspace B's own work-item page, where a leaked error from A
    // would actually be rendered.
    window.history.pushState(null, '', '/workspaces/workspace-b/work-items/item-workspace-b');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: /BQ-01 · Beta work item/ });

    planning.admit.reject(new Error('admission failed in workspace A'));
    await settle();
    expect(screen.queryByRole('alert')).toBeNull();
    // A plain Error renders as the generic message, so assert on what is shown.
    expect(screen.queryByText('Admission failed')).toBeNull();
    // The busy state was reset by the switch, not left stuck from A.
    expect(screen.queryByRole('button', { name: 'Admitting…' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Admit into agenda' })).toBeDefined();
  });

  it('discards an import outcome produced for the previous workspace', async () => {
    await loadWorkspaceA();

    window.history.pushState(null, '', '/workspaces/workspace-a/import');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: 'Import plan' });

    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Alpha import' },
    });
    for (const [label, name] of [
      ['Implementation plan (required)', 'plan.md'],
      ['Work breakdown (required)', 'breakdown.yaml'],
    ] as const) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new File(['x'], name, { type: 'text/plain' })],
      });
      fireEvent.change(input);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Import plan bundle' }));
    expect(screen.getByRole('button', { name: 'Importing…' })).toBeDefined();

    switchToB();
    pendingSnapshotB.resolve(SNAPSHOT_B);
    await screen.findByText('Beta Project');

    // Stand on workspace B's import page, where a leaked outcome would render.
    window.history.pushState(null, '', '/workspaces/workspace-b/import');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: 'Import plan' });

    planning.import.resolve({
      importAttemptId: 'attempt-a',
      outcome: 'failed-validation',
      diagnostics: [
        { severity: 'error', code: 'invalid-yaml', message: 'Alpha import diagnostic' },
      ],
    });
    await settle();
    expect(screen.queryByRole('region', { name: 'Import result' })).toBeNull();
    expect(screen.queryByText(/Alpha import diagnostic/)).toBeNull();
    expect(screen.queryByText('Import failed validation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Importing…' })).toBeNull();
    // A failed import never navigates, but a leaked success would; the import
    // page for B must still be the one on screen.
    expect(window.location.pathname).toBe('/workspaces/workspace-b/import');
  });
  it('never opens a project imported into the previous workspace (R-D4 increment 4b)', async () => {
    await loadWorkspaceA();

    window.history.pushState(null, '', '/workspaces/workspace-a/import');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: 'Import plan' });

    fireEvent.change(screen.getByLabelText('Project name'), {
      target: { value: 'Alpha import' },
    });
    for (const [label, name] of [
      ['Implementation plan (required)', 'plan.md'],
      ['Work breakdown (required)', 'breakdown.yaml'],
    ] as const) {
      const input = screen.getByLabelText(label) as HTMLInputElement;
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [new File(['x'], name, { type: 'text/plain' })],
      });
      fireEvent.change(input);
    }
    fireEvent.click(screen.getByRole('button', { name: 'Import plan bundle' }));
    expect(screen.getByRole('button', { name: 'Importing…' })).toBeDefined();

    switchToB();
    pendingSnapshotB.resolve(SNAPSHOT_B);
    await screen.findByText('Beta Project');

    // Stand on workspace B's import page, where a leaked outcome would render.
    window.history.pushState(null, '', '/workspaces/workspace-b/import');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByRole('heading', { name: 'Import plan' });

    planning.import.resolve({
      importAttemptId: 'attempt-a',
      outcome: 'succeeded',
      projectId: 'project-workspace-a',
      planVersionId: 'plan-workspace-a',
      diagnostics: [],
    });
    await settle();
    expect(window.location.pathname).toBe('/workspaces/workspace-b/import');
  });
});

describe('route-driven workspace changes (CT03-R2R4)', () => {
  it('never renders the previous workspace under a deep-linked new one', async () => {
    renderApp();
    await screen.findByText('Alpha Project');

    // A popstate straight into workspace B, whose snapshot stays pending.
    window.history.pushState(null, '', '/workspaces/workspace-b');
    window.dispatchEvent(new PopStateEvent('popstate'));

    const samples = await sampleMicrotaskTurns(16);

    // From the first turn in which React could respond onwards, no committed
    // DOM under workspace B's URL may still contain workspace A's content.
    // Deriving the identity from the route satisfies this on turn 1; relying on
    // an effect to correct it afterwards does not.
    const underB = samples.filter(
      (sample) => sample.turn > 0 && sample.pathname === '/workspaces/workspace-b',
    );
    expect(underB.length).toBeGreaterThan(0);
    for (const sample of underB) {
      expect(sample.text, `turn ${sample.turn}`).not.toContain('Alpha Project');
      expect(sample.text, `turn ${sample.turn}`).not.toContain('Alpha Activity');
      expect(sample.text, `turn ${sample.turn}`).not.toContain('plan.import.succeeded');
    }

    await waitFor(() => expect(snapshotCalls).toContain('workspace-b'));
    expect(screen.queryByText('Alpha Project')).toBeNull();
    expect(screen.getByText('Loading durable workspace snapshot…')).toBeDefined();

    pendingSnapshotB.resolve(SNAPSHOT_B);
    await screen.findByText('Beta Project');
    expect(screen.queryByText('Alpha Project')).toBeNull();
  });

  it('shows the routed workspace as selected while its data loads', async () => {
    renderApp();
    await screen.findByText('Alpha Project');

    window.history.pushState(null, '', '/workspaces/workspace-b');
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(snapshotCalls).toContain('workspace-b'));

    // The picker must agree with the URL immediately, not one render later.
    expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe('workspace-b');
  });

  it('ignores a route naming a workspace the user cannot see', async () => {
    renderApp();
    await screen.findByText('Alpha Project');

    window.history.pushState(null, '', '/workspaces/workspace-unknown');
    window.dispatchEvent(new PopStateEvent('popstate'));

    // Falls back to the current selection rather than loading forever.
    await waitFor(() =>
      expect((screen.getByLabelText('Workspace') as HTMLSelectElement).value).toBe('workspace-a'),
    );
    expect(snapshotCalls).not.toContain('workspace-unknown');
  });
});
