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

/** One roadmap's pages (R-E2): its board and controls, its setup checklist, its history. */
export const ROADMAP_TABS = ['board', 'setup', 'history'] as const;
export type RoadmapTab = (typeof ROADMAP_TABS)[number];

/**
 * Which of a roadmap's pages holds an element. Links stored before the Roadmaps page was split
 * (attention items, notification records: `/roadmaps?roadmap=<id>#<focus>`) name only the
 * element, so the page follows from its id's prefix; anything else is on the board.
 */
export function roadmapTabForFocus(focus: string | undefined): RoadmapTab {
  if (focus === undefined) return 'board';
  if (['map-amendments-', 'roadmap-revisions-'].some((prefix) => focus.startsWith(prefix)))
    return 'history';
  return [
    'runtime-evidence-',
    'architecture-decisions-',
    'map-',
    'scope-recovery-',
    'future-delegation-',
    'decision-preparation-',
    'roadmap-setup-',
  ].some((prefix) => focus.startsWith(prefix))
    ? 'setup'
    : 'board';
}

export type Route =
  /** `/`: resolved by the app to the last used workspace, else the workspace list. */
  | { readonly name: 'root' }
  /** `/workspaces`: every workspace as a card. */
  | { readonly name: 'home' }
  | { readonly name: 'account' }
  /**
   * `/roadmaps`: every roadmap and the imported maps. `#focus` names an element to reveal once
   * the page mounts (R-E1): a deep link does not depend on a panel reading the address itself.
   */
  | { readonly name: 'roadmaps'; readonly workspaceId: WorkspaceId; readonly focus?: string }
  /** `/roadmaps/:id[/setup|/history]`: one roadmap's board, setup or history (R-E2). */
  | {
      readonly name: 'roadmap';
      readonly workspaceId: WorkspaceId;
      readonly roadmapId: string;
      readonly tab: RoadmapTab;
      readonly focus?: string;
    }
  /** `/roadmaps/maps/:definitionId`: one imported concurrency map, before a roadmap uses it. */
  | {
      readonly name: 'roadmap-map';
      readonly workspaceId: WorkspaceId;
      readonly definitionId: string;
      readonly focus?: string;
    }
  | { readonly name: 'projects'; readonly workspaceId: WorkspaceId }
  | { readonly name: 'dashboard'; readonly workspaceId: WorkspaceId }
  /** `/workspaces/:id/inbox[/:itemId]`: what needs the operator, and one item's decision. */
  | { readonly name: 'inbox'; readonly workspaceId: WorkspaceId; readonly itemId?: string }
  | {
      readonly name: 'settings';
      readonly workspaceId: WorkspaceId;
      readonly roadmapId?: string;
      readonly focus?: string;
    }
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
      readonly focus?: string;
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
export function parseRoute(pathname: string, search = '', hash = ''): Route {
  const route = parsePath(pathname);
  const focus = decode(hash.startsWith('#') ? hash.slice(1) : hash);
  // URLSearchParams has already decoded the value; decoding again would lose a `%`.
  const roadmapId = new URLSearchParams(search).get('roadmap') || undefined;
  switch (route.name) {
    case 'roadmaps': {
      if (roadmapId === undefined) return { ...route, ...(focus === undefined ? {} : { focus }) };
      // A link to the single page this one replaced opens the page that holds its focus. The
      // decision cards' old id named the map; they are now the roadmap's own.
      const moved = focus?.startsWith('architecture-decisions-')
        ? `runtime-evidence-roadmap-${roadmapId}-decisions`
        : focus;
      return {
        name: 'roadmap',
        workspaceId: route.workspaceId,
        roadmapId,
        tab: roadmapTabForFocus(moved),
        ...(moved === undefined ? {} : { focus: moved }),
      };
    }
    case 'roadmap':
    case 'roadmap-map':
      return { ...route, ...(focus === undefined ? {} : { focus }) };
    case 'settings':
      return {
        ...route,
        ...(roadmapId === undefined ? {} : { roadmapId }),
        ...(focus === undefined ? {} : { focus }),
      };
    case 'work-item':
      return { ...route, ...(focus === undefined ? {} : { focus }) };
    default:
      return route;
  }
}

function parsePath(pathname: string): Route {
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
  if (section === 'roadmaps') {
    if (segments[3] === 'maps') {
      const definitionId = decode(segments[4]);
      return definitionId === undefined || segments.length > 5
        ? { name: 'roadmaps', workspaceId }
        : { name: 'roadmap-map', workspaceId, definitionId };
    }
    const roadmapId = decode(segments[3]);
    if (roadmapId === undefined) return { name: 'roadmaps', workspaceId };
    const tab = segments[4];
    return {
      name: 'roadmap',
      workspaceId,
      roadmapId,
      tab: segments.length === 5 && (tab === 'setup' || tab === 'history') ? tab : 'board',
    };
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
  const path = buildPathname(route);
  // Only Settings takes a roadmap in the query; a roadmap's own pages carry it in the path.
  const roadmap =
    route.name === 'settings' && route.roadmapId !== undefined
      ? `?roadmap=${encodeURIComponent(route.roadmapId)}`
      : '';
  const focus =
    'focus' in route && route.focus !== undefined ? `#${encodeURIComponent(route.focus)}` : '';
  return `${path}${roadmap}${focus}`;
}

function buildPathname(route: Route): string {
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
    case 'roadmap':
      return `${workspace(route.workspaceId)}/roadmaps/${encodeURIComponent(route.roadmapId)}${
        route.tab === 'board' ? '' : `/${route.tab}`
      }`;
    case 'roadmap-map':
      return `${workspace(route.workspaceId)}/roadmaps/maps/${encodeURIComponent(route.definitionId)}`;
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
