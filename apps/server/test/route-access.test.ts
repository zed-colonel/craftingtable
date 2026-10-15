import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  asUserId,
  asWorkspaceId,
  asWorkspaceMembershipId,
  type WorkspaceId,
  type WorkspaceRole,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from '../src/config.js';
import type { FastifyRequest } from 'fastify';
import {
  contextOf,
  declaredRouteAccess,
  declaredRoutes,
  paramsOf,
  parsedParamsOf,
  type RouteAccess,
  routeAccessProblem,
  WORKSPACE_PARAMS,
  workspaceParams,
} from '../src/routes/route-access.js';
import { UnauthenticatedError } from '../src/services/errors.js';
import { createTestContext, routeTable, TEST_USERNAME, type TestContext } from './test-support.js';

/**
 * The authorization sweep (R-I3, QA-03, SEC-05). Every route in the live route table is
 * requested as each kind of caller, and the response must match the access the route declares:
 * no session gets 401; a mutation without the CSRF token or from another origin gets 403; a user
 * who is not a member of the workspace gets 404; a member below the declared role gets 403, and
 * a member at the declared role is not refused.
 */

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

const PASSWORD = 'another correct horse battery';
const at = '2026-09-24T00:00:00.000Z';

interface Caller {
  readonly cookie: string;
  readonly csrfToken: string;
}

async function sweepFixture() {
  const context = await createTestContext({ workers: false });
  contexts.push(context);
  await context.bootstrap();
  const owner = context.storage.users.findByNormalizedUsername(TEST_USERNAME);
  if (owner === undefined) throw new Error('bootstrap user missing');
  const workspaceId = context.storage.workspaces.listAuthorized(owner.id)[0]?.workspace.id;
  if (workspaceId === undefined) throw new Error('default workspace missing');
  const foreignWorkspaceId = asWorkspaceId(randomUUID());
  const passwordHash = `$argon2id$test$${Buffer.from(PASSWORD).toString('base64url')}`;
  const member = (username: string, workspace: WorkspaceId, role: WorkspaceRole) => {
    const id = asUserId(`${username}-id`);
    context.storage.users.insert({
      id,
      username,
      usernameNormalized: username,
      passwordHash,
      occurredAt: at,
    });
    if (workspace === foreignWorkspaceId)
      context.storage.workspaces.insert({
        id: foreignWorkspaceId,
        name: 'Someone else’s workspace',
        slug: 'foreign',
        createdByUserId: id,
        occurredAt: at,
      });
    context.storage.workspaces.insertMembership({
      id: asWorkspaceMembershipId(`${username}-membership`),
      workspaceId: workspace,
      userId: id,
      role,
      occurredAt: at,
    });
  };
  // A second owner signs in afresh for every request, so logout, revocation and password
  // routes cannot end the session another check relies on.
  member('second-owner', workspaceId, 'owner');
  member('editor', workspaceId, 'editor');
  member('viewer', workspaceId, 'viewer');
  member('outsider', foreignWorkspaceId, 'owner');
  // Owns every active workspace, so it owns the installation (host-level settings).
  member('installer', workspaceId, 'owner');
  context.storage.workspaces.insertMembership({
    id: asWorkspaceMembershipId('installer-foreign-membership'),
    workspaceId: foreignWorkspaceId,
    userId: asUserId('installer-id'),
    role: 'owner',
    occurredAt: at,
  });
  const signIn = async (username: string): Promise<Caller> => {
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: context.config.publicOrigin, 'content-type': 'application/json' },
      payload: { username, password: PASSWORD },
    });
    expect(response.statusCode, response.body).toBe(200);
    const setCookie = response.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(';')[0];
    if (!cookie?.startsWith(`${SESSION_COOKIE_NAME}=`)) throw new Error('No session cookie');
    return { cookie, csrfToken: (response.json() as { csrfToken: string }).csrfToken };
  };
  await context.app.ready();
  return { context, workspaceId, foreignWorkspaceId, signIn };
}

type Fixture = Awaited<ReturnType<typeof sweepFixture>>;

