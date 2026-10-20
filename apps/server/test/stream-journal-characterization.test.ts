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

async function streaming(waitTimeoutMs?: number) {
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
      ...(waitTimeoutMs === undefined ? {} : { waitTimeoutMs }),
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
    workspaceId: bootstrap.workspace.id,
    userId: bootstrap.user.id,
    queries: () => queries,
    settled,
    stop: async () => {
      controller.abort();
      await pending.catch(() => undefined);
    },
  };
}

it("re-queries an open stream at its own workspace's events, not at every notification (flipped by increment 14)", async () => {
  // Before increment 14 every notification of any workspace, activity included, woke it.
  const stream = await streaming(60_000);
  expect(stream.queries()).toBe(1);
  stream.context.services.workspaceEventNotifier.notify('activity');
  stream.context.services.workspaceEventNotifier.notify();
  stream.context.services.workspaceEventNotifier.notifyKeys(['workspace:another']);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(stream.queries()).toBe(1);
  // Its workspace's event, committed, wakes it.
  stream.context.storage.transaction((tx) => {
    tx.workspaceEvents.appendWorkspaceCreated({
      id: asEventId(randomUUID()),
      occurredAt: new Date().toISOString(),
      workspaceId: stream.workspaceId as never,
      actorUserId: stream.userId as never,
      name: 'An event of its own',
      slug: 'own-event',
    });
  });
  await stream.settled(2);
  expect(stream.queries()).toBeGreaterThanOrEqual(2);
  await stream.stop();
});

it('re-queries an open stream every 30 s with nothing notified, not every second (flipped by increment 14)', async () => {
  // Before increment 14, at least three times in 2.3 s.
  const stream = await streaming();
  await new Promise((resolve) => setTimeout(resolve, 2_300));
  expect(stream.queries()).toBe(1);
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

/** A turn's result, then a message after it: the run waits, then the message moves it on. */
const resultThenMore = {
  resultText: '',
  claudeStream: [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Working.' }] } },
    { type: 'result', subtype: 'success', result: designDone.resultText },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'One more thing.' }] } },
  ],
};

it('writes each agent event in its own transaction, opening a status transaction only for a waiting run, with one notification per macrotask (flipped by increment 15)', async () => {
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
    // Outermost only: a nested call is a savepoint of the same commit.
    if (inTransition && !storage.inTransaction) statusTransactions += 1;
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
  // Before increment 15: three status transactions though the run never waited, and an
  // `activity` notification for each of the six events. Now: none, and one per macrotask.
  expect(statusCalls).toBe(0);
  expect(statusTransactions).toBe(0);
  expect(activity).toBeGreaterThanOrEqual(1);
  expect(activity).toBeLessThan(6);
});

it('moves a waiting run back to running at its next message, a status transaction for each (increment 15)', async () => {
  // A result, then the agent goes on (as Claude does when background work outlives the result).
  const { state, worktree } = await cycleFixture([resultThenMore]);
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
    // Outermost only: a nested call is a savepoint of the same commit.
    if (inTransition && !storage.inTransaction) statusTransactions += 1;
    return open(callback);
  }) as typeof storage.transaction;
  const cycle = await startCycle(state, worktree.id);
  // The message after the result moves the waiting run on: once.
  await waitFor(() => statusCalls >= 1, 'the message after the result');
  await waitFor(
    () =>
      storage.execution.runs
        .listForWorktree(state.workspaceId, cycle.worktreeId)
        .some((run) => run.status === 'running'),
    'the run running again',
  );
  // One status transaction per message that found the run waiting (the scripted agent repeats
  // its reply in the cycle's next turn, which waits and moves on again), and no other.
  expect(statusCalls).toBeGreaterThanOrEqual(1);
  expect(statusTransactions).toBe(statusCalls);
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
        // No notification of its own since increment 14: the channel's, from the commit.
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
