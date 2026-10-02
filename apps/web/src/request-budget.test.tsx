import {
  type AuthenticatedSessionResponse,
  type WorkspaceEventEnvelope,
  workspaceEventEnvelopeSchema,
} from '@craftingtable/contracts';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceEventStream } from './lib/use-workspace-event-stream.js';

/**
 * Requests per workspace event (R-D4 increment 4c). The app renders a page with every read
 * mocked and counted, and anything else caught at `fetch`; each event kind is delivered through
 * the stream and the reads it causes are counted. The same file measured the app before R-D4
 * (07081fe), whose numbers the register records beside these; the budget below is today's, so
 * a change that reads more on an event fails here.
 */

const { requests, count } = vi.hoisted(() => {
  const requests: string[] = [];
  return {
    requests,
    count:
      <T extends (...args: never[]) => unknown>(name: string, fn: T) =>
      (...args: Parameters<T>) => {
        requests.push(name);
        return fn(...args);
      },
  };
});

const WS = 'ws-a';
const ITEM = 'item-a';
const RISK = { low: 0, medium: 0, high: 0, critical: 0, unspecified: 0 };
const SESSION = {
  user: { id: 'user-1', username: 'keith', status: 'active' },
  session: {
    id: 'session-1',
    createdAt: '2026-10-02T00:00:00.000Z',
    lastSeenAt: '2026-10-02T00:00:00.000Z',
    expiresAt: '2026-11-02T00:00:00.000Z',
    status: 'active',
    current: true,
  },
  csrfToken: 'csrf',
} as unknown as AuthenticatedSessionResponse;
const WORKSPACES = {
  workspaces: [
    {
      id: WS,
      name: 'Workspace A',
      slug: WS,
      status: 'active',
      role: 'owner',
      projects: [],
      projectCount: 1,
      admittedCount: 0,
      completedCount: 0,
      liveRunCount: 0,
    },
  ],
};
const SNAPSHOT = {
  workspace: { id: WS, name: 'Workspace A', slug: WS, status: 'active', role: 'owner' },
  asOfSequence: 5,
  statusSummary: {
    needsAttention: 0,
    active: 0,
    planningReady: 1,
    dependencyBlocked: 0,
    completed: 0,
    liveRuns: 0,
  },
  planningSummary: {
    projectCount: 1,
    importAttentionCount: 0,
    proposedCount: 0,
    admittedCount: 0,
    completedCount: 0,
    planningReadyCount: 0,
    dependencyBlockedCount: 0,
    riskCounts: RISK,
  },
  projects: [
    {
      id: 'project-a',
      name: 'Alpha Project',
      slug: 'p',
      versionCount: 1,
      warningCount: 0,
      createdAt: '2026-10-02T00:00:00.000Z',
      proposedCount: 0,
      admittedCount: 0,
      planningReadyCount: 0,
      dependencyBlockedCount: 0,
      riskCounts: RISK,
    },
  ],
  recentActivity: [],
};
const WORK_ITEM = {
  workItem: {
    id: ITEM,
    sourceId: 'AQ-01',
    ordinal: 0,
    title: 'Alpha work item',
    status: 'proposed',
    risk: 'medium',
    primaryAreas: [],
    exitGate: 'Green.',
    requiredPredecessorCount: 0,
    recommendedPredecessorCount: 0,
    blockerSourceIds: [],
    readiness: 'planning-ready',
    projectId: 'project-a',
    planVersionId: 'version-a',
  },
  projectName: 'Alpha Project',
  requiredPredecessors: [],
  recommendedPredecessors: [],
  dependents: [],
};
const never = () => new Promise<never>(() => undefined);

