import { workspaceIdSchema } from '@craftingtable/contracts';
import type { WorkspaceId, WorkspaceRole } from '@craftingtable/domain';
import type { FastifyContextConfig, FastifyInstance, FastifyRequest } from 'fastify';
import { CSRF_HEADER_NAME, type ServerConfig, sessionCookieName } from '../config.js';
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

/** A path parameter's schema (R-H7): a shared contract, applied by the daemon before the handler. */
export type ParamSchema = BodySchema;

/** A route's path parameters (R-H7): each name in its path, with the schema it is parsed with. */
export type RouteParams = Readonly<Record<string, ParamSchema>>;

/** What a declared parameter parses to: its schema's output, a brand for an id. */
type ParsedParam<S> = S extends { safeParse(value: unknown): infer R }
  ? Extract<R, { readonly success: true }> extends { readonly data: infer T }
    ? T
    : never
  : never;

/** A route's parameters as its handler reads them (R-H7): each parsed by its declared schema. */
export type ParamsOf<P extends RouteParams> = { readonly [K in keyof P]: ParsedParam<P[K]> };

/**
 * A workspace route's parameters (R-H7): its workspace's id, which the access check parses with
 * `workspaceIdSchema` before the body is read, and the route's own.
 */
export function workspaceParams<const P extends RouteParams>(
  params: P,
): { readonly workspaceId: typeof workspaceIdSchema } & P {
  return { workspaceId: workspaceIdSchema, ...params };
}

/** The parameters of a workspace route that takes no other (R-H7). */
export const WORKSPACE_PARAMS = workspaceParams({});

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
    /**
     * Every path parameter's schema, by its name in the path (R-H7). The daemon parses each once,
     * before anything reads it, and the handler reads the parsed values with `paramsOf`. A
     * workspace route's `workspaceId` is `workspaceIdSchema` (`workspaceParams`): the access check
     * refuses one that does not parse with 404 before the body is read. Any other parameter that
     * does not parse is refused once step-up and the body are settled, where handlers refused it:
     * with 404 and `notFound`, or, with `paramsRefusedAsBody`, as an invalid body.
     */
    readonly params?: RouteParams;
    /** The message of the 404 a parameter that does not parse gets (R-H7); "Resource not found". */
    readonly notFound?: string;
    /**
     * A parameter that does not parse is refused as the body is (400 and `invalidBody`), as the
     * map and supervision commands that read their id with their body refused it (R-H7).
     */
    readonly paramsRefusedAsBody?: true;
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

/** What a route declares beyond its method and URL (R-I3, R-H5, R-H7). */
export type RouteDeclaration = Pick<
  FastifyContextConfig,
  | 'access'
  | 'tag'
  | 'body'
  | 'multipart'
  | 'stepUp'
  | 'stepUpRule'
  | 'invalidBody'
  | 'params'
  | 'notFound'
  | 'paramsRefusedAsBody'
>;

/** The names of a route path's parameters, in order (`:name`, Fastify's syntax). */
export function pathParameters(url: string): readonly string[] {
  return [...url.matchAll(/:([^/(?:.-]+)/g)].map((match) => match[1] ?? '');
}

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
  // R-H7: every path parameter has a declared schema, and nothing else is declared.
  const names = pathParameters(url);
  const declared = Object.keys(declaration.params ?? {});
  const undeclared = names.find((name) => !declared.includes(name));
  if (undeclared !== undefined)
    return `has a path parameter :${undeclared} without a declared schema`;
  const extra = declared.find((name) => !names.includes(name));
  if (extra !== undefined) return `declares a parameter ${extra} its path does not have`;
  if (workspaceRoute && declaration.params?.workspaceId !== workspaceIdSchema)
    return "parses its workspace's id with a schema other than workspaceIdSchema";
  const own = names.filter((name) => !(workspaceRoute && name === 'workspaceId'));
  if (own.length === 0 && (declaration.notFound !== undefined || declaration.paramsRefusedAsBody))
    return 'names a refusal for parameters it does not have';
  if (declaration.paramsRefusedAsBody && declaration.body === undefined)
    return 'refuses a parameter as its body, but has no body';
  if (declaration.paramsRefusedAsBody && declaration.notFound !== undefined)
    return 'names both a 404 and an invalid body for a parameter';
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

/** Each request's parameters as the access check parsed them (R-H7), for `paramsOf`. */
interface ParsedParams {
  readonly declared: RouteParams | undefined;
  readonly values: Readonly<Record<string, unknown>>;
  readonly invalid: boolean;
}
const parsedParams = new WeakMap<FastifyRequest, ParsedParams>();

function parseParams(declared: RouteParams | undefined, raw: unknown): ParsedParams {
  const values: Record<string, unknown> = {};
  let invalid = false;
  for (const [name, schema] of Object.entries(declared ?? {})) {
    const parsed = schema.safeParse(
      typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>)[name] : undefined,
    );
    if (parsed.success) values[name] = parsed.data;
    else invalid = true;
  }
  return { declared, values, invalid };
}

/**
 * A handler's path parameters (R-H7): what the daemon parsed with the schemas its route declares,
 * read with that declaration. Handlers never read `request.params`. A declaration other than its
 * route's, or parameters that did not parse (the daemon refused them first), are a fault.
 */
export function paramsOf<P extends RouteParams>(request: FastifyRequest, declared: P): ParamsOf<P> {
  const parsed = parsedParamsOf(request, declared);
  if (parsed === undefined)
    throw new Error("Read a route's parameters with the declaration it registered (R-H7).");
  return parsed;
}

/**
 * The parsed parameters for a step-up rule (R-H7), which runs before a parameter that did not
 * parse is refused: undefined then, as a lookup of the text as sent would have found nothing.
 */
export function parsedParamsOf<P extends RouteParams>(
  request: FastifyRequest,
  declared: P,
): ParamsOf<P> | undefined {
  const parsed = parsedParams.get(request);
  if (parsed === undefined || parsed.declared !== declared)
    throw new Error("Read a route's parameters with the declaration it registered (R-H7).");
  return parsed.invalid ? undefined : (parsed.values as ParamsOf<P>);
}

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
    const route = request.routeOptions.config;
    const access = route?.access;
    if (access === undefined) return;
    // R-H7: every path parameter is parsed here, once, with the schema its route declares.
    const params = parseParams(route.params, request.params);
    parsedParams.set(request, params);
    if (access === 'public') return;
    const context = isMutation(request.method)
      ? authorizeMutation(request, auth, config)
      : authenticate(request, auth, config);
    request.auth = context;
    if (access === 'session') return;
    const workspaceId = params.values.workspaceId as WorkspaceId | undefined;
    if (workspaceId === undefined) throw new NotFoundError();
    workspaces.requireRole(context, workspaceId, ROUTE_ACCESS_ROLES[access], {
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
  // Then a path parameter that did not parse is refused (R-H7), after the body, where handlers
  // refused it: 404 with the route's message, or 400 as an invalid body where a route read its id
  // with its body.
  app.addHook('preValidation', async (request, reply) => {
    if (parsedParams.get(request)?.invalid !== true) return;
    const config = request.routeOptions.config;
    return config?.paramsRefusedAsBody
      ? sendApiError(reply, 400, 'invalid-request', config.invalidBody ?? 'Invalid request')
      : sendApiError(reply, 404, 'not-found', config?.notFound ?? 'Resource not found');
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
function authenticate(
  request: FastifyRequest,
  authService: AuthService,
  config: ServerConfig,
): AuthContext {
  return authService.authenticate(request.cookies[sessionCookieName(config)]);
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
  const context = authenticate(request, authService, config);
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
