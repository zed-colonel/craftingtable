import type {
  AgentRunId,
  PlanVersionId,
  ProjectId,
  WorkItemId,
  WorkspaceId,
} from '@craftingtable/domain';

/**
 * Deep-linkable routes, parsed and built by pure functions.
 *
 * A handful of static shapes need about a hundred lines; a routing library
 * would bring a data-loading framework the daemon-as-authority design does
 * not want (ADR-015). Keeping this pure also makes navigation testable
 * without a DOM.
 */

export const AGENDA_FILTERS = [
  'all',
  'admitted',
  'planning-ready',
  'dependency-blocked',
  'completed',
] as const;
export type AgendaFilter = (typeof AGENDA_FILTERS)[number];

export type Route =
  /** `/`: resolved by the app to the last used workspace, else the workspace list. */
  | { readonly name: 'root' }
  /** `/workspaces`: every workspace as a card. */
  | { readonly name: 'home' }
  | { readonly name: 'account' }
  | { readonly name: 'roadmaps'; readonly workspaceId: WorkspaceId }
  | { readonly name: 'projects'; readonly workspaceId: WorkspaceId }
  | { readonly name: 'dashboard'; readonly workspaceId: WorkspaceId }
  /** `/workspaces/:id/inbox[/:itemId]`: what needs the operator, and one item's decision. */
  | { readonly name: 'inbox'; readonly workspaceId: WorkspaceId; readonly itemId?: string }
  | { readonly name: 'settings'; readonly workspaceId: WorkspaceId }
  | { readonly name: 'import'; readonly workspaceId: WorkspaceId }
  | { readonly name: 'repositories'; readonly workspaceId: WorkspaceId }
  | { readonly name: 'runs'; readonly workspaceId: WorkspaceId }
  | { readonly name: 'agenda'; readonly workspaceId: WorkspaceId; readonly filter: AgendaFilter }
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
    }
  | { readonly name: 'run'; readonly workspaceId: WorkspaceId; readonly runId: AgentRunId };

export const ROOT_ROUTE: Route = { name: 'root' };
export const HOME_ROUTE: Route = { name: 'home' };

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

function isAgendaFilter(value: string | undefined): value is AgendaFilter {
  return (AGENDA_FILTERS as readonly string[]).includes(value ?? '');
}

/** Unrecognized paths fall back to the root rather than erroring. */
export function parseRoute(pathname: string): Route {
  const segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) {
    return ROOT_ROUTE;
  }
  if (segments[0] === 'account' && segments.length === 1) {
    return { name: 'account' };
  }
  if (segments[0] !== 'workspaces') {
    return ROOT_ROUTE;
  }
  if (segments.length === 1) {
    return HOME_ROUTE;
  }
  const workspaceId = decode(segments[1]) as WorkspaceId | undefined;
  if (workspaceId === undefined) {
    return HOME_ROUTE;
  }
  const dashboard: Route = { name: 'dashboard', workspaceId };
  if (segments.length === 2) {
    return dashboard;
  }
  const section = segments[2];
  if (segments.length === 3) {
    switch (section) {
      case 'roadmaps':
        return { name: 'roadmaps', workspaceId };
      case 'inbox':
        return { name: 'inbox', workspaceId };
      case 'projects':
        return { name: 'projects', workspaceId };
      case 'import':
        return { name: 'import', workspaceId };
      case 'repositories':
        return { name: 'repositories', workspaceId };
      case 'runs':
        return { name: 'runs', workspaceId };
      case 'settings':
        return { name: 'settings', workspaceId };
      case 'agenda':
        return { name: 'agenda', workspaceId, filter: 'all' };
      default:
        break;
    }
  }
  if (section === 'agenda' && segments.length === 4) {
    const filter = decode(segments[3]);
    return isAgendaFilter(filter)
      ? { name: 'agenda', workspaceId, filter }
      : { name: 'agenda', workspaceId, filter: 'all' };
  }
  if (section === 'inbox' && segments.length === 4) {
    const itemId = decode(segments[3]);
    return itemId === undefined
      ? { name: 'inbox', workspaceId }
      : { name: 'inbox', workspaceId, itemId };
  }
  if (section === 'runs') {
    const runId = decode(segments[3]) as AgentRunId | undefined;
    return runId === undefined ? dashboard : { name: 'run', workspaceId, runId };
  }
  if (section === 'work-items') {
    const workItemId = decode(segments[3]) as WorkItemId | undefined;
    return workItemId === undefined ? dashboard : { name: 'work-item', workspaceId, workItemId };
  }
  if (section === 'projects') {
    const projectId = decode(segments[3]) as ProjectId | undefined;
    if (projectId === undefined) {
      return dashboard;
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
  return dashboard;
}

export function buildPath(route: Route): string {
  const workspace = (id: WorkspaceId): string => `/workspaces/${encodeURIComponent(id)}`;
  switch (route.name) {
    case 'root':
      return '/';
    case 'home':
      return '/workspaces';
    case 'account':
      return '/account';
    case 'dashboard':
      return workspace(route.workspaceId);
    case 'roadmaps':
      return `${workspace(route.workspaceId)}/roadmaps`;
    case 'inbox':
      return route.itemId === undefined
        ? `${workspace(route.workspaceId)}/inbox`
        : `${workspace(route.workspaceId)}/inbox/${encodeURIComponent(route.itemId)}`;
    case 'projects':
      return `${workspace(route.workspaceId)}/projects`;
    case 'settings':
      return `${workspace(route.workspaceId)}/settings`;
    case 'import':
      return `${workspace(route.workspaceId)}/import`;
    case 'repositories':
      return `${workspace(route.workspaceId)}/repositories`;
    case 'runs':
      return `${workspace(route.workspaceId)}/runs`;
    case 'agenda':
      return route.filter === 'all'
        ? `${workspace(route.workspaceId)}/agenda`
        : `${workspace(route.workspaceId)}/agenda/${route.filter}`;
    case 'project':
      return `${workspace(route.workspaceId)}/projects/${encodeURIComponent(route.projectId)}`;
    case 'plan-version':
      return `${workspace(route.workspaceId)}/projects/${encodeURIComponent(
        route.projectId,
      )}/plans/${encodeURIComponent(route.planVersionId)}`;
    case 'work-item':
      return `${workspace(route.workspaceId)}/work-items/${encodeURIComponent(route.workItemId)}`;
    case 'run':
      return `${workspace(route.workspaceId)}/runs/${encodeURIComponent(route.runId)}`;
  }
}

/** The workspace a route addresses, if any. */
export function routeWorkspaceId(route: Route): WorkspaceId | undefined {
  return 'workspaceId' in route ? route.workspaceId : undefined;
}
