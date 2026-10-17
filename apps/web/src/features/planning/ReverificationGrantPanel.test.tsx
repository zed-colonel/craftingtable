import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Roadmap } from '@craftingtable/domain';
import { ReverificationGrantPanel } from './ReverificationGrantPanel.js';
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
  definition: { entries: [] },
  attempts: [],
} as unknown as Roadmap;
function setup(value = roadmap, canMutate = true) {
  const onChange = vi.fn();
  render(
    <ReverificationGrantPanel
      roadmap={value}
      csrfToken="csrf"
      canMutate={canMutate}
      onChange={onChange}
    />,
  );
  return { onChange };
}
it('is off until the operator grants it, and saves only the switch', async () => {
  vi.mocked(request).mockResolvedValue({ roadmap, progress: [] });
  const { onChange } = setup();
  expect(screen.getByText(/Manual · stale evidence waits for your Re-verify/)).toBeTruthy();
  expect(screen.queryByRole('checkbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Configure automatic re-verification' }));
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save re-verification grant' }));
  await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
  expect(vi.mocked(request).mock.calls[0]![0]).toBe(
    '/api/workspaces/workspace/roadmaps/roadmap/reverification',
  );
  expect(JSON.parse(vi.mocked(request).mock.calls[0]![2]!.body as string)).toEqual({
    expectedVersion: 9,
    enabled: true,
  });
});
it('revokes a standing grant', async () => {
  const granted = {
    ...roadmap,
    reverificationGrant: { enabled: true, grantedByUserId: 'user', grantedAt: 'now' },
  } as unknown as Roadmap;
  vi.mocked(request).mockResolvedValue({ roadmap: granted, progress: [] });
  setup(granted);
  expect(screen.getByText(/Automatic · stale evidence is reviewed again in place/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Configure automatic re-verification' }));
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Save re-verification grant' }));
  await waitFor(() => expect(request).toHaveBeenCalledOnce());
  expect(JSON.parse(vi.mocked(request).mock.calls[0]![2]!.body as string)).toEqual({
    expectedVersion: 9,
    enabled: false,
  });
});
it('is changed only while the roadmap does not run, and keeps input after an error', async () => {
  setup({ ...roadmap, status: 'running' } as Roadmap);
  expect(
    (
      screen.getByRole('button', {
        name: 'Configure automatic re-verification',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(screen.getByText('Pause roadmap scheduling to change this grant.')).toBeTruthy();
  cleanup();
  vi.mocked(request).mockRejectedValue(new Error('Roadmap changed; refresh before saving.'));
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Configure automatic re-verification' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save re-verification grant' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Roadmap changed');
  expect(screen.getByRole('checkbox')).toBeTruthy();
});
it('offers no control to a reader', () => {
  setup(roadmap, false);
  expect(screen.queryByRole('button')).toBeNull();
});
