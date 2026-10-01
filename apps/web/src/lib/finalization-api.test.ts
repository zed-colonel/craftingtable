import { FINALIZATION_DECISIONS, asWorkspaceId } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from './api-client.js';
import { controlFinalization, type FinalizationControl } from './finalization-api.js';

vi.mock('./api-client.js', () => ({ request: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("posts a finalization's manual controls, and never one of its decisions (R-A6 2b review)", async () => {
  vi.mocked(request).mockResolvedValue({});
  await controlFinalization(
    asWorkspaceId('ws'),
    'fin-1',
    { action: 'retry-cleanup', expectedVersion: 2 },
    'csrf',
  );
  expect(request).toHaveBeenCalledTimes(1);
  for (const action of FINALIZATION_DECISIONS)
    await expect(
      controlFinalization(
        asWorkspaceId('ws'),
        'fin-1',
        { action, expectedVersion: 2 } as unknown as FinalizationControl,
        'csrf',
      ),
    ).rejects.toThrow('is a finalization decision');
  expect(request).toHaveBeenCalledTimes(1);
});
