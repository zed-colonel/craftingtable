import type { WorkCycle } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { IntegrationConflict } from './IntegrationConflict.js';
import { stopRecord, type CycleAttention } from '@craftingtable/domain';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(cleanup);

const panel = ({
  attention,
  ...cycle
}: Partial<WorkCycle> & { readonly attention?: CycleAttention }) =>
  render(
    <IntegrationConflict
      cycle={
        {
          status: 'needs-attention',
          reason: '',
          profiles: {},
          ...cycle,
          ...(attention ? { stop: stopRecord(attention, '2026-09-20T12:00:00.000Z') } : {}),
        } as WorkCycle
      }
      backends={[]}
      disabled={false}
      canMutate
      csrfToken="csrf"
      onChanged={vi.fn()}
      onOpenRun={vi.fn()}
      runIds={[]}
    />,
  );

it('shows only the inspect action for an idle cycle with nothing to resolve (R-E6, UI-10)', () => {
  panel({ attention: { code: 'design-open-questions', owner: 'operator' } });
  expect(screen.queryByRole('region', { name: 'Integration conflicts' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Inspect integration conflicts' })).toBeDefined();
  cleanup();
  panel({ status: 'running' });
  expect(screen.queryByRole('button', { name: 'Inspect integration conflicts' })).toBeNull();
});

it('keeps inspection reachable on a paused cycle after a manual update conflicted', () => {
  // A conflicting manual update records no stop; the paused cycle still offers inspection.
  panel({ status: 'paused', reason: 'Automation paused by operator.' });
  expect(screen.getByRole('button', { name: 'Inspect integration conflicts' })).toBeDefined();
});

it('shows the panel for an integration stop written before codes existed, as migration 0047 coded it', () => {
  // The browser reads stored codes only (R-B4b): the decoder's code is what the record holds now.
  panel({
    reason: 'Integration refresh limit reached.',
    attention: { code: 'integration-refresh-limit', owner: 'operator' },
  });
  expect(screen.getByRole('region', { name: 'Integration conflicts' })).toBeDefined();
});

it('offers inspection when an integration update stopped the cycle', () => {
  panel({ attention: { code: 'integration-update-failed', owner: 'operator' } });
  expect(screen.getByRole('button', { name: 'Inspect integration conflicts' })).toBeDefined();
});

it('asks for a fresh review only until one has run on the resolution commit (LIVE-25)', () => {
  const resolution = {
    id: 'r',
    status: 'completed',
    headSha: 'a'.repeat(40),
    targetSha: 'b'.repeat(40),
    targetBranch: 'exo-v3',
    paths: ['docs/policy.json'],
    diagnostics: '',
    createdAt: '2026-09-28T20:10:32.553Z',
    attempts: 1,
    commitSha: 'c'.repeat(40),
  } as NonNullable<WorkCycle['integrationResolution']>;
  panel({ status: 'needs-attention', step: 'review', integrationResolution: resolution });
  expect(screen.getByText(/Fresh review required/)).toBeDefined();
  cleanup();
  // A review that has only started has not reviewed them.
  panel({ status: 'running', step: 'review', integrationResolution: resolution });
  expect(screen.queryByText(/reviewed afresh/)).toBeNull();
  expect(screen.getByText(/fresh review of the combined changes is running/)).toBeDefined();
  cleanup();
  // Passed, even on a later head than the resolution's.
  panel({
    status: 'awaiting-merge',
    integrationResolution: resolution,
    reviewHeadSha: 'd'.repeat(40),
  });
  expect(screen.queryByText(/Fresh review required/)).toBeNull();
  expect(screen.getByText(/reviewed afresh/)).toBeDefined();
});

it('posts its own command, naming the version it saw, and reloads the cycle (R-A6)', async () => {
  vi.mocked(request).mockResolvedValue({});
  const onChanged = vi.fn();
  render(
    <IntegrationConflict
      cycle={
        {
          id: 'c1',
          workspaceId: 'ws',
          version: 7,
          status: 'paused',
          reason: '',
          profiles: {},
        } as unknown as WorkCycle
      }
      backends={[]}
      disabled={false}
      canMutate
      csrfToken="csrf"
      onChanged={onChanged}
      onOpenRun={vi.fn()}
      runIds={[]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Inspect integration conflicts' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  const [url, , init] = vi.mocked(request).mock.calls[0]!;
  expect(url).toBe('/api/workspaces/ws/cycles/c1/integration-resolution');
  expect(JSON.parse(String(init!.body))).toEqual({ action: 'inspect', expectedVersion: 7 });
});

/** R-E5b: the resolution form's agent, from the daemon or as the resolution recorded it. */
const resolving = (status: 'detected' | 'resolving', profile?: object) =>
  ({
    id: 'c1',
    workspaceId: 'ws',
    version: 3,
    status: 'needs-attention',
    reason: '',
    profiles: { remediate: { backend: 'claude-code', permissionMode: 'edit-only' } },
    integrationResolution: {
      id: 'r1',
      status,
      attempts: 1,
      paths: ['README.md'],
      ...(profile ? { profile } : {}),
    },
  }) as unknown as WorkCycle;
const backends = [
  {
    kind: 'claude-code' as const,
    label: 'Claude Code',
    available: true,
    models: [
      { id: 'daemon-model', label: 'Daemon', section: 'main', hidden: false },
      { id: 'recorded-model', label: 'Recorded', section: 'main', hidden: false },
    ],
    catalog: { source: 'catalog' as const },
  },
];
const agent = {
  selection: { backend: 'claude-code' as const, model: 'daemon-model' },
  source: { layer: 'cycle-start' as const, slot: 'remediate' as const },
  permissionMode: 'edit-only' as const,
};
const openForm = (cycle: WorkCycle) => {
  render(
    <IntegrationConflict
      cycle={cycle}
      agent={agent}
      backends={backends}
      disabled={false}
      canMutate
      csrfToken="csrf"
      onChanged={vi.fn()}
      onOpenRun={vi.fn()}
      runIds={[]}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', {
      name: /^(Resolve integration conflicts|Resume resolution with agent)$/,
    }),
  );
  return screen.getByRole('form', { name: 'Resolve with agent' });
};

it('starts a new resolution from the daemon’s conflict agent, named with its source', () => {
  const form = openForm(resolving('detected'));
  expect(form).toBeTruthy();
  expect(screen.getByText(/Starts from/).textContent).toContain('Chosen when the cycle started');
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('daemon-model');
});

it('resumes an owned resolution from the agent it recorded, as the daemon ranks it (review LOW-3)', () => {
  openForm(resolving('resolving', { backend: 'claude-code', model: 'recorded-model' }));
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('recorded-model');
  expect(screen.getByText(/Starts from the agent this resolution recorded/)).toBeTruthy();
});

it('starts a resolution it does not own from the daemon’s agent even when one was recorded (review N19)', () => {
  openForm(resolving('detected', { backend: 'claude-code', model: 'recorded-model' }));
  expect((screen.getByLabelText('Model') as HTMLSelectElement).value).toBe('daemon-model');
  expect(screen.queryByText(/Starts from the agent this resolution recorded/)).toBeNull();
});
