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
    // The revision the form showed, which a running roadmap is held to (R-B6, decision 10).
    expectedRevision: 2,
    maxInFlight: 3,
    maxPerRepository: 2,
  });
  expect(vi.mocked(request).mock.calls.every((c) => !c[0].endsWith('/host-scheduling'))).toBe(true);
  // Roadmap limits are not a plan-acceptance input (R-C6 D1): no new plan review is asked.
  expect(
    within(screen.getByRole('region', { name: 'Roadmap in-flight limits' })).getByText(
      'Roadmap limits saved. They apply to the next admission; items in flight keep running.',
    ),
  ).toBeTruthy();
});

// R-C6 review L2: a host capacity save carries an older plan acceptance only for the saving
// workspace's roadmaps, so the list says what holds for each roadmap.
it('says which roadmaps a capacity change leaves without a plan review', async () => {
  const roadmap = (id: string, workspaceId: string, crossProject: boolean) => ({
    id,
    workspaceId,
    name: id,
    status: 'paused',
    crossProject,
  });
  vi.mocked(request).mockImplementation(async (url) =>
    url.endsWith('/capacities')
      ? { roadmaps: [] }
      : {
          ...status,
          roadmaps: [
            roadmap('Here', 'workspace', true),
            roadmap('Elsewhere', 'other-workspace', true),
            roadmap('Queue', 'workspace', false),
          ],
        },
  );
  render(<HostSchedulingPanel workspaceId="workspace" csrfToken="csrf" />);
  const item = async (name: string) =>
    (await screen.findByRole('link', { name })).closest('li')!.textContent;
  expect(await item('Here')).toBe(
    'Here · paused · No plan review required after a capacity change',
  );
  expect(await item('Elsewhere')).toBe(
    'Elsewhere · paused · A plan accepted there before this release may need review after a capacity change',
  );
  expect(await item('Queue')).toBe('Queue · paused · No cross-project plan review required');
});
it('saves workstation capacity while a roadmap runs (R-B6, decision 9)', async () => {
  const running = {
    ...status,
    roadmaps: [
      {
        id: 'roadmap',
        workspaceId: 'workspace',
        name: 'Running roadmap',
        status: 'running',
        crossProject: false,
      },
    ],
  };
  vi.mocked(request).mockImplementation(async (url, _schema, options) =>
    url.endsWith('/capacities')
      ? { roadmaps: [] }
      : options
        ? { ...running, version: 2, verificationCapacity: 2 }
        : running,
  );
  render(<HostSchedulingPanel workspaceId="workspace" csrfToken="csrf" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Change workstation capacity' }));
  fireEvent.change(screen.getByLabelText('Concurrent verification/parent acceptance reviews'), {
    target: { value: '2' },
  });
  expect(screen.queryByText(/Pause these roadmaps first/)).toBeNull();
  expect(
    screen.getByText(
      'Running work keeps its slots; the new capacity applies to the next reservation.',
    ),
  ).toBeTruthy();
  const save = screen.getByRole('button', {
    name: 'Save workstation capacity',
  }) as HTMLButtonElement;
  expect(save.disabled).toBe(false);
  fireEvent.click(save);
  await screen.findByText(/Workstation capacity saved/);
});
it('dates a running roadmap’s limits edit by its revision, not its version (R-B6, decision 10)', async () => {
  const roadmap = (version: number, revision: number) => ({
    id: 'map',
    version,
    name: 'Stack',
    status: 'running',
    revision,
    crossProject: true,
    scheduling: {
      mode: 'parallel',
      maxInFlight: 4,
      maxPerRepository: 2,
      maxIntegrationRefreshes: 3,
    },
    editBlocker: null,
    inFlight: [],
  });
  let current = roadmap(3, 2);
  vi.mocked(request).mockImplementation(async (url) =>
    url.endsWith('/capacities') ? { roadmaps: [current] } : status,
  );
  render(<HostSchedulingPanel workspaceId="workspace" csrfToken="csrf" canManageHost={false} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Change roadmap limits' }));
  fireEvent.change(screen.getByLabelText('Maximum in-flight items'), { target: { value: '3' } });
  // The scheduler moved the version on: the edit still stands.
  current = roadmap(7, 2);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh roadmap limits' }));
  await screen.findByText('Roadmap limits and in-flight work refreshed.');
  expect(screen.queryByText(/The roadmap changed during this edit/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Save roadmap limits' }).hasAttribute('disabled')).toBe(
    false,
  );
  // A new revision dates it.
  current = roadmap(8, 3);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh roadmap limits' }));
  await screen.findByText(/The roadmap changed during this edit/);
  expect(screen.getByRole('button', { name: 'Save roadmap limits' }).hasAttribute('disabled')).toBe(
    true,
  );
});
