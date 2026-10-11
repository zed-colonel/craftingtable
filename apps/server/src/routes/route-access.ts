import { workspaceIdSchema } from '@craftingtable/contracts';
import type { WorkspaceRole } from '@craftingtable/domain';
import type { FastifyContextConfig, FastifyInstance, FastifyRequest } from 'fastify';
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
import { sendApiError } from './http.js';
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

/**
 * What a route does (R-H5, H5-4; R-A6's A1): a GET is a `read`; a command is a `decision` (it
 * resolves an operator decision, posted from one decision component in the browser), a
 * `control` (it acts on work in progress or on the session) or `config` (settings, imports and
 * definitions: what the daemon does later).
 */
export type RouteTag = 'read' | 'decision' | 'control' | 'config';

/** The parsed value of a declared body schema, for a route's `Body` type (R-H5). */
export type BodyOf<S> = S extends { parse(value: unknown): infer T } ? T : never;

/** A command's body schema (R-H5): a shared contract, applied by the daemon before the handler. */
export interface BodySchema {
  safeParse(value: unknown):
    | { readonly success: true; readonly data: unknown }
    | {
        readonly success: false;
      };
}

declare module 'fastify' {
  interface FastifyContextConfig {
    readonly access?: RouteAccess;
    /** Every command's tag (R-H5); a GET is a `read` without declaring one. */
    readonly tag?: Exclude<RouteTag, 'read'>;
    /**
     * Every command's body (R-H5): once the caller is admitted, the daemon parses the body (an
     * absent one as `{}`) with it and hands the handler the parsed value, or refuses with 400 and
     * `invalidBody`. A multipart upload's text fields are parsed with it by its reader instead.
     */
    readonly body?: BodySchema;
    readonly invalidBody?: string;
    readonly multipart?: true;
    /** The route's own step-up rule, in words, for the route inventory (R-H5); with `stepUp`. */
    readonly stepUpRule?: string;
    /**
     * Whether a command needs the operator's password again (R-G9), beyond the unrestricted
     * permission mode every body is checked for: final promotion, a merge into a repository's
     * default branch, or agent work under stored settings that grant unrestricted. Called after
     * the caller's access is checked; it may read what the route names.
     */
    readonly stepUp?: (body: unknown, request: FastifyRequest) => boolean;
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

/**
 * A multipart route's declared field schema and refusal (R-H5), for its upload reader, which parses
 * the text fields with it once the parts are read.
 */
export function declaredBody(request: FastifyRequest): {
  readonly schema: BodySchema;
  readonly invalid: string;
} {
  const config = request.routeOptions.config;
  if (config?.body === undefined) throw new Error('This route declares no body schema (R-H5).');
  return { schema: config.body, invalid: config.invalidBody ?? 'Invalid request' };
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

/** What a route declares beyond its method and URL (R-I3, R-H5). */
export type RouteDeclaration = Pick<
  FastifyContextConfig,
  'access' | 'tag' | 'body' | 'multipart' | 'stepUp' | 'stepUpRule' | 'invalidBody'
>;

/** Why a route's declaration is refused, or undefined when it is acceptable. */
export function routeAccessProblem(
  methods: readonly string[],
  url: string,
  access: RouteAccess | undefined,
  declaration?: RouteDeclaration,
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
  // R-H5: a command says what it is and what body it takes; a read takes neither.
  if (declaration === undefined) return undefined;
  if (methods.some(isMutation)) {
    if (declaration.tag === undefined)
      return 'is a command without a decision, control or config tag';
    if (declaration.body === undefined) return 'is a command without a body schema';
  } else if (
    declaration.tag !== undefined ||
    declaration.body !== undefined ||
    declaration.multipart !== undefined
  )
    return 'is a read, which takes no tag or body';
  if ((declaration.stepUp === undefined) !== (declaration.stepUpRule === undefined))
    return 'declares a step-up without its rule in words, or a rule without a step-up';
  return undefined;
}

/** One API route as it is registered: the source of the route inventory (R-H5). */
export interface DeclaredRoute extends Omit<RouteDeclaration, 'tag'> {
  readonly method: string;
  readonly url: string;
  readonly access: RouteAccess;
  readonly tag: RouteTag;
}

const declarations = new WeakMap<FastifyInstance, Map<string, DeclaredRoute>>();

/** Each API route's declared access, keyed `METHOD url`, as registered on this app. */
export function declaredRouteAccess(app: FastifyInstance): ReadonlyMap<string, RouteAccess> {
  return new Map([...declaredRoutes(app)].map(([key, route]) => [key, route.access]));
}

/** Each API route's whole declaration, keyed `METHOD url`, as registered on this app (R-H5). */
export function declaredRoutes(app: FastifyInstance): ReadonlyMap<string, DeclaredRoute> {
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
  const declared = new Map<string, DeclaredRoute>();
  declarations.set(app, declared);
  app.decorateRequest('auth', undefined);
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/api/')) return;
    const methods = [route.method].flat();
    const config: RouteDeclaration = route.config ?? {};
    const access = config.access;
    const problem = routeAccessProblem(methods, route.url, access, config);
    if (problem !== undefined || access === undefined)
      throw new Error(`Route ${methods.join(',')} ${route.url} ${problem} (R-I3, R-H5).`);
    for (const method of methods)
      if (method !== 'HEAD')
        declared.set(`${method} ${route.url}`, {
          ...config,
          method,
          url: route.url,
          access,
          tag: config.tag ?? 'read',
        });
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
    const declared = request.routeOptions.config?.stepUp?.(request.body, request) ?? false;
    if ((declared || grantsUnrestricted(request.body)) && !auth.isSteppedUp(request.auth))
      throw new StepUpRequiredError();
  });
  // Then every command's body is parsed with the schema its route declares (R-H5), so no handler
  // reads a body it did not declare. Step-up above reads the body as sent.
  app.addHook('preValidation', async (request, reply) => {
    const config = request.routeOptions.config;
    if (!isMutation(request.method) || config?.body === undefined || config.multipart) return;
    const parsed = config.body.safeParse(request.body ?? {});
    if (!parsed.success)
      return sendApiError(reply, 400, 'invalid-request', config.invalidBody ?? 'Invalid request');
    request.body = parsed.data;
  });
}

/** The control actions that start no agent work: they never need step-up. */
const IDLE_ACTIONS: ReadonlySet<unknown> = new Set(['pause', 'stop', 'abandon']);

/**
 * A control route's step-up (R-G9 review): an action that starts or resumes agent work needs the
 * password again when the stored record it works under grants unrestricted anywhere, since that
 * work runs under the stored settings, whatever the body says.
 */
export function stepUpForStoredWork(
  stored: (request: FastifyRequest) => unknown,
): (body: unknown, request: FastifyRequest) => boolean {
  return (body, request) => {
    const action =
      typeof body === 'object' && body !== null ? (body as { action?: unknown }).action : undefined;
    return !IDLE_ACTIONS.has(action) && grantsUnrestricted(stored(request));
  };
}

/**
 * Whether a body sets `permissionMode: 'unrestricted'` anywhere in it (R-G9), or a step's mode to
 * `unrestricted` in a `permissions` record, the shape a roadmap's settings save sends (R-E5b).
 */
export function grantsUnrestricted(body: unknown, depth = 0): boolean {
  if (depth > 32 || body === null || typeof body !== 'object') return false;
  if (Array.isArray(body)) return body.some((value) => grantsUnrestricted(value, depth + 1));
  return Object.entries(body).some(
    ([key, value]) =>
      (key === 'permissionMode' && value === 'unrestricted') ||
      (key === 'permissions' &&
        typeof value === 'object' &&
        value !== null &&
        Object.values(value).includes('unrestricted')) ||
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
