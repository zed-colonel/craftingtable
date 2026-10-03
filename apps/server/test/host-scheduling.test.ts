import { randomUUID } from 'node:crypto';
import { hostSchedulingSchema } from '@craftingtable/contracts';
import {
  asUserId,
  asWorkspaceId,
  asWorkspaceMembershipId,
  type Roadmap,
} from '@craftingtable/domain';
import { openDatabase, type StorageRepositories } from '@craftingtable/storage';
import { afterEach, expect, it, vi } from 'vitest';
import type { ResolvedScope } from '../src/services/execution-scope.js';
import { resourceBlockers } from '../src/services/phase-resources.js';
import { createTestContext, type TestContext } from './test-support.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of contexts.splice(0)) await c.cleanup();
});
async function fixture() {
  const c = await createTestContext({
    env: { CRAFTINGTABLE_VERIFICATION_CAPACITY: '2', CRAFTINGTABLE_DEVELOPMENT_CAPACITY: '4' },
  });
  contexts.push(c);
  await c.bootstrap();
  const login = await c.login();
  const auth = c.services.authService.authenticate(login.cookie.split('=').slice(1).join('='));
  const workspaceId = c.storage.workspaces.listAuthorized(auth.user.id)[0]!.workspace.id;
  const headers = {
    cookie: login.cookie,
    origin: c.config.publicOrigin,
    'x-craftingtable-csrf': login.csrfToken,
  };
  const url = `/api/workspaces/${workspaceId}/host-scheduling`;
  const get = async () =>
    hostSchedulingSchema.parse((await c.app.inject({ method: 'GET', url, headers })).json());
  const save = (expectedVersion: number, verificationCapacity: number) =>
    c.app.inject({
      method: 'POST',
      url,
      headers,
      payload: {
        expectedVersion,
        verificationCapacity,
        expectedDevelopmentVersion: c.storage.phaseScheduling.setting('local-development').version,
        developmentCapacity: 4,
      },
    });
  return { c, auth, workspaceId, headers, url, get, save };
}
it('persists an audited host setting across database reopen and environment initialization, rejecting stale updates', async () => {
  const s = await fixture();
  const first = await s.get();
  expect(first).toMatchObject({
    verificationCapacity: 2,
    developmentCapacity: 4,
    source: 'daemon-environment',
  });
  expect((await s.save(first.version, 3)).statusCode).toBe(200);
  const changed = await s.get();
  expect(changed).toMatchObject({
    verificationCapacity: 3,
    source: 'saved-setting',
    version: first.version + 1,
  });
  expect((await s.save(first.version, 1)).statusCode).toBe(409);
  s.c.storage.phaseScheduling.initializeCapacity('local-verification', 1);
  expect((await s.get()).verificationCapacity).toBe(3);
  const db = openDatabase(s.c.config.databasePath);
  try {
    expect(
      db
        .prepare(
          "SELECT capacity, updated_by_user_id FROM phase_resource_limits WHERE resource_key='local-verification'",
        )
        .get(),
    ).toEqual({ capacity: 3, updated_by_user_id: s.auth.user.id });
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action='host-scheduling.updated'")
        .get(),
    ).toEqual({ n: 1 });
  } finally {
    db.close();
  }
  expect((await s.save(changed.version, 3)).statusCode).toBe(200);
  expect((await s.get()).version).toBe(changed.version);
});
it('requires authentication, CSRF, valid capacity, and ownership of every active workspace', async () => {
  const s = await fixture();
  const first = await s.get();
  expect((await s.c.app.inject({ method: 'GET', url: s.url })).statusCode).toBe(401);
  expect(
    (
      await s.c.app.inject({
        method: 'POST',
        url: s.url,
        headers: { cookie: s.headers.cookie },
        payload: { expectedVersion: first.version, verificationCapacity: 2 },
      })
    ).statusCode,
  ).toBe(403);
  for (const value of [0, 33, 1.5])
    expect((await s.save(first.version, value)).statusCode).toBe(400);
  const other = asUserId(randomUUID()),
    ws = asWorkspaceId(randomUUID()),
    at = new Date().toISOString();
  s.c.storage.users.insert({
    id: other,
    username: 'other',
    usernameNormalized: 'other',
    passwordHash: '$argon2id$test$hash',
    occurredAt: at,
  });
  s.c.storage.workspaces.insert({
    id: ws,
    name: 'Other',
    slug: 'other',
    createdByUserId: other,
    occurredAt: at,
  });
  s.c.storage.workspaces.insertMembership({
    id: asWorkspaceMembershipId(randomUUID()),
    workspaceId: ws,
    userId: other,
    role: 'owner',
    occurredAt: at,
  });
  expect((await s.c.app.inject({ method: 'GET', url: s.url, headers: s.headers })).statusCode).toBe(
    403,
  );
  expect((await s.save(first.version, 3)).statusCode).toBe(403);
});
it('requires paused scheduling without silently resuming or revising a roadmap', async () => {
  const s = await fixture();
  const first = await s.get();
  const id = randomUUID(),
    at = new Date().toISOString();
  const roadmap: Roadmap = {
    id,
    workspaceId: s.workspaceId,
    version: 1,
    status: 'running',
    reason: 'Running',
    createdAt: at,
    updatedAt: at,
    createdByUserId: s.auth.user.id,
    definition: {
      roadmapId: id,
      revision: 1,
      name: 'Test roadmap',
      entries: [],
      createdAt: at,
      createdByUserId: s.auth.user.id,
    },
    attempts: [],
  };
  s.c.storage.roadmaps.save(roadmap, 0);
  expect((await s.save(first.version, 3)).statusCode).toBe(409);
  s.c.storage.roadmaps.save({ ...roadmap, version: 2, status: 'paused' }, 1);
  expect((await s.save(first.version, 3)).statusCode).toBe(200);
  expect(s.c.storage.roadmaps.find(s.workspaceId, id)).toMatchObject({
    status: 'paused',
    version: 2,
    definition: { revision: 1 },
  });
});
it('uses the current verification limit for new claims while retaining occupied reservations', () => {
  let capacity = 1;
  const claims = [{ resourceKey: 'local-verification', ownerId: 'one', capacity: 1 }];
  const tx = {
    phaseScheduling: { capacity: () => capacity, active: () => claims },
  } as unknown as StorageRepositories;
  const r = {} as ResolvedScope; // Parent acceptance always needs the verification pool.
  expect(resourceBlockers(tx, r, 'accept')).toMatchObject([
    { kind: 'resource', message: expect.stringContaining('1/1') },
  ]);
  capacity = 2;
  expect(resourceBlockers(tx, r, 'accept')).toEqual([]);
  claims.push({ resourceKey: 'local-verification', ownerId: 'two', capacity: 2 });
  capacity = 1;
  expect(resourceBlockers(tx, r, 'accept')).toMatchObject([
    { message: expect.stringContaining('2/1') },
  ]);
  expect(claims).toHaveLength(2);
  claims.splice(0, 1);
  expect(resourceBlockers(tx, r, 'accept')).toHaveLength(1);
  claims.splice(0, 1);
  expect(resourceBlockers(tx, r, 'accept')).toEqual([]);
});

