import { asWorkspaceId, DEFAULT_NOTIFICATION_PREFERENCES } from '@craftingtable/domain';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadNotifications } from '../../lib/notification-api.js';
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
