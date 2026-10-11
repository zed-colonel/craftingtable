import type { ExecutionScopeChoice, WorktreeSummary } from '@craftingtable/contracts';
import type { WorkCycle, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorktree } from '../../lib/execution-api.js';
import { ExecutionScopesPanel } from './ExecutionScopesPanel.js';
vi.mock('../../lib/execution-api.js', () => ({ createWorktree: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const scope = {
  kind: 'slice' as const,
  definitionId: 'map',
  bindingRevision: 4,
  sourceId: 'wi/WI-01/implementation',
};
const tree = {
  id: 'verification-tree',
  status: 'active',
  branchName: 'ct/verification',
  executionScope: { ...scope, kind: 'slice-verification' },
} as WorktreeSummary;
const onChanged = vi.fn();
function view(
  trees: WorktreeSummary[],
  cycles: WorkCycle[] = [],
  itemStatus: 'proposed' | 'admitted' | 'completed' = 'admitted',
) {
  const scopes = {
    choices: [
      {
        scope,
        title: 'Implementation',
        description: 'Slice',
        status: 'merged',
        excludes: [],
        blockers: [],
        repositoryId: 'repo',
        phases: [{ phase: 'verify', blockers: [], resources: [], reservations: [] }],
      } as unknown as ExecutionScopeChoice,
    ],
  };
  const onOpenCycle = vi.fn();
  render(
    <ExecutionScopesPanel
      workspaceId={'ws' as WorkspaceId}
      workItemId={'wi' as WorkItemId}
      csrfToken="csrf"
      canMutate
      itemStatus={itemStatus}
      onChanged={onChanged}
      worktrees={trees}
      scopes={scopes}
      cycles={cycles.map((cycle) => ({
        cycle,
        projection: { nextAgentSelections: {} as never, actions: [] },
      }))}
      onOpenCycle={onOpenCycle}
    />,
  );
  return onOpenCycle;
}
it('opens completed verification recovery instead of creating a duplicate worktree', async () => {
  const onOpen = view([tree], [{ worktreeId: tree.id, status: 'completed' } as WorkCycle]);
  fireEvent.click(
    await screen.findByRole('button', { name: 'Review again with existing verification cycle' }),
  );
  expect(onOpen).toHaveBeenCalledWith(tree.id);
  expect(createWorktree).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Create verification worktree' })).toBeNull();
});
it('routes unfinished verification to its existing recovery controls', async () => {
  const onOpen = view([tree], [{ worktreeId: tree.id, status: 'needs-attention' } as WorkCycle]);
  fireEvent.click(await screen.findByRole('button', { name: 'Open verification recovery' }));
  expect(onOpen).toHaveBeenCalledWith(tree.id);
  expect(createWorktree).not.toHaveBeenCalled();
});
it('does not reuse a verification worktree from another exact binding', async () => {
  view([{ ...tree, executionScope: { ...tree.executionScope!, bindingRevision: 3 } }]);
  expect(await screen.findByRole('button', { name: 'Create verification worktree' })).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Open existing verification worktree' })).toBeNull();
});

it('offers fresh verification on a completed parent, as the daemon allows', async () => {
  // A decision approved after verification makes the evidence stale on a completed item; the
  // daemon accepts scoped work on it, so the page must too.
  view([], [], 'completed');
  const create = await screen.findByRole<HTMLButtonElement>('button', {
    name: 'Create verification worktree',
  });
  expect(create.disabled).toBe(false);
  fireEvent.click(create);
  expect(createWorktree).toHaveBeenCalledWith(
    'ws',
    'wi',
    { repositoryId: 'repo', executionScope: { ...scope, kind: 'slice-verification' } },
    'csrf',
  );
  // Its own command has the host read the item's region, slices included, again at once (R-D5).
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
});
it('still asks for admission before scoped work on a proposed item', async () => {
  view([], [], 'proposed');
  const create = await screen.findByRole<HTMLButtonElement>('button', {
    name: 'Create verification worktree',
  });
  expect(create.disabled).toBe(true);
  expect(screen.getByText('Admit the parent before creating an execution worktree.')).toBeDefined();
});
it("links a slice's checkpoint to the inbox item that carries its merge, else prepares it here (R-A6)", async () => {
  const slice = {
    id: 'slice-tree',
    status: 'active',
    branchName: 'ct/slice',
    executionScope: scope,
  } as WorktreeSummary;
  const choices = {
    choices: [
      {
        scope,
        title: 'Implementation',
        description: 'Slice',
        status: 'in-progress',
        excludes: [],
        blockers: [],
        repositoryId: 'repo',
        phases: [
          {
            phase: 'merge',
            blockers: [
              { kind: 'checkpoint', code: 'checkpoint-evidence', message: 'Evidence needed' },
            ],
            resources: [],
            reservations: [],
          },
        ],
      } as unknown as ExecutionScopeChoice,
    ],
  };
  const props = {
    workspaceId: 'ws' as WorkspaceId,
    workItemId: 'wi' as WorkItemId,
    csrfToken: 'csrf',
    canMutate: true,
    itemStatus: 'admitted' as const,
    onChanged: vi.fn(),
    worktrees: [slice],
  };
  render(<ExecutionScopesPanel {...props} scopes={choices} decisionItemFor={() => 'item-3'} />);
  expect(await screen.findByText(/This checkpoint is decided in Needs you/)).toBeDefined();
  expect(screen.queryByRole('region', { name: 'Checkpoint recovery' })).toBeNull();
  cleanup();
  render(<ExecutionScopesPanel {...props} scopes={choices} />);
  expect(await screen.findByRole('region', { name: 'Checkpoint recovery' })).toBeDefined();
});

it('shows why the slices could not be read, over the ones last read', () => {
  render(
    <ExecutionScopesPanel
      workspaceId={'ws' as WorkspaceId}
      workItemId={'wi' as WorkItemId}
      csrfToken="csrf"
      canMutate
      itemStatus="admitted"
      onChanged={vi.fn()}
      worktrees={[]}
      scopes={undefined}
      loadError={new Error('Daemon unavailable')}
    />,
  );
  expect(screen.getByRole('alert').textContent).toBe('Daemon unavailable');
});

it("shows a scope's cycle by the projection's review wait, not its stored reason (CTRL-22, R-D5)", async () => {
  vi.mocked(createWorktree).mockReset();
  render(
    <ExecutionScopesPanel
      workspaceId={'ws' as WorkspaceId}
      workItemId={'wi' as WorkItemId}
      csrfToken="csrf"
      canMutate
      itemStatus="admitted"
      onChanged={vi.fn()}
      worktrees={[{ ...tree, executionScope: scope } as WorktreeSummary]}
      onOpenCycle={vi.fn()}
      cycles={[
        {
          cycle: {
            id: 'c1',
            worktreeId: tree.id,
            status: 'needs-attention',
            reason: 'The stored reason.',
          } as WorkCycle,
          projection: {
            nextAgentSelections: {} as never,
            actions: [],
            scopeReviewWait: 'Waiting for prerequisite work.',
          },
        },
      ]}
      scopes={{
        choices: [
          {
            scope,
            title: 'Implementation',
            description: 'Slice',
            status: 'in-progress',
            excludes: [],
            blockers: [],
            repositoryId: 'repo',
            phases: [],
          } as unknown as ExecutionScopeChoice,
        ],
      }}
    />,
  );
  expect(await screen.findByText('Waiting for prerequisite work.')).toBeTruthy();
  expect(screen.queryByText('The stored reason.')).toBeNull();
});

it('reads the slices again once a scope verification is recorded (review L4, C64)', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ recorded: true, workItemCompleted: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetch);
  try {
    view([tree]);
    fireEvent.click(screen.getByRole('button', { name: 'Record slice verification' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe(
      '/api/workspaces/ws/worktrees/verification-tree/scope-evidence',
    );
  } finally {
    vi.unstubAllGlobals();
  }
});

it('shows a slice’s next phase, keeps its other phases closed, and is the strip’s anchor (R-E4)', () => {
  const blocker = (message: string) => ({ kind: 'dependency', code: 'slice-requirement', message });
  render(
    <ExecutionScopesPanel
      workspaceId={'ws' as WorkspaceId}
      workItemId={'wi' as WorkItemId}
      csrfToken="csrf"
      canMutate
      itemStatus="admitted"
      onChanged={onChanged}
      worktrees={[]}
      scopes={{
        choices: [
          {
            scope,
            title: 'Implementation',
            description: 'Slice',
            status: 'started',
            excludes: [],
            blockers: [],
            repositoryId: 'repo',
            phases: [
              { phase: 'start', blockers: [], resources: [], reservations: [] },
              {
                phase: 'merge',
                blockers: [blocker('Merge the contract first.')],
                resources: [],
                reservations: [],
              },
              {
                phase: 'verify',
                blockers: [blocker('Merge this slice first.')],
                resources: [],
                reservations: [],
              },
            ],
          } as unknown as ExecutionScopeChoice,
        ],
      }}
    />,
  );
  const article = screen
    .getByRole('heading', { name: /wi\/WI-01\/implementation/ })
    .closest('article')!;
  expect(article.id).toBe('slice-slice-wi/WI-01/implementation');
  // Started, so merging is next: its requirements show; starting and verifying sit in a closed
  // disclosure.
  const next = screen.getByRole('heading', { name: 'Next: Merge into integration' });
  expect(next.closest('details')).toBeNull();
  expect(screen.getByText('Merge the contract first.').closest('details')).toBeNull();
  const later = screen.getByText('Merge this slice first.').closest('details')!;
  expect(later.open).toBe(false);
  expect(later.querySelector('summary')?.textContent).toBe('Other phases (2)');
});

it('points at the acceptance worktree only once there is one (R-E4)', () => {
  const acceptance = { ...scope, kind: 'parent-acceptance' as const, sourceId: 'wi/WI-01' };
  const panel = (worktrees: WorktreeSummary[]) =>
    render(
      <ExecutionScopesPanel
        workspaceId={'ws' as WorkspaceId}
        workItemId={'wi' as WorkItemId}
        csrfToken="csrf"
        canMutate
        itemStatus="admitted"
        onChanged={onChanged}
        worktrees={worktrees}
        scopes={{
          choices: [
            {
              scope: acceptance,
              title: 'Parent',
              description: 'Parent',
              status: 'not-started',
              excludes: [],
              blockers: [],
              repositoryId: 'repo',
              phases: [{ phase: 'accept', blockers: [], resources: [], reservations: [] }],
            } as unknown as ExecutionScopeChoice,
          ],
        }}
      />,
    );
  panel([]);
  expect(screen.queryByText(/acceptance worktree below/)).toBeNull();
  cleanup();
  panel([
    {
      id: 'acceptance-tree',
      status: 'active',
      branchName: 'ct/acceptance',
      executionScope: acceptance,
    } as WorktreeSummary,
  ]);
  expect(screen.getByText(/acceptance worktree below/)).toBeDefined();
});

it('shows the follow-ups a passing verification kept, as such (R-C7 D7)', () => {
  render(
    <ExecutionScopesPanel
      workspaceId={'ws' as WorkspaceId}
      workItemId={'wi' as WorkItemId}
      csrfToken="csrf"
      canMutate
      itemStatus="admitted"
      onChanged={onChanged}
      worktrees={[]}
      scopes={{
        choices: [
          {
            scope,
            title: 'Implementation',
            description: 'Slice',
            status: 'verified',
            excludes: [],
            blockers: [],
            repositoryId: 'repo',
            phases: [],
            followUps: [
              {
                id: 'R-1',
                severity: 'minor',
                status: 'open',
                title: 'A minor left open',
                explanation: 'Why',
                recommendation: 'What',
              },
            ],
          } as unknown as ExecutionScopeChoice,
        ],
      }}
      cycles={[]}
      onOpenCycle={vi.fn()}
    />,
  );
  expect(screen.getByText('Verification follow-ups (1)')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'R-1 · minor · A minor left open' })).toBeTruthy();
});
