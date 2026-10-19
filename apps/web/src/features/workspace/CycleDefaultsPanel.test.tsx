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
