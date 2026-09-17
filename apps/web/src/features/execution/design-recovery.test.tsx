import type { DesignRecoveryPreview } from '@craftingtable/contracts';
import { CYCLE_STEPS, DEFAULT_COMPLETION_POLICY, type WorkCycle } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DesignRecoveryPanel } from './DesignRecoveryPanel.js';
import { previewDesignRecovery, recoverDesign } from '../../lib/work-cycle-api.js';

vi.mock('../../lib/work-cycle-api.js', () => ({
  previewDesignRecovery: vi.fn(),
  recoverDesign: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const cycle = {
  id: 'cycle',
  workspaceId: 'ws',
  workItemId: 'item',
  worktreeId: 'tree',
  currentRunId: 'design',
  version: 2,
  step: 'design',
  status: 'needs-attention',
  policy: DEFAULT_COMPLETION_POLICY,
  profiles: Object.fromEntries(
    CYCLE_STEPS.map((step) => [
      step,
      { backend: 'claude-code', permissionMode: 'auto', model: 'prior-model' },
    ]),
  ),
} as WorkCycle;
const preview: DesignRecoveryPreview = {
  expectedVersion: 2,
  sourceRunId: cycle.currentRunId,
  questions: 'Who owns this decision?',
  facts: 'Saved facts',
  snapshotDigest: 'a'.repeat(64),
  sources: [],
  notices: [],
};
const backends = [
  {
    kind: 'claude-code' as const,
    label: 'Claude Code',
    available: true,
    executable: 'claude',
    models: [],
  },
];
it('only discovers on request, defaults to bounded investigation, and retains guidance after a failed submission', async () => {
  vi.mocked(previewDesignRecovery).mockResolvedValue(preview);
  vi.mocked(recoverDesign).mockRejectedValue(new Error('Evidence changed; refresh.'));
  const onChanged = vi.fn();
  render(
    <DesignRecoveryPanel
      cycle={cycle}
      backends={backends}
      csrfToken="csrf"
      onChanged={onChanged}
    />,
  );
  expect(previewDesignRecovery).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Resolve design questions' }));
  expect(await screen.findByText('Who owns this decision?')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Answers and guidance'), {
    target: { value: 'I own the decision.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Start bounded investigation' }));
  await screen.findByRole('alert');
  expect(recoverDesign).toHaveBeenCalledWith(
    cycle,
    expect.objectContaining({
      mode: 'investigate',
      expectedVersion: 2,
      snapshotDigest: preview.snapshotDigest,
      instructions: 'I own the decision.',
      profile: { backend: 'claude-code', model: 'prior-model' },
    }),
    'csrf',
  );
  expect((screen.getByLabelText('Answers and guidance') as HTMLTextAreaElement).value).toBe(
    'I own the decision.',
  );
  expect(onChanged).not.toHaveBeenCalled();
  vi.mocked(recoverDesign).mockResolvedValue({ cycle } as Awaited<
    ReturnType<typeof recoverDesign>
  >);
  fireEvent.change(screen.getByRole('combobox', { name: 'Next action' }), {
    target: { value: 'continue' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Continue design with evidence' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  expect(vi.mocked(recoverDesign).mock.calls[1]?.[1].mode).toBe('continue');
});
it('disables a preview when the cycle changes until discovery is refreshed', async () => {
  vi.mocked(previewDesignRecovery).mockResolvedValue(preview);
  const view = render(
    <DesignRecoveryPanel cycle={cycle} backends={backends} csrfToken="csrf" onChanged={vi.fn()} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Resolve design questions' }));
  await screen.findByText('Who owns this decision?');
  view.rerender(
    <DesignRecoveryPanel
      cycle={{ ...cycle, version: 3 }}
      backends={backends}
      csrfToken="csrf"
      onChanged={vi.fn()}
    />,
  );
  expect(
    (screen.getByRole('button', { name: 'Start bounded investigation' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(screen.getByRole('alert').textContent).toContain('cycle changed');
  expect(recoverDesign).not.toHaveBeenCalled();
});
