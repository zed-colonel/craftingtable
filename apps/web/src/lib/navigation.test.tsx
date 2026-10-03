import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { asWorkspaceId } from '@craftingtable/domain';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { Link, NavigationProvider, PathLink, useRevealRouteFocus } from './navigation.js';
import type { Route } from './route.js';
import { asyncWaitMs } from '../test-time.js';

afterEach(cleanup);
const workspaceId = asWorkspaceId('workspace-1');
const settings: Route = {
  name: 'settings',
  workspaceId,
  roadmapId: 'roadmap-1',
  focus: 'execution-capacity',
};

function inApp(ui: React.ReactNode) {
  const navigate = vi.fn();
  render(
    <NavigationProvider value={{ route: { name: 'home' }, navigate }}>{ui}</NavigationProvider>,
  );
  return navigate;
}

it('follows a link in place, without reloading the document (R-E1, UI-07)', () => {
  const navigate = inApp(<Link route={settings}>Manage capacity</Link>);
  const link = screen.getByRole('link', { name: 'Manage capacity' });
  expect(link.getAttribute('href')).toBe(
    '/workspaces/workspace-1/settings?roadmap=roadmap-1#execution-capacity',
  );
  // fireEvent returns false when the default (a document load) was prevented.
  expect(fireEvent.click(link)).toBe(false);
  expect(navigate).toHaveBeenCalledWith(settings);
});

it('leaves a new-tab click, or a click a handler takes over, to the browser or the handler', () => {
  const opened = vi.fn();
  const navigate = inApp(
    <>
      <Link route={settings}>Settings</Link>
      <Link
        route={settings}
        onClick={(event) => {
          event.preventDefault();
          opened();
        }}
      >
        Open here
      </Link>
    </>,
  );
  expect(fireEvent.click(screen.getByRole('link', { name: 'Settings' }), { ctrlKey: true })).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Open here' }));
  expect(opened).toHaveBeenCalledTimes(1);
  expect(navigate).not.toHaveBeenCalled();
});

it('reads a path held as text as a route', () => {
  const navigate = inApp(
    <PathLink path="/workspaces/workspace-1/roadmaps/r/setup#runtime-evidence-roadmap-r-decisions">
      Decisions
    </PathLink>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Decisions' }));
  expect(navigate).toHaveBeenCalledWith({
    name: 'roadmap',
    workspaceId,
    roadmapId: 'r',
    tab: 'setup',
    focus: 'runtime-evidence-roadmap-r-decisions',
  });
});

it('opens a link stored before the Roadmaps page was split in place, on the page it names (R-E2)', () => {
  const navigate = inApp(
    <PathLink path="/workspaces/workspace-1/roadmaps?roadmap=r#runtime-evidence-roadmap-r">
      Dependency refresh
    </PathLink>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Dependency refresh' }));
  expect(navigate).toHaveBeenCalledWith({
    name: 'roadmap',
    workspaceId,
    roadmapId: 'r',
    tab: 'setup',
    focus: 'runtime-evidence-roadmap-r',
  });
});

it('reveals a route focus even when its panel mounts after the page (R-E1, UI-08)', async () => {
  function Page() {
    useRevealRouteFocus(settings);
    const [loaded, setLoaded] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setLoaded(true)}>
          Load
        </button>
        {loaded && (
          <details>
            <summary>Capacity</summary>
            <section id="execution-capacity">Capacity controls</section>
          </details>
        )}
      </>
    );
  }
  render(<Page />);
  // The panel loads on its own, after navigation.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
  });
  const target = await screen.findByText('Capacity controls');
  await vi.waitFor(() => expect(document.activeElement).toBe(target), { timeout: asyncWaitMs() });
  expect((target.closest('details') as HTMLDetailsElement).open).toBe(true);
});

it('leaves a stored link whose fragment cannot be read as a plain anchor (R-E2 review)', () => {
  const navigate = inApp(
    <PathLink path="/workspaces/workspace-1/roadmaps?roadmap=r#%E0%A4%A">Old</PathLink>,
  );
  fireEvent.click(screen.getByRole('link', { name: 'Old' }));
  expect(navigate).not.toHaveBeenCalled();
});
