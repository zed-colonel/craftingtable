import { randomUUID } from 'node:crypto';
import { asEventId } from '@craftingtable/domain';
import { openDatabase, WorkspaceEventMappingError } from '@craftingtable/storage';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  TEST_PASSWORD,
  TEST_USERNAME,
  type TestContext,
} from '../test-support.js';
import { WorkspaceEventStreamService } from '../../src/services/workspace-event-stream-service.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

describe('WorkspaceEventStreamService', () => {
  it('B1-STO-009 rejects a poisoned batch before yielding its valid prefix', async () => {
    const context = await createTestContext({ verifyRecords: false });
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
