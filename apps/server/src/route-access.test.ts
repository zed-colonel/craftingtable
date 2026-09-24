import { randomUUID } from 'node:crypto';
import {
  asUserId,
  asWorkspaceId,
  asWorkspaceMembershipId,
  type WorkspaceId,
  type WorkspaceRole,
} from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from './config.js';
import {
  declaredRouteAccess,
  type RouteAccess,
  routeAccessProblem,
} from './routes/route-access.js';
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
    ...(route.method === 'GET' ? {} : { payload: {} }),
  });
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

  it('answers each kind of caller as every route declares', { timeout: 120_000 }, async () => {
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
      const anonymous = await request(f, route, {});
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
      });
      check(key, 'non-member', outsider.statusCode, outsider.statusCode === 404, outsider.body);
      for (const role of BELOW[access]) {
        const below = await request(f, route, { caller: await f.signIn(role) });
        check(key, role, below.statusCode, below.statusCode === 403, below.body);
      }
      const at = AT[access];
      if (at !== undefined && !streaming(url)) {
        const admitted = await request(f, route, { caller: await f.signIn(at) });
        check(
          key,
          `${at} (admitted)`,
          admitted.statusCode,
          ![401, 403].includes(admitted.statusCode),
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
