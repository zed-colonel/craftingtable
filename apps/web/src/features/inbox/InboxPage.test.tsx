import type { AttentionItemView } from '@craftingtable/contracts';
import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NeedsYou } from '../../components/NeedsYou.js';
import { WorkspaceShell } from '../../components/WorkspaceShell.js';
import { InboxPage } from './InboxPage.js';

afterEach(cleanup);
const workspaceId = asWorkspaceId('ws');
const now = Date.parse('2026-09-25T12:00:00Z');
const item = (id: string, changes: Partial<AttentionItemView>): AttentionItemView => ({
  id,
  subjectKey: `cycle:${id}`,
  code: 'service-failure-not-retryable',
  kind: 'attention',
  title: `WorldInterface · ${id} · Needs attention`,
  message: 'The backend failed without a recognized temporary service error.',
  path: `/workspaces/ws/work-items/${id}`,
  inboxPath: `/workspaces/ws/inbox/${id}`,
  refs: { cycleId: id, workItemId: id },
  blocks: 0,
  openedAt: '2026-09-25T11:00:00Z',
  pushedAt: null,
  ...changes,
});
// The stops of 2026-09-25, as the daemon serves them, most blocking first.
const items = [
  item('wi-02', { blocks: 4 }),
  item('exo-03', { code: 'shared-decision-required', refs: { cycleId: 'c', roadmapId: 'r' } }),
  item('hold', {
    subjectKey: 'roadmap:r:entry:e',
    code: 'evidence-not-current',
    refs: { roadmapId: 'r', entryId: 'e' },
    actions: ['reverify'],
  }),
  item('scope', { code: 'scope-review-open-questions' }),
  item('upstream', { code: 'upstream-transition-undeclared' }),
];

it('lists every item with its stop, and shows the same count on the rail and the dashboard', () => {
  const navigate = vi.fn();
  render(
    <WorkspaceShell
      username="keith"
      workspaces={[
        {
          id: workspaceId,
          name: 'Home',
          role: 'owner',
          liveRunCount: 0,
          admittedCount: 0,
        } as never,
      ]}
      selectedWorkspaceId={workspaceId}
      attentionCount={items.length}
      connection="open"
      route={{ name: 'inbox', workspaceId }}
      theme="dark"
      onSelectWorkspace={() => undefined}
      onToggleTheme={() => undefined}
      onLogout={() => undefined}
    >
      <InboxPage
        workspaceId={workspaceId}
        items={items}
        loaded
        now={now}
        onNavigate={navigate}
        renderHost={() => null}
      />
      <NeedsYou items={items} workspaceId={workspaceId} variant="section" onNavigate={navigate} />
    </WorkspaceShell>,
  );
  const rail = screen.getByRole('link', { name: /Needs you/ });
  expect(rail.textContent).toContain(String(items.length));
  const list = screen.getByRole('region', { name: 'Open items' });
  const labels = within(list)
    .getAllByRole('link')
    .map((link) => link.textContent);
  expect(labels).toEqual([
    'Service failure',
    'Shared decision required',
    'Evidence no longer current',
    'Scope review questions',
    'Upstream transition undeclared',
  ]);
  expect(within(list).getByText(/unblocks 4/)).toBeTruthy();
  const dashboard = screen.getByRole('region', { name: 'Needs you' });
  expect(within(dashboard).getAllByRole('link', { name: /./ })).toHaveLength(items.length + 1);
  fireEvent.click(within(list).getAllByRole('link')[2]!);
  expect(navigate).toHaveBeenCalledWith({ name: 'inbox', workspaceId, itemId: 'hold' });
});

it('hosts the controls that resolve the selected item, and says when it has resolved', () => {
  const host = vi.fn((selected: AttentionItemView) => (
    <button type="button">Resolve {selected.id}</button>
  ));
  const view = render(
    <InboxPage
      workspaceId={workspaceId}
      items={items}
      loaded
      selectedId="upstream"
      now={now}
      onNavigate={() => undefined}
      renderHost={host}
    />,
  );
  const decision = screen.getByRole('region', { name: 'Decision' });
  expect(within(decision).getByText('Upstream transition undeclared')).toBeTruthy();
  expect(within(decision).getByRole('button', { name: 'Resolve upstream' })).toBeTruthy();
  expect(within(decision).getByRole('link', { name: 'Open where it happened' })).toHaveProperty(
    'href',
    expect.stringContaining('/workspaces/ws/work-items/upstream'),
  );
  view.rerender(
    <InboxPage
      workspaceId={workspaceId}
      items={items.filter((i) => i.id !== 'upstream')}
      loaded
      selectedId="upstream"
      now={now}
      onNavigate={() => undefined}
      renderHost={host}
    />,
  );
  expect(screen.queryByRole('region', { name: 'Decision' })).toBeNull();
  expect(screen.getByText(/This item is resolved/)).toBeTruthy();
});
