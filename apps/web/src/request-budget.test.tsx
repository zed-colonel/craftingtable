import {
  type AuthenticatedSessionResponse,
  type WorkspaceEventEnvelope,
  workspaceEventEnvelopeSchema,
} from '@craftingtable/contracts';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useWorkspaceEventStream } from './lib/use-workspace-event-stream.js';

/**
 * Requests per workspace event (R-D4 increment 4c). The app renders a page with every read
 * mocked and counted, and anything else caught at `fetch`; each event kind is delivered through
 * the stream and the reads it causes are counted. The same file measured the app before R-D4
 * (07081fe), whose numbers the register records beside these; the budget below is today's, so
 * a change that reads more on an event fails here.
 */

const { requests, count, fixture } = vi.hoisted(() => {
  const requests: string[] = [];
  return {
    requests,
    /** The work item's worktrees: none, or one, which mounts its branch panel. */
    fixture: { worktrees: [] as unknown[] },
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
const WORKTREE = {
  id: 'tree-a',
  workspaceId: WS,
  repositoryId: 'repo-a',
  projectId: 'project-a',
  workItemId: ITEM,
  branchName: 'ct/aq-01',
  baseSha: '0'.repeat(40),
  baseBranch: 'main',
  path: '/data/worktrees/aq-01',
  status: 'active',
  createdAt: '2026-10-02T00:00:00.000Z',
  createdByUserId: 'user-1',
  version: 1,
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
const REPOSITORY = {
  id: 'repo-a',
  workspaceId: WS,
  displayName: 'alpha',
  rootPath: '/data/repos/alpha',
  defaultBranch: 'main',
  registeredHeadSha: '0'.repeat(40),
  status: 'active',
  registeredAt: '2026-10-02T00:00:00.000Z',
  registeredByUserId: 'user-1',
  version: 1,
};
/** The plan's branch settings, bound to the repository, which mounts its policy panel. */
const PLAN_SETTINGS = {
  workspaceId: WS,
  planVersionId: 'version-a',
  repositoryId: 'repo-a',
  integrationBranch: 'main',
  updatedAt: '2026-10-02T00:00:00.000Z',
  updatedByUserId: 'user-1',
  version: 1,
};
const never = () => new Promise<never>(() => undefined);

vi.mock('./lib/session-api.js', async (original) => ({
  ...(await original<typeof import('./lib/session-api.js')>()),
  loadSession: count('session', async () => SESSION),
  loadSessions: count('sessions', async () => ({ sessions: [] })),
}));
vi.mock('./lib/workspace-api.js', async (original) => ({
  ...(await original<typeof import('./lib/workspace-api.js')>()),
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
    settings: PLAN_SETTINGS,
    issues: [],
    missingEvidence: [],
  })),
  loadWorktreeBranchStatus: count('worktree-branch', async () => ({
    worktree: fixture.worktrees[0],
    reviewCurrent: false,
    issues: [],
  })),
  loadRepositoryPolicy: count('repository-policy', async () => ({
    kind: 'repository-policy-evidence-v1',
    observedAt: '2026-10-02T00:00:00.000Z',
    settingsVersion: 1,
    issues: [],
    manualApprovalBranches: [],
    controls: [],
    limitations: [],
  })),
}));
vi.mock('./lib/notification-api.js', async (original) => ({
  ...(await original<typeof import('./lib/notification-api.js')>()),
  loadNotifications: count('notifications', async () => ({
    preferences: (await import('@craftingtable/domain')).DEFAULT_NOTIFICATION_PREFERENCES,
    version: 1,
    credentialsConfigured: false,
    blockedReason: null,
    retryAt: null,
    records: [],
  })),
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
    outsideSources: [],
  })),
  loadRunProfiles: count('run-profiles', async () => ({ profiles: [] })),
  loadRepositories: count('repositories', async () => ({ repositories: [REPOSITORY] })),
  loadRepositoryChecks: count('repository-checks', async () => ({
    repositoryId: 'repo-a',
    declarations: [],
  })),
  loadRepositoryCheckReceipts: count('repository-check-receipts', async () => ({
    repositoryId: 'repo-a',
    runs: [],
  })),
  loadWorkspaceRuns: count('runs', async () => ({ runs: [], liveCount: 0 })),
  loadRunView: count('run-view', async () => ({
    detail: {
      run: { id: 'run-a', workItemId: ITEM, worktreeId: 'tree-a', status: 'finished' },
      worktree: { ...WORKTREE },
      brief: 'Brief',
      eventCount: 0,
    },
    runs: [],
    backends: [],
    profiles: [],
  })),
  loadRunEvents: count('run-events', async () => ({ events: [], nextAfter: 0 })),
  loadWorkItemView: count('work-item-view', async () => ({
    detail: WORK_ITEM,
    execution: { workItemId: ITEM, worktrees: fixture.worktrees, runs: [], mergeGates: {} },
    cycles: [],
    scopes: { choices: [] },
    repositories: [REPOSITORY],
    backends: [],
    profiles: [],
  })),
}));
vi.mock('./lib/roadmap-api.js', async (original) => {
  const board = await import('./features/roadmap-board/board-testing.js');
  const profile = { backend: 'codex', permissionMode: 'auto' };
  const roadmap = {
    id: board.ROADMAP_ID,
    workspaceId: WS,
    status: 'running',
    version: 3,
    reason: 'Scheduling.',
    attempts: [],
  };
  const definition = {
    name: 'Cross-project roadmap',
    revision: 2,
    scheduling: { mode: 'parallel', maxInFlight: 2, maxPerRepository: 2 },
    crossProject: {
      definitionId: 'def-1',
      bindingRevision: 4,
      targetId: 'TARGET',
      selection: 'target-only',
    },
    entries: board.ENTRY_IDS.map((id) => ({
      id,
      workItemId: 'wi-01',
      sourceId: 'wi/WI-01/impl',
      title: 'World interface core',
      executionScope: { kind: 'slice', sourceId: 'wi/WI-01/impl' },
      integrationBranch: 'wi-fabric',
      planVersionId: 'plan',
      profiles: { design: profile, implement: profile, review: profile, remediate: profile },
      policy: { maxNits: 3, maxRemediationRounds: 3, maxRunMinutes: 60 },
      instructions: '',
    })),
  };
  return {
    ...(await original<typeof import('./lib/roadmap-api.js')>()),
    loadRoadmaps: count('roadmaps', async () => ({ roadmaps: [] })),
    loadRoadmapSummaries: count('roadmap-summaries', async () => ({ roadmaps: [] })),
    loadRoadmapPage: count('roadmap-view', async () => ({
      view: { roadmap, progress: [] },
      definitionRevision: 2,
      status: board.STATUS,
      board: board.BOARD,
    })),
    loadRoadmapDefinition: count('roadmap-definition', async () => definition),
    loadRoadmapGraph: count('roadmap-graph', async () => board.GRAPH),
  };
});
vi.mock('./lib/planning-api.js', async (original) => ({
  ...(await original<typeof import('./lib/planning-api.js')>()),
  loadWorkspaceWorkItems: count('agenda', async () => ({ filter: 'all', items: [] })),
  loadPlanVersion: count('plan-version', async () => PLAN_VERSION),
  loadPlanVersionGraph: count('plan-version-graph', async () => ({
    planVersionId: 'plan',
    nodes: [
      { workItemId: ITEM, sourceId: 'AQ-01', title: 'Alpha work item' },
      { workItemId: 'item-2', sourceId: 'AQ-02', title: 'Beta work item' },
    ],
    edges: [[0, 1]],
  })),
}));
/** A plan version with two work items, the second requiring the first (R-E4). */
const PLAN_VERSION = {
  version: {
    id: 'plan',
    projectId: 'project-a',
    versionNumber: 1,
    document: 'plan.md',
    isActive: true,
    contentDigest: 'a'.repeat(64),
    digestAlgorithm: 'sha256',
    digestFormatVersion: 1,
    sourceProfile: 'exo-work-breakdown-v1',
    itemCount: 2,
    requiredDependencyCount: 1,
    createdAt: '2026-10-01T00:00:00.000Z',
  },
  workItems: [],
  artifacts: [],
  diagnostics: [],
};

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

