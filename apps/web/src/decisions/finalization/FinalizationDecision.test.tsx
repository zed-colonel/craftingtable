import type { FinalizationView } from '@craftingtable/contracts';
import { asPlanVersionId, asWorkspaceId } from '@craftingtable/domain';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadExecutionStatus } from '../../lib/execution-api.js';
import { loadFinalizations } from '../../lib/finalization-api.js';
import { FinalizationDecision } from './FinalizationDecision.js';

vi.mock('../../lib/execution-api.js', () => ({ loadExecutionStatus: vi.fn() }));
vi.mock('../../lib/finalization-api.js', () => ({ loadFinalizations: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const recovering = {
  finalization: {
    id: 'fin-1',
    cycleId: 'cycle-1',
    worktreeId: 'tree-1',
    version: 5,
    status: 'active',
    targetBranch: 'main',
    integrationBranch: 'aq-cont-1',
    policy: { maxRemediationRounds: 3 },
    stages: [],
  },
  cycle: { id: 'cycle-1', version: 9, status: 'paused', currentRunId: 'run-9' },
  runs: [
    { id: 'run-9', reviewBranchContext: { headSha: 'a'.repeat(40), targetSha: 'b'.repeat(40) } },
  ],
  actions: ['merge'],
  mergeRecoveryPending: true,
  checkpointFindings: [],
  canAuthorizeRemediation: false,
} as unknown as FinalizationView;

it("finds a merge item's finalization by its worktree, which is all the item names (R-A6 2b review)", async () => {
  vi.mocked(loadExecutionStatus).mockResolvedValue({ backends: [] } as never);
  vi.mocked(loadFinalizations).mockResolvedValue({ finalizations: [recovering] } as never);
  render(
    <FinalizationDecision
      workspaceId={asWorkspaceId('ws')}
      planVersionId={asPlanVersionId('plan')}
      worktreeId="tree-1"
      csrfToken="csrf"
      canMutate
      refreshToken={0}
      onChanged={vi.fn()}
      onOpenRun={vi.fn()}
    />,
  );
  expect(await screen.findByRole('button', { name: 'Recover approved promotion' })).toBeTruthy();
});

it('does not take another finalization for one it cannot find', async () => {
  vi.mocked(loadExecutionStatus).mockResolvedValue({ backends: [] } as never);
  vi.mocked(loadFinalizations).mockResolvedValue({ finalizations: [recovering] } as never);
  render(
    <FinalizationDecision
      workspaceId={asWorkspaceId('ws')}
      planVersionId={asPlanVersionId('plan')}
      worktreeId="tree-2"
      csrfToken="csrf"
      canMutate
      refreshToken={0}
      onChanged={vi.fn()}
      onOpenRun={vi.fn()}
    />,
  );
  expect(await screen.findByText(/could not be loaded/)).toBeTruthy();
});