vi.mock('./lib/api-client.js', async (original) => ({
  ...(await original<typeof import('./lib/api-client.js')>()),
  loadSession: count('session', async () => SESSION),
  loadSessions: count('sessions', async () => ({ sessions: [] })),
  loadWorkspaces: count('workspaces', async () => WORKSPACES),
  loadWorkspaceSnapshot: count('snapshot', async () => SNAPSHOT),
  loadWorkspaceAudit: count('audit', async () => ({ records: [] })),
}));
vi.mock('./lib/use-workspace-event-stream.js', () => ({ useWorkspaceEventStream: vi.fn() }));
vi.mock('./lib/use-run-event-stream.js', () => ({ useRunEventStream: vi.fn() }));
vi.mock('./lib/execution-scope-api.js', async (original) => ({
  ...(await original<typeof import('./lib/execution-scope-api.js')>()),
  loadExecutionScopes: count('scopes', async () => ({ choices: [] })),
}));
vi.mock('./lib/branch-api.js', async (original) => ({
  ...(await original<typeof import('./lib/branch-api.js')>()),
  loadPlanBranchSettings: count('plan-branches', async () => ({
    issues: [],
    missingEvidence: [],
  })),
  loadWorktreeBranchStatus: count('worktree-branch', never),
  loadRepositoryPolicy: count('repository-policy', never),
}));
vi.mock('./lib/notification-api.js', async (original) => ({
  ...(await original<typeof import('./lib/notification-api.js')>()),
  loadNotifications: count('notifications', never),
}));
vi.mock('./lib/attention-api.js', async (original) => ({
  ...(await original<typeof import('./lib/attention-api.js')>()),
  loadAttention: count('attention', async () => ({ items: [] })),
}));
vi.mock('./lib/work-cycle-api.js', async (original) => ({
  ...(await original<typeof import('./lib/work-cycle-api.js')>()),
  loadWorkCycles: count('cycles', async () => ({ cycles: [] })),
}));
vi.mock('./lib/execution-api.js', async (original) => ({
  ...(await original<typeof import('./lib/execution-api.js')>()),
  loadExecutionStatus: count('execution-status', async () => ({
    git: { available: true },
    backends: [],
  })),
  loadRunProfiles: count('run-profiles', async () => ({ profiles: [] })),
  loadRepositories: count('repositories', async () => ({ repositories: [] })),
  loadWorkItemExecution: count('work-item-execution', async () => ({
    workItemId: ITEM,
    worktrees: [],
    runs: [],
    mergeGates: {},
  })),
  loadWorkspaceRuns: count('runs', async () => ({ runs: [], liveCount: 0 })),
}));
vi.mock('./lib/planning-api.js', async (original) => ({
  ...(await original<typeof import('./lib/planning-api.js')>()),
  loadWorkItem: count('work-item', async () => WORK_ITEM),
  loadWorkspaceWorkItems: count('agenda', async () => ({ filter: 'all', items: [] })),
}));

const { App } = await import('./App.js');

