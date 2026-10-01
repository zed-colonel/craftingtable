import type { RoadmapStatusListResponse } from '@craftingtable/contracts';
import { asWorkItemId, type Roadmap } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { request } from '../../lib/api-client.js';
import { testQueryStore } from '../../lib/query-store-testing.js';
import { RoadmapStatusList } from './RoadmapStatusList.js';

vi.mock('../../lib/api-client.js', () => ({ request: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const roadmap = { id: 'roadmap', workspaceId: 'workspace' } as unknown as Roadmap;
const entry = (
  id: string,
  sourceId: string,
  rest: Partial<RoadmapStatusListResponse['entries'][number]>,
): RoadmapStatusListResponse['entries'][number] => ({
  entryId: id,
  sourceId,
  scope: 'slice-verification',
  title: sourceId,
  workItemId: asWorkItemId(`item-${id}`),
  state: 'needs-attention',
  actor: 'controller',
  ...rest,
});

it('groups open entries by who acts next and links each reason to its record (R-E3a)', async () => {
  vi.mocked(request).mockResolvedValue({
    roadmapId: 'roadmap',
    name: 'Cross-project roadmap',
    status: 'running',
    reason: 'Parallel scheduling enabled.',
    completed: 20,
    entries: [
      entry('a', 'exo/EXO-18/instance-design', {
        scope: 'slice',
        actor: 'operator',
        waitsOn: {
          source: 'attention-item',
          code: 'shared-decision-required',
          reason: 'EXO-18 · Needs attention',
          since: '2026-09-27T03:57:16.863Z',
          attentionItemId: 'item-1',
        },
      }),
      entry('b', 'exo/EXO-02/domain', {
        state: 'running',
        actor: 'agent',
        waitsOn: { source: 'progress', reason: 'Roadmap recovery: repair.', runId: 'run-1' },
      }),
      entry('c', 'exo/EXO-04/domain', {
        state: 'running',
        waitsOn: {
          source: 'entry-wait',
          code: 'cycle-waiting',
          reason: 'Slice exo/EXO-02/domain must be verified.',
          since: '2026-09-27T03:57:16.863Z',
        },
      }),
    ],
  } satisfies RoadmapStatusListResponse);
  const onOpenAttention = vi.fn();
  const onOpenWorkItem = vi.fn();
  render(
    <RoadmapStatusList
      roadmap={roadmap}
      onOpenWorkItem={onOpenWorkItem}
      onOpenAttention={onOpenAttention}
    />,
  );
  const list = await screen.findByRole('region', { name: 'Entry status' });
  expect(vi.mocked(request).mock.calls[0]![0]).toBe(
    '/api/workspaces/workspace/roadmaps/roadmap/status',
  );
  expect(within(list).getByText(/3 open · 20 completed/)).toBeTruthy();
  const you = within(list).getByText('Needs you (1)').parentElement!;
  expect(within(you).getByText('EXO-18 · Needs attention')).toBeTruthy();
  fireEvent.click(within(you).getByRole('link', { name: 'Open in Needs you' }));
  expect(onOpenAttention).toHaveBeenCalledWith('item-1');
  const agents = within(list).getByText('Agents at work (1)').parentElement!;
  expect(within(agents).getByRole('link', { name: 'Open run' }).getAttribute('href')).toContain(
    '/runs/run-1',
  );
  const waiting = within(list).getByText('Waiting on automation or other work (1)').closest('div')!;
  expect(within(waiting).getByText('Slice exo/EXO-02/domain must be verified.')).toBeTruthy();
  fireEvent.click(within(waiting).getByRole('link', { name: /exo\/EXO-04\/domain/ }));
  expect(onOpenWorkItem).toHaveBeenCalledWith('item-c');
  // Read-only: the list offers no decision control of its own.
  expect(within(list).queryByRole('button')).toBeNull();
});

it('says when the roadmap itself is not running', async () => {
  vi.mocked(request).mockResolvedValue({
    roadmapId: 'roadmap',
    name: 'Cross-project roadmap',
    status: 'paused',
    reason: 'Paused by operator.',
    completed: 0,
    entries: [],
  } satisfies RoadmapStatusListResponse);
  render(<RoadmapStatusList roadmap={roadmap} onOpenWorkItem={vi.fn()} />);
  expect(
    await screen.findByText(/The roadmap is paused, so nothing starts until it runs/),
  ).toBeTruthy();
});

it("re-reads on its own roadmap's events and its cycles' and runs', never another roadmap's (R-D4)", async () => {
  vi.mocked(request).mockResolvedValue({
    roadmapId: 'roadmap',
    name: 'Cross-project roadmap',
    status: 'running',
    reason: 'Parallel scheduling enabled.',
    completed: 0,
    entries: [],
  });
  const { wrap, send } = testQueryStore();
  render(wrap(<RoadmapStatusList roadmap={roadmap} onOpenWorkItem={vi.fn()} />));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  await send('roadmap-changed', { workspaceId: 'workspace', payload: { roadmapId: 'another' } });
  await send('repository-registered', { workspaceId: 'workspace', repositoryId: 'repo' });
  expect(request).toHaveBeenCalledTimes(1);
  await send('roadmap-changed', { workspaceId: 'workspace', payload: { roadmapId: 'roadmap' } });
  expect(request).toHaveBeenCalledTimes(2);
  await send('agent-run-status-changed', { workspaceId: 'workspace', payload: { runId: 'r' } });
  expect(request).toHaveBeenCalledTimes(3);
});
