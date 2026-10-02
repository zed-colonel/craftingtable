import type { ExecutionScopeChoice, WorktreeSummary } from '@craftingtable/contracts';
import type { WorkCycle, WorkItemId, WorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadExecutionScopes } from '../../lib/execution-scope-api.js';
import { testQueryStore } from '../../lib/query-store-testing.js';
import { createWorktree } from '../../lib/execution-api.js';
import { ExecutionScopesPanel } from './ExecutionScopesPanel.js';
vi.mock('../../lib/execution-scope-api.js', () => ({ loadExecutionScopes: vi.fn() }));
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
function view(
  trees: WorktreeSummary[],
  cycles: WorkCycle[] = [],
  itemStatus: 'proposed' | 'admitted' | 'completed' = 'admitted',
) {
  vi.mocked(loadExecutionScopes).mockResolvedValue({
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
  });
  const onOpenCycle = vi.fn();
  render(
    <ExecutionScopesPanel
      workspaceId={'ws' as WorkspaceId}
      workItemId={'wi' as WorkItemId}
      csrfToken="csrf"
      canMutate
      itemStatus={itemStatus}
      onChanged={vi.fn()}
      worktrees={trees}
      cycles={cycles}
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
  // Its own command reads the slices again at once (R-D4 increment 4b).
  await waitFor(() => expect(loadExecutionScopes).toHaveBeenCalledTimes(2));
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
  vi.mocked(loadExecutionScopes).mockResolvedValue(choices);
  render(<ExecutionScopesPanel {...props} decisionItemFor={() => 'item-3'} />);
  expect(await screen.findByText(/This checkpoint is decided in Needs you/)).toBeDefined();
  expect(screen.queryByRole('region', { name: 'Checkpoint recovery' })).toBeNull();
  cleanup();
  vi.mocked(loadExecutionScopes).mockResolvedValue(choices);
  render(<ExecutionScopesPanel {...props} />);
  expect(await screen.findByRole('region', { name: 'Checkpoint recovery' })).toBeDefined();
});

// R-D4 increment 4b: the slices re-read on their own work item's events, not on every event.
it("re-reads its work item's slices when an event names the item, and not for another item's", async () => {
  vi.mocked(loadExecutionScopes).mockResolvedValue({ choices: [] });
  const { wrap, send } = testQueryStore();
  render(
    wrap(
      <ExecutionScopesPanel
        workspaceId={'ws' as WorkspaceId}
        workItemId={'wi' as WorkItemId}
        csrfToken="csrf"
        canMutate
        itemStatus="admitted"
        onChanged={vi.fn()}
        worktrees={[]}
      />,
    ),
  );
  await send('notifications-changed', { workspaceId: 'ws' });
  expect(loadExecutionScopes).toHaveBeenCalledTimes(1);
  await send('work-cycle-changed', { workspaceId: 'ws', workItemId: 'other' });
  await send('repository-registered', { workspaceId: 'ws', repositoryId: 'repo' });
  expect(loadExecutionScopes).toHaveBeenCalledTimes(1);
  await send('work-cycle-changed', { workspaceId: 'ws', workItemId: 'wi' });
  expect(loadExecutionScopes).toHaveBeenCalledTimes(2);
  await send('roadmap-changed', { workspaceId: 'ws', payload: { roadmapId: 'r' } });
  expect(loadExecutionScopes).toHaveBeenCalledTimes(3);
});
