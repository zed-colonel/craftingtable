import { randomUUID } from 'node:crypto';
import {
  STORED_REPOSITORY_RISK_SCAN_PATTERN,
  asEventId,
  asRepositoryId,
  asRepositoryInspectionId,
  type SuccessfulRepositoryInspection,
  type UserId,
  type WorkspaceId,
} from '@craftingtable/domain';
import {
  openDatabase,
  serializeRepositoryObservation,
  sha256ExactUtf8,
  type SuccessfulInspectionWrite,
  WorkspaceEventMappingError,
} from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  TEST_PASSWORD,
  TEST_USERNAME,
  type TestContext,
} from '../test-support.js';
import { WorkspaceEventStreamService } from './workspace-event-stream-service.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

function registrationInspection(input: {
  readonly workspaceId: WorkspaceId;
  readonly actorUserId: UserId;
  readonly repositoryId: ReturnType<typeof asRepositoryId>;
  readonly createdAt: string;
}): SuccessfulInspectionWrite & { readonly kind: 'registration'; readonly outcome: 'succeeded' } {
  const path = '/source/sse-mixed';
  const observation = {
    observationVersion: 1,
    inspectionPolicyVersion: 1,
    observedAt: input.createdAt,
    gitVersion: { major: 2, minor: 50, patch: 0 },
    canonicalTopLevel: path,
    canonicalGitDirectory: `${path}/.git`,
    canonicalCommonGitDirectory: `${path}/.git`,
    objectFormat: 'sha1',
    coreIdentity: {
      topLevelInode: '100',
      commonDirectoryInode: '101',
      fingerprintSha256: sha256ExactUtf8('sse-mixed-fingerprint'),
    },
    environmentalEvidence: {
      topLevelDevice: '10',
      commonDirectoryDevice: '10',
    },
    riskScan: {
      scanScopeVersion: 1,
      scannedKeyPattern: STORED_REPOSITORY_RISK_SCAN_PATTERN,
      classification: 'no-signals-in-scanned-set',
      signals: [],
    },
  } as const;
  return {
    id: asRepositoryInspectionId('inspection-sse-mixed'),
    workspaceId: input.workspaceId,
    repositoryId: input.repositoryId,
    actorUserId: input.actorUserId,
    kind: 'registration',
    outcome: 'succeeded',
    createdAt: input.createdAt,
    ...serializeRepositoryObservation(observation),
    observationVersion: 1,
    inspectionPolicyVersion: 1,
    observedAt: input.createdAt,
    canonicalTopLevel: observation.canonicalTopLevel,
    canonicalGitDirectory: observation.canonicalGitDirectory,
    canonicalCommonGitDirectory: observation.canonicalCommonGitDirectory,
    objectFormat: observation.objectFormat,
    topLevelInode: observation.coreIdentity.topLevelInode,
    commonDirectoryInode: observation.coreIdentity.commonDirectoryInode,
    coreFingerprintSha256: observation.coreIdentity.fingerprintSha256,
    topLevelDevice: observation.environmentalEvidence.topLevelDevice,
    commonDirectoryDevice: observation.environmentalEvidence.commonDirectoryDevice,
    riskScanScopeVersion: 1,
    riskScannedKeyPattern: STORED_REPOSITORY_RISK_SCAN_PATTERN,
    riskClassification: observation.riskScan.classification,
    riskSignals: [] as readonly SuccessfulRepositoryInspection['riskSignals'][number][],
  };
}

