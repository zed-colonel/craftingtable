import type { AgentRunDetailResponse, RunEventEnvelope } from '@craftingtable/contracts';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { eventTitle } from './run-event-text.js';
import { RunPage } from './RunPage.js';

// Each event row renders its title once, so the title's calls count the rows rendered.
vi.mock('./run-event-text.js', async (original) => {
  const actual = await original<typeof import('./run-event-text.js')>();
  return { ...actual, eventTitle: vi.fn(actual.eventTitle) };
});
afterEach(cleanup);

const detail = {
  run: {
    id: 'run-1',
    workspaceId: 'ws-1',
    worktreeId: 'wt-1',
    repositoryId: 'repo-1',
    projectId: 'project-1',
    workItemId: 'item-1',
    backend: 'claude-code',
    role: 'implement',
    status: 'running',
    permissionMode: 'auto',
    createdAt: '2026-10-02T00:00:00.000Z',
    createdByUserId: 'user-1',
    turnCount: 1,
    version: 1,
  },
  worktree: {
    id: 'wt-1',
    workspaceId: 'ws-1',
    repositoryId: 'repo-1',
    projectId: 'project-1',
    workItemId: 'item-1',
    branchName: 'ct/aq-01',
    baseSha: '0'.repeat(40),
    baseBranch: 'main',
    path: '/data/worktrees/aq-01',
    status: 'active',
    createdAt: '2026-10-02T00:00:00.000Z',
    createdByUserId: 'user-1',
    version: 1,
  },
  brief: '# Work item AQ-01',
  eventCount: 0,
} as unknown as AgentRunDetailResponse;
const message = (sequence: number): RunEventEnvelope =>
  ({
    sequence,
    id: `event-${sequence}`,
    workspaceId: 'ws-1',
    runId: 'run-1',
    occurredAt: '2026-10-02T00:00:00.000Z',
    kind: 'assistant-message',
    payload: { text: `Message ${sequence}` },
  }) as RunEventEnvelope;
const page = (events: readonly RunEventEnvelope[], busy = false) => (
  <RunPage
    detail={detail}
    events={events}
    connection="open"
    canMutate
    busy={busy}
    onSend={vi.fn()}
    onEnd={vi.fn()}
    onCancel={vi.fn()}
    onOpenWorkItem={vi.fn()}
    onLoadDiff={vi.fn()}
    onCloseDiff={vi.fn()}
  />
);

// R-D4 increment 4c (PERF-10): a long run's feed renders each event once, not once per update.
it('renders only the new event when one arrives, and none when the page re-renders otherwise', () => {
  const events = Array.from({ length: 200 }, (_, index) => message(index + 1));
  const { rerender } = render(page(events));
  expect(vi.mocked(eventTitle)).toHaveBeenCalledTimes(200);
  vi.mocked(eventTitle).mockClear();
  const more = [...events, message(201)];
  rerender(page(more));
  expect(vi.mocked(eventTitle)).toHaveBeenCalledTimes(1);
  vi.mocked(eventTitle).mockClear();
  rerender(page(more, true));
  expect(vi.mocked(eventTitle)).toHaveBeenCalledTimes(0);
});
