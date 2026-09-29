import { cleanup, render, screen } from '@testing-library/react';
import { asWorkspaceId } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { NavigationProvider, PathLink, useRevealRouteFocus } from './navigation.js';
import { buildPath, parseRoute, type Route } from './route.js';

afterEach(cleanup);
const workspaceId = asWorkspaceId('ws');

it('PathLink keeps an external URL external instead of rewriting it to the app root', () => {
  render(
    <NavigationProvider value={{ route: { name: 'home' }, navigate: vi.fn() }}>
      <PathLink path="https://example.com/docs">Docs</PathLink>
    </NavigationProvider>,
  );
  //
  expect(screen.getByRole('link', { name: 'Docs' }).getAttribute('href')).toBe(
    'https://example.com/docs',
  );
});

it('PathLink keeps a fragment on a route that does not take focus', () => {
  render(
    <NavigationProvider value={{ route: { name: 'home' }, navigate: vi.fn() }}>
      <PathLink path="/workspaces/ws/runs/r1#events">Run</PathLink>
    </NavigationProvider>,
  );
  //
  expect(screen.getByRole('link', { name: 'Run' }).getAttribute('href')).toBe(
    '/workspaces/ws/runs/r1#events',
  );
});

it('round-trips a roadmap id and focus with reserved characters', () => {
  const route: Route = {
    name: 'settings',
    workspaceId,
    roadmapId: 'a&b=c #d%',
    focus: 'x y#z%',
  };
  const url = new URL(buildPath(route), 'http://x.invalid');
  expect(parseRoute(url.pathname, url.search, url.hash)).toEqual(route);
});

it('a pending reveal is cancelled when the route moves on before the target mounts', async () => {
  function Page({ route, show }: { route: Route; show: boolean }) {
    useRevealRouteFocus(route);
    return show ? <section id="slices">Slices of another item</section> : null;
  }
  const a: Route = {
    name: 'work-item',
    workspaceId,
    workItemId: 'a' as never,
    focus: 'slices',
  };
  const b: Route = { name: 'work-item', workspaceId, workItemId: 'b' as never };
  const { rerender } = render(<Page route={a} show={false} />);
  // The operator navigates to item B before A's slices loaded.
  rerender(<Page route={b} show={false} />);
  // B's slices load later: the reveal meant for A must not steal focus/scroll on B.
  rerender(<Page route={b} show />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  //
  expect(document.activeElement).not.toBe(screen.getByText('Slices of another item'));
});