it('saves both pools atomically, rejects either stale version, and preserves both overrides on restart', async () => {
  const s = await fixture();
  const first = await s.get();
  const payload = {
    expectedVersion: first.version,
    expectedDevelopmentVersion: first.developmentVersion,
    verificationCapacity: 3,
    developmentCapacity: 6,
  };
  expect(
    (
      await s.c.app.inject({
        method: 'POST',
        url: s.url,
        headers: s.headers,
        payload: { ...payload, expectedDevelopmentVersion: 99 },
      })
    ).statusCode,
  ).toBe(409);
  expect(await s.get()).toMatchObject({ verificationCapacity: 2, developmentCapacity: 4 });
  expect(
    (await s.c.app.inject({ method: 'POST', url: s.url, headers: s.headers, payload })).statusCode,
  ).toBe(200);
  s.c.storage.phaseScheduling.initializeCapacity('local-development', 2);
  s.c.storage.phaseScheduling.initializeCapacity('local-verification', 1);
  expect(await s.get()).toMatchObject({
    verificationCapacity: 3,
    developmentCapacity: 6,
    developmentVersion: first.developmentVersion + 1,
    developmentSource: 'saved-setting',
  });
  for (const value of [0, 33, 1.5])
    expect(
      (
        await s.c.app.inject({
          method: 'POST',
          url: s.url,
          headers: s.headers,
          payload: { ...payload, developmentCapacity: value },
        })
      ).statusCode,
    ).toBe(400);
});
it('applies raised and lowered development limits to existing claims without ending them', () => {
  let capacity = 1;
  const claims = [{ resourceKey: 'local-development', ownerId: 'one', capacity: 1 }];
  const tx = {
    phaseScheduling: { capacity: () => capacity, active: () => claims },
  } as unknown as StorageRepositories;
  const r = {
    slice: { resources_by_phase: { start: ['isolated-development-workspace'] } },
    definition: {
      source: {
        resource_profiles: [
          {
            id: 'isolated-development-workspace',
            requires_hardware_virtualization: false,
            fixture_authorization_required: false,
          },
        ],
      },
    },
  } as unknown as ResolvedScope;
  expect(resourceBlockers(tx, r, 'start')).toHaveLength(1);
  capacity = 2;
  expect(resourceBlockers(tx, r, 'start')).toEqual([]);
  claims.push({ resourceKey: 'local-development', ownerId: 'two', capacity: 2 });
  capacity = 1;
  expect(resourceBlockers(tx, r, 'start')).toMatchObject([
    { message: expect.stringContaining('2/1') },
  ]);
  expect(claims).toHaveLength(2);
});