function request(
  f: Fixture,
  route: { readonly method: string; readonly url: string },
  options: {
    readonly caller?: Caller;
    readonly workspaceId?: WorkspaceId;
    readonly csrf?: boolean;
    readonly origin?: string;
    /** A raw body; outsiders send one that is not JSON, to show they are refused before parsing. */
    readonly body?: string;
  },
) {
  const url = route.url
    .replace(':workspaceId', options.workspaceId ?? f.workspaceId)
    .replace(/:[A-Za-z]+/g, () => randomUUID());
  return f.context.app.inject({
    method: route.method as 'GET' | 'POST',
    url,
    headers: {
      origin: options.origin ?? f.context.config.publicOrigin,
      'content-type': 'application/json',
      ...(options.caller ? { cookie: options.caller.cookie } : {}),
      ...(options.caller && options.csrf !== false
        ? { [CSRF_HEADER_NAME]: options.caller.csrfToken }
        : {}),
    },
    ...(route.method === 'GET' ? {} : { payload: options.body ?? {} }),
  });
}

/** An API error's typed reason, if the body carries one. */
function reasonOf(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: { reason?: string } }).error?.reason;
  } catch {
    return undefined;
  }
}

/** Routes that stream until the client leaves; only their refusals are requested. */
const streaming = (url: string) => url.endsWith('/events');

const BELOW: Readonly<Record<RouteAccess, readonly string[]>> = {
  public: [],
  session: [],
  member: [],
  editor: ['viewer'],
  owner: ['viewer', 'editor'],
  // The second owner owns only this workspace, not the installation.
  installation: ['viewer', 'editor', 'second-owner'],
};
const AT: Readonly<Record<RouteAccess, string | undefined>> = {
  public: undefined,
  session: undefined,
  member: 'viewer',
  editor: 'editor',
  owner: 'second-owner',
  installation: 'installer',
};

