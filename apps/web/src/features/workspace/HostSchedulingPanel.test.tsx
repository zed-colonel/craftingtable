import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
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
  developmentVersion: 1,
  verificationCapacity: 1,
  developmentCapacity: 4,
  source: 'daemon-environment',
  developmentSource: 'daemon-environment',
  updatedAt: null,
  reservations: [],
  waiting: [],
  roadmaps: [],
};
it('saves both workstation pools and keeps the original edit through an occupancy refresh', async () => {
  vi.mocked(request).mockImplementation(async (url, _schema, options) =>
    url.endsWith('/capacities')
      ? { roadmaps: [] }
      : options
        ? { ...status, version: 2, verificationCapacity: 2 }
        : status,
  );
  render(<HostSchedulingPanel workspaceId="workspace" csrfToken="csrf" />);
  await screen.findByText('0/4');
  fireEvent.click(await screen.findByRole('button', { name: 'Change workstation capacity' }));
  const input = screen.getByLabelText(
    'Concurrent verification/parent acceptance reviews',
  ) as HTMLInputElement;
  fireEvent.change(input, { target: { value: '2' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh reservations' }));
  await screen.findByText('Reservations and settings refreshed.');
  expect(input.value).toBe('2');
  fireEvent.click(screen.getByRole('button', { name: 'Save workstation capacity' }));
  await screen.findByText(/Workstation capacity saved/);
  const call = vi.mocked(request).mock.calls.find((c) => c[2]?.method === 'POST')!;
  expect(JSON.parse(String(call[2]!.body))).toEqual({
    expectedVersion: 1,
    expectedDevelopmentVersion: 1,
    verificationCapacity: 2,
    developmentCapacity: 4,
  });
});
it('links reservations and blocks stale edits after a refresh instead of overwriting other saves', async () => {
  let current = {
    ...status,
    reservations: [
      {
        id: 'claim',
        workspaceId: 'workspace',
        workItemId: 'item',
        runId: 'run',
        label: 'EXO-02',
        phase: 'accept',
        resourceKey: 'local-verification',
        acquiredAt: '2026-09-22T01:00:00Z',
      },
    ],
  };
  vi.mocked(request).mockImplementation(async (url) =>
    url.endsWith('/capacities') ? { roadmaps: [] } : current,
  );
  render(<HostSchedulingPanel workspaceId="workspace" csrfToken="csrf" />);
  await screen.findByText('EXO-02');
  expect(screen.getByRole('link', { name: 'Open run' }).getAttribute('href')).toBe(
    '/workspaces/workspace/runs/run',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Change workstation capacity' }));
  fireEvent.change(screen.getByLabelText('Concurrent development/work-item review runs'), {
    target: { value: '6' },
  });
  current = { ...current, developmentVersion: 2, developmentCapacity: 5 };
  fireEvent.click(screen.getByRole('button', { name: 'Refresh reservations' }));
  await screen.findByText(/Saved limits changed during this edit/);
  expect(
    (screen.getByLabelText('Concurrent development/work-item review runs') as HTMLInputElement)
      .value,
  ).toBe('6');
  expect(
    screen.getByRole('button', { name: 'Save workstation capacity' }).hasAttribute('disabled'),
  ).toBe(true);
});
it('keeps roadmap controls usable for editors without requesting installation authority', async () => {
  const roadmap = {
    id: 'map',
    version: 3,
    name: 'Stack',
    status: 'paused',
    revision: 2,
    crossProject: true,
    scheduling: {
      mode: 'parallel',
      maxInFlight: 4,
      maxPerRepository: 2,
      maxIntegrationRefreshes: 3,
    },
    editBlocker: null,
    inFlight: [],
  };
  vi.mocked(request).mockResolvedValue({ roadmaps: [roadmap] });
  render(<HostSchedulingPanel workspaceId="workspace" csrfToken="csrf" canManageHost={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Change roadmap limits' }));
  fireEvent.change(screen.getByLabelText('Maximum in-flight items'), { target: { value: '3' } });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh roadmap limits' }));
  await screen.findByText('Roadmap limits and in-flight work refreshed.');
  expect((screen.getByLabelText('Maximum in-flight items') as HTMLInputElement).value).toBe('3');
  fireEvent.click(screen.getByRole('button', { name: 'Save roadmap limits' }));
  await screen.findByText(/Roadmap limits saved/);
  const call = vi.mocked(request).mock.calls.find((c) => c[2]?.method === 'POST')!;
  expect(JSON.parse(String(call[2]!.body))).toEqual({
    expectedVersion: 3,
    maxInFlight: 3,
    maxPerRepository: 2,
  });
  expect(vi.mocked(request).mock.calls.every((c) => !c[0].endsWith('/host-scheduling'))).toBe(true);
  expect(
    within(screen.getByRole('region', { name: 'Roadmap in-flight limits' })).getByText(
      /fresh saved-plan evidence/,
    ),
  ).toBeTruthy();
});
