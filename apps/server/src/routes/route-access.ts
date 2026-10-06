import { workspaceIdSchema } from '@craftingtable/contracts';
import type { WorkspaceRole } from '@craftingtable/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME, type ServerConfig } from '../config.js';
import { csrfTokensEqual } from '../security/csrf.js';
import { isAllowedBrowserRequest } from '../security/origin-policy.js';
import type { AuthContext, AuthService } from '../services/auth-service.js';
import {
  ForbiddenError,
  NotFoundError,
  StepUpRequiredError,
  UnauthenticatedError,
} from '../services/errors.js';
import type { WorkspaceService } from '../services/workspace-service.js';
import { browserHeaders } from './request-security.js';

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
    /**
     * Whether a command with this body needs the operator's password again (R-G9), beyond the
     * unrestricted permission mode every command is checked for: final promotion.
     */
    readonly stepUp?: (body: unknown) => boolean;
  }
  interface FastifyRequest {
    /** The signed-in caller, attached by the access guard to every non-public route (R-G9). */
    auth?: AuthContext;
  }
}

/**
 * The caller of a route that declared any access but `public`: the guard authenticated it (and,
 * for a mutation, checked its CSRF token and origin) before the body was read, and attached it.
 * Handlers read it here and never authenticate again (R-G9, QA-03).
 */
export function contextOf(request: FastifyRequest): AuthContext {
  if (request.auth === undefined) throw new UnauthenticatedError();
  return request.auth;
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
 * request then passes the declared check before its body is parsed or its handler validates
 * input, so an outsider learns nothing from parse or validation errors. Handlers keep their
 * own checks.
 */
export function installRouteAccess(
  app: FastifyInstance,
  auth: AuthService,
  workspaces: WorkspaceService,
  config: ServerConfig,
): void {
  const declared = new Map<string, RouteAccess>();
  declarations.set(app, declared);
  app.decorateRequest('auth', undefined);
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
  // preParsing runs after every onRequest hook (the cookie parser's included) and before the
  // body is read, so an outsider is refused before the daemon buffers or parses its input.
  app.addHook('preParsing', async (request) => {
    const access = request.routeOptions.config?.access;
    if (access === undefined || access === 'public') return;
    const context = isMutation(request.method)
      ? authorizeMutation(request, auth, config)
      : authenticate(request, auth);
    request.auth = context;
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
  // Once the body is parsed, and the caller is known to be allowed the route: a command that
  // grants an agent unrestricted permissions, or that a route declares (final promotion), needs
  // the session to have given its password again recently (R-G9; operator decision 2026-10-05).
  app.addHook('preValidation', async (request) => {
    if (request.auth === undefined || !isMutation(request.method)) return;
    const declared = request.routeOptions.config?.stepUp?.(request.body) ?? false;
    if ((declared || grantsUnrestricted(request.body)) && !auth.isSteppedUp(request.auth))
      throw new StepUpRequiredError();
  });
}

/** Whether a body sets `permissionMode: 'unrestricted'` anywhere in it (R-G9). */
export function grantsUnrestricted(body: unknown, depth = 0): boolean {
  if (depth > 32 || body === null || typeof body !== 'object') return false;
  if (Array.isArray(body)) return body.some((value) => grantsUnrestricted(value, depth + 1));
  return Object.entries(body).some(
    ([key, value]) =>
      (key === 'permissionMode' && value === 'unrestricted') ||
      grantsUnrestricted(value, depth + 1),
  );
}

// The guard alone authenticates: handlers read what it attached, with `contextOf` (R-G9).
function authenticate(request: FastifyRequest, authService: AuthService): AuthContext {
  return authService.authenticate(request.cookies[SESSION_COOKIE_NAME]);
}

/**
 * Authenticates, then requires a session-bound CSRF token and an allowed
 * origin. Authentication runs first so an unauthenticated request always
 * receives 401 regardless of its other headers (CT-02 finding F5).
 */
function authorizeMutation(
  request: FastifyRequest,
  authService: AuthService,
  config: ServerConfig,
): AuthContext {
  const context = authenticate(request, authService);
  const csrf = request.headers[CSRF_HEADER_NAME];
  if (
    typeof csrf !== 'string' ||
    !csrfTokensEqual(context.session.csrfToken, csrf) ||
    !isAllowedBrowserRequest(browserHeaders(request), config.publicOrigin)
  ) {
    throw new ForbiddenError();
  }
  return context;
}
