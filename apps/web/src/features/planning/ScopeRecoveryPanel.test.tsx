import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Roadmap } from '@craftingtable/domain';
import { ScopeRecoveryPanel } from './ScopeRecoveryPanel.js';
import { request } from '../../lib/api-client.js';
vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const roadmap = {
  id: 'roadmap',
  workspaceId: 'workspace',
  version: 9,
  status: 'paused',
  definition: { entries: [{ id: 'owner', workItemId: 'item', sourceId: 'exo/EXO-01/domain' }] },
  attempts: [],
} as unknown as Roadmap;
function setup(value = roadmap, canMutate = true) {
  const onChange = vi.fn(),
    onOpenWorkItem = vi.fn();
  render(
    <ScopeRecoveryPanel
      roadmap={value}
      csrfToken="csrf"
      canMutate={canMutate}
      onChange={onChange}
      onOpenWorkItem={onOpenWorkItem}
    />,
  );
  return { onChange, onOpenWorkItem };
}
it('explicitly grants a total allowance without resuming or changing the accepted plan', async () => {
  vi.mocked(request).mockResolvedValue({ roadmap, progress: [] });
  const { onChange } = setup();
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Configure review recovery' }));
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText('Total automatic repair rounds per parent'), {
    target: { value: '5' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save recovery delegation' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  expect(request).toHaveBeenCalledTimes(1);
  expect(vi.mocked(request).mock.calls[0]![0]).toContain('/scope-recovery');
  expect(JSON.parse(vi.mocked(request).mock.calls[0]![2]!.body as string)).toEqual({
    expectedVersion: 9,
    enabled: true,
    maxRoundsPerParent: 5,
  });
});
it('preserves input after a stale-version error', async () => {
  vi.mocked(request).mockRejectedValue(new Error('Roadmap changed; refresh before saving.'));
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Configure review recovery' }));
  fireEvent.change(screen.getByLabelText('Total automatic repair rounds per parent'), {
    target: { value: '6' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save recovery delegation' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Roadmap changed');
  expect(
    (screen.getByLabelText('Total automatic repair rounds per parent') as HTMLInputElement).value,
  ).toBe('6');
});
it('requires pause and hides mutation controls from read-only users', () => {
  setup({ ...roadmap, status: 'running' });
  expect(
    (screen.getByRole('button', { name: 'Configure review recovery' }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  cleanup();
  setup(roadmap, false);
  expect(screen.queryByRole('button', { name: 'Configure review recovery' })).toBeNull();
});
it('shows durable rounds and opens the owning work item', () => {
  const { onOpenWorkItem } = setup({
    ...roadmap,
    scopeRecovery: {
      enabled: true,
      maxRoundsPerParent: 3,
      grantedAt: '2026-09-18T00:00:00Z',
      grantedByUserId: 'owner',
    },
    attempts: [
      {
        id: 'round',
        entryId: 'owner',
        createdAt: '2026-09-18T00:00:00Z',
        recovery: { phase: 'verification' },
      },
    ],
  } as unknown as Roadmap);
  fireEvent.click(screen.getByRole('button', { name: 'exo/EXO-01: 1 / 3 automatic rounds used' }));
  expect(onOpenWorkItem).toHaveBeenCalledWith('item');
  expect(screen.getByText('Fresh independent verification')).toBeTruthy();
});
