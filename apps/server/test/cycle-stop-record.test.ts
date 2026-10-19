import { cycleAttention, heldStop, stopRecord, type WorkCycle } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { restoredStatus } from '../src/services/cycle/core/commands.js';
import { CycleTransitionError } from '../src/services/cycle/core/transitions.js';
import { type CycleFixture, createCycleFixture, storedCycle } from './cycle-test-support.js';
import { cleanupExecutionFixtures, startCycle } from './execution-test-support.js';

/**
 * The stop record's times as the writer keeps them (R-B4b increment 2 review, MEDIUM-1, LOW-1,
 * LOW-2). A stop's `since` is when the cycle entered the status that carries it, as migration
 * 0047 reads it from the audit: a write that keeps the status keeps it, and so does a pause at
 * the stop; entering the status again begins it anew. Undoing a reservation puts the record back
 * as it was. Each row first stamps the stored stop with a time no write could make, so a kept
 * `since` is told from a new one.
 */

afterEach(cleanupExecutionFixtures);

const EARLIER = '2026-01-01T00:00:00.000Z';

type Writer = {
  change: (cycle: WorkCycle, changes: Record<string, unknown>, action?: string) => WorkCycle;
  refreshAttention: (cycle: WorkCycle) => WorkCycle;
};

async function stopped(): Promise<{ f: CycleFixture; writer: Writer; cycle: WorkCycle }> {
  const f = await createCycleFixture();
  const started = await startCycle(f, f.worktreeId);
  const writer = (f.services.workCycleService as unknown as { writer: Writer }).writer;
  const cycle = writer.change(started, {
    status: 'needs-attention',
    attention: cycleAttention('step-incomplete'),
    reason: 'Inspect the step.',
  });
  return { f, writer, cycle: stamped(f, cycle) };
}

/** Rewrites the stored stop's start (or end) to `EARLIER`, in place. */
function stamped(f: CycleFixture, cycle: WorkCycle, stop = cycle.stop): WorkCycle {
  const record =
    stop?.kind === 'ended' ? { ...stop, at: EARLIER } : stop && { ...stop, since: EARLIER };
  const updated = { ...cycle, stop: record, version: cycle.version + 1 };
  expect(f.context.storage.execution.cycles.replace(updated, cycle.version)).toBeTruthy();
  return storedCycle(f, cycle.id);
}

const since = (cycle: WorkCycle) =>
  cycle.stop?.kind === 'ended' ? cycle.stop.at : cycle.stop?.since;

it('begins a stop when its status is entered, and keeps that start while the status holds', async () => {
  const { f, writer, cycle } = await stopped();
  const fresh = storedCycle(f, cycle.id);
  expect(fresh.stop).toMatchObject({ kind: 'attention', code: 'step-incomplete', since: EARLIER });
  // Declared again at the same status, with another code: the status's start, as 0047 reads it.
  const recoded = writer.change(fresh, {
    status: 'needs-attention',
    attention: cycleAttention('implementation-open-questions'),
    reason: 'Answer the questions.',
  });
  expect(recoded.stop).toMatchObject({ code: 'implementation-open-questions', since: EARLIER });
  // A pause at the stop keeps it, and its start.
  const paused = writer.change(
    recoded,
    { status: 'paused', attention: heldStop(recoded), reason: 'Paused.' },
    'pause',
  );
  expect(paused.stop).toMatchObject({ code: 'implementation-open-questions', since: EARLIER });
  // Resumed to the stop, the cycle enters its status again: the stop begins now.
  const resumed = writer.change(
    paused,
    { status: 'needs-attention', attention: heldStop(paused), reason: 'Answer the questions.' },
    'resume',
  );
  expect(resumed.stop?.code).toBe('implementation-open-questions');
  expect(since(resumed)).not.toBe(EARLIER);
  expect(since(resumed)).toBe(resumed.updatedAt);
});

it("keeps a stop's start when its attention is refreshed", async () => {
  const { f, writer, cycle } = await stopped();
  // A claim nothing makes any more: the refresh writes the stop without it.
  const claimed = stamped(
    f,
    cycle,
    stopRecord(cycleAttention('step-incomplete', undefined, { claim: 'scope-recovery' }), EARLIER),
  );
  const refreshed = writer.refreshAttention(claimed);
  expect(refreshed).not.toBe(claimed);
  expect(storedCycle(f, cycle.id).stop).toEqual(
    stopRecord(cycleAttention('step-incomplete'), EARLIER),
  );
});

it('puts back the stop or end an undone reservation replaced, as stored', async () => {
  const { f, writer, cycle } = await stopped();
  // A stop: reserved by a resume, then undone.
  const running = writer.change(cycle, { status: 'running', reason: 'Resumed.' }, 'resume');
  const undone = writer.change(running, { ...restoredStatus(cycle), reason: cycle.reason });
  expect(undone.status).toBe('needs-attention');
  expect(undone.stop).toEqual(cycle.stop);
  // A pause's kept stop.
  const paused = stamped(
    f,
    writer.change(
      undone,
      { status: 'paused', attention: heldStop(undone), reason: 'Paused.' },
      'pause',
    ),
  );
  const unpaused = writer.change(paused, { status: 'running', reason: 'Resumed.' }, 'resume');
  expect(
    writer.change(unpaused, { ...restoredStatus(paused), reason: paused.reason }).stop,
  ).toEqual(paused.stop);
  // An end, reopened by review again and undone.
  const completed = stamped(
    f,
    writer.change(storedCycle(f, cycle.id), {
      status: 'completed',
      end: 'scope-evidence-recorded',
      reason: 'Done.',
    }),
  );
  const reviewing = writer.change(
    completed,
    { status: 'running', reason: 'Reviewing again.' },
    'review-again',
  );
  const restored = writer.change(reviewing, {
    ...restoredStatus(completed),
    reason: completed.reason,
  });
  expect(restored.stop).toEqual({ kind: 'ended', code: 'scope-evidence-recorded', at: EARLIER });
});

it('refuses an end in the status another end code names', async () => {
  const { f, writer, cycle } = await stopped();
  expect(() =>
    writer.change(cycle, { status: 'completed', end: 'operator-stopped', reason: 'Done.' }),
  ).toThrow(CycleTransitionError);
  expect(() =>
    writer.change(cycle, { status: 'stopped', end: 'integrated', reason: 'Stopped.' }, 'stop'),
  ).toThrow(CycleTransitionError);
  expect(storedCycle(f, cycle.id)).toEqual(cycle);
});

it('removes the waits record once every wait in it is cleared (increment 2 review, LOW-4)', async () => {
  const { f, writer, cycle } = await stopped();
  const waiting = writer.change(cycle, {
    waits: {
      phase: { since: EARLIER, blockers: [] },
      design: { since: EARLIER, requirements: [{ kind: 'slice', id: 'wi/A', state: 'merged' }] },
    },
  });
  expect(Object.keys(waiting.waits ?? {})).toEqual(['phase', 'design']);
  const one = writer.change(waiting, { waits: { phase: null } });
  expect(one.waits).toEqual({
    design: { since: EARLIER, requirements: [{ kind: 'slice', id: 'wi/A', state: 'merged' }] },
  });
  writer.change(one, { waits: { design: null } });
  expect('waits' in storedCycle(f, cycle.id)).toBe(false);
});
