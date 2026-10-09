import type { PlanVersionGraph } from '@craftingtable/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PlanGraph } from './PlanGraph.js';

/** R-E4 (review L3): a plan graph that cannot be laid out says so; it never takes the page down. */
vi.mock('../roadmap-board/layered-layout.js', async (original) => ({
  ...(await original<typeof import('../roadmap-board/layered-layout.js')>()),
  layeredLayout: () => {
    throw new Error('cannot lay out');
  },
}));
afterEach(cleanup);

it('shows a message instead of the graph when the layout fails', () => {
  render(
    <PlanGraph
      graph={
        {
          planVersionId: 'version-1',
          nodes: [{ workItemId: 'item-1', sourceId: 'AQ-01', title: 'Alpha' }],
          edges: [],
        } as unknown as PlanVersionGraph
      }
      items={[]}
      onOpen={vi.fn()}
    />,
  );
  expect(screen.getByRole('alert').textContent).toContain('could not be laid out');
  expect(screen.queryByRole('button')).toBeNull();
});
