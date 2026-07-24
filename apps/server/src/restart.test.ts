import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  authenticatedSessionResponseSchema,
  workspaceAuditPageResponseSchema,
  workspaceListResponseSchema,
  workspaceSnapshotResponseSchema,
} from '@craftingtable/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { configFromEnv } from './config.js';
import { createRuntime, type CraftingTableRuntime } from './composition.js';
import { FastTestPasswordHasher, TEST_PASSWORD, TEST_USERNAME } from './test-support.js';

const runtimes: CraftingTableRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('daemon restart reconstruction', () => {
  it('reopens the same database with user, session, audit, event, and snapshot state', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'craftingtable-restart-test-'));
    directories.push(directory);
    const config = configFromEnv({
      CRAFTINGTABLE_DATA_DIR: directory,
      CRAFTINGTABLE_LOG_LEVEL: 'silent',
    });
    const passwordHasher = new FastTestPasswordHasher();
    const first = await createRuntime(config, {
      logger: false,
      overrides: { passwordHasher },
    });
    runtimes.push(first);
    const bootstrap = await first.services.bootstrapService.bootstrap(TEST_USERNAME, TEST_PASSWORD);
    const login = await first.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: {
        origin: config.publicOrigin,
        'content-type': 'application/json',
      },
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0] as string;
    const sessionBefore = authenticatedSessionResponseSchema.parse(login.json());
    expect(first.storage.audit.count()).toBe(3);
    await first.close();
    runtimes.splice(runtimes.indexOf(first), 1);

    const second = await createRuntime(config, {
      logger: false,
      overrides: { passwordHasher },
    });
    runtimes.push(second);
    expect(second.storage.migrationStatus.currentVersion).toBe(1);
    expect(second.storage.users.count()).toBe(1);
    expect(second.storage.workspaceEvents.count()).toBe(1);
    expect(second.storage.audit.count()).toBe(3);

    const session = await second.app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie },
    });
    expect(authenticatedSessionResponseSchema.parse(session.json()).session.id).toBe(
      sessionBefore.session.id,
    );
    const workspaces = workspaceListResponseSchema.parse(
      (
        await second.app.inject({
          method: 'GET',
          url: '/api/workspaces',
          headers: { cookie },
        })
      ).json(),
    );
    expect(workspaces.workspaces).toHaveLength(1);
    expect(workspaces.workspaces[0]?.id).toBe(bootstrap.workspace.id);

    const snapshot = workspaceSnapshotResponseSchema.parse(
      (
        await second.app.inject({
          method: 'GET',
          url: `/api/workspaces/${bootstrap.workspace.id}/snapshot`,
          headers: { cookie },
        })
      ).json(),
    );
    expect(snapshot.asOfSequence).toBe(1);
    expect(snapshot.recentActivity).toEqual([bootstrap.event]);
    const audit = workspaceAuditPageResponseSchema.parse(
      (
        await second.app.inject({
          method: 'GET',
          url: `/api/workspaces/${bootstrap.workspace.id}/audit`,
          headers: { cookie },
        })
      ).json(),
    );
    expect(audit.records.map((record) => record.action)).toEqual([
      'workspace.created',
      'admin.bootstrap',
    ]);
  });
});