describe('route authorization sweep', () => {
  it('gives every API route an access declaration', async () => {
    const f = await sweepFixture();
    const routes = routeTable(f.context.app.printRoutes({ commonPrefix: false })).filter(
      (r) => r.startsWith('GET /api/') || r.startsWith('POST /api/'),
    );
    const declared = declaredRouteAccess(f.context.app);
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.filter((route) => !declared.has(route))).toEqual([]);
    expect([...declared.keys()].toSorted()).toEqual(routes.toSorted());
  });

  it('refuses to register a route without an acceptable declaration', async () => {
    const context = await createTestContext({ workers: false });
    contexts.push(context);
    const handler = async () => ({});
    expect(() => context.app.get('/api/workspaces/:workspaceId/undeclared', handler)).toThrow(
      /declares no access/,
    );
    expect(() =>
      context.app.post(
        '/api/workspaces/:workspaceId/viewer-write',
        { config: { access: 'member' } },
        handler,
      ),
    ).toThrow(/viewer may not perform/);
    expect(() =>
      context.app.post('/api/open-write', { config: { access: 'public' } }, handler),
    ).toThrow(/needs a session/);
    expect(() =>
      context.app.get('/api/workspaces/:workspaceId/x', { config: { access: 'session' } }, handler),
    ).toThrow(/workspace-scoped/);
    expect(routeAccessProblem(['GET'], '/api/workspaces/:workspaceId/x', 'member')).toBeUndefined();
  });

  it('refuses a command without a tag or a body schema, and a read with either (R-H5)', async () => {
    const context = await createTestContext({ workers: false });
    contexts.push(context);
    const handler = async () => ({});
    const body = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };
    const url = '/api/workspaces/:workspaceId/r-h5';
    expect(() => context.app.post(url, { config: { access: 'editor', body } }, handler)).toThrow(
      /without a decision, control or config tag/,
    );
    expect(() =>
      context.app.post(url, { config: { access: 'editor', tag: 'control' } }, handler),
    ).toThrow(/without a body schema/);
    expect(() =>
      context.app.get(url, { config: { access: 'member', tag: 'config' } }, handler),
    ).toThrow(/is a read, which takes no tag or body/);
    expect(() => context.app.get(url, { config: { access: 'member', body } }, handler)).toThrow(
      /is a read/,
    );
    expect(() =>
      context.app.post(
        url,
        { config: { access: 'editor', tag: 'control', body, stepUp: () => true } },
        handler,
      ),
    ).toThrow(/without its rule in words/);
    expect(() =>
      context.app.post(
        `${url}/declared`,
        {
          config: {
            access: 'editor',
            tag: 'control',
            params: WORKSPACE_PARAMS,
            body,
            stepUpRule: 'always',
            stepUp: () => true,
          },
        },
        handler,
      ),
    ).not.toThrow();
  });

  it("parses every command's body with its declared schema before the handler (R-H5)", async () => {
    const context = await createTestContext({ workers: false });
    contexts.push(context);
    await context.bootstrap();
    const seen: unknown[] = [];
    const seenRaw: unknown[] = [];
    const body = {
      safeParse: (value: unknown) => {
        seenRaw.push(value);
        return typeof value === 'object' && value !== null && 'n' in value
          ? { success: true as const, data: { n: Number((value as { n: unknown }).n) + 1 } }
          : { success: false as const };
      },
    };
    context.app.post(
      '/api/workspaces/:workspaceId/r-h5-parsed',
      {
        config: {
          access: 'editor',
          tag: 'control',
          params: WORKSPACE_PARAMS,
          body,
          invalidBody: 'Name n.',
        },
      },
      async (request) => {
        seen.push(request.body);
        return { ok: true };
      },
    );
    const session = await context.login();
    const workspaceId = context.storage.workspaces.listAuthorized(
      context.storage.users.findByNormalizedUsername(TEST_USERNAME)!.id,
    )[0]!.workspace.id;
    const send = (payload: unknown) =>
      context.app.inject({
        method: 'POST',
        url: `/api/workspaces/${workspaceId}/r-h5-parsed`,
        headers: {
          cookie: session.cookie,
          [CSRF_HEADER_NAME]: session.csrfToken,
          origin: context.config.publicOrigin,
          'content-type': 'application/json',
        },
        payload: payload as Record<string, unknown>,
      });
    // An absent body is parsed as `{}` (the shape a command without fields takes).
    const bare = await context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/r-h5-parsed`,
      headers: {
        cookie: session.cookie,
        [CSRF_HEADER_NAME]: session.csrfToken,
        origin: context.config.publicOrigin,
      },
    });
    expect(bare.statusCode).toBe(400);
    expect(seenRaw).toEqual([{}]);
    seenRaw.length = 0;
    const refused = await send({ m: 1 });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      error: { code: 'invalid-request', message: 'Name n.' },
    });
    expect(seen).toEqual([]);
    const parsed = await send({ n: 1 });
    expect(parsed.statusCode, parsed.body).toBe(200);
    // The handler reads the schema's output, not the body as sent.
    expect(seen).toEqual([{ n: 2 }]);
  });

  it('refuses a route whose path has a parameter without a declared schema (R-H7)', async () => {
    const context = await createTestContext({ workers: false });
    contexts.push(context);
    const handler = async () => ({});
    const thing = { safeParse: (value: unknown) => ({ success: true as const, data: value }) };
    const url = '/api/workspaces/:workspaceId/r-h7/:thingId';
    expect(() => context.app.get(url, { config: { access: 'member' } }, handler)).toThrow(
      /parameter :workspaceId without a declared schema/,
    );
    expect(() =>
      context.app.get(url, { config: { access: 'member', params: WORKSPACE_PARAMS } }, handler),
    ).toThrow(/parameter :thingId without a declared schema/);
    expect(() =>
      context.app.get(
        '/api/workspaces/:workspaceId/r-h7',
        { config: { access: 'member', params: workspaceParams({ thingId: thing }) } },
        handler,
      ),
    ).toThrow(/declares a parameter thingId its path does not have/);
    // The access check parses the workspace's id, before the body is read, with its one schema.
    expect(() =>
      context.app.get(
        url,
        { config: { access: 'member', params: { workspaceId: thing, thingId: thing } } },
        handler,
      ),
    ).toThrow(/workspace's id with a schema other than workspaceIdSchema/);
    expect(() =>
      context.app.get(
        '/api/workspaces/:workspaceId/r-h7-only',
        { config: { access: 'member', params: WORKSPACE_PARAMS, notFound: 'Thing not found' } },
        handler,
      ),
    ).toThrow(/refusal for parameters it does not have/);
    expect(() =>
      context.app.post(
        '/api/auth/sessions/:sessionId/r-h7',
        { config: { access: 'session', tag: 'control', body: thing } },
        handler,
      ),
    ).toThrow(/parameter :sessionId without a declared schema/);
    expect(() =>
      context.app.get(
        url,
        {
          config: {
            access: 'member',
            params: workspaceParams({ thingId: thing }),
            notFound: 'Thing not found',
          },
        },
        handler,
      ),
    ).not.toThrow();
    expect(() =>
      context.app.post(
        '/api/auth/sessions/:sessionId/r-h7',
        {
          config: { access: 'session', tag: 'control', params: { sessionId: thing }, body: thing },
        },
        handler,
      ),
    ).not.toThrow();
  });

  it('parses every path parameter once, before the handler, and refuses one as its route declares (R-H7)', async () => {
    const context = await createTestContext({ workers: false });
    contexts.push(context);
    await context.bootstrap();
    const parsedSeen: unknown[] = [];
    const thing = {
      safeParse: (value: unknown) => {
        parsedSeen.push(value);
        return typeof value === 'string' && value.startsWith('t-')
          ? { success: true as const, data: `${value}!` }
          : { success: false as const };
      },
    };
    const body = {
      safeParse: (value: unknown) =>
        typeof value === 'object' && value !== null && 'n' in value
          ? { success: true as const, data: value }
          : { success: false as const },
    };
    const THING = workspaceParams({ thingId: thing });
    const handled: unknown[] = [];
    const steppedUp: unknown[] = [];
    context.app.get(
      '/api/workspaces/:workspaceId/r-h7/:thingId',
      { config: { access: 'member', params: THING, notFound: 'Thing not found' } },
      async (request) => {
        handled.push(paramsOf(request, THING));
        return { ok: true };
      },
    );
    context.app.post(
      '/api/workspaces/:workspaceId/r-h7/:thingId',
      {
        config: {
          access: 'editor',
          tag: 'control',
          params: THING,
          notFound: 'Thing not found',
          body,
          invalidBody: 'Name n.',
          stepUpRule: 'never, but it reads the parameters',
          stepUp: (_body, request) => {
            steppedUp.push(parsedParamsOf(request, THING));
            return false;
          },
        },
      },
      async (request) => {
        handled.push(paramsOf(request, THING));
        return { ok: true };
      },
    );
    // A public route's parameters are parsed like any other's, before the access check returns.
    const PUBLIC = { thingId: thing };
    context.app.get(
      '/api/r-h7-public/:thingId',
      { config: { access: 'public', params: PUBLIC } },
      async (request) => {
        handled.push(paramsOf(request, PUBLIC));
        return { ok: true };
      },
    );
    context.app.get(
      '/api/workspaces/:workspaceId/r-h7-other/:thingId',
      { config: { access: 'member', params: THING } },
      // Reads a declaration other than its route's: refused, not silently trusted.
      async (request) => paramsOf(request, workspaceParams({ thingId: thing })),
    );
    const session = await context.login();
    const workspaceId = context.storage.workspaces.listAuthorized(
      context.storage.users.findByNormalizedUsername(TEST_USERNAME)!.id,
    )[0]!.workspace.id;
    const headers = {
      cookie: session.cookie,
      [CSRF_HEADER_NAME]: session.csrfToken,
      origin: context.config.publicOrigin,
      'content-type': 'application/json',
    };
    const get = (path: string) =>
      context.app.inject({ method: 'GET', url: `/api/workspaces/${path}`, headers });
    const post = (path: string, payload: Record<string, unknown>) =>
      context.app.inject({ method: 'POST', url: `/api/workspaces/${path}`, headers, payload });

    // The handler reads the schema's output, branded or transformed, never the text as sent.
    const read = await get(`${workspaceId}/r-h7/t-1`);
    expect(read.statusCode, read.body).toBe(200);
    expect(handled).toEqual([{ workspaceId, thingId: 't-1!' }]);
    expect(parsedSeen).toEqual(['t-1']);
    // A parameter that does not parse is refused before the handler, with the route's message.
    const missing = await get(`${workspaceId}/r-h7/x-1`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: { code: 'not-found', message: 'Thing not found' } });
    // A workspace id that does not parse is refused by the access check, before anything else.
    const noWorkspace = await get('%20w/r-h7/t-1');
    expect(noWorkspace.statusCode).toBe(404);
    expect(noWorkspace.json()).toEqual({
      error: { code: 'not-found', message: 'Resource not found' },
    });
    expect(handled).toHaveLength(1);

    // A command: step-up reads the parsed parameters (or none), then the body is refused before a
    // parameter, as handlers refused them after the body was parsed.
    const bothWrong = await post(`${workspaceId}/r-h7/x-1`, { m: 1 });
    expect(bothWrong.statusCode).toBe(400);
    expect(bothWrong.json()).toEqual({ error: { code: 'invalid-request', message: 'Name n.' } });
    const idWrong = await post(`${workspaceId}/r-h7/x-1`, { n: 1 });
    expect(idWrong.statusCode).toBe(404);
    expect(idWrong.json()).toEqual({ error: { code: 'not-found', message: 'Thing not found' } });
    const right = await post(`${workspaceId}/r-h7/t-2`, { n: 1 });
    expect(right.statusCode, right.body).toBe(200);
    expect(steppedUp).toEqual([undefined, undefined, { workspaceId, thingId: 't-2!' }]);
    expect(handled).toEqual([
      { workspaceId, thingId: 't-1!' },
      { workspaceId, thingId: 't-2!' },
    ]);
    expect(handled).toHaveLength(2);
    // Each parameter was parsed once per request.
    expect(parsedSeen).toEqual(['t-1', 'x-1', 't-1', 'x-1', 'x-1', 't-2']);

    const other = await get(`${workspaceId}/r-h7-other/t-3`);
    expect(other.statusCode).toBe(500);
    const open = await context.app.inject({ method: 'GET', url: '/api/r-h7-public/t-4' });
    expect(open.statusCode, open.body).toBe(200);
    expect(handled.at(-1)).toEqual({ thingId: 't-4!' });
    const openRefused = await context.app.inject({ method: 'GET', url: '/api/r-h7-public/x-4' });
    expect(openRefused.statusCode).toBe(404);
    expect(openRefused.json()).toEqual({
      error: { code: 'not-found', message: 'Resource not found' },
    });
  });

  it('checks sign-in origin and media type before reading the body (R-H5)', async () => {
    const context = await createTestContext({ workers: false });
    contexts.push(context);
    await context.bootstrap();
    const signIn = (headers: Record<string, string>, payload: string) =>
      context.app.inject({ method: 'POST', url: '/api/auth/login', headers, payload });
    const text = await signIn(
      { origin: context.config.publicOrigin, 'content-type': 'text/plain' },
      'username=x',
    );
    expect(text.statusCode).toBe(400);
    expect(text.json()).toMatchObject({
      error: { code: 'invalid-request', message: 'Invalid authentication request' },
    });
    const foreign = await signIn(
      { origin: 'http://attacker.invalid', 'content-type': 'text/plain' },
      'username=x',
    );
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.message).toContain('Sign-in is only allowed from');
  });

  it('answers each kind of caller as every route declares', async () => {
    const f = await sweepFixture();
    const failures: string[] = [];
    const check = (route: string, label: string, actual: number, ok: boolean, body: string) => {
      if (!ok) failures.push(`${route}: ${label} got ${actual} ${body.slice(0, 120)}`);
    };
    for (const [key, access] of declaredRouteAccess(f.context.app)) {
      const [method, url] = key.split(' ') as [string, string];
      const route = { method, url };
      const mutation = method !== 'GET';
      if (access === 'public') {
        const open = await request(f, route, {});
        check(key, 'no session', open.statusCode, open.statusCode !== 401, open.body);
        continue;
      }
      const anonymous = await request(f, route, { body: '{not json' });
      check(key, 'no session', anonymous.statusCode, anonymous.statusCode === 401, anonymous.body);
      if (mutation) {
        const noCsrf = await request(f, route, {
          caller: await f.signIn('second-owner'),
          csrf: false,
        });
        check(key, 'no CSRF token', noCsrf.statusCode, noCsrf.statusCode === 403, noCsrf.body);
        const crossOrigin = await request(f, route, {
          caller: await f.signIn('second-owner'),
          origin: 'http://attacker.invalid',
        });
        check(
          key,
          'another origin',
          crossOrigin.statusCode,
          crossOrigin.statusCode === 403,
          crossOrigin.body,
        );
      }
      if (access === 'session') continue;
      const outsider = await request(f, route, {
        caller: await f.signIn('second-owner'),
        workspaceId: f.foreignWorkspaceId,
        body: '{not json',
      });
      check(key, 'non-member', outsider.statusCode, outsider.statusCode === 404, outsider.body);
      for (const role of BELOW[access]) {
        const below = await request(f, route, { caller: await f.signIn(role) });
        // Refused for the role, before any step-up is asked (R-B11 review F14).
        check(
          key,
          role,
          below.statusCode,
          below.statusCode === 403 && reasonOf(below.body) !== 'step-up-required',
          below.body,
        );
      }
      const at = AT[access];
      if (at !== undefined && !streaming(url)) {
        const admitted = await request(f, route, { caller: await f.signIn(at) });
        // A route that declares step-up admits the role, then asks for the password (R-B11).
        const steppingUp =
          admitted.statusCode === 403 &&
          reasonOf(admitted.body) === 'step-up-required' &&
          declaredRoutes(f.context.app).get(key)?.stepUp !== undefined;
        check(
          key,
          `${at} (admitted)`,
          admitted.statusCode,
          steppingUp || ![401, 403].includes(admitted.statusCode),
          admitted.body,
        );
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('operator wait read', () => {
  it('serves any member, hides the workspace from others and needs a session', async () => {
    const f = await sweepFixture();
    const route = { method: 'GET', url: '/api/workspaces/:workspaceId/operator-wait' };
    expect((await request(f, route, {})).statusCode).toBe(401);
    const viewer = await request(f, route, { caller: await f.signIn('viewer') });
    expect(viewer.statusCode, viewer.body).toBe(200);
    expect(viewer.json()).toMatchObject({ waitingHours: expect.any(Number) });
    const outsider = await request(f, route, {
      caller: await f.signIn('outsider'),
      workspaceId: f.workspaceId,
    });
    expect(outsider.statusCode, outsider.body).toBe(404);
  });
});

// R-G9: the guard authenticates once, before the body is read, and attaches the caller; a handler
// reads it with `contextOf` and never authenticates again.
describe('the authenticated context (R-G9)', () => {
  it('is what the guard attached, and a request it did not reach has none', () => {
    const auth = { user: { id: 'u' } } as never;
    expect(contextOf({ auth } as unknown as FastifyRequest)).toBe(auth);
    expect(() => contextOf({} as FastifyRequest)).toThrow(UnauthenticatedError);
  });

  it('is never authenticated again by a route module', () => {
    const routes = fileURLToPath(new URL('../src/routes/', import.meta.url));
    const offenders = readdirSync(routes)
      .filter((name) => name.endsWith('.ts') && name !== 'route-access.ts')
      .filter((name) =>
        /\b(?:authenticate|authorizeMutation)\(/.test(readFileSync(join(routes, name), 'utf8')),
      );
    expect(offenders).toEqual([]);
  });

  it('reaches the handler of a signed-in read and a signed-in command', async () => {
    const context = await createTestContext({ workers: false });
    contexts.push(context);
    await context.bootstrap();
    const session = await context.login();
    const read = await context.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: session.cookie },
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().user.username).toBe(TEST_USERNAME);
    const command = await context.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: {
        cookie: session.cookie,
        [CSRF_HEADER_NAME]: session.csrfToken,
        origin: context.config.publicOrigin,
        'content-type': 'application/json',
      },
      payload: { name: 'Attached' },
    });
    expect(command.statusCode, command.body).toBe(200);
  });
});