const KINDS = workspaceEventEnvelopeSchema.options.map((option) => option.shape.kind.value);
let sequence = 100;
/** Which reads each event caused, for the register. */
const reads: Record<string, string[]> = {};
/** An event of a kind, naming another work item, project and run than the page's own. */
function eventOf(kind: string, own = false): WorkspaceEventEnvelope {
  sequence += 1;
  return {
    id: `event-${sequence}`,
    sequence,
    occurredAt: '2026-10-02T00:00:00.000Z',
    workspaceId: WS,
    schemaVersion: 1,
    kind,
    workItemId: own ? ITEM : 'item-other',
    projectId: own ? 'project-a' : 'project-other',
    runId: 'run-other',
    repositoryId: 'repo-other',
    payload: { roadmapId: 'roadmap-other', definitionId: 'map-other', planVersionId: 'other' },
  } as unknown as WorkspaceEventEnvelope;
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  // Anything not mocked above is still a request: counted, and never answered.
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      requests.push(
        `fetch ${String(input)
          .split('?')[0]
          ?.replace(/\/[0-9a-z-]{20,}/g, '/:id')}`,
      );
      return never();
    }),
  );
  requests.length = 0;
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Requests each event kind causes on a page, once the page has settled. */
async function measure(path: string, settled: () => Promise<unknown>, own = false) {
  window.history.replaceState(null, '', path);
  render(<App />);
  await settled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  const table: Record<string, number> = {};
  for (const kind of KINDS) {
    const onEvent = vi.mocked(useWorkspaceEventStream).mock.lastCall![2].onEvent;
    const before = requests.length;
    act(() => onEvent(eventOf(kind, own)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    table[kind] = requests.length - before;
    reads[`${path}${own ? ' (own)' : ''} ${kind}`] = requests.slice(before).sort();
  }
  return table;
}

/** Today's requests per event; more on any event is a regression to justify. */
const BUDGET: Record<string, Record<string, number>> = {
  dashboard: {
    'runtime-evidence-changed': 4,
    'scope-evidence-recorded': 4,
    'scope-scheduling-authorized': 4,
    'notifications-changed': 0,
    'attention-changed': 4,
    'roadmap-changed': 5,
    'workspace-created': 3,
    'project-created': 3,
    'plan-version-imported': 3,
    'work-item-admitted': 4,
    'work-item-removed-from-agenda': 4,
    'repository-registered': 1,
    'repository-status-changed': 1,
    'repository-evidence-changed': 1,
    'project-repository-bound': 1,
    'project-repository-binding-retired': 1,
    'source-repository-registered': 1,
    'worktree-created': 4,
    'worktree-removed': 4,
    'agent-run-started': 5,
    'agent-run-status-changed': 5,
    'workspace-updated': 3,
    'work-item-completed': 5,
    'worktree-merged': 4,
    'work-cycle-changed': 4,
    'branches-changed': 4,
  },
  workItem: {
    'runtime-evidence-changed': 7,
    'scope-evidence-recorded': 8,
    'scope-scheduling-authorized': 7,
    'notifications-changed': 0,
    'attention-changed': 3,
    'roadmap-changed': 8,
    'workspace-created': 2,
    'project-created': 2,
    'plan-version-imported': 6,
    'work-item-admitted': 7,
    'work-item-removed-from-agenda': 7,
    'repository-registered': 1,
    'repository-status-changed': 5,
    'repository-evidence-changed': 1,
    'project-repository-bound': 1,
    'project-repository-binding-retired': 1,
    'source-repository-registered': 1,
    'worktree-created': 3,
    'worktree-removed': 4,
    'agent-run-started': 3,
    'agent-run-status-changed': 3,
    'workspace-updated': 2,
    'work-item-completed': 9,
    'worktree-merged': 7,
    'work-cycle-changed': 3,
    'branches-changed': 3,
  },
  ownWorkItem: {
    'runtime-evidence-changed': 7,
    'scope-evidence-recorded': 8,
    'scope-scheduling-authorized': 7,
    'notifications-changed': 0,
    'attention-changed': 3,
    'roadmap-changed': 8,
    'workspace-created': 2,
    'project-created': 2,
    'plan-version-imported': 6,
    'work-item-admitted': 7,
    'work-item-removed-from-agenda': 7,
    'repository-registered': 1,
    'repository-status-changed': 5,
    'repository-evidence-changed': 1,
    'project-repository-bound': 1,
    'project-repository-binding-retired': 1,
    'source-repository-registered': 1,
    'worktree-created': 7,
    'worktree-removed': 8,
    'agent-run-started': 7,
    'agent-run-status-changed': 7,
    'workspace-updated': 2,
    'work-item-completed': 9,
    'worktree-merged': 7,
    'work-cycle-changed': 7,
    'branches-changed': 7,
  },
};

it('reads only what each event changed, on the dashboard and a work item page (R-D4 4c)', async () => {
  const tables = {
    dashboard: await measure('/workspaces/ws-a', () => screen.findByText('Alpha Project')),
  };
  cleanup();
  const workItem = await measure(`/workspaces/ws-a/work-items/${ITEM}`, () =>
    screen.findByRole('heading', { name: /AQ-01 · Alpha work item/ }),
  );
  cleanup();
  const ownWorkItem = await measure(
    `/workspaces/ws-a/work-items/${ITEM}`,
    () => screen.findByRole('heading', { name: /AQ-01 · Alpha work item/ }),
    true,
  );
  const measured = { ...tables, workItem, ownWorkItem };
  // The reads behind each count, shown when the budget fails.
  expect(measured, `requests per event; the reads were ${JSON.stringify(reads)}`).toEqual(BUDGET);
});
