import {
  createWorkspaceResponseSchema,
  renameWorkspaceResponseSchema,
  workspaceAuditPageResponseSchema,
  workspaceListResponseSchema,
  workspaceSnapshotResponseSchema,
} from '@craftingtable/contracts';
import { asUserId, asWorkspaceId, asWorkspaceMembershipId } from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  FastTestPasswordHasher,
  TEST_PASSWORD,
  type TestContext,
} from './test-support.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

describe('workspace HTTP surface', () => {
  it('authenticates before validating workspace identifiers', async () => {
    const context = await createTestContext();
    contexts.push(context);
    for (const suffix of ['snapshot', 'audit']) {
      const response = await context.app.inject({
        method: 'GET',
        url: `/api/workspaces/%20/${suffix}`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({
        error: { code: 'unauthenticated', message: 'Authentication required' },
      });
    }
  });

  it('lists, snapshots, and audits the authorized durable workspace', async () => {
    const context = await createTestContext();
    contexts.push(context);
    await context.bootstrap();
    const login = await context.login();
    const headers = { cookie: login.cookie };

    const listResponse = await context.app.inject({
      method: 'GET',
      url: '/api/workspaces',
      headers,
    });
    const list = workspaceListResponseSchema.parse(listResponse.json());
    expect(list.workspaces).toHaveLength(1);
    expect(list.workspaces[0]?.role).toBe('owner');
    expect(list.workspaces[0]).toMatchObject({
      projectCount: 0,
      admittedCount: 0,
      completedCount: 0,
      liveRunCount: 0,
      projects: [],
    });

    const workspace = list.workspaces[0];
    if (workspace === undefined) {
      throw new Error('Expected an authorized workspace');
    }
    const workspaceId = workspace.id;
    const snapshotResponse = await context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/snapshot`,
      headers,
    });
    const snapshot = workspaceSnapshotResponseSchema.parse(snapshotResponse.json());
    expect(snapshot.asOfSequence).toBe(1);
    expect(snapshot.recentActivity).toHaveLength(1);
    expect(snapshot.recentActivity[0]?.kind).toBe('workspace-created');

    const auditResponse = await context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${workspaceId}/audit?limit=10`,
      headers,
    });
    expect(workspaceAuditPageResponseSchema.parse(auditResponse.json()).records).toHaveLength(2);
  });

  it('creates and renames workspaces with audit and events', async () => {
    const context = await createTestContext();
    contexts.push(context);
    await context.bootstrap();
    const login = await context.login();
    const mutation = {
      cookie: login.cookie,
      origin: context.config.publicOrigin,
      'x-craftingtable-csrf': login.csrfToken,
      'content-type': 'application/json',
    };

    const created = await context.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: mutation,
      payload: { name: '  Laptop  ' },
    });
    expect(created.statusCode, created.body).toBe(200);
    const { workspace } = createWorkspaceResponseSchema.parse(created.json());
    expect(workspace).toMatchObject({ name: 'Laptop', slug: 'laptop', role: 'owner' });

    // The same name again gets a distinct slug.
    const again = await context.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: mutation,
      payload: { name: 'Laptop' },
    });
    expect(createWorkspaceResponseSchema.parse(again.json()).workspace.slug).toBe('laptop-2');

    const invalid = await context.app.inject({
      method: 'POST',
      url: '/api/workspaces',
      headers: mutation,
      payload: { name: '   ' },
    });
    expect(invalid.statusCode).toBe(400);

    const list = workspaceListResponseSchema.parse(
      (
        await context.app.inject({ method: 'GET', url: '/api/workspaces', headers: mutation })
      ).json(),
    );
    expect(list.workspaces.map((entry) => entry.slug).toSorted()).toEqual([
      'default',
      'laptop',
      'laptop-2',
    ]);

    const renamed = await context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspace.id}/rename`,
      headers: mutation,
      payload: { name: 'Couch laptop' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(renameWorkspaceResponseSchema.parse(renamed.json())).toMatchObject({
      changed: true,
      workspace: { id: workspace.id, name: 'Couch laptop', slug: 'laptop' },
    });
    const repeat = renameWorkspaceResponseSchema.parse(
      (
        await context.app.inject({
          method: 'POST',
          url: `/api/workspaces/${workspace.id}/rename`,
          headers: mutation,
          payload: { name: 'Couch laptop' },
        })
      ).json(),
    );
    expect(repeat.changed).toBe(false);

    const snapshot = workspaceSnapshotResponseSchema.parse(
      (
        await context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${workspace.id}/snapshot`,
          headers: { cookie: login.cookie },
        })
      ).json(),
    );
    expect(snapshot.workspace.name).toBe('Couch laptop');
    expect(snapshot.recentActivity.map((event) => event.kind)).toEqual([
      'workspace-created',
      'workspace-updated',
    ]);
    const audit = workspaceAuditPageResponseSchema.parse(
      (
        await context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${workspace.id}/audit?limit=10`,
          headers: { cookie: login.cookie },
        })
      ).json(),
    );
    expect(audit.records.map((record) => record.action)).toEqual([
      'workspace.updated',
      'workspace.created',
    ]);

    const unknown = await context.app.inject({
      method: 'POST',
      url: '/api/workspaces/not-a-workspace/rename',
      headers: mutation,
      payload: { name: 'x' },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('denies a non-member without disclosing workspace existence or content', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const bootstrap = await context.services.bootstrapService.bootstrap('owner', TEST_PASSWORD);

    const otherId = asUserId('other-user');
    context.storage.users.insert({
      id: otherId,
      username: 'other',
      usernameNormalized: 'other',
      passwordHash: await new FastTestPasswordHasher().hash(TEST_PASSWORD),
      occurredAt: new Date().toISOString(),
    });
    const otherLogin = await context.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: context.config.publicOrigin, 'content-type': 'application/json' },
      payload: { username: 'other', password: TEST_PASSWORD },
    });
    const cookie = String(otherLogin.headers['set-cookie']).split(';')[0] as string;

    const denied = await context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${bootstrap.workspace.id}/snapshot`,
      headers: { cookie },
    });
    const missing = await context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${asWorkspaceId('missing-workspace')}/snapshot`,
      headers: { cookie },
    });
    expect(denied.statusCode).toBe(404);
    expect(denied.body).toBe(missing.body);
    expect(denied.body).not.toContain(bootstrap.workspace.name);

    const deniedAudit = await context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${bootstrap.workspace.id}/audit`,
      headers: { cookie },
    });
    expect(deniedAudit.statusCode).toBe(404);
    expect(deniedAudit.body).not.toContain(bootstrap.workspace.name);

    const database = openDatabase(context.config.databasePath);
    try {
      const rows = database
        .prepare(`SELECT action FROM audit_events WHERE action = 'workspace.access.denied'`)
        .all();
      expect(rows).toHaveLength(3);
    } finally {
      database.close();
    }
  });

  it('keeps two-user/two-workspace service authorization isolated', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const first = await context.services.bootstrapService.bootstrap('first', TEST_PASSWORD);
    const secondUserId = asUserId('second-user');
    const secondWorkspaceId = asWorkspaceId('second-workspace');
    const now = new Date().toISOString();
    context.storage.transaction((tx) => {
      tx.users.insert({
        id: secondUserId,
        username: 'second',
        usernameNormalized: 'second',
        passwordHash: '$argon2id$test$second',
        occurredAt: now,
      });
      tx.workspaces.insert({
        id: secondWorkspaceId,
        name: 'Second private workspace',
        slug: 'second-private',
        createdByUserId: secondUserId,
        occurredAt: now,
      });
      tx.workspaces.insertMembership({
        id: asWorkspaceMembershipId('second-membership'),
        workspaceId: secondWorkspaceId,
        userId: secondUserId,
        role: 'owner',
        occurredAt: now,
      });
    });
    expect(
      context.storage.workspaces.findAuthorized(first.user.id, secondWorkspaceId),
    ).toBeUndefined();
    expect(
      context.storage.workspaces.findAuthorized(secondUserId, first.workspace.id),
    ).toBeUndefined();
  });
});
