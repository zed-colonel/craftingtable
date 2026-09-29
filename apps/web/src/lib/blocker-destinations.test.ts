import { expect, it } from 'vitest';
import { blockerDestination } from './blocker-destinations.js';

const ws = 'ws' as never;

it('sends a setup blocker to the page that holds the setup (R-E2 review)', () => {
  // The roadmap that owns the scope, when there is one: its setup, at the section.
  expect(
    blockerDestination('environment-approval', ws, { roadmapId: 'r-1', definitionId: 'd-1' }),
  ).toEqual({
    label: 'Open verification environments',
    href: '/workspaces/ws/roadmaps/r-1/setup#runtime-evidence-roadmap-r-1-native',
  });
  expect(blockerDestination('reviewer-assignment', ws, { roadmapId: 'r-1' })?.href).toBe(
    '/workspaces/ws/roadmaps/r-1/setup#map-reviewers-roadmap-r-1',
  );
  // Else the map the scope comes from.
  expect(blockerDestination('upstream-pin-missing', ws, { definitionId: 'd-1' })?.href).toBe(
    '/workspaces/ws/roadmaps/maps/d-1#runtime-evidence-d-1-native',
  );
  expect(blockerDestination('reviewer-assignment', ws, { definitionId: 'd-1' })?.href).toBe(
    '/workspaces/ws/roadmaps/maps/d-1#map-reviewers-d-1',
  );
  // Else the list, and the inbox for decisions and amendments, as before.
  expect(blockerDestination('reviewer-assignment', ws)?.href).toBe('/workspaces/ws/roadmaps');
  expect(blockerDestination('amendment-pending', ws, { roadmapId: 'r-1' })?.href).toBe(
    '/workspaces/ws/inbox',
  );
});
