import type { WorkspaceOverview } from '@craftingtable/contracts';
import type { WorkItemId, WorkspaceId } from '@craftingtable/domain';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadWorkItemView } from '../../lib/execution-api.js';
import { NavigationProvider } from '../../lib/navigation.js';
import { createQueryStore, QueryStoreProvider } from '../../lib/query-store.js';
import { startWorkCycle } from '../../lib/work-cycle-api.js';
import { CycleFocusProvider, SessionProvider, WorkspaceProvider } from '../session.js';
import { WorkItemRoute } from './WorkItemRoute.js';

/**
 * R-E4 (review L3, M2): the work item page's wiring, through the route with the page's own
 * components: the slice strip on a map work item, the navigation's entries, an empty map
 * delegation left out, and a refused command still shown.
 */

const cycle = vi.hoisted(() => ({ onStart: undefined as undefined | ((input: never) => void) }));
vi.mock('../../features/execution/PlanBranchPanel.js', () => ({ PlanBranchPanel: () => null }));
vi.mock('../../features/execution/CyclePanel.js', () => ({
  CyclePanel: (props: { onStart: (input: never) => void }) => {
    cycle.onStart = props.onStart;
    return null;
  },
}));
vi.mock('../../lib/execution-api.js', async (original) => ({
  ...(await original<typeof import('../../lib/execution-api.js')>()),
  loadWorkItemView: vi.fn(),
}));
vi.mock('../../lib/work-cycle-api.js', async (original) => ({
  ...(await original<typeof import('../../lib/work-cycle-api.js')>()),
  startWorkCycle: vi.fn(async () => {
    throw new Error('Start refused: no worktree for this slice.');
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ws = 'ws' as WorkspaceId;
const slice = {
  scope: { kind: 'slice', definitionId: 'map', bindingRevision: 1, sourceId: 'wi/WI-01/impl' },
  repositoryId: 'repo',
  title: 'Implementation',
  description: 'Slice',
  excludes: [],
  blockers: [],
  earlyDevelopment: false,
  earlyDevelopmentAuthorized: false,
  canAuthorizeEarlyDevelopment: false,
  phases: [{ phase: 'start', blockers: [], resources: [], reservations: [] }],
  status: 'not-started',
  next: { actor: 'controller', reason: 'No requirement waiting.' },
  worktreeIds: [],
};

function view(extra: { runs?: unknown[]; worktrees?: unknown[] } = {}) {
  return {
    detail: {
      workItem: {
        id: 'item-1',
        sourceId: 'WI-01',
        title: 'Freeze evidence',
        status: 'admitted',
        readiness: 'active',
        risk: 'medium',
        primaryAreas: [],
        exitGate: 'Baseline.',
        blockerSourceIds: [],
        planVersionId: 'plan-1',
        projectId: 'p1',
      },
      projectName: 'WorldInterface',
      requiredPredecessors: [],
      recommendedPredecessors: [],
      dependents: [],
    },
    execution: {
      workItemId: 'item-1',
      worktrees: extra.worktrees ?? [],
      runs: extra.runs ?? [],
      mergeGates: {},
    },
    cycles: [],
    scopes: { choices: [slice] },
    repositories: [{ id: 'repo', displayName: 'repo', status: 'active' }],
    backends: [],
    profiles: [],
  };
}

function page() {
  return render(
    <QueryStoreProvider value={createQueryStore({ debounceMs: 0, maxWaitMs: 0 })}>
      <SessionProvider
        value={{ user: { username: 'operator' } as never, csrfToken: 'csrf', expire: vi.fn() }}
      >
        <CycleFocusProvider value={{ worktreeId: undefined, focus: vi.fn() }}>
          <NavigationProvider value={{ route: { name: 'home' }, navigate: vi.fn() }}>
            <WorkspaceProvider
              value={{
                workspaceId: ws,
                workspace: { id: ws, name: 'W', role: 'owner' } as WorkspaceOverview,
                canMutate: true,
                isOwner: true,
              }}
            >
              <WorkItemRoute
                workItemId={'item-1' as WorkItemId}
                attention={[]}
                cycles={[]}
                workspaceCyclesFailed={false}
              />
            </WorkspaceProvider>
          </NavigationProvider>
        </CycleFocusProvider>
      </SessionProvider>
    </QueryStoreProvider>,
  );
}

it('opens a map work item with its slice strip, and leaves its empty delegation out', async () => {
  vi.mocked(loadWorkItemView).mockResolvedValue(view() as never);
  page();
  const strip = await screen.findByRole('region', { name: 'Slices' });
  expect(within(strip).getByRole('link', { name: 'impl' })).toBeDefined();
  const nav = screen.getByRole('navigation', { name: 'On this page' });
  const entries = within(nav)
    .getAllByRole('link')
    .map((link) => link.getAttribute('href'));
  expect(entries).toEqual(['#overview', '#branches', '#automation', '#slices']);
  expect(screen.queryByRole('region', { name: 'Delegation' })).toBeNull();
  expect(screen.queryByRole('region', { name: 'Runs' })).toBeNull();
});

it('shows a refused command even while the map delegation would be left out (review M2)', async () => {
  vi.mocked(loadWorkItemView).mockResolvedValue(view() as never);
  page();
  await screen.findByRole('region', { name: 'Slices' });
  await waitFor(() => expect(cycle.onStart).toBeDefined());
  await act(async () => {
    cycle.onStart!({} as never);
  });
  expect(vi.mocked(startWorkCycle)).toHaveBeenCalled();
  const delegation = await screen.findByRole('region', { name: 'Delegation' });
  // A plain error reads as the generic failure; it is shown, not swallowed.
  expect(within(delegation).getByRole('alert').textContent).toBe('The request failed');
});

it('lists delegation and a closed run history once there is a run, naming the newest', async () => {
  const run = (id: string, role: string, createdAt: string) => ({
    id,
    workItemId: 'item-1',
    worktreeId: 'tree-1',
    role,
    status: 'finished',
    backend: 'claude-code',
    createdAt,
    turnCount: 1,
  });
  vi.mocked(loadWorkItemView).mockResolvedValue(
    view({
      worktrees: [
        {
          id: 'tree-1',
          repositoryId: 'repo',
          status: 'active',
          branchName: 'ct/wi-01',
          baseBranch: 'main',
          baseSha: 'a'.repeat(40),
          path: '/tmp/wi-01',
        },
      ],
      // The daemon lists runs newest first.
      runs: [
        run('run-2', 'review', '2026-10-09T02:00:00.000Z'),
        run('run-1', 'implement', '2026-10-09T01:00:00.000Z'),
      ],
    }) as never,
  );
  page();
  const runs = await screen.findByRole('region', { name: 'Runs' });
  // The newest run, and the hand-off it offers, which sits in the closed list (review L1).
  expect(runs.textContent).toContain('Latest: Review · Finished · hand-off offered: Remediate.');
  expect(runs.querySelector('details')?.open).toBe(false);
  const nav = screen.getByRole('navigation', { name: 'On this page' });
  expect(
    within(nav)
      .getAllByRole('link')
      .map((link) => link.getAttribute('href')),
  ).toEqual(['#overview', '#branches', '#automation', '#slices', '#delegation', '#runs']);
});
