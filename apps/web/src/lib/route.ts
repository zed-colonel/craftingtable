import type { PlanVersionId, ProjectId, WorkItemId, WorkspaceId } from '@craftingtable/domain';

/**
 * Deep-linkable routes, parsed and built by pure functions.
 *
 * Four static shapes need about fifty lines; a routing library would bring a
 * data-loading framework the daemon-as-authority design does not want
 * (ADR-015). Keeping this pure also makes navigation testable without a DOM.
 */

export type Route =
  | { readonly name: 'dashboard'; readonly workspaceId?: WorkspaceId }
  | { readonly name: 'import'; readonly workspaceId: WorkspaceId }
  | { readonly name: 'project'; readonly workspaceId: WorkspaceId; readonly projectId: ProjectId }
  | {
      readonly name: 'plan-version';
      readonly workspaceId: WorkspaceId;
      readonly projectId: ProjectId;
      readonly planVersionId: PlanVersionId;
    }
  | {
      readonly name: 'work-item';
      readonly workspaceId: WorkspaceId;
      readonly workItemId: WorkItemId;
    };

export const DASHBOARD_ROUTE: Route = { name: 'dashboard' };

function decode(segment: string | undefined): string | undefined {
  if (segment === undefined || segment === '') {
    return undefined;
  }
  try {
    const value = decodeURIComponent(segment);
    return value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Unrecognized paths fall back to the dashboard rather than erroring. */
export function parseRoute(pathname: string): Route {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments[0] !== 'workspaces') {
    return DASHBOARD_ROUTE;
  }
  const workspaceId = decode(segments[1]) as WorkspaceId | undefined;
  if (workspaceId === undefined) {
    return DASHBOARD_ROUTE;
  }
  if (segments.length === 2) {
    return { name: 'dashboard', workspaceId };
  }
  if (segments[2] === 'import' && segments.length === 3) {
    return { name: 'import', workspaceId };
  }
  if (segments[2] === 'work-items') {
    const workItemId = decode(segments[3]) as WorkItemId | undefined;
    return workItemId === undefined
      ? { name: 'dashboard', workspaceId }
      : { name: 'work-item', workspaceId, workItemId };
  }
  if (segments[2] === 'projects') {
    const projectId = decode(segments[3]) as ProjectId | undefined;
    if (projectId === undefined) {
      return { name: 'dashboard', workspaceId };
    }
    if (segments.length === 4) {
      return { name: 'project', workspaceId, projectId };
    }
    if (segments[4] === 'plans') {
      const planVersionId = decode(segments[5]) as PlanVersionId | undefined;
      if (planVersionId !== undefined && segments.length === 6) {
        return { name: 'plan-version', workspaceId, projectId, planVersionId };
      }
    }
    return { name: 'project', workspaceId, projectId };
  }
  return { name: 'dashboard', workspaceId };
}

export function buildPath(route: Route): string {
  const workspace = (id: WorkspaceId): string => `/workspaces/${encodeURIComponent(id)}`;
  switch (route.name) {
    case 'dashboard':
      return route.workspaceId === undefined ? '/' : workspace(route.workspaceId);
    case 'import':
      return `${workspace(route.workspaceId)}/import`;
    case 'project':
      return `${workspace(route.workspaceId)}/projects/${encodeURIComponent(route.projectId)}`;
    case 'plan-version':
      return `${workspace(route.workspaceId)}/projects/${encodeURIComponent(
        route.projectId,
      )}/plans/${encodeURIComponent(route.planVersionId)}`;
    case 'work-item':
      return `${workspace(route.workspaceId)}/work-items/${encodeURIComponent(route.workItemId)}`;
  }
}

/** The workspace a route addresses, if any. */
export function routeWorkspaceId(route: Route): WorkspaceId | undefined {
  return route.name === 'dashboard' ? route.workspaceId : route.workspaceId;
}
