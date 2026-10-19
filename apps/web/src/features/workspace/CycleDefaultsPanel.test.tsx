import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadCycleDefaults, saveCycleDefaults } from '../../lib/cycle-defaults-api.js';
import { CycleDefaultsPanel } from './CycleDefaultsPanel.js';

vi.mock('../../lib/cycle-defaults-api.js', () => ({
  loadCycleDefaults: vi.fn(),
  saveCycleDefaults: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

/** R-C17 part 4, decisions 8 and 9: the workspace's default step time limit, on Settings. */
const workspaceId = asWorkspaceId('ws');

it('shows the default and saves a changed one', async () => {
  vi.mocked(loadCycleDefaults).mockResolvedValue({ maxRunMinutes: 120, stored: false });
  vi.mocked(saveCycleDefaults).mockResolvedValue({ maxRunMinutes: 45, stored: true });
  render(<CycleDefaultsPanel workspaceId={workspaceId} csrfToken="csrf" canEdit />);
  const field = (await screen.findByLabelText('Minutes per step for new work')) as HTMLInputElement;
  expect(field.value).toBe('120');
  const save = screen.getByRole('button', { name: 'Save step time limit' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  fireEvent.change(field, { target: { value: '2000' } });
  expect(save.disabled).toBe(true);
  fireEvent.change(field, { target: { value: '45' } });
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  expect(await screen.findByText('Step time limit saved.')).toBeTruthy();
  expect(saveCycleDefaults).toHaveBeenCalledWith(workspaceId, { maxRunMinutes: 45 }, 'csrf');
  await waitFor(() => expect(save.disabled).toBe(true));
});

it('lets a viewer read it but not change it', async () => {
  vi.mocked(loadCycleDefaults).mockResolvedValue({ maxRunMinutes: 60, stored: true });
  render(<CycleDefaultsPanel workspaceId={workspaceId} csrfToken="csrf" canEdit={false} />);
  const field = (await screen.findByLabelText('Minutes per step for new work')) as HTMLInputElement;
  expect(field.value).toBe('60');
  expect(field.disabled).toBe(true);
});

// Increment 5 review L-4, N-1, N-2: errors shown, an invalid value explained, a stale notice
// cleared.
it('shows a read failure, a save failure, why a value is refused, and clears the notice on edit', async () => {
  vi.mocked(loadCycleDefaults).mockRejectedValueOnce(new Error('offline'));
  const failed = render(<CycleDefaultsPanel workspaceId={workspaceId} csrfToken="csrf" canEdit />);
  expect((await screen.findByRole('alert')).textContent).toContain('could not be read');
  failed.unmount();
  vi.mocked(loadCycleDefaults).mockResolvedValue({ maxRunMinutes: 120, stored: false });
  vi.mocked(saveCycleDefaults)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ maxRunMinutes: 45, stored: true });
  render(<CycleDefaultsPanel workspaceId={workspaceId} csrfToken="csrf" canEdit />);
  const field = (await screen.findByLabelText('Minutes per step for new work')) as HTMLInputElement;
  fireEvent.change(field, { target: { value: '0' } });
  expect(screen.getByText('Between 1 and 1440 minutes.')).toBeTruthy();
  fireEvent.change(field, { target: { value: '45' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save step time limit' }));
  expect((await screen.findByRole('alert')).textContent).toContain('could not be saved');
  fireEvent.click(screen.getByRole('button', { name: 'Save step time limit' }));
  expect(await screen.findByText('Step time limit saved.')).toBeTruthy();
  fireEvent.change(field, { target: { value: '50' } });
  expect(screen.queryByText('Step time limit saved.')).toBeNull();
});
