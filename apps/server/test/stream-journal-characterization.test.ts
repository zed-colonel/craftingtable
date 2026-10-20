import { randomUUID } from 'node:crypto';
import { asEventId } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { WorkspaceEventStreamService } from '../src/services/workspace-event-stream-service.js';
import {
  cleanupExecutionFixtures,
  cycleFixture,
  designDone,
  startCycle,
  waitFor,
} from './execution-test-support.js';
import {
  createTestContext,
  TEST_PASSWORD,
  TEST_USERNAME,
  type TestContext,
} from './test-support.js';

/**
 * What the event streams and the journal do today, where the replays cannot pin it (R-B5 part 3,
 * increment 13; characterize before refactoring). A stream wakes on every notification of any
 * workspace and at least once a second; an agent's events are each their own transaction, with a
 * status transaction after every assistant message and tool call and a notification each. The
 * assertions marked "flips" change with part 3, as R-B5's entry says.
 */

const contexts: TestContext[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map((context) => context.cleanup()));
  await cleanupExecutionFixtures();
});

async function streaming(waitTimeoutMs: number) {
  const context = await createTestContext({ workers: false });
  contexts.push(context);
  const bootstrap = await context.services.bootstrapService.bootstrap(TEST_USERNAME, TEST_PASSWORD);
  const login = await context.login();
  let queries = 0;
  const service = new WorkspaceEventStreamService(
    context.storage,
    context.services.authService,
    context.services.workspaceService,
    context.services.workspaceEventNotifier,
    {
      waitTimeoutMs,
      afterEmptyQuery: () => {
        queries += 1;
      },
    },
  );
  const controller = new AbortController();
  const iterator = service
    .stream({
      rawSessionToken: login.cookie.split('=')[1] as string,
      workspaceId: bootstrap.workspace.id,
      after: 1_000_000,
      signal: controller.signal,
    })
    [Symbol.asyncIterator]();
  const pending = iterator.next();
  const settled = async (count: number) => {
    for (let turn = 0; turn < 200 && queries < count; turn++)
      await new Promise((resolve) => setTimeout(resolve, 5));
  };
  await settled(1);
  return {
    context,
    queries: () => queries,
    settled,
    stop: async () => {
      controller.abort();
      await pending.catch(() => undefined);
    },
  };
}

it("re-queries an open stream at every notification, any workspace's, activity too (flips: its own channel)", async () => {
  const stream = await streaming(60_000);
  expect(stream.queries()).toBe(1);
  // No workspace is named: today every waiter wakes.
  stream.context.services.workspaceEventNotifier.notify('activity');
  await stream.settled(2);
  expect(stream.queries()).toBe(2);
  await stream.stop();
});

it('re-queries an open stream at least once a second with nothing notified (flips: every 30 s)', async () => {
  const stream = await streaming(1000);
  await new Promise((resolve) => setTimeout(resolve, 2_300));
  expect(stream.queries()).toBeGreaterThanOrEqual(3);
  await stream.stop();
});

/** A design turn that makes three tool calls, through the real Claude normalizer. */
const toolTurn = {
  resultText: '',
  claudeStream: [
    ...[1, 2, 3].flatMap((n) => [
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: `toolu_${n}`, name: 'Read', input: {} }] },
      },
      {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: `toolu_${n}`, content: 'ok' }] },
      },
    ]),
    { type: 'result', subtype: 'success', result: designDone.resultText },
  ],
};

it('writes each agent event in its own transaction, with a status transaction after every tool call and a notification each (flips: the status one only when the run waits)', async () => {
  const { state, worktree } = await cycleFixture([toolTurn]);
  const storage = state.context.storage;
  const journal = (
    state.context.services.agentRunService as unknown as {
      journal: { transition: (...args: unknown[]) => unknown };
    }
  ).journal;
  const transition = journal.transition.bind(journal);
  let inTransition = false;
  let statusTransactions = 0;
  let statusCalls = 0;
  journal.transition = (...args: unknown[]) => {
    const from = args[2] as readonly string[];
    const perEvent = from.length === 1 && from[0] === 'waiting';
    if (perEvent) statusCalls += 1;
    inTransition = perEvent;
    try {
      return transition(...args);
    } finally {
      inTransition = false;
    }
  };
  const open = storage.transaction.bind(storage);
  storage.transaction = ((callback: never) => {
    if (inTransition) statusTransactions += 1;
    return open(callback);
  }) as typeof storage.transaction;
  const notifier = state.context.services.workspaceEventNotifier;
  const notify = notifier.notify.bind(notifier);
  let activity = 0;
  notifier.notify = (kind = 'workflow') => {
    if (kind === 'activity') activity += 1;
    notify(kind);
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(
    () =>
      storage.execution.runs
        .listForWorktree(state.workspaceId, cycle.worktreeId)
        .some((run) => run.status === 'finished' || run.status === 'waiting'),
    'the design turn ended',
  );
  // Three tool calls: three status transactions, though the run was never waiting.
  expect(statusCalls).toBe(3);
  expect(statusTransactions).toBe(3);
  // Each tool call and tool result notified on its own.
  expect(activity).toBeGreaterThanOrEqual(6);
});

it('does not lose a commit made between an empty query and the wait, with a long fallback', async () => {
  // As the stream service's own race test, but its fallback longer than the test, so only the
  // wake can bring the event (part 3 review MEDIUM-1: that test passes by its 25 ms timeout).
  const context = await createTestContext({ workers: false });
  contexts.push(context);
  const bootstrap = await context.services.bootstrapService.bootstrap(TEST_USERNAME, TEST_PASSWORD);
  const login = await context.login();
  let committed = false;
  const service = new WorkspaceEventStreamService(
    context.storage,
    context.services.authService,
    context.services.workspaceService,
    context.services.workspaceEventNotifier,
    {
      waitTimeoutMs: 600_000,
      afterEmptyQuery: () => {
        if (committed) return;
        committed = true;
        context.storage.transaction((tx) => {
          tx.workspaceEvents.appendWorkspaceCreated({
            id: asEventId(randomUUID()),
            occurredAt: new Date().toISOString(),
            workspaceId: bootstrap.workspace.id,
            actorUserId: bootstrap.user.id,
            name: 'Committed in race window',
            slug: 'race-window-long',
          });
        });
        context.services.workspaceEventNotifier.notify();
      },
    },
  );
  const controller = new AbortController();
  const iterator = service
    .stream({
      rawSessionToken: login.cookie.split('=')[1] as string,
      workspaceId: bootstrap.workspace.id,
      after: 1,
      signal: controller.signal,
    })
    [Symbol.asyncIterator]();
  const next = await iterator.next();
  controller.abort();
  expect(next.value).toMatchObject({ event: { payload: { name: 'Committed in race window' } } });
});
