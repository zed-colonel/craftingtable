import { finalizationsResponseSchema } from '@craftingtable/contracts';
import type { AgentRunId, PlanVersionId, WorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadPlanBranchSettings } from '../../lib/branch-api.js';
import { loadExecutionStatus, loadRunProfiles } from '../../lib/execution-api.js';
import { loadFinalizations } from '../../lib/finalization-api.js';
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

function renderPanel(finalizations: unknown[]) {
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
    <FinalizationPanel
      workspaceId={legacy.finalization.workspaceId as WorkspaceId}
      planVersionId={legacy.finalization.planVersionId as PlanVersionId}
      csrfToken="csrf"
      canMutate
      onOpenRun={(_id: AgentRunId) => undefined}
    />,
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
