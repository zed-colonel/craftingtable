import { describe, expect, it } from 'vitest';
import { buildPath, parseRoute, type Route, routeWorkspaceId } from './route.js';

/** Pure navigation: testable without a DOM (ADR-015). */

const WORKSPACE = 'workspace-1' as never;
const PROJECT = 'project-1' as never;
const VERSION = 'version-1' as never;
const ITEM = 'item-1' as never;
const RUN = 'run-1' as never;

const ROUTES: readonly Route[] = [
  { name: 'root' },
  { name: 'home' },
  { name: 'account' },
  { name: 'dashboard', workspaceId: WORKSPACE },
  { name: 'projects', workspaceId: WORKSPACE },
  { name: 'settings', workspaceId: WORKSPACE },
  { name: 'import', workspaceId: WORKSPACE },
  { name: 'repositories', workspaceId: WORKSPACE },
  { name: 'runs', workspaceId: WORKSPACE },
  { name: 'agenda', workspaceId: WORKSPACE, filter: 'all' },
  { name: 'agenda', workspaceId: WORKSPACE, filter: 'completed' },
  { name: 'project', workspaceId: WORKSPACE, projectId: PROJECT },
  { name: 'plan-version', workspaceId: WORKSPACE, projectId: PROJECT, planVersionId: VERSION },
  { name: 'work-item', workspaceId: WORKSPACE, workItemId: ITEM },
  { name: 'run', workspaceId: WORKSPACE, runId: RUN },
  { name: 'inbox', workspaceId: WORKSPACE },
  { name: 'inbox', workspaceId: WORKSPACE, itemId: 'item-9' },
  // Typed focus (R-E1): a roadmap, a settings section, an element to reveal.
  { name: 'roadmaps', workspaceId: WORKSPACE, roadmapId: 'roadmap-1' },
  { name: 'roadmaps', workspaceId: WORKSPACE, roadmapId: 'roadmap-1', focus: 'map-reviewers' },
  { name: 'settings', workspaceId: WORKSPACE, roadmapId: 'roadmap-1', focus: 'execution-capacity' },
  { name: 'settings', workspaceId: WORKSPACE, focus: 'roadmap-agent-profiles' },
  { name: 'work-item', workspaceId: WORKSPACE, workItemId: ITEM, focus: 'slices' },
];

describe('route parsing', () => {
  it('round-trips every route shape', () => {
    for (const route of ROUTES) {
      const url = new URL(buildPath(route), 'http://ct.invalid');
      expect(parseRoute(url.pathname, url.search, url.hash), buildPath(route)).toEqual(route);
    }
  });

  it('builds the documented deep-link paths', () => {
    expect(buildPath({ name: 'root' })).toBe('/');
    expect(buildPath({ name: 'home' })).toBe('/workspaces');
    expect(buildPath({ name: 'account' })).toBe('/account');
    expect(buildPath({ name: 'dashboard', workspaceId: WORKSPACE })).toBe(
      '/workspaces/workspace-1',
    );
    expect(buildPath({ name: 'agenda', workspaceId: WORKSPACE, filter: 'all' })).toBe(
      '/workspaces/workspace-1/agenda',
    );
    expect(buildPath({ name: 'agenda', workspaceId: WORKSPACE, filter: 'admitted' })).toBe(
      '/workspaces/workspace-1/agenda/admitted',
    );
    // Notification links open these (R-A5).
    expect(buildPath({ name: 'inbox', workspaceId: WORKSPACE, itemId: 'item-9' })).toBe(
      '/workspaces/workspace-1/inbox/item-9',
    );
    expect(buildPath({ name: 'runs', workspaceId: WORKSPACE })).toBe(
      '/workspaces/workspace-1/runs',
    );
    expect(buildPath({ name: 'run', workspaceId: WORKSPACE, runId: RUN })).toBe(
      '/workspaces/workspace-1/runs/run-1',
    );
    expect(
      buildPath({
        name: 'plan-version',
        workspaceId: WORKSPACE,
        projectId: PROJECT,
        planVersionId: VERSION,
      }),
    ).toBe('/workspaces/workspace-1/projects/project-1/plans/version-1');
    expect(buildPath({ name: 'work-item', workspaceId: WORKSPACE, workItemId: ITEM })).toBe(
      '/workspaces/workspace-1/work-items/item-1',
    );
  });

  it('percent-encodes identifiers in both directions', () => {
    const route: Route = {
      name: 'work-item',
      workspaceId: 'workspace/one' as never,
      workItemId: 'item one' as never,
    };
    const path = buildPath(route);
    expect(path).toBe('/workspaces/workspace%2Fone/work-items/item%20one');
    expect(parseRoute(path)).toEqual(route);
  });

  it('falls back to the root for anything unrecognized', () => {
    for (const path of ['/', '', '/unknown', '/api/workspaces/x', '/account/extra']) {
      expect(parseRoute(path), path).toEqual({ name: 'root' });
    }
    expect(parseRoute('/workspaces')).toEqual({ name: 'home' });
    expect(parseRoute('/workspaces/')).toEqual({ name: 'home' });
  });

  it('degrades a partial path to the nearest valid route', () => {
    expect(parseRoute('/workspaces/workspace-1/projects')).toEqual({
      name: 'projects',
      workspaceId: WORKSPACE,
    });
    expect(parseRoute('/workspaces/workspace-1/projects/project-1/plans')).toEqual({
      name: 'project',
      workspaceId: WORKSPACE,
      projectId: PROJECT,
    });
    expect(parseRoute('/workspaces/workspace-1/work-items')).toEqual({
      name: 'dashboard',
      workspaceId: WORKSPACE,
    });
    expect(parseRoute('/workspaces/workspace-1/agenda/nonsense')).toEqual({
      name: 'agenda',
      workspaceId: WORKSPACE,
      filter: 'all',
    });
  });

  it('does not throw on a malformed percent escape', () => {
    expect(parseRoute('/workspaces/%E0%A4%A')).toEqual({ name: 'home' });
  });

  it('reports the workspace a route addresses', () => {
    expect(routeWorkspaceId({ name: 'home' })).toBeUndefined();
    expect(routeWorkspaceId({ name: 'runs', workspaceId: WORKSPACE })).toBe(WORKSPACE);
  });
});

describe('typed focus (R-E1)', () => {
  it('carries a roadmap in the query and the element to reveal in the fragment', () => {
    expect(
      buildPath({
        name: 'settings',
        workspaceId: WORKSPACE,
        roadmapId: 'roadmap 1',
        focus: 'execution-capacity',
      }),
    ).toBe('/workspaces/workspace-1/settings?roadmap=roadmap%201#execution-capacity');
    expect(
      parseRoute('/workspaces/workspace-1/roadmaps', '?roadmap=r-2', '#architecture-decisions-d'),
    ).toEqual({
      name: 'roadmaps',
      workspaceId: WORKSPACE,
      roadmapId: 'r-2',
      focus: 'architecture-decisions-d',
    });
  });

  it('ignores focus a route does not take, and malformed values', () => {
    expect(parseRoute('/workspaces/workspace-1/runs', '?roadmap=x', '#y')).toEqual({
      name: 'runs',
      workspaceId: WORKSPACE,
    });
    expect(parseRoute('/workspaces/workspace-1/settings', '', '#%E0%A4%A')).toEqual({
      name: 'settings',
      workspaceId: WORKSPACE,
    });
  });
});
