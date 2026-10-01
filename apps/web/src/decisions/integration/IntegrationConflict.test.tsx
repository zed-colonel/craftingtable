import type { WorkCycle } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { IntegrationConflict } from './IntegrationConflict.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(cleanup);

const panel = (cycle: Partial<WorkCycle>) =>
  render(
    <IntegrationConflict
      cycle={{ status: 'needs-attention', reason: '', profiles: {}, ...cycle } as WorkCycle}
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

it('shows the panel for an integration stop written before codes existed', () => {
  panel({ reason: 'Integration refresh limit reached.' });
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