/**
 * Requests each event kind causes on a page. Each kind is measured on a page mounted afresh and
 * settled, so no event's reads, and no timer (the visible tab's Git minute, 60 s after mount),
 * fall into another's window, whatever the order of the kinds (R-D4 4c review F1).
 */
async function measure(path: string, settled: () => Promise<unknown>, own = false) {
  const table: Record<string, number> = {};
  for (const kind of KINDS) {
    window.history.replaceState(null, '', path);
    render(<App />);
    await settled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const onEvent = vi.mocked(useWorkspaceEventStream).mock.lastCall![2].onEvent;
    const before = requests.length;
    act(() => onEvent(eventOf(kind, own)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    table[kind] = requests.length - before;
    reads[`${path}${own ? ' (own)' : ''} ${kind}`] = requests.slice(before).sort();
    cleanup();
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
    'runtime-evidence-changed': 4,
    'scope-evidence-recorded': 5,
    'scope-scheduling-authorized': 4,
    'notifications-changed': 0,
    'attention-changed': 3,
    'roadmap-changed': 5,
    'workspace-created': 2,
    'project-created': 2,
    'plan-version-imported': 3,
    'work-item-admitted': 4,
    'work-item-removed-from-agenda': 4,
    'source-repository-registered': 1,
    'worktree-created': 3,
    'worktree-removed': 3,
    'agent-run-started': 3,
    'agent-run-status-changed': 3,
    'workspace-updated': 2,
    'work-item-completed': 6,
    'worktree-merged': 5,
    'work-cycle-changed': 3,
    'branches-changed': 4,
  },
  ownWorkItem: {
    'runtime-evidence-changed': 4,
    'scope-evidence-recorded': 5,
    'scope-scheduling-authorized': 4,
    'notifications-changed': 0,
    'attention-changed': 3,
    'roadmap-changed': 5,
    'workspace-created': 2,
    'project-created': 2,
    'plan-version-imported': 3,
    'work-item-admitted': 4,
    'work-item-removed-from-agenda': 4,
    'source-repository-registered': 1,
    'worktree-created': 4,
    'worktree-removed': 4,
    'agent-run-started': 4,
    'agent-run-status-changed': 4,
    'workspace-updated': 2,
    'work-item-completed': 6,
    'worktree-merged': 5,
    'work-cycle-changed': 4,
    'branches-changed': 5,
  },
  settings: {
    'runtime-evidence-changed': 3,
    'scope-evidence-recorded': 3,
    'scope-scheduling-authorized': 3,
    'notifications-changed': 1,
    'attention-changed': 4,
    'roadmap-changed': 4,
    'workspace-created': 2,
    'project-created': 2,
    'plan-version-imported': 2,
    'work-item-admitted': 3,
    'work-item-removed-from-agenda': 3,
    'source-repository-registered': 0,
    'worktree-created': 3,
    'worktree-removed': 3,
    'agent-run-started': 3,
    'agent-run-status-changed': 3,
    'workspace-updated': 2,
    'work-item-completed': 4,
    'worktree-merged': 3,
    'work-cycle-changed': 3,
    'branches-changed': 3,
  },
  roadmaps: {
    'runtime-evidence-changed': 4,
    'scope-evidence-recorded': 4,
    'scope-scheduling-authorized': 4,
    'notifications-changed': 0,
    'attention-changed': 4,
    'roadmap-changed': 5,
    'workspace-created': 2,
    'project-created': 2,
    'plan-version-imported': 2,
    'work-item-admitted': 4,
    'work-item-removed-from-agenda': 4,
    'source-repository-registered': 0,
    'worktree-created': 4,
    'worktree-removed': 4,
    'agent-run-started': 3,
    'agent-run-status-changed': 3,
    'workspace-updated': 2,
    'work-item-completed': 5,
    'worktree-merged': 4,
    'work-cycle-changed': 4,
    'branches-changed': 4,
  },
  repositories: {
    'runtime-evidence-changed': 3,
    'scope-evidence-recorded': 3,
    'scope-scheduling-authorized': 3,
    'notifications-changed': 0,
    'attention-changed': 3,
    'roadmap-changed': 4,
    'workspace-created': 2,
    'project-created': 2,
    'plan-version-imported': 2,
    'work-item-admitted': 3,
    'work-item-removed-from-agenda': 3,
    'source-repository-registered': 1,
    'worktree-created': 3,
    'worktree-removed': 3,
    'agent-run-started': 3,
    'agent-run-status-changed': 5,
    'workspace-updated': 2,
    'work-item-completed': 4,
    'worktree-merged': 5,
    'work-cycle-changed': 5,
    'branches-changed': 3,
  },
};

const heading = () => screen.findByRole('heading', { name: /AQ-01 · Alpha work item/ });

/**
 * The pages measured, and so the reads the budget covers: the dashboard (snapshot, workspaces,
 * attention, cycles, audit, live runs), a work item with a worktree (its detail, worktrees and
 * runs, cycles, slices, plan branches and the repository policy, repositories, profiles,
 * agent backends; the worktree's branch only once asked for, R-D5), settings' notifications page, the roadmaps list, and the repositories (each one's checks and receipts). Not
 * measured: a roadmap's own views, its runtime evidence and the cross-project map.
 */
it('reads only what each event changed, on the pages measured (R-D4 4c)', async () => {
  const dashboard = await measure('/workspaces/ws-a', () => screen.findByText('Alpha Project'));
  fixture.worktrees = [WORKTREE];
  const workItem = await measure(`/workspaces/ws-a/work-items/${ITEM}`, heading);
  const ownWorkItem = await measure(`/workspaces/ws-a/work-items/${ITEM}`, heading, true);
  fixture.worktrees = [];
  // Settings' notifications page, whose status a notifications event reads again (R-E5b split).
  const settings = await measure('/workspaces/ws-a/settings/notifications', () =>
    screen.findByRole('heading', { name: 'Settings' }),
  );
  const roadmaps = await measure('/workspaces/ws-a/roadmaps', () =>
    screen.findByRole('heading', { name: 'Roadmaps' }),
  );
  const repositories = await measure('/workspaces/ws-a/repositories', () =>
    screen.findByRole('heading', { name: 'alpha' }),
  );
  const measured = { dashboard, workItem, ownWorkItem, settings, roadmaps, repositories };
  // The reads behind each count, shown when the budget fails.
  expect(measured, `requests per event; the reads were ${JSON.stringify(reads)}`).toEqual(BUDGET);
});

/**
 * R-D5's done-when: a work item page loads with at most three requests. Navigating to it from
 * another page of the app, with the shell's reads held, it reads its region (one answer for the
 * detail, worktrees, runs, cycles, slices, repositories, profiles and agent backends), its plan's
 * branches and that plan's repository policy; a worktree's branch only once asked for.
 */
it('loads a work item page with at most three requests (R-D5)', async () => {
  fixture.worktrees = [WORKTREE];
  window.history.replaceState(null, '', '/workspaces/ws-a');
  render(<App />);
  await screen.findByText('Alpha Project');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  const before = requests.length;
  act(() => {
    window.history.pushState(null, '', `/workspaces/ws-a/work-items/${ITEM}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await heading();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  const loaded = requests.slice(before).sort();
  expect(loaded).toEqual(['plan-branches', 'repository-policy', 'work-item-view']);
  fixture.worktrees = [];
});

/**
 * A run page loads with its region in one read (R-D5): the run's detail, its item's runs and the
 * hand-off's options, then the first page of its events; the stream (mocked here) follows them.
 */
it('loads a run page with its view and its first page of events (R-D5)', async () => {
  window.history.replaceState(null, '', '/workspaces/ws-a');
  render(<App />);
  await screen.findByText('Alpha Project');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  const before = requests.length;
  act(() => {
    window.history.pushState(null, '', '/workspaces/ws-a/runs/run-a');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  // The run page is its own chunk: wait for it to load and read.
  await waitFor(() => expect(requests.slice(before)).toContain('run-events'));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(requests.slice(before).sort()).toEqual(['run-events', 'run-view']);
});

/**
 * R-E3b's done-when (c): selecting on the board makes no request. The board's page reads its
 * region, its definition and its graph; selecting a card, a slice, a gate and a root blocker
 * then changes only the address.
 */
it('reads nothing when the board selects (R-E3b)', async () => {
  const { ROADMAP_ID } = await import('./features/roadmap-board/board-testing.js');
  window.history.replaceState(null, '', `/workspaces/ws-a/roadmaps/${ROADMAP_ID}`);
  render(<App />);
  const card = await screen.findByRole('button', { name: /wi\/WI-01 World interface core/ });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(requests).toEqual(
    expect.arrayContaining(['roadmap-view', 'roadmap-definition', 'roadmap-graph']),
  );
  const before = requests.length;
  // Selecting replaces the history entry: Back leaves the board, not the last selection.
  const entries = window.history.length;
  act(() => card.click());
  expect(window.location.search).toBe('?select=work_item%3Awi%2FWI-01%3Aaccepted');
  act(() => screen.getByRole('button', { name: 'wi/WI-01/impl merged: not met' }).click());
  act(() => screen.getByRole('button', { name: /ADR-1.*unblocks 1/ }).click());
  const panel = screen.getByRole('complementary', { name: 'Selection' });
  act(() =>
    within(panel)
      .getAllByRole('button', { name: /wi\/WI-01\/impl/ })[0]!
      .click(),
  );
  expect(window.location.search).toBe('?select=slice%3Awi%2FWI-01%2Fimpl%3Astarted');
  expect(window.history.length).toBe(entries);
  // The graph view selects the same way.
  act(() => screen.getByRole('link', { name: 'Graph' }).click());
  const graph = await screen.findByRole('region', { name: 'Neighbourhood graph' });
  act(() =>
    within(graph)
      .getByRole('button', { name: /^ADR-1 / })
      .dispatchEvent(new MouseEvent('click', { bubbles: true })),
  );
  expect(window.location.search).toBe('?view=graph&select=checkpoint%3AADR-1%3Apassed');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(requests.slice(before)).toEqual([]);
});

/**
 * R-E4: a plan version's dependency graph is read once per version. The page reads its detail and
 * its graph; no event reads the graph again, since a version never changes.
 */
it('reads a plan version’s graph once, and no event reads it again (R-E4)', async () => {
  for (const kind of KINDS) {
    window.history.replaceState(null, '', '/workspaces/ws-a/projects/project-a/plans/plan');
    render(<App />);
    await screen.findByRole('heading', { name: 'Dependency graph' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    const before = requests.length;
    const onEvent = vi.mocked(useWorkspaceEventStream).mock.lastCall![2].onEvent;
    act(() => onEvent(eventOf(kind, true)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(requests.slice(before), kind).not.toContain('plan-version-graph');
    cleanup();
  }
});

/** R-E4 (review L3): on a phone the plan graph is not drawn, so it is not read either. */
it('reads no plan graph on a phone', async () => {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  window.history.replaceState(null, '', '/workspaces/ws-a/projects/project-a/plans/plan');
  render(<App />);
  await screen.findByRole('heading', { name: 'Plan version 1' });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  });
  expect(requests).toContain('plan-version');
  expect(requests).not.toContain('plan-version-graph');
  expect(screen.queryByRole('region', { name: 'Dependency graph' })).toBeNull();
});