describe('WorkspaceEventStreamService', () => {
  it('B1-REGRESS-002 resumes a mixed legacy/repository stream at the exact cursor', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const bootstrap = await context.services.bootstrapService.bootstrap(
      TEST_USERNAME,
      TEST_PASSWORD,
    );
    const login = await context.login();
    const rawSessionToken = login.cookie.split('=')[1] as string;
    const repositoryId = asRepositoryId('repository-sse-mixed');
    const occurredAt = '2026-07-29T00:00:01.000Z';
    const inspection = registrationInspection({
      workspaceId: bootstrap.workspace.id,
      actorUserId: bootstrap.user.id,
      repositoryId,
      createdAt: occurredAt,
    });
    context.storage.repositoryRegistry.repositories.register({
      id: repositoryId,
      workspaceId: bootstrap.workspace.id,
      displayName: 'SSE mixed repository',
      actorUserId: bootstrap.user.id,
      inspection,
    });
    context.storage.workspaceEvents.appendEvent({
      id: asEventId('event-sse-mixed-repository'),
      occurredAt,
      workspaceId: bootstrap.workspace.id,
      actorUserId: bootstrap.user.id,
      repositoryId,
      repositoryInspectionId: inspection.id,
      kind: 'repository-registered',
      payload: {
        repositoryId,
        inspectionId: inspection.id,
        displayName: 'SSE mixed repository',
        status: 'active',
        statusReason: 'registration-accepted',
        version: 1,
      },
    });

    const controller = new AbortController();
    const iterator = context.services.workspaceEventStreamService
      .stream({
        rawSessionToken,
        workspaceId: bootstrap.workspace.id,
        after: 1,
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    const next = await iterator.next();
    controller.abort();
    expect(next.value).toMatchObject({
      type: 'workspace-event',
      event: { sequence: 2, kind: 'repository-registered', repositoryId },
    });
  });

  it('B1-STO-009 rejects a poisoned batch before yielding its valid prefix', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const bootstrap = await context.services.bootstrapService.bootstrap(
      TEST_USERNAME,
      TEST_PASSWORD,
    );
    const login = await context.login();
    const rawSessionToken = login.cookie.split('=')[1] as string;
    const database = openDatabase(context.storage.databasePath);
    try {
      database
        .prepare(
          `INSERT INTO workspace_event_kinds (kind, introduced_in_schema)
           VALUES ('future-event-kind', 5)`,
        )
        .run();
      database
        .prepare(
          `INSERT INTO workspace_events (
             id, schema_version, occurred_at, workspace_id, kind, payload_json
           ) VALUES (?, 1, ?, ?, 'future-event-kind', '{}')`,
        )
        .run('event-sse-poisoned', '2026-07-29T00:00:02.000Z', bootstrap.workspace.id);
    } finally {
      database.close();
    }

    const controller = new AbortController();
    const iterator = context.services.workspaceEventStreamService
      .stream({
        rawSessionToken,
        workspaceId: bootstrap.workspace.id,
        after: 0,
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({
      name: WorkspaceEventMappingError.name,
      failure: 'unknown-kind',
    });
    controller.abort();
  });

  it('does not lose a commit between an empty journal query and waiter registration', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const bootstrap = await context.services.bootstrapService.bootstrap(
      TEST_USERNAME,
      TEST_PASSWORD,
    );
    const login = await context.login();
    const rawSessionToken = login.cookie.split('=')[1] as string;
    let committed = false;
    const service = new WorkspaceEventStreamService(
      context.storage,
      context.services.authService,
      context.services.workspaceService,
      context.services.workspaceEventNotifier,
      {
        waitTimeoutMs: 25,
        afterEmptyQuery: () => {
          if (committed) {
            return;
          }
          committed = true;
          context.storage.transaction((tx) => {
            tx.workspaceEvents.appendWorkspaceCreated({
              id: asEventId(randomUUID()),
              occurredAt: new Date().toISOString(),
              workspaceId: bootstrap.workspace.id,
              actorUserId: bootstrap.user.id,
              name: 'Committed in race window',
              slug: 'race-window',
            });
          });
          context.services.workspaceEventNotifier.notify();
        },
      },
    );
    const controller = new AbortController();
    const iterator = service
      .stream({
        rawSessionToken,
        workspaceId: bootstrap.workspace.id,
        after: 1,
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    const next = await iterator.next();
    controller.abort();
    expect(next.value).toMatchObject({
      type: 'workspace-event',
      event: { sequence: 2, payload: { name: 'Committed in race window' } },
    });
  });

  it('recovers a dropped in-memory notification by timeout and requery', async () => {
    const context = await createTestContext();
    contexts.push(context);
    const bootstrap = await context.services.bootstrapService.bootstrap(
      TEST_USERNAME,
      TEST_PASSWORD,
    );
    const login = await context.login();
    const rawSessionToken = login.cookie.split('=')[1] as string;
    let committed = false;
    const service = new WorkspaceEventStreamService(
      context.storage,
      context.services.authService,
      context.services.workspaceService,
      context.services.workspaceEventNotifier,
      {
        waitTimeoutMs: 10,
        afterEmptyQuery: () => {
          if (committed) {
            return;
          }
          committed = true;
          context.storage.workspaceEvents.appendWorkspaceCreated({
            id: asEventId(randomUUID()),
            occurredAt: new Date().toISOString(),
            workspaceId: bootstrap.workspace.id,
            actorUserId: bootstrap.user.id,
            name: 'Recovered by poll',
            slug: 'recovered-by-poll',
          });
          // Deliberately omit notifier.notify().
        },
      },
    );
    const controller = new AbortController();
    const iterator = service
      .stream({
        rawSessionToken,
        workspaceId: bootstrap.workspace.id,
        after: 1,
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    const next = await iterator.next();
    controller.abort();
    expect(next.value).toMatchObject({
      type: 'workspace-event',
      event: { sequence: 2, payload: { name: 'Recovered by poll' } },
    });
  });
});
