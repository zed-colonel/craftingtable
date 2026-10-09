import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { resetFallbackQueryStore } from '../../lib/query-store.js';
import { RoadmapPage } from './RoadmapBoardPage.js';

/**
 * R-E3b: a map roadmap's board tab shows the board at 900 px and wider and the grouped list
 * below; `?view=` overrides the width. Without a board (a sequential roadmap), the status list.
 */

vi.mock('./RoadmapStatusList.js', () => ({
  RoadmapStatusList: () => <section aria-label="Entry status" />,
}));
vi.mock('../../lib/roadmap-api.js', async () => {
  const board = await import('../roadmap-board/board-testing.js');
  const roadmap = {
    id: board.ROADMAP_ID,
    workspaceId: 'workspace',
    status: 'running',
    version: 3,
    reason: 'Scheduling.',
    attempts: [],
  };
  return {
    loadRoadmapPage: vi.fn(async () => ({
      view: { roadmap, progress: [] },
      definitionRevision: 2,
      status: board.STATUS,
      board: board.BOARD,
    })),
    loadRoadmapDefinition: vi.fn(async () => ({
      name: 'Cross-project roadmap',
      revision: 2,
      scheduling: { mode: 'parallel', maxInFlight: 2, maxPerRepository: 2 },
      crossProject: {
        definitionId: 'def-1',
        bindingRevision: 4,
        targetId: 'T',
        selection: 'target-only',
      },
      entries: [],
    })),
    loadRoadmapGraph: vi.fn(async () => board.GRAPH),
    loadRoadmapHistory: vi.fn(),
    controlRoadmap: vi.fn(),
  };
});

const common = {
  workspaceId: asWorkspaceId('workspace'),
  csrfToken: 'csrf',
  canMutate: true,
  onOpenWorkItem: vi.fn(),
  roadmapId: '00000000-0000-4000-8000-0000000000aa',
  tab: 'board' as const,
};
afterEach(() => {
  cleanup();
  resetFallbackQueryStore();
  vi.unstubAllGlobals();
});
const width = (wide: boolean) =>
  vi.stubGlobal('matchMedia', () => ({
    matches: wide,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));

it('shows the lanes on a wide screen and the grouped list on a narrow one', async () => {
  width(true);
  render(<RoadmapPage {...common} />);
  expect(await screen.findByRole('region', { name: 'Lane wi' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Needs you' })).toBeNull();
  cleanup();
  resetFallbackQueryStore();
  width(false);
  render(<RoadmapPage {...common} />);
  expect(await screen.findByRole('region', { name: 'Needs you' })).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Lane wi' })).toBeNull();
});

it('takes the view from the route over the width', async () => {
  width(true);
  render(<RoadmapPage {...common} view="list" />);
  expect(await screen.findByRole('region', { name: 'Needs you' })).toBeTruthy();
  const views = screen.getByRole('navigation', { name: 'Board views' });
  expect(views.querySelector('[aria-current="page"]')?.textContent).toBe('List');
  cleanup();
  resetFallbackQueryStore();
  width(false);
  render(<RoadmapPage {...common} view="board" select="checkpoint:ADR-1:passed" />);
  expect(await screen.findByRole('region', { name: 'Lane wi' })).toBeTruthy();
  expect(screen.getByRole('complementary', { name: 'Selection' }).textContent).toContain(
    'Transport contract',
  );
});
