import { asWorkspaceId } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from './api-client.js';
import { cycleDefaultMinutes, saveCycleDefaults } from './cycle-defaults-api.js';

vi.mock('./api-client.js', () => ({ request: vi.fn() }));
afterEach(() => vi.resetAllMocks());

/** R-C17 part 4, decisions 8 and 9 (increment 5 review L-4): the client of the default. */
const workspaceId = asWorkspaceId('w s');

it('reads the workspace’s default, and falls back to 120 when it cannot', async () => {
  vi.mocked(request).mockResolvedValueOnce({ maxRunMinutes: 45, stored: true });
  expect(await cycleDefaultMinutes(workspaceId)).toBe(45);
  expect(vi.mocked(request).mock.calls[0]?.[0]).toBe('/api/workspaces/w%20s/cycle-defaults');
  vi.mocked(request).mockRejectedValueOnce(new Error('offline'));
  expect(await cycleDefaultMinutes(workspaceId)).toBe(120);
});

it('saves to the same address with the CSRF token', async () => {
  vi.mocked(request).mockResolvedValueOnce({ maxRunMinutes: 60, stored: true });
  await saveCycleDefaults(workspaceId, { maxRunMinutes: 60 }, 'csrf');
  const [url, , init] = vi.mocked(request).mock.calls[0]!;
  expect(url).toBe('/api/workspaces/w%20s/cycle-defaults');
  expect(init).toMatchObject({
    method: 'POST',
    headers: { 'x-craftingtable-csrf': 'csrf' },
    body: JSON.stringify({ maxRunMinutes: 60 }),
  });
});
