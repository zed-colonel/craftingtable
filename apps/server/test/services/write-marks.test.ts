import { expect, it } from 'vitest';
import { writeMarks } from '../../src/services/kernel/write-marks.js';

/**
 * Which committed writes wake the cycle controller (R-B5, decision 2): everything but an agent's
 * activity, attention, deliveries, audit and workspace events; a transaction that rolls back
 * wakes nothing; one that wrote only tables the storage guard does not report wakes; a write
 * outside any transaction wakes once its task ends.
 */

type Kind = Parameters<ReturnType<typeof writeMarks>['written']>[0];
const observer = (inTransaction = true) => {
  let wakes = 0;
  let open = inTransaction;
  const marks = writeMarks(
    () => {
      wakes += 1;
    },
    () => open,
  );
  return {
    marks,
    wakes: () => wakes,
    open: (value: boolean) => {
      open = value;
    },
  };
};
const settled = () => new Promise((resolve) => setImmediate(resolve));

it('wakes on a committed write that is not only quiet', async () => {
  const { marks, wakes } = observer();
  marks.written('work-cycle' as Kind, {} as never);
  marks.written('audit-event' as Kind, {} as never);
  marks.ended(true, 1);
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
  marks.ended(true, 1);
  await settled();
  expect(wakes()).toBe(0);
});

it("wakes on the run events today's journal wakes the controller for", async () => {
  for (const kind of ['session-started', 'turn-completed', 'run-finished']) {
    const { marks, wakes } = observer();
    marks.written('run-event' as Kind, { kind } as never);
    marks.ended(true, 1);
    await settled();
    expect(wakes(), kind).toBe(1);
  }
});

it('wakes nothing for a transaction that rolls back', async () => {
  const { marks, wakes } = observer();
  marks.written('work-cycle' as Kind, {} as never);
  marks.ended(false, 0);
  await settled();
  expect(wakes()).toBe(0);
});

it('wakes for a committed transaction that changed rows the guard does not report', async () => {
  const { marks, wakes } = observer();
  marks.ended(true, 2);
  await settled();
  expect(wakes()).toBe(1);
});

it('wakes for rows the guard does not report beside quiet guarded writes', async () => {
  // A phase reservation's release beside its audit row: two rows changed, one reported.
  const { marks, wakes } = observer();
  marks.written('audit-event' as Kind, {} as never);
  marks.ended(true, 2);
  await settled();
  expect(wakes()).toBe(1);
});

it('does not wake for a committed transaction that changed nothing (review MEDIUM-1)', async () => {
  const { marks, wakes } = observer();
  marks.ended(true, 0);
  await settled();
  expect(wakes()).toBe(0);
});

it('wakes once for writes outside any transaction, when their task ends', async () => {
  const { marks, wakes, open } = observer(false);
  marks.written('work-cycle' as Kind, {} as never);
  marks.written('worktree' as Kind, {} as never);
  expect(wakes()).toBe(0);
  await settled();
  expect(wakes()).toBe(1);
  // A quiet write outside a transaction wakes nothing and leaves nothing for the next commit
  // (review LOW-1): a transaction of quiet writes and unguarded rows still wakes for the rows.
  marks.written('audit-event' as Kind, {} as never);
  open(true);
  marks.ended(true, 1);
  await settled();
  expect(wakes()).toBe(2);
  // Nor does a waking write outside one leave a flag for a transaction that rolls back.
  open(false);
  marks.written('work-cycle' as Kind, {} as never);
  open(true);
  marks.written('work-cycle' as Kind, {} as never);
  marks.ended(false, 0);
  await settled();
  expect(wakes()).toBe(3);
});
