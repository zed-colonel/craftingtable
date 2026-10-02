import type { RunOverview } from '@craftingtable/contracts';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RunList } from './RunsPage.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T00:01:00.000Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const live = {
  id: 'run-1',
  role: 'implement',
  status: 'running',
  createdAt: '2026-10-02T00:00:00.000Z',
  workItemId: 'item-1',
  workItemSourceId: 'WI-01',
  workItemTitle: 'Queue',
  projectName: 'ActionQueue',
  branchName: 'ct/wi-01',
  backend: 'codex',
  turnCount: 1,
} as unknown as RunOverview;

// R-D4 increment 4b: the running time moves with the list's own clock, not an app-wide render.
it("ticks a live run's running time on its own", () => {
  render(<RunList runs={[live]} onOpenRun={() => undefined} onOpenWorkItem={() => undefined} />);
  expect(screen.getByText('1m 0s')).toBeTruthy();
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
  expect(screen.getByText('1m 10s')).toBeTruthy();
});
