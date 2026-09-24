import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { OperatorWaitSection } from './OperatorWaitSection.js';
vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('shows the week of operator wait and the costliest stops, reloading only on a new key', async () => {
  vi.mocked(request).mockResolvedValue({
    from: '2026-09-16T12:00:00.000Z',
    to: '2026-09-23T12:00:00.000Z',
    waitingHours: 158.7,
    idleWaitingHours: 132.2,
    agentHours: 31.3,
    kinds: [
      { kind: 'design-decision-required', stops: 9, cycleHours: 131 },
      { kind: 'paused', stops: 10, cycleHours: 75.4 },
    ],
  });
  const { rerender } = render(<OperatorWaitSection workspaceId="ws" refreshKey="a:running" />);
  expect(
    await screen.findByText(
      /^Last 7 days: 132\.2 h with work waiting on you and no agent running \(as of .+\)\.$/,
    ),
  ).toBeTruthy();
  const rows = within(
    screen.getByRole('list', { name: 'Stops that cost the most waiting' }),
  ).getAllByRole('listitem');
  expect(rows.map((row) => row.textContent)).toEqual([
    'StopDesign decision requiredStops9Cycle-hours131.0',
    'StopPausedStops10Cycle-hours75.4',
  ]);
  expect(vi.mocked(request).mock.calls[0]?.[0]).toBe('/api/workspaces/ws/operator-wait?days=7');
  rerender(<OperatorWaitSection workspaceId="ws" refreshKey="a:running" />);
  rerender(<OperatorWaitSection workspaceId="ws" refreshKey="a:needs-attention" />);
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
});

it('reloads a stale report when the tab becomes visible again', async () => {
  const report = {
    from: '2026-09-16T12:00:00.000Z',
    to: new Date(Date.now() - 10 * 60_000).toISOString(),
    waitingHours: 1,
    idleWaitingHours: 1,
    agentHours: 0,
    kinds: [],
  };
  vi.mocked(request).mockResolvedValue(report);
  render(<OperatorWaitSection workspaceId="ws" refreshKey="a:running" />);
  await screen.findByText('Nothing waited on you in the last 7 days.');
  vi.mocked(request).mockResolvedValue({ ...report, to: new Date().toISOString() });
  document.dispatchEvent(new Event('visibilitychange'));
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  // A fresh report is not reloaded again.
  document.dispatchEvent(new Event('visibilitychange'));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(request).toHaveBeenCalledTimes(2);
});
