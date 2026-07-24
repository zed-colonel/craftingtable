import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@craftingtable/storage';
import { BootstrapRefusedError } from './errors.js';
import {
  createTestContext,
  TEST_PASSWORD,
  TEST_USERNAME,
  type TestContext,
} from '../test-support.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

describe('BootstrapService', () => {
  it('creates one user, default workspace, Owner membership, audits, and event atomically', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const result = await context.services.bootstrapService.bootstrap(TEST_USERNAME, TEST_PASSWORD);
    expect(context.storage.users.count()).toBe(1);
    expect(context.storage.workspaces.listAuthorized(result.user.id)).toHaveLength(1);
    expect(result.membership.role).toBe('owner');
    expect(context.storage.audit.count()).toBe(2);
    expect(context.storage.workspaceEvents.count()).toBe(1);
    expect(result.event).toMatchObject({
      sequence: 1,
      workspaceId: result.workspace.id,
      kind: 'workspace-created',
    });
  });

  it('adds exactly one safe denial audit and no other row on second bootstrap', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const first = await context.services.bootstrapService.bootstrap(TEST_USERNAME, TEST_PASSWORD);
    await expect(
      context.services.bootstrapService.bootstrap('another-user', TEST_PASSWORD),
    ).rejects.toBeInstanceOf(BootstrapRefusedError);
    expect(context.storage.users.count()).toBe(1);
    expect(context.storage.workspaces.listAuthorized(first.user.id)).toHaveLength(1);
    expect(context.storage.workspaceEvents.count()).toBe(1);
    expect(context.storage.audit.count()).toBe(3);
    expect(
      context.storage.audit.listWorkspace({
        workspaceId: first.workspace.id,
        limit: 20,
      }),
    ).toHaveLength(2);
    const inspection = openDatabase(context.config.databasePath);
    try {
      const denial = inspection
        .prepare(
          `SELECT actor_kind, actor_user_id, session_id, workspace_id, action,
                  target_type, target_id, outcome, metadata_json
           FROM audit_events WHERE action = 'admin.bootstrap.denied'`,
        )
        .all();
      expect(denial).toEqual([
        {
          actor_kind: 'system',
          actor_user_id: null,
          session_id: null,
          workspace_id: null,
          action: 'admin.bootstrap.denied',
          target_type: 'installation',
          target_id: 'local',
          outcome: 'denied',
          metadata_json: '{"reason":"user-already-exists"}',
        },
      ]);
    } finally {
      inspection.close();
    }
  });
});
