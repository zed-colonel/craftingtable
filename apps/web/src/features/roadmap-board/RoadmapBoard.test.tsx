import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MODEL, ROADMAP_ID } from './board-testing.js';
import { RoadmapBoard } from './RoadmapBoard.js';

/**
 * R-E3b: the board draws what the daemon said and posts nothing. A selection is a key handed to
 * the route; the panel shows the status list's wait verbatim, the root blockers as in-page
 * links, the direct requirements in a disclosure, what it unblocks, and links.
 */

const ws = asWorkspaceId('workspace');
const links = { workspaceId: ws, roadmapId: ROADMAP_ID, onOpenWorkItem: vi.fn() };
const fetched = vi.fn();
beforeEach(() => vi.stubGlobal('fetch', fetched));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetched.mockReset();
});

function board(selected?: string) {
  const onSelect = vi.fn();
  const view = render(
    <RoadmapBoard model={MODEL} selected={selected} onSelect={onSelect} links={links} />,
  );
  return { onSelect, view };
}

it('draws the summary, the gates by slices unblocked, the lanes and their cards', () => {
  board();
  const summary = screen.getByLabelText('Board summary');
  expect(summary.textContent).toContain('Needs you1');
  expect(summary.textContent).toContain('Done3');
  const gates = screen.getByRole('region', { name: 'Gates' });
  expect(
    within(gates).getByRole('button', { name: /ADR-1.*unblocks 1.*In Needs you/ }),
  ).toBeTruthy();
  const wi = screen.getByRole('region', { name: 'Lane wi' });
  const card = within(wi).getByRole('article');
  // The card's state is its first open entry's, with who acts; its wait is the daemon's.
  expect(card.textContent).toContain('Waiting on prerequisites · Needs you');
  expect(card.textContent).toContain('ADR-1 has a prepared brief awaiting your approval');
  expect(card.textContent).toContain('1 gate');
  // Slice chips are the milestones the map has, each labelled met or not.
  expect(within(card).getByRole('button', { name: 'wi/WI-01/impl started: not met' })).toBeTruthy();
  expect(
    within(card).getByRole('button', { name: 'wi/WI-01/impl verified: not met' }),
  ).toBeTruthy();
  // A lane with only done work collapses it into a chip.
  const exo = screen.getByRole('region', { name: 'Lane exo' });
  expect(within(exo).getByText('✓ 1 done')).toBeTruthy();
  expect(screen.getByRole('complementary', { name: 'Selection' }).textContent).toContain(
    'Select a card, slice or gate',
  );
});

it('selects by handing the node key to the route, from a card, a chip or a gate', () => {
  const { onSelect } = board();
  fireEvent.click(screen.getByRole('button', { name: /wi\/WI-01 World interface core/ }));
  expect(onSelect).toHaveBeenLastCalledWith('work_item:wi/WI-01:accepted');
  fireEvent.click(screen.getByRole('button', { name: 'wi/WI-01/impl merged: not met' }));
  expect(onSelect).toHaveBeenLastCalledWith('slice:wi/WI-01/impl:merged');
  fireEvent.click(screen.getByRole('button', { name: /ADR-1.*unblocks 1/ }));
  expect(onSelect).toHaveBeenLastCalledWith('checkpoint:ADR-1:passed');
});

it("shows a slice's wait verbatim, its root blockers in place and its direct requirements", () => {
  const { onSelect } = board('slice:wi/WI-01/impl:started');
  const panel = screen.getByRole('complementary', { name: 'Selection' });
  expect(
    within(panel).getByRole('heading', { name: /wi\/WI-01\/impl Implementation/ }),
  ).toBeTruthy();
  const waiting = within(panel).getByRole('region', { name: 'Waiting on' });
  expect(waiting.textContent).toContain(
    'ADR-1 has a prepared brief awaiting your approval; wi/WI-01/impl starts once it is approved.',
  );
  expect(
    within(waiting).getByRole('link', { name: 'Open in Needs you' }).getAttribute('href'),
  ).toBe('/workspaces/workspace/inbox/item-slice');
  const roots = within(panel).getByRole('region', { name: 'Root blockers' });
  fireEvent.click(within(roots).getAllByRole('button', { name: /ADR-1/ })[0]!);
  expect(onSelect).toHaveBeenLastCalledWith('checkpoint:ADR-1:passed');
  expect(within(roots).getByText('Direct requirements not met (1)')).toBeTruthy();
  expect(within(panel).getByRole('link', { name: 'Open work item' }).getAttribute('href')).toBe(
    '/workspaces/workspace/work-items/wi-01',
  );
});

