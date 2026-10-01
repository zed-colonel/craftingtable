import { finalizationsResponseSchema } from '@craftingtable/contracts';
import type { AgentRunId, PlanVersionId, WorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadPlanBranchSettings } from '../../lib/branch-api.js';
import { loadExecutionStatus, loadRunProfiles } from '../../lib/execution-api.js';
import { loadFinalizations } from '../../lib/finalization-api.js';
import { testQueryStore } from '../../lib/query-store-testing.js';
import type { ReactElement } from 'react';
import legacyRecord from '../../../../../fixtures/records/legacy-finalization-2026-09-13.json?raw';
import { FinalizationPanel } from './FinalizationPanel.js';

vi.mock('../../lib/finalization-api.js', () => ({
  loadFinalizations: vi.fn(),
  startFinalization: vi.fn(),
  controlFinalization: vi.fn(),
}));
vi.mock('../../lib/branch-api.js', () => ({ loadPlanBranchSettings: vi.fn() }));
vi.mock('../../lib/execution-api.js', () => ({
  loadExecutionStatus: vi.fn(),
  loadRunProfiles: vi.fn(),
  loadRun: vi.fn(),
  loadWorktreeDiff: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

/** The completed legacy finalization on the live database, 2026-09-13 (R-B10). */
const legacy = JSON.parse(legacyRecord);

function renderPanel(finalizations: unknown[], wrap = (ui: ReactElement) => ui) {
  vi.mocked(loadFinalizations).mockResolvedValue(
    finalizationsResponseSchema.parse({ finalizations }),
  );
  vi.mocked(loadPlanBranchSettings).mockResolvedValue({
    settings: { version: 1, integrationBranch: 'aq-cont-1' },
  } as Awaited<ReturnType<typeof loadPlanBranchSettings>>);
  vi.mocked(loadExecutionStatus).mockResolvedValue({
    backends: [{ kind: 'claude-code', available: true }],
  } as Awaited<ReturnType<typeof loadExecutionStatus>>);
  vi.mocked(loadRunProfiles).mockResolvedValue({ profiles: [] } as unknown as Awaited<
    ReturnType<typeof loadRunProfiles>
  >);
  render(
    wrap(
      <FinalizationPanel
        workspaceId={legacy.finalization.workspaceId as WorkspaceId}
        planVersionId={legacy.finalization.planVersionId as PlanVersionId}
        csrfToken="csrf"
        canMutate
        onOpenRun={(_id: AgentRunId) => undefined}
      />,
    ),
  );
}

it('still renders the completed legacy finalization after new starts became staged', async () => {
  renderPanel([
    {
      finalization: legacy.finalization,
      cycle: legacy.cycle,
      runs: [],
      mergeRecoveryPending: false,
    },
  ]);
  const attempt = await screen.findByRole('region', { name: 'Finalization attempt' });
  expect(attempt.textContent).toContain('aq-cont-1 → main');
  expect(attempt.textContent).toContain('Promoted by operator');
  expect(attempt.textContent).toContain('final-review · 2 of 2 improvement rounds');
  expect(attempt.textContent).toContain('Promoted to main by explicit operator approval.');
  expect(attempt.textContent).toContain('Local integration branch aq-cont-1 removed.');
});

it('offers only staged finalizations for a new start', async () => {
  renderPanel([]);
  fireEvent.click(await screen.findByRole('button', { name: 'Set up finalization' }));
  expect(await screen.findByRole('region', { name: 'Finalization stage setup' })).toBeTruthy();
  expect(screen.queryByLabelText('Finalization workflow')).toBeNull();
  expect(screen.queryByText('Legacy improvement rounds')).toBeNull();
  expect(screen.queryByLabelText('Improvement rounds')).toBeNull();
});

it("re-reads its plan's finalizations on its own cycles' and runs' events, and its branches each minute (R-D4)", async () => {
  const { store, wrap, send } = testQueryStore();
  const ws = legacy.finalization.workspaceId as string;
  const plan = legacy.finalization.planVersionId as string;
  renderPanel(
    [
      {
        finalization: legacy.finalization,
        cycle: legacy.cycle,
        runs: [],
        mergeRecoveryPending: false,
      },
    ],
    wrap,
  );
  await screen.findByRole('region', { name: 'Finalization attempt' });
  expect(loadFinalizations).toHaveBeenCalledTimes(1);
  // A work item's cycle, and another plan's, change nothing here.
  await send('work-cycle-changed', {
    workspaceId: ws,
    workItemId: 'w',
    payload: { workItemId: 'w' },
  });
  await send('work-cycle-changed', { workspaceId: ws, payload: { planVersionId: 'another-plan' } });
  expect(loadFinalizations).toHaveBeenCalledTimes(1);
  await send('agent-run-status-changed', { workspaceId: ws, payload: { planVersionId: plan } });
  await waitFor(() => expect(loadFinalizations).toHaveBeenCalledTimes(2));
  // The branches are Git's: the minute's refresh reads them, and nothing else.
  const branches = vi.mocked(loadPlanBranchSettings).mock.calls.length;
  store.invalidate([['plan-branches']]);
  await waitFor(() => expect(loadPlanBranchSettings).toHaveBeenCalledTimes(branches + 1));
  expect(loadFinalizations).toHaveBeenCalledTimes(2);
});
