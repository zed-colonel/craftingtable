import type { ExecutionScopeChoice } from '@craftingtable/contracts';
import type { WorkCycle } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadExecutionScopes } from '../../lib/execution-scope-api.js';
import { ScopeReviewRecovery } from './ScopeReviewRecovery.js';
vi.mock('../../lib/execution-scope-api.js', () => ({ loadExecutionScopes: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const cycle = {
  workspaceId: 'ws',
  workItemId: 'wi',
  version: 2,
  executionScope: {
    kind: 'parent-acceptance',
    definitionId: 'map',
    bindingRevision: 4,
    sourceId: 'wi/WI-01',
  },
} as WorkCycle;
const choice = (blocked: boolean) =>
  ({
    scope: cycle.executionScope,
    phases: [
      {
        phase: 'accept',
        blockers: blocked
          ? [
              {
                kind: 'evidence',
                message: 'Required slice wi/WI-01/implementation has not been verified.',
              },
            ]
          : [],
      },
    ],
  }) as ExecutionScopeChoice;
it('keeps guidance visible while verification is stale and submits only after fresh gates clear', async () => {
  vi.mocked(loadExecutionScopes)
    .mockResolvedValueOnce({ choices: [choice(true)] })
    .mockResolvedValueOnce({ choices: [choice(false)] });
  const onResume = vi.fn();
  render(
    <ScopeReviewRecovery cycle={cycle} disabled={false} refreshToken={0} onResume={onResume} />,
  );
  await screen.findByText('Required slice wi/WI-01/implementation has not been verified.');
  expect(
    (screen.getByRole('button', { name: 'Resume scope review' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText('Additional review guidance'), {
    target: { value: 'Use the adopted repository policy.' },
  });
  fireEvent.submit(screen.getByRole('form', { name: 'Recover scope review' }));
  expect(onResume).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh review requirements' }));
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Resume scope review' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Resume scope review' }));
  expect(onResume).toHaveBeenCalledWith('Use the adopted repository policy.');
});
it('does not enable recovery when requirements cannot be loaded', async () => {
  vi.mocked(loadExecutionScopes).mockRejectedValue(new Error('Requirements unavailable'));
  render(
    <ScopeReviewRecovery cycle={cycle} disabled={false} refreshToken={0} onResume={vi.fn()} />,
  );
  await screen.findByRole('alert');
  expect(
    (screen.getByRole('button', { name: 'Resume scope review' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});
