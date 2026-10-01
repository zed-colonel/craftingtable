import { asWorkspaceId, DEFAULT_NOTIFICATION_PREFERENCES } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadNotifications, saveNotifications } from '../../lib/notification-api.js';
import { testQueryStore } from '../../lib/query-store-testing.js';
import { NotificationPanel } from './NotificationPanel.js';

vi.mock('../../lib/notification-api.js', () => ({
  loadNotifications: vi.fn(),
  saveNotifications: vi.fn(),
  testNotifications: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const status = {
  preferences: DEFAULT_NOTIFICATION_PREFERENCES,
  version: 1,
  credentialsConfigured: false,
  blockedReason: null,
  retryAt: null,
  records: [],
};

it('re-reads delivery status on notification and attention events, and no others (R-D4)', async () => {
  vi.mocked(loadNotifications).mockResolvedValue(status as never);
  const { wrap, send } = testQueryStore();
  render(wrap(<NotificationPanel workspaceId={asWorkspaceId('ws')} csrfToken="csrf" />));
  expect(await screen.findByText('No notifications yet.')).toBeTruthy();
  expect(loadNotifications).toHaveBeenCalledTimes(1);
  await send('repository-registered', { workspaceId: 'ws', repositoryId: 'repo' });
  await send('roadmap-changed', { workspaceId: 'ws', payload: { roadmapId: 'r' } });
  expect(loadNotifications).toHaveBeenCalledTimes(1);
  await send('notifications-changed', { workspaceId: 'ws', payload: { action: 'delivery' } });
  await waitFor(() => expect(loadNotifications).toHaveBeenCalledTimes(2));
  await send('attention-changed', { workspaceId: 'ws', payload: { open: 1 } });
  await waitFor(() => expect(loadNotifications).toHaveBeenCalledTimes(3));
});

it('keeps an unsaved draft when the status is read again in the background (R-D4 review M20)', async () => {
  vi.mocked(loadNotifications).mockResolvedValue(status as never);
  const { wrap, send } = testQueryStore();
  render(wrap(<NotificationPanel workspaceId={asWorkspaceId('ws')} csrfToken="csrf" />));
  const time = (await screen.findByLabelText('Daily reminder time')) as HTMLInputElement;
  fireEvent.change(time, { target: { value: '07:30' } });
  vi.mocked(loadNotifications).mockResolvedValue({
    ...status,
    version: 2,
    preferences: { ...status.preferences, dailyTime: '22:00' },
  } as never);
  await send('notifications-changed', { workspaceId: 'ws', payload: { action: 'delivery' } });
  await waitFor(() => expect(loadNotifications).toHaveBeenCalledTimes(2));
  expect(time.value).toBe('07:30');
});

it('reloads after a conflict from the status read now, not the cached one (R-D4 review F3, M32)', async () => {
  vi.mocked(loadNotifications).mockResolvedValue(status as never);
  vi.mocked(saveNotifications).mockRejectedValueOnce(
    new Error('Notification settings changed. Reload settings before saving.'),
  );
  const { wrap } = testQueryStore();
  render(wrap(<NotificationPanel workspaceId={asWorkspaceId('ws')} csrfToken="csrf" />));
  fireEvent.click(await screen.findByRole('button', { name: 'Save notifications' }));
  // Changed elsewhere meanwhile: the reload reads version 2.
  vi.mocked(loadNotifications).mockResolvedValue({ ...status, version: 2 } as never);
  fireEvent.click(await screen.findByRole('button', { name: 'Reload settings' }));
  await waitFor(() => expect(loadNotifications).toHaveBeenCalledTimes(2));
  vi.mocked(saveNotifications).mockResolvedValue({ ...status, version: 3 } as never);
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Reload settings' })).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Save notifications' }));
  await waitFor(() => expect(saveNotifications).toHaveBeenCalledTimes(2));
  expect(vi.mocked(saveNotifications).mock.calls[1]![1]).toMatchObject({ expectedVersion: 2 });
});
