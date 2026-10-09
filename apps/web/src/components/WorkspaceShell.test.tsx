import { asWorkspaceId } from '@craftingtable/domain';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Route } from '../lib/route.js';
import { WorkspaceShell } from './WorkspaceShell.js';

/**
 * On a phone a new destination starts at the top; a board's selection is not one (R-E3b): it
 * changes the address but leaves the reader where they are, so a selection's detail opens in
 * place.
 */

const ws = asWorkspaceId('workspace');
const scrolled = vi.fn();
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('scrollTo', scrolled);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  scrolled.mockReset();
});

function shell(route: Route) {
  return (
    <WorkspaceShell
      username="keith"
      workspaces={[]}
      connection="open"
      route={route}
      theme="dark"
      onSelectWorkspace={() => undefined}
      onToggleTheme={() => undefined}
      onLogout={() => undefined}
    >
      <p>Page</p>
    </WorkspaceShell>
  );
}

it("starts a new destination at the top, but not a board's new selection", () => {
  const board: Route = { name: 'roadmap', workspaceId: ws, roadmapId: 'r-1', tab: 'board' };
  const view = render(shell(board));
  expect(scrolled).toHaveBeenCalledTimes(1);
  view.rerender(shell({ ...board, select: 'slice:a:merged' }));
  view.rerender(shell({ ...board, select: 'checkpoint:b:passed' }));
  expect(scrolled).toHaveBeenCalledTimes(1);
  view.rerender(shell({ ...board, view: 'graph', select: 'checkpoint:b:passed' }));
  expect(scrolled).toHaveBeenCalledTimes(2);
  view.rerender(shell({ ...board, tab: 'setup' }));
  expect(scrolled).toHaveBeenCalledTimes(3);
});
