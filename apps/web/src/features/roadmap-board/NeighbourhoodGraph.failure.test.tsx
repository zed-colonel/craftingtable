import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MODEL, ROADMAP_ID } from './board-testing.js';
import { NeighbourhoodGraph } from './NeighbourhoodGraph.js';

/** R-E3b review H1: a graph that cannot be laid out says so; it never takes the page down. */
vi.mock('./layered-layout.js', () => ({
  layeredLayout: () => {
    throw new Error('cannot lay out');
  },
}));
afterEach(cleanup);

it('shows a message, and the selection panel, when the layout fails', () => {
  render(
    <NeighbourhoodGraph
      model={MODEL}
      selected="checkpoint:ADR-1:passed"
      onSelect={vi.fn()}
      links={{ workspaceId: asWorkspaceId('w'), roadmapId: ROADMAP_ID, onOpenWorkItem: vi.fn() }}
    />,
  );
  expect(screen.getByRole('alert').textContent).toContain('could not be drawn');
  expect(screen.getByRole('complementary', { name: 'Selection' }).textContent).toContain('ADR-1');
});
