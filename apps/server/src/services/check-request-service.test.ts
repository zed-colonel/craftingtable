import { expect, it } from 'vitest';
import { WorkflowQueue } from './check-request-service.js';

const never = new AbortController().signal;
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

it('runs one holder of a workflow at a time, in order, and says who it waits for (R-G4, LIVE-03)', async () => {
  const queue = new WorkflowQueue();
  const events: string[] = [];
  const waits: string[] = [];
  const hold = (holder: string) =>
    queue
      .hold('w', holder, Date.now() + 60_000, never, (h) => waits.push(`${holder}<-${h}`))
      .then((release) => {
        events.push(`start ${holder}`);
        return release;
      });
  const first = await hold('a');
  const second = hold('b');
  const third = hold('c');
  await tick();
  expect(events).toEqual(['start a']);
  first();
  const releaseSecond = await second;
  await tick();
  expect(events).toEqual(['start a', 'start b']);
  releaseSecond();
  (await third)();
  expect(events).toEqual(['start a', 'start b', 'start c']);
  expect(waits).toEqual(['b<-a', 'c<-b']);
  // Another workflow never waits.
  (await queue.hold('other', 'd', Date.now() + 1000, never, () => waits.push('d')))();
  expect(waits).toHaveLength(2);
});

it('a waiter that gives up keeps the order: no one behind it starts before the holder ends (R-G4)', async () => {
  const queue = new WorkflowQueue();
  const releaseA = await queue.hold('w', 'a', Date.now() + 60_000, never, () => undefined);
  const expired = queue.hold('w', 'b', Date.now() + 20, never, () => undefined);
  const cancel = new AbortController();
  const cancelled = queue.hold('w', 'c', Date.now() + 60_000, cancel.signal, () => undefined);
  let dStarted = false;
  const d = queue
    .hold('w', 'd', Date.now() + 60_000, never, () => undefined)
    .then((release) => {
      dStarted = true;
      return release;
    });
  await expect(expired).rejects.toThrow('held this workflow');
  cancel.abort();
  await expect(cancelled).rejects.toThrow('Interrupted');
  await tick();
  expect(dStarted).toBe(false);
  releaseA();
  (await d)();
  expect(dStarted).toBe(true);
});
