import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { loopModel, MODEL, ROADMAP_ID } from './board-testing.js';
import { NeighbourhoodGraph } from './NeighbourhoodGraph.js';

/**
 * R-E3b, ADR-072: the neighbourhood graph draws the selection's work-item-level neighbourhood,
 * each node stating the daemon's state in words, and selects in place; it posts and reads nothing.
 */

const links = {
  workspaceId: asWorkspaceId('workspace'),
  roadmapId: ROADMAP_ID,
  onOpenWorkItem: vi.fn(),
};
const fetched = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetched));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetched.mockReset();
});

function graph(selected?: string) {
  const onSelect = vi.fn();
  render(
    <NeighbourhoodGraph model={MODEL} selected={selected} onSelect={onSelect} links={links} />,
  );
  return onSelect;
}

it('asks for a selection, with the gates to choose from', () => {
  graph();
  const area = screen.getByRole('region', { name: 'Neighbourhood graph' });
  expect(area.textContent).toContain('Select a gate above');
  expect(area.querySelector('svg')).toBeNull();
  expect(screen.getByRole('region', { name: 'Gates' })).toBeTruthy();
});

it("draws a slice's work item with the decision it waits on, each node saying its state", () => {
  const onSelect = graph('slice:wi/WI-01/impl:merged');
  const area = screen.getByRole('region', { name: 'Neighbourhood graph' });
  expect(area.querySelector('svg title')?.textContent).toBe('Neighbourhood of wi/WI-01');
  const nodes = within(area).getAllByRole('button', { name: /:/ });
  expect(nodes.map((n) => n.getAttribute('aria-label'))).toEqual(
    expect.arrayContaining([
      'ADR-1 Transport contract: In Needs you · unblocks 1',
      'wi/WI-01 World interface core: Waiting on prerequisites · Needs you',
    ]),
  );
  expect(nodes).toHaveLength(2);
  // The work item is pressed: the selection is one of its slices.
  expect(
    within(area)
      .getByRole('button', { name: /^wi\/WI-01 / })
      .getAttribute('aria-pressed'),
  ).toBe('true');
  expect(area.querySelectorAll('path.board-edge')).toHaveLength(1);
  expect(area.textContent).toContain('2 hops each way · 2 nodes');
  // A node selects in place, by click and by key.
  fireEvent.click(within(area).getByRole('button', { name: /^ADR-1 / }));
  expect(onSelect).toHaveBeenLastCalledWith('checkpoint:ADR-1:passed');
  fireEvent.keyDown(within(area).getByRole('button', { name: /^wi\/WI-01 / }), { key: 'Enter' });
  expect(onSelect).toHaveBeenLastCalledWith('work_item:wi/WI-01:accepted');
  // Nothing more to reach: "expand" is off.
  expect((within(area).getByRole('button', { name: 'Expand' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(fetched).not.toHaveBeenCalled();
});

it('shows the selection in the panel beside the graph', () => {
  graph('checkpoint:ADR-1:passed');
  const panel = screen.getByRole('complementary', { name: 'Selection' });
  expect(within(panel).getByRole('region', { name: 'Unblocks' }).textContent).toContain(
    'Unblocks 1 slices',
  );
});

it('draws a loop the folding to work items makes, the back edge dotted, without failing (R-E3b review H1)', () => {
  render(
    <NeighbourhoodGraph
      model={loopModel()}
      selected="slice:wi/WI-01/impl:merged"
      onSelect={vi.fn()}
      links={links}
    />,
  );
  const area = screen.getByRole('region', { name: 'Neighbourhood graph' });
  expect(area.querySelectorAll('path.board-edge')).toHaveLength(2);
  expect(area.querySelectorAll('path.board-edge-back')).toHaveLength(1);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('says a selection outside the roadmap has no neighbourhood, and resets Expand per selection', () => {
  const outside = {
    ...MODEL,
    graph: {
      ...MODEL.graph,
      nodes: MODEL.graph.nodes.map((n, i) => (i === 5 ? { ...n, included: false } : n)),
    },
  };
  render(
    <NeighbourhoodGraph
      model={outside}
      selected="work_item:exo/EXO-01:accepted"
      onSelect={vi.fn()}
      links={links}
    />,
  );
  expect(screen.getByRole('region', { name: 'Neighbourhood graph' }).textContent).toContain(
    "outside this roadmap's selected work",
  );
});
