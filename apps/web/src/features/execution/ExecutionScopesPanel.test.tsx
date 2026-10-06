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
