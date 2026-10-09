import type { PlanVersionGraph, WorkItemSummary } from '@craftingtable/contracts';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { PLAN_GRAPH_CAP, PlanGraph } from './PlanGraph.js';

/**
 * R-E4: a plan version's dependency graph, deferred from R-E3b. The structure is read once per
 * version; each node says its work item's state in words, from the version's detail.
 */

afterEach(cleanup);

const node = (sourceId: string) => ({
  workItemId: `item-${sourceId}`,
  sourceId,
  title: `${sourceId} title`,
});
const summary = (sourceId: string, readiness: WorkItemSummary['readiness']) =>
  ({ id: `item-${sourceId}`, sourceId, readiness, status: 'proposed' }) as WorkItemSummary;

function graph(ids: string[], edges: [number, number][]): PlanVersionGraph {
  return { planVersionId: 'version-1', nodes: ids.map(node), edges } as PlanVersionGraph;
}

it('draws each work item with its state in words, and the dependencies no other path implies', () => {
  const { container } = render(
    <PlanGraph
      graph={graph(
        ['AQ-01', 'AQ-02', 'AQ-03'],
        [
          [0, 1],
          [1, 2],
          // Implied through AQ-02.
          [0, 2],
        ],
      )}
      items={[
        summary('AQ-01', 'completed'),
        summary('AQ-02', 'planning-ready'),
        summary('AQ-03', 'dependency-blocked'),
      ]}
      onOpen={vi.fn()}
    />,
  );
  const first = screen.getByRole('button', { name: /AQ-01/ });
  expect(first.getAttribute('aria-label')).toContain('Completed');
  expect(screen.getByRole('button', { name: /AQ-03/ }).getAttribute('aria-label')).toContain(
    'Dependency-blocked',
  );
  expect(container.querySelectorAll('path.board-edge')).toHaveLength(2);
});

it('opens a work item from its node, by click or key', () => {
  const onOpen = vi.fn();
  render(
    <PlanGraph
      graph={graph(['AQ-01', 'AQ-02'], [[0, 1]])}
      items={[summary('AQ-01', 'completed'), summary('AQ-02', 'planning-ready')]}
      onOpen={onOpen}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /AQ-01/ }));
  fireEvent.keyDown(screen.getByRole('button', { name: /AQ-02/ }), { key: 'Enter' });
  expect(onOpen.mock.calls).toEqual([['item-AQ-01'], ['item-AQ-02']]);
});

it('says so instead of drawing a plan too large to read', () => {
  const ids = Array.from({ length: PLAN_GRAPH_CAP + 1 }, (_, i) => `AQ-${i}`);
  render(<PlanGraph graph={graph(ids, [])} items={[]} onOpen={vi.fn()} />);
  expect(screen.getByText(/too many to draw/)).toBeDefined();
  expect(screen.queryByRole('button')).toBeNull();
});

it('draws a plan whose dependencies loop, rather than failing the page', () => {
  render(
    <PlanGraph
      graph={graph(
        ['AQ-01', 'AQ-02'],
        [
          [0, 1],
          [1, 0],
        ],
      )}
      items={[]}
      onOpen={vi.fn()}
    />,
  );
  expect(screen.getAllByRole('button')).toHaveLength(2);
});
