import { randomUUID } from 'node:crypto';
import { asEventId } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { RunEventStreamService } from '../../src/services/run-event-stream-service.js';
import { streamChannels } from '../../src/services/stream-channels.js';
import { WorkspaceEventNotifier } from '../../src/services/workspace-event-notifier.js';
import { WorkspaceEventStreamService } from '../../src/services/workspace-event-stream-service.js';
import {
  createTestContext,
  TEST_PASSWORD,
  TEST_USERNAME,
  type TestContext,
} from '../test-support.js';

/**
 * The event streams' channels (R-B5 part 3, increment 14): keyed waits that miss no notification
 * made after their snapshot, the write observer that notifies a committed event's key, and a
 * stream ended at once by its session's revocation.
 */

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
});

type Kind = Parameters<ReturnType<typeof streamChannels>['written']>[0];

it('wakes a keyed wait at its key, or at once for a notification after its snapshot', async () => {
  const notifier = new WorkspaceEventNotifier();
  const signal = new AbortController().signal;
  const before = notifier.keySequence;
  notifier.notifyKeys(['workspace:a']);
  // Notified after the snapshot: at once.
  await notifier.waitForKeys({ keys: ['workspace:a'], after: before, timeoutMs: 60_000, signal });
  // Another key, or before the snapshot, does not wake it.
  const after = notifier.keySequence;
  let woken = false;
  const waiting = notifier
    .waitForKeys({ keys: ['workspace:a', 'session:s'], after, timeoutMs: 60_000, signal })
    .then(() => {
      woken = true;
    });
  notifier.notifyKeys(['workspace:b']);
  notifier.notify();
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(woken).toBe(false);
  notifier.notifyKeys(['session:s']);
  await waiting;
  expect(woken).toBe(true);
});

