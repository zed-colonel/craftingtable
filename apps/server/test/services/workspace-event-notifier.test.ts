import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceEventNotifier } from '../../src/services/workspace-event-notifier.js';

afterEach(() => vi.useRealTimers());

it('streams activity immediately without waking workflow evaluators', async () => {
  const notifier = new WorkspaceEventNotifier();
  const abort = new AbortController();
  const workflow = vi.fn();
  const stream = vi.fn();
  const options = { timeoutMs: 5000, signal: abort.signal };
  const waiting = notifier
    .waitForChangeOrTimeout({
      ...options,
      channel: 'workflow',
      generation: notifier.workflowGeneration,
    })
    .then(workflow);
  const streaming = notifier
    .waitForChangeOrTimeout({ ...options, generation: notifier.generation })
    .then(stream);
  notifier.notify('activity');
  await streaming;
  expect(stream).toHaveBeenCalledOnce();
  expect(workflow).not.toHaveBeenCalled();
  notifier.notify();
  await waiting;
  expect(workflow).toHaveBeenCalledOnce();
});

it('does not miss workflow changes before waiting, and retains timeout/abort wakeups', async () => {
  vi.useFakeTimers();
  const notifier = new WorkspaceEventNotifier();
  const abort = new AbortController();
  const options = { channel: 'workflow' as const, timeoutMs: 5000, signal: abort.signal };
  const generation = notifier.workflowGeneration;
  notifier.notify();
  await notifier.waitForChangeOrTimeout({ ...options, generation });
  const done = vi.fn();
  const wait = notifier
    .waitForChangeOrTimeout({ ...options, generation: notifier.workflowGeneration })
    .then(done);
  notifier.notify('activity');
  await vi.advanceTimersByTimeAsync(4999);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await wait;
  const cancelled = notifier.waitForChangeOrTimeout({
    ...options,
    generation: notifier.workflowGeneration,
  });
  abort.abort();
  await cancelled;
  expect(vi.getTimerCount()).toBe(0);
});
