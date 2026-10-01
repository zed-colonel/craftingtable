import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WorkCycle } from '@craftingtable/domain';
import { BaselinePreparation } from './BaselinePreparation.js';
import { prepareBaseline, previewBaseline } from './design-api.js';
vi.mock('./design-api.js', () => ({
  prepareBaseline: vi.fn(),
  previewBaseline: vi.fn(),
  loadBaselineEvidence: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('requires explicit exact-ref confirmation and keeps errors visible without launching recovery', async () => {
  const cycle = { id: 'cycle', workspaceId: 'ws', version: 2 } as WorkCycle;
  const source = {
    alias: 'aq',
    repositoryId: 'repo' as never,
    directoryName: 'actionqueue',
    ref: 'a'.repeat(40),
    tag: '',
    fixed: false,
    explanation: 'Retained pre-redesign tag',
  };
  vi.mocked(previewBaseline).mockResolvedValue({
    expectedVersion: 2,
    contextDigest: 'a'.repeat(64),
    consumerAlias: 'aq',
    sources: [source],
    notices: [],
  });
  vi.mocked(prepareBaseline).mockRejectedValue(new Error('Tag mismatch; nothing was moved.'));
  const onChanged = vi.fn();
  render(<BaselinePreparation cycle={cycle} csrfToken="csrf" onChanged={onChanged} />);
  expect(previewBaseline).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Prepare baseline evidence' }));
  const submit = await screen.findByRole('button', { name: 'Prepare historical sources and tags' });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  expect((submit as HTMLButtonElement).disabled).toBe(false);
  fireEvent.change(screen.getByLabelText('Historical commit or local ref'), {
    target: { value: 'b'.repeat(40) },
  });
  expect((submit as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(submit);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Tag mismatch'));
  expect(onChanged).not.toHaveBeenCalled();
  expect(prepareBaseline).toHaveBeenCalledWith(
    cycle,
    expect.objectContaining({ sources: [{ alias: 'aq', ref: 'b'.repeat(40) }] }),
    'csrf',
  );
});
