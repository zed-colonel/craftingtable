import { randomUUID } from 'node:crypto';
import { asEventId } from '@craftingtable/domain';
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

describe('WorkspaceEventStreamService', () => {
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
