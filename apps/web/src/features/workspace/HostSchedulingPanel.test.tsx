import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { HostSchedulingPanel } from './HostSchedulingPanel.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const status = {
  version: 1,
  verificationCapacity: 1,
  developmentCapacity: 4,
  source: 'daemon-environment',
  updatedAt: null,
  reservations: [],
  waiting: [],
  roadmaps: [],
};
it('shows separate capacity and preserves an unsaved edit when refreshing reservations', async () => {
  vi.mocked(request)
    .mockResolvedValueOnce(status)
    .mockResolvedValueOnce(status)
    .mockResolvedValueOnce({
      ...status,
      version: 2,
      verificationCapacity: 2,
      source: 'saved-setting',
    });
  render(<HostSchedulingPanel workspaceId="workspace" csrfToken="csrf" />);
  await screen.findByText('No verification reservations are occupied.');
  fireEvent.click(screen.getByRole('button', { name: 'Change verification capacity' }));
  const input = screen.getByLabelText('Concurrent verification reviews') as HTMLInputElement;
  fireEvent.change(input, { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh reservations' }));
  await screen.findByText('Reservations and settings refreshed.');
  expect(input.value).toBe('2');
  fireEvent.click(screen.getByRole('button', { name: 'Save verification capacity' }));
  await screen.findByText(/Verification capacity saved/);
  expect(JSON.parse(String(vi.mocked(request).mock.calls[2]![2]!.body))).toEqual({
    expectedVersion: 1,
    verificationCapacity: 2,
  });
  expect(screen.queryByLabelText('Concurrent verification reviews')).toBeNull();
});
it('links occupied runs and prevents saving while scheduling is running', async () => {
  vi.mocked(request).mockResolvedValue({
    ...status,
    reservations: [
      {
        id: 'claim',
        workspaceId: 'workspace',
        workItemId: 'item',
        runId: 'run',
        label: 'EXO-02',
        phase: 'accept',
        acquiredAt: '2026-09-22T01:00:00Z',
      },
    ],
    roadmaps: [{ id: 'map', workspaceId: 'workspace', name: 'Stack', status: 'running' }],
  });
  render(<HostSchedulingPanel workspaceId="workspace" csrfToken="csrf" />);
  await screen.findByText('EXO-02');
  expect(screen.getByRole('link', { name: 'Open run' }).getAttribute('href')).toBe(
    '/workspaces/workspace/runs/run',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Change verification capacity' }));
  fireEvent.change(screen.getByLabelText('Concurrent verification reviews'), {
    target: { value: '2' },
  });
  expect(
    screen.getByRole('button', { name: 'Save verification capacity' }).hasAttribute('disabled'),
  ).toBe(true);
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
});
