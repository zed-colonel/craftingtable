import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  authenticatedSessionResponseSchema,
  planImportResponseSchema,
  projectDetailResponseSchema,
  workItemDetailResponseSchema,
  workspaceAuditPageResponseSchema,
  workspaceListResponseSchema,
  workspaceSnapshotResponseSchema,
} from '@craftingtable/contracts';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { type CraftingTableRuntime, createRuntime } from '../src/composition.js';
import { CSRF_HEADER_NAME, configFromEnv } from '../src/config.js';
import { CredentialFile } from '../src/security/credential-file.js';
import { buildMultipartBody } from './multipart-test-support.js';
import {
  FastTestPasswordHasher,
  TEST_PASSWORD,
  TEST_USERNAME,
  testDataRoot,
} from './test-support.js';

const runtimes: CraftingTableRuntime[] = [];
/** No agent CLI of the host's: a daemon reads each backend's model catalog at start (R-G15). */
const NO_AGENTS = new Map();
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('daemon restart reconstruction', () => {
  it('reopens with imported plans and admission intact (CT03-A50)', async () => {
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-restart-planning-'));
    directories.push(directory);
    const config = configFromEnv({
      CRAFTINGTABLE_DATA_DIR: directory,
      // Its own credentials file, never the operator's (R-G9).
      CRAFTINGTABLE_CONFIG_DIR: join(directory, 'config'),
      CRAFTINGTABLE_LOG_LEVEL: 'silent',
    });
    const passwordHasher = new FastTestPasswordHasher();

    const first = await createRuntime(config, {
      logger: false,
      overrides: { passwordHasher, agentBackends: NO_AGENTS },
    });
    runtimes.push(first);
    await first.services.bootstrapService.bootstrap(TEST_USERNAME, TEST_PASSWORD);
    const login = await first.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { origin: config.publicOrigin, 'content-type': 'application/json' },
      payload: { username: TEST_USERNAME, password: TEST_PASSWORD },
    });
    const cookie = String(login.headers['set-cookie']).split(';')[0] as string;
    const csrfToken = (login.json() as { csrfToken: string }).csrfToken;
    const workspaceId = first.storage.workspaces
      .listAuthorized(first.storage.users.findByNormalizedUsername(TEST_USERNAME)?.id as never)
      .at(0)?.workspace.id as never;

    const fixtureDir = new URL('../../../fixtures/plan-bundles/aq-cont-1/', import.meta.url);
    const body = buildMultipartBody({
      fields: { projectName: 'ActionQueue — AQ-CONT-1' },
      files: [
        {
          fieldName: 'implementation-plan',
          filename: 'aq-cont-1-implementation-plan.md',
          contentType: 'text/markdown',
          bytes: new Uint8Array(
            readFileSync(new URL('aq-cont-1-implementation-plan.md', fixtureDir)),
          ),
        },
        {
          fieldName: 'work-breakdown',
          filename: 'aq-cont-1-work-breakdown.yaml',
          contentType: 'application/yaml',
          bytes: new Uint8Array(readFileSync(new URL('aq-cont-1-work-breakdown.yaml', fixtureDir))),
        },
      ],
    });
    const imported = planImportResponseSchema.parse(
      (
        await first.app.inject({
          method: 'POST',
          url: `/api/workspaces/${workspaceId}/plan-imports`,
          headers: {
            cookie,
            origin: config.publicOrigin,
            [CSRF_HEADER_NAME]: csrfToken,
            'content-type': body.contentType,
          },
          payload: body.payload,
        })
      ).json(),
    );
    if (imported.outcome !== 'succeeded') {
      throw new Error('Expected the import to succeed');
    }
    const aq01 = first.storage.planning.workItems
      .listForVersion(workspaceId, imported.planVersionId)
      .find((item) => item.sourceId === 'AQ-01');
    await first.app.inject({
      method: 'POST',
      url: `/api/workspaces/${workspaceId}/work-items/${aq01?.id}/admit`,
      headers: {
        cookie,
        origin: config.publicOrigin,
        [CSRF_HEADER_NAME]: csrfToken,
        'content-type': 'application/json',
      },
      payload: {},
    });

    const before = {
      versions: first.storage.planning.versions.count(),
      workItems: first.storage.planning.workItems.count(),
      dependencies: first.storage.planning.dependencies.count(),
      artifacts: first.storage.planning.artifacts.count(),
      audit: first.storage.audit.count(),
      events: first.storage.workspaceEvents.count(),
      maxSequence: first.storage.workspaceEvents.maxSequence(),
    };
    await first.close();
    runtimes.splice(runtimes.indexOf(first), 1);

    // Real close and reopen of the same database file.
    const second = await createRuntime(config, {
      logger: false,
      overrides: { passwordHasher, agentBackends: NO_AGENTS },
    });
    runtimes.push(second);
    expect(second.storage.migrationStatus.currentVersion).toBe(
      second.storage.migrationStatus.supportedVersion,
    );
    expect({
      versions: second.storage.planning.versions.count(),
      workItems: second.storage.planning.workItems.count(),
      dependencies: second.storage.planning.dependencies.count(),
      artifacts: second.storage.planning.artifacts.count(),
      audit: second.storage.audit.count(),
      events: second.storage.workspaceEvents.count(),
      maxSequence: second.storage.workspaceEvents.maxSequence(),
    }).toEqual(before);

    const detail = projectDetailResponseSchema.parse(
      (
        await second.app.inject({
          method: 'GET',
          url: `/api/workspaces/${workspaceId}/projects/${imported.projectId}`,
          headers: { cookie },
        })
      ).json(),
    );
    expect(detail.project.admittedCount).toBe(1);
    expect(detail.project.planningReadyCount).toBe(0);
    expect(detail.activeVersion?.workItems).toHaveLength(14);

    const workItem = workItemDetailResponseSchema.parse(
      (
        await second.app.inject({
          method: 'GET',
          url: `/api/workspaces/${workspaceId}/work-items/${aq01?.id}`,
          headers: { cookie },
        })
      ).json(),
    );
    expect(workItem.workItem.status).toBe('admitted');
    expect(workItem.workItem.readiness).toBe('active');
  });

  it('moves Pushover credentials kept in the database into the credentials file when it starts (R-G9)', async () => {
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-restart-credentials-'));
    directories.push(directory);
    const config = configFromEnv({
      CRAFTINGTABLE_DATA_DIR: directory,
      CRAFTINGTABLE_CONFIG_DIR: join(directory, 'config'),
      CRAFTINGTABLE_LOG_LEVEL: 'silent',
    });
    const options = {
      logger: false,
      overrides: { passwordHasher: new FastTestPasswordHasher(), agentBackends: NO_AGENTS },
    } as const;
    const first = await createRuntime(config, options);
    runtimes.push(first);
    await first.services.bootstrapService.bootstrap(TEST_USERNAME, TEST_PASSWORD);
    const owner = first.storage.users.findByNormalizedUsername(TEST_USERNAME)!;
    const workspaceId = first.storage.workspaces.listAuthorized(owner.id)[0]!.workspace.id;
    // As a daemon before R-G9 kept them.
    const credentials = { applicationToken: 'a'.repeat(30), userKey: 'u'.repeat(30) };
    first.storage.transaction((tx) =>
      tx.notifications.saveSettings({
        workspaceId,
        ownerUserId: owner.id,
        preferences: DEFAULT_NOTIFICATION_PREFERENCES,
        ...credentials,
        version: 1,
        blockedReason: null,
        retryAt: null,
      }),
    );
    await first.close();
    runtimes.splice(runtimes.indexOf(first), 1);

    const second = await createRuntime(config, options);
    runtimes.push(second);
    expect(new CredentialFile(config.configDir).pushover(workspaceId)).toEqual(credentials);
    expect(second.storage.notifications.settings(workspaceId)).toMatchObject({
      applicationToken: null,
      userKey: null,
      version: 1,
    });
  });

  it('reopens the same database with user, session, audit, event, and snapshot state', async () => {
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-restart-test-'));
    directories.push(directory);
    const config = configFromEnv({
      CRAFTINGTABLE_DATA_DIR: directory,
      // Its own credentials file, never the operator's (R-G9).
      CRAFTINGTABLE_CONFIG_DIR: join(directory, 'config'),
      CRAFTINGTABLE_LOG_LEVEL: 'silent',
    });
    const passwordHasher = new FastTestPasswordHasher();
    const first = await createRuntime(config, {
      logger: false,
      overrides: { passwordHasher, agentBackends: NO_AGENTS },
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
      overrides: { passwordHasher, agentBackends: NO_AGENTS },
    });
    runtimes.push(second);
    expect(second.storage.migrationStatus.currentVersion).toBe(
      second.storage.migrationStatus.supportedVersion,
    );
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
