import { asRoadmapEntryId, asWorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BoardList } from './BoardList.js';
import { MODEL, ROADMAP_ID } from './board-testing.js';

/**
 * R-E3b's phone layout: the grouped status list, by the daemon's actor and counts, whose rows and
 * gates open the selection's content in place; the Gates strip becomes a list; no graph.
 */

const links = {
  workspaceId: asWorkspaceId('workspace'),
  roadmapId: ROADMAP_ID,
  onOpenWorkItem: vi.fn(),
};
afterEach(cleanup);

function list(selected?: string) {
  const onSelect = vi.fn();
  const view = render(
    <BoardList model={MODEL} selected={selected} onSelect={onSelect} links={links} />,
  );
  return { onSelect, view };
}

it('groups the open entries by who acts, with the daemon counts, and lists the gates', () => {
  list();
  const you = screen.getByRole('region', { name: 'Needs you' });
  expect(within(you).getByRole('heading').textContent).toBe('Needs you (1)');
  expect(within(you).getByRole('button').textContent).toContain(
    'ADR-1 has a prepared brief awaiting your approval',
  );
  const waiting = screen.getByRole('region', { name: 'Waiting' });
  expect(within(waiting).getByRole('heading').textContent).toBe('Waiting (2)');
  expect(within(waiting).getAllByRole('button')).toHaveLength(2);
  expect(screen.queryByRole('region', { name: 'Agents at work' })).toBeNull();
  const gates = screen.getByRole('region', { name: 'Gates' });
  expect(within(gates).getByRole('button', { name: /ADR-1.*unblocks 1/ })).toBeTruthy();
  expect(document.querySelector('svg')).toBeNull();
});

it("opens a row's node in place: a slice entry at its first unmet milestone", () => {
  const { onSelect, view } = list();
  const you = screen.getByRole('region', { name: 'Needs you' });
  fireEvent.click(within(you).getByRole('button'));
  expect(onSelect).toHaveBeenLastCalledWith('slice:wi/WI-01/impl:started');
  view.rerender(
    <BoardList
      model={MODEL}
      selected="slice:wi/WI-01/impl:started"
      onSelect={onSelect}
      links={links}
    />,
  );
  const row = within(screen.getByRole('region', { name: 'Needs you' })).getAllByRole(
    'listitem',
  )[0]!;
  expect(within(row).getByRole('button', { expanded: true })).toBeTruthy();
  expect(within(row).getByRole('region', { name: 'Root blockers' }).textContent).toContain('ADR-1');
  // Selecting it again closes it.
  fireEvent.click(within(row).getByRole('button', { expanded: true }));
  expect(onSelect).toHaveBeenLastCalledWith(undefined);
});

it("opens a gate's slices under the gate", () => {
  list('checkpoint:ADR-1:passed');
  const gates = screen.getByRole('region', { name: 'Gates' });
  expect(within(gates).getByRole('region', { name: 'Unblocks' }).textContent).toContain(
    'Unblocks 1 slices',
  );
  // The row groups below show no second copy.
  expect(screen.getAllByRole('region', { name: 'Unblocks' })).toHaveLength(1);
});

it('starts a group of more than ten rows closed, unless it holds the selection', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({
    ...MODEL.status.entries[1]!,
    entryId: asRoadmapEntryId(`00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`),
  }));
  const model = { ...MODEL, status: { ...MODEL.status, entries: many } };
  render(<BoardList model={model} selected={undefined} onSelect={vi.fn()} links={links} />);
  const waiting = screen.getByRole('region', { name: 'Waiting' });
  expect(waiting.querySelector('details')?.open).toBe(false);
  expect(waiting.querySelector('summary')?.textContent).toBe('Waiting (2)');
});

it('keeps what needs the operator open however long it is', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({
    ...MODEL.status.entries[0]!,
    entryId: asRoadmapEntryId(`00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`),
  }));
  const model = { ...MODEL, status: { ...MODEL.status, entries: many } };
  render(<BoardList model={model} selected={undefined} onSelect={vi.fn()} links={links} />);
  const you = screen.getByRole('region', { name: 'Needs you' });
  expect(you.querySelector('details')).toBeNull();
  expect(within(you).getAllByRole('button')).toHaveLength(11);
});

it('opens a node no row or gate holds above the list (R-E3b review M1)', () => {
  // The met plan checkpoint: no open entry opens on it and it is no gate.
  const onSelect = vi.fn();
  render(
    <BoardList model={MODEL} selected="checkpoint:PLAN:passed" onSelect={onSelect} links={links} />,
  );
  const selection = screen.getByRole('region', { name: 'Selection' });
  expect(within(selection).getByRole('heading').textContent).toContain('Plan accepted');
  fireEvent.click(within(selection).getByRole('button', { name: 'Clear selection' }));
  expect(onSelect).toHaveBeenLastCalledWith(undefined);
  cleanup();
  // A row's own node opens under the row, not above.
  render(
    <BoardList
      model={MODEL}
      selected="slice:wi/WI-01/impl:started"
      onSelect={vi.fn()}
      links={links}
    />,
  );
  expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
});