it("shows a gate's unblocked slices and links to its inbox item and its setup step by kind", () => {
  board('checkpoint:ADR-1:passed');
  const panel = screen.getByRole('complementary', { name: 'Selection' });
  const unblocks = within(panel).getByRole('region', { name: 'Unblocks' });
  expect(unblocks.textContent).toContain('Unblocks 1 slices');
  expect(within(unblocks).getByRole('button', { name: /wi\/WI-01\/impl/ })).toBeTruthy();
  expect(within(panel).getByRole('link', { name: 'Open in Needs you' }).getAttribute('href')).toBe(
    '/workspaces/workspace/inbox/item-adr',
  );
  expect(
    within(panel).getByRole('link', { name: 'Open its decision in setup' }).getAttribute('href'),
  ).toBe(
    `/workspaces/workspace/roadmaps/${ROADMAP_ID}/setup#runtime-evidence-roadmap-${ROADMAP_ID}-decisions`,
  );
  expect(within(panel).queryByRole('region', { name: 'Waiting on' })).toBeNull();
});

it('posts nothing: every control only selects, and nothing is fetched', () => {
  const { onSelect } = board('slice:wi/WI-01/impl:started');
  expect(document.querySelector('form')).toBeNull();
  for (const button of screen.getAllByRole('button')) fireEvent.click(button);
  expect(fetched).not.toHaveBeenCalled();
  for (const [key] of onSelect.mock.calls)
    expect(key === undefined || MODEL.graph.nodes.some((n) => n.key === key)).toBe(true);
});

it('moves between cards with the arrow keys and into the panel on a selection', () => {
  const { onSelect, view } = board();
  const title = screen.getByRole('button', { name: /wi\/WI-01 World interface core/ });
  title.focus();
  fireEvent.click(title);
  view.rerender(
    <RoadmapBoard
      model={MODEL}
      selected={onSelect.mock.lastCall![0]}
      onSelect={onSelect}
      links={links}
    />,
  );
  expect(document.activeElement).toBe(
    screen.getByRole('heading', { name: /wi\/WI-01 World interface core/ }),
  );
  // The done card in the next lane is a card too.
  fireEvent.click(screen.getByText('✓ 1 done'));
  title.focus();
  fireEvent.keyDown(title, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: /exo\/EXO-01 Exoskeleton domain/ }),
  );
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
  expect(document.activeElement).toBe(title);
});

it('says so when the route selects a node the board does not have', () => {
  board('slice:gone:merged');
  expect(screen.getByRole('status').textContent).toContain(
    "slice:gone:merged is not on this roadmap's board.",
  );
});

it("draws a sequential roadmap's work items as cards with no slices (R-E3b 7)", () => {
  const sequence = {
    ...MODEL,
    graph: {
      ...MODEL.graph,
      model: 'sequence' as const,
      lanes: [{ key: 'project-1', label: 'ActionQueue' }],
      nodes: [
        {
          key: 'work_item:item-1:completed',
          kind: 'work_item' as const,
          sourceId: 'AQ-01',
          state: 'completed' as const,
          title: 'First',
          lane: 0,
          requires: [],
          included: true,
        },
        {
          key: 'work_item:item-2:completed',
          kind: 'work_item' as const,
          sourceId: 'AQ-02',
          state: 'completed' as const,
          title: 'Second',
          lane: 0,
          requires: [0],
          included: true,
        },
      ],
    },
    board: {
      ...MODEL.board,
      nodes: [
        { satisfied: false, entries: [0] },
        { satisfied: false, entries: [2], unmet: [0], roots: [0] },
      ],
      gates: [],
      lanes: [
        {
          lane: 0,
          cards: [
            { node: 0, gates: 0 },
            { node: 1, gates: 0 },
          ],
          done: [],
        },
      ],
    },
  };
  render(
    <RoadmapBoard
      model={sequence}
      selected="work_item:item-2:completed"
      onSelect={vi.fn()}
      links={links}
    />,
  );
  const lane = screen.getByRole('region', { name: 'Lane project-1' });
  expect(within(lane).getAllByRole('article')).toHaveLength(2);
  expect(lane.querySelector('.board-slices')).toBeNull();
  expect(screen.queryByRole('region', { name: 'Gates' })).toBeNull();
  const roots = screen.getByRole('region', { name: 'Root blockers' });
  expect(within(roots).getAllByRole('button', { name: /AQ-01/ }).length).toBeGreaterThan(0);
});
