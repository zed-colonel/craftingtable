import { expect, it } from 'vitest';
import { writeMarks } from '../../src/services/kernel/write-marks.js';

/**
 * Which committed writes wake the cycle controller (R-B5, decision 2): everything but an agent's
 * activity, attention, deliveries, audit and workspace events; a transaction that rolls back
 * wakes nothing; one that wrote only tables the storage guard does not report wakes; a write
 * outside any transaction wakes once its task ends.
 */

type Kind = Parameters<ReturnType<typeof writeMarks>['written']>[0];
const observer = () => {
  let wakes = 0;
  const marks = writeMarks(() => {
    wakes += 1;
  });
  return { marks, wakes: () => wakes };
};
const settled = () => new Promise((resolve) => setImmediate(resolve));

it('wakes on a committed write that is not only quiet', async () => {
  const { marks, wakes } = observer();
  marks.written('work-cycle' as Kind, {} as never);
  marks.written('audit-event' as Kind, {} as never);
  marks.ended(true);
  await settled();
  expect(wakes()).toBe(1);
});

it('does not wake on quiet writes alone', async () => {
  const { marks, wakes } = observer();
  for (const kind of [
    'attention-item',
    'notification-delivery',
    'notification-record',
    'audit-event',
    'workspace-event',
  ])
    marks.written(kind as Kind, {} as never);
  marks.written('run-event' as Kind, { kind: 'tool-call' } as never);
  marks.written('run-event' as Kind, { kind: 'assistant-message' } as never);
  marks.ended(true);
  await settled();
  expect(wakes()).toBe(0);
});

it("wakes on the run events today's journal wakes the controller for", async () => {
  for (const kind of ['session-started', 'turn-completed', 'run-finished']) {
    const { marks, wakes } = observer();
    marks.written('run-event' as Kind, { kind } as never);
    marks.ended(true);
    await settled();
    expect(wakes(), kind).toBe(1);
  }
});

it('wakes nothing for a transaction that rolls back', async () => {
  const { marks, wakes } = observer();
  marks.written('work-cycle' as Kind, {} as never);
  marks.ended(false);
  await settled();
  expect(wakes()).toBe(0);
});

it('wakes for a committed transaction that reported no write (an unguarded table)', async () => {
  const { marks, wakes } = observer();
  marks.ended(true);
  await settled();
  expect(wakes()).toBe(1);
});

it('wakes once for writes outside any transaction, when their task ends', async () => {
  const { marks, wakes } = observer();
  marks.written('work-cycle' as Kind, {} as never);
  marks.written('worktree' as Kind, {} as never);
  expect(wakes()).toBe(0);
  await settled();
  expect(wakes()).toBe(1);
  // A quiet write outside a transaction wakes nothing, and leaves nothing for the next commit.
  marks.written('audit-event' as Kind, {} as never);
  await settled();
  marks.written('audit-event' as Kind, {} as never);
  marks.ended(true);
  await settled();
  expect(wakes()).toBe(1);
});