it('ends a keyed wait at its timeout or its abort', async () => {
  const notifier = new WorkspaceEventNotifier();
  const started = Date.now();
  await notifier.waitForKeys({
    keys: ['workspace:a'],
    after: notifier.keySequence,
    timeoutMs: 30,
    signal: new AbortController().signal,
  });
  expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  const controller = new AbortController();
  const waiting = notifier.waitForKeys({
    keys: ['workspace:a'],
    after: notifier.keySequence,
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  controller.abort();
  await waiting;
});

it("notifies a committed event's workspace or run, once per commit; nothing for a rollback", async () => {
  const notified: string[][] = [];
  let open = true;
  const channels = streamChannels(
    (keys) => notified.push([...keys]),
    () => open,
  );
  channels.written('workspace-event' as Kind, { workspaceId: 'w1' } as never);
  channels.written('run-event' as Kind, { runId: 'r1' } as never);
  channels.written('run-event' as Kind, { runId: 'r1' } as never);
  channels.written('work-cycle' as Kind, { workspaceId: 'w1' } as never);
  expect(notified).toEqual([]);
  channels.ended(true, 3);
  expect(notified).toEqual([['workspace:w1', 'run:r1']]);
  channels.written('run-event' as Kind, { runId: 'r2' } as never);
  channels.ended(false, 0);
  expect(notified).toHaveLength(1);
  // Outside a transaction: at the end of the task.
  open = false;
  channels.written('workspace-event' as Kind, { workspaceId: 'w2' } as never);
  expect(notified).toHaveLength(1);
  await Promise.resolve();
  expect(notified.at(-1)).toEqual(['workspace:w2']);
});

it('ends an open stream at once when its session is logged out, with a fallback of ten minutes', async () => {
  const context = await createTestContext({ workers: false });
  contexts.push(context);
  const bootstrap = await context.services.bootstrapService.bootstrap(TEST_USERNAME, TEST_PASSWORD);
  const login = await context.login();
  const raw = login.cookie.split('=')[1] as string;
  let queried = false;
  const service = new WorkspaceEventStreamService(
    context.storage,
    context.services.authService,
    context.services.workspaceService,
    context.services.workspaceEventNotifier,
    {
      waitTimeoutMs: 600_000,
      afterEmptyQuery: () => {
        queried = true;
      },
    },
  );
  const controller = new AbortController();
  const iterator = service
    .stream({
      rawSessionToken: raw,
      workspaceId: bootstrap.workspace.id,
      after: 1_000_000,
      signal: controller.signal,
    })
    [Symbol.asyncIterator]();
  const next = iterator.next();
  for (let turn = 0; turn < 100 && !queried; turn++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  context.services.authService.logout(context.services.authService.authenticate(raw, false));
  expect((await next).value).toEqual({ type: 'authentication-expired' });
  controller.abort();
  // An event of the workspace after it changes nothing.
  context.storage.transaction((tx) =>
    tx.workspaceEvents.appendWorkspaceCreated({
      id: asEventId(randomUUID()),
      occurredAt: new Date().toISOString(),
      workspaceId: bootstrap.workspace.id,
      actorUserId: bootstrap.user.id,
      name: 'After the logout',
      slug: 'after-logout',
    }),
  );
});

it("waits no longer than its session stays usable without a request (the expiry's timeout)", async () => {
  const context = await createTestContext({ workers: false });
  contexts.push(context);
  await context.services.bootstrapService.bootstrap(TEST_USERNAME, TEST_PASSWORD);
  const login = await context.login();
  const auth = context.services.authService;
  const { session } = auth.authenticate(login.cookie.split('=')[1] as string, false);
  expect(auth.streamWaitMs(session, 30_000)).toBe(30_000);
  const until = auth.sessionUsableUntil(session);
  const soon = { ...session, expiresAt: new Date(Date.now() + 1_000).toISOString() };
  expect(auth.streamWaitMs(soon, 30_000)).toBeLessThanOrEqual(1_000);
  expect(auth.streamWaitMs(soon, 30_000)).toBeGreaterThan(0);
  expect(until).toBeGreaterThan(Date.now());
});

it('ends an open stream at once when its session is revoked from another, or by a password change', async () => {
  const context = await createTestContext({ workers: false });
  contexts.push(context);
  const bootstrap = await context.services.bootstrapService.bootstrap(TEST_USERNAME, TEST_PASSWORD);
  const auth = context.services.authService;
  const open = async (raw: string) => {
    let queried = false;
    const service = new WorkspaceEventStreamService(
      context.storage,
      auth,
      context.services.workspaceService,
      context.services.workspaceEventNotifier,
      {
        waitTimeoutMs: 600_000,
        afterEmptyQuery: () => {
          queried = true;
        },
      },
    );
    const controller = new AbortController();
    const next = service
      .stream({
        rawSessionToken: raw,
        workspaceId: bootstrap.workspace.id,
        after: 1_000_000,
        signal: controller.signal,
      })
      [Symbol.asyncIterator]()
      .next();
    for (let turn = 0; turn < 100 && !queried; turn++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    return { next, controller };
  };
  const token = async () => (await context.login()).cookie.split('=')[1] as string;
  // Revoked from another session.
  const [streamed, other] = [await token(), await token()];
  const first = await open(streamed);
  const from = auth.authenticate(other, false);
  auth.revokeSession(from, auth.authenticate(streamed, false).session.id);
  expect((await first.next).value).toEqual({ type: 'authentication-expired' });
  first.controller.abort();
  // A password change revokes every other session of the user.
  const [changed, changer] = [await token(), await token()];
  const second = await open(changed);
  await auth.changePassword(auth.authenticate(changer, false), {
    currentPassword: TEST_PASSWORD,
    newPassword: `${TEST_PASSWORD}-changed`,
  });
  expect((await second.next).value).toEqual({ type: 'authentication-expired' });
  second.controller.abort();
});

it("wakes an open run stream at its run's own channel", async () => {
  const context = await createTestContext({ workers: false });
  contexts.push(context);
  const bootstrap = await context.services.bootstrapService.bootstrap(TEST_USERNAME, TEST_PASSWORD);
  const login = await context.login();
  const notifier = context.services.workspaceEventNotifier;
  let queries = 0;
  const service = new RunEventStreamService(
    context.storage,
    context.services.authService,
    context.services.workspaceService,
    notifier,
    {
      waitTimeoutMs: 600_000,
      afterEmptyQuery: () => {
        queries += 1;
      },
    },
  );
  const controller = new AbortController();
  const pending = service
    .stream({
      rawSessionToken: login.cookie.split('=')[1] as string,
      workspaceId: bootstrap.workspace.id,
      runId: 'run-1' as never,
      after: 0,
      signal: controller.signal,
    })
    [Symbol.asyncIterator]()
    .next();
  for (let turn = 0; turn < 100 && queries < 1; turn++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  notifier.notifyKeys(['run:another', `workspace:${bootstrap.workspace.id}`]);
  notifier.notify('activity');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(queries).toBe(1);
  notifier.notifyKeys(['run:run-1']);
  for (let turn = 0; turn < 100 && queries < 2; turn++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(queries).toBe(2);
  controller.abort();
  await pending.catch(() => undefined);
});
