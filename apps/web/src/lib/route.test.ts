import { describe, expect, it } from 'vitest';
import { buildPath, parseRoute, type Route } from './route.js';

/** Pure navigation: testable without a DOM (ADR-015). */

const WORKSPACE = 'workspace-1' as never;
const PROJECT = 'project-1' as never;
const VERSION = 'version-1' as never;
const ITEM = 'item-1' as never;

const ROUTES: readonly Route[] = [
  { name: 'dashboard' },
  { name: 'dashboard', workspaceId: WORKSPACE },
  { name: 'import', workspaceId: WORKSPACE },
  { name: 'project', workspaceId: WORKSPACE, projectId: PROJECT },
  { name: 'plan-version', workspaceId: WORKSPACE, projectId: PROJECT, planVersionId: VERSION },
  { name: 'work-item', workspaceId: WORKSPACE, workItemId: ITEM },
];

describe('route parsing', () => {
  it('round-trips every route shape', () => {
    for (const route of ROUTES) {
      expect(parseRoute(buildPath(route)), buildPath(route)).toEqual(route);
    }
  });

  it('builds the documented deep-link paths', () => {
    expect(buildPath(ROUTES[0] as Route)).toBe('/');
    expect(buildPath(ROUTES[1] as Route)).toBe('/workspaces/workspace-1');
    expect(buildPath(ROUTES[2] as Route)).toBe('/workspaces/workspace-1/import');
    expect(buildPath(ROUTES[3] as Route)).toBe('/workspaces/workspace-1/projects/project-1');
    expect(buildPath(ROUTES[4] as Route)).toBe(
      '/workspaces/workspace-1/projects/project-1/plans/version-1',
    );
    expect(buildPath(ROUTES[5] as Route)).toBe('/workspaces/workspace-1/work-items/item-1');
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

  it('falls back to the dashboard for anything unrecognized', () => {
    for (const path of ['/', '', '/unknown', '/workspaces', '/workspaces/', '/api/workspaces/x']) {
      expect(parseRoute(path), path).toEqual({ name: 'dashboard' });
    }
  });

  it('degrades a partial planning path to the nearest valid route', () => {
    expect(parseRoute('/workspaces/workspace-1/projects')).toEqual({
      name: 'dashboard',
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
  });

  it('does not throw on a malformed percent escape', () => {
    expect(parseRoute('/workspaces/%E0%A4%A')).toEqual({ name: 'dashboard' });
  });
});
