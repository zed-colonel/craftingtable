import { workspaceIdSchema } from '@craftingtable/contracts';
import type { WorkspaceRole } from '@craftingtable/domain';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import { ForbiddenError, NotFoundError } from '../services/errors.js';
import type { WorkspaceService } from '../services/workspace-service.js';
import { authenticate, authorizeMutation } from './request-security.js';

/**
 * Every API route declares who may call it (R-I3, SEC-05):
 * - `public`: no session (health, login).
 * - `session`: any signed-in user, outside a workspace.
 * - `member`, `editor`, `owner`: the least workspace role the route admits, for routes under
 *   `/api/workspaces/:workspaceId/`.
 * - `installation`: host-level settings, for the user who owns every active workspace.
 * A route that is not a GET is a mutation and also needs the CSRF token and an allowed origin.
 */
export type RouteAccess = 'public' | 'session' | 'member' | 'editor' | 'owner' | 'installation';

declare module 'fastify' {
  interface FastifyContextConfig {
    readonly access?: RouteAccess;
  }
}

export const ROUTE_ACCESS_ROLES: Readonly<
  Record<'member' | 'editor' | 'owner' | 'installation', readonly WorkspaceRole[]>
> = {
  member: ['owner', 'editor', 'viewer'],
  editor: ['owner', 'editor'],
  owner: ['owner'],
  installation: ['owner'],
};

const WORKSPACE_PREFIX = '/api/workspaces/:workspaceId/';

function isMutation(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD';
}

/** Why a route's declaration is refused, or undefined when it is acceptable. */
export function routeAccessProblem(
  methods: readonly string[],
  url: string,
  access: RouteAccess | undefined,
): string | undefined {
  if (access === undefined) return 'declares no access';
  const workspaceRoute = url.startsWith(WORKSPACE_PREFIX);
  if (workspaceRoute && (access === 'public' || access === 'session'))
    return `is workspace-scoped but declares ${access} access`;
  if (!workspaceRoute && access !== 'public' && access !== 'session')
    return `is not workspace-scoped but declares ${access} access`;
  if (access === 'member' && methods.some(isMutation))
    return 'is a workspace mutation, which a viewer may not perform';
  if (access === 'public' && methods.some(isMutation) && url !== '/api/auth/login')
    return 'is a mutation, which needs a session';
  return undefined;
}

const declarations = new WeakMap<FastifyInstance, Map<string, RouteAccess>>();

/** Each API route's declared access, keyed `METHOD url`, as registered on this app. */
export function declaredRouteAccess(app: FastifyInstance): ReadonlyMap<string, RouteAccess> {
  return declarations.get(app) ?? new Map();
}

/**
 * Installs the default-deny access check for the API. It must run before any route is
 * registered: a route without an acceptable declaration stops the daemon from starting. Each
 * request then passes the declared check before its handler validates input, so an outsider
 * learns nothing from validation errors. Handlers keep their own checks.
 */
export function installRouteAccess(
  app: FastifyInstance,
  auth: AuthService,
  workspaces: WorkspaceService,
  config: ServerConfig,
): void {
  const declared = new Map<string, RouteAccess>();
  declarations.set(app, declared);
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/')) return;
    const methods = [route.method].flat();
    const access = route.config?.access;
    const problem = routeAccessProblem(methods, route.url, access);
    if (problem !== undefined || access === undefined)
      throw new Error(`Route ${methods.join(',')} ${route.url} ${problem} (R-I3).`);
    for (const method of methods)
      if (method !== 'HEAD') declared.set(`${method} ${route.url}`, access);
  });
  app.addHook('preHandler', async (request) => {
    const access = request.routeOptions.config?.access;
    if (access === undefined || access === 'public') return;
    const context = isMutation(request.method)
      ? authorizeMutation(request, auth, config)
      : authenticate(request, auth);
    if (access === 'session') return;
    const workspaceId = workspaceIdSchema.safeParse(
      (request.params as { readonly workspaceId?: unknown }).workspaceId,
    );
    if (!workspaceId.success) throw new NotFoundError();
    workspaces.requireRole(context, workspaceId.data, ROUTE_ACCESS_ROLES[access], {
      requestId: request.id,
    });
    if (access === 'installation' && !workspaces.ownsInstallation(context))
      throw new ForbiddenError();
  });
}
