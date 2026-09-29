import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CheckRequestService, WorkflowQueue } from './check-request-service.js';

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

it("at start, removes declared checks' clones and build outputs a stopped daemon left, and keeps the logs (R-G13 review)", () => {
  const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ct-check-scratch-'));
  try {
    const run = join(root, 'run-1');
    for (const dir of ['declared-target/abc', 'a1.private/tree', 'replies'])
      mkdirSync(join(run, dir), { recursive: true });
    writeFileSync(join(run, 'a1.log'), 'log');
    new CheckRequestService(
      undefined as never,
      { checkConfinement: 'none', checkLogRoot: root, cargoHome: join(root, 'cargo') },
      { warn: () => undefined },
    ).stopLeftoverUnits();
    expect(existsSync(join(run, 'declared-target'))).toBe(false);
    expect(existsSync(join(run, 'a1.private'))).toBe(false);
    expect(existsSync(join(run, 'a1.log'))).toBe(true);
    expect(existsSync(join(run, 'replies'))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
