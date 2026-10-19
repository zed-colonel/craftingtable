import { InvariantError, type WorkCycle } from '@craftingtable/domain';
import { daemonDiagnosticsResponseSchema } from '@craftingtable/contracts';
import { afterEach, expect, it } from 'vitest';
import {
  type CycleFixture,
  createCycleFixture,
  ManualClock,
  storedCycle,
} from './cycle-test-support.js';
import { cleanupExecutionFixtures, startCycle, waitUntil } from './execution-test-support.js';

/**
 * What the controller tells the operator of itself (R-B5 increment 7): a broken invariant logged
 * and named in the step history (decision 8), a job or a command's hold that lasts over ten
 * minutes logged once (design review L-13, increment 5 review LOW-5), and its figures in the
 * owner-only diagnostics (decision 9).
 */

afterEach(cleanupExecutionFixtures);

type Warning = { readonly message: string; readonly detail: Readonly<Record<string, unknown>> };
const logged = () => {
  const warnings: Warning[] = [];
  return {
    warnings,
    runLog: {
      warn: (message: string, detail: Readonly<Record<string, unknown>> = {}) => {
        warnings.push({ message, detail });
      },
    },
  };
};

const failureRows = (f: CycleFixture, cycle: WorkCycle) =>
  f.context.storage.audit
    .listCycleTransitions(f.workspaceId, '2000-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z')
    .filter((row) => row.cycleId === cycle.id && row.decision === 'failure')
    .map((row) => row.metadata);

const brokenLaunch = (f: CycleFixture, before?: (cycle: WorkCycle) => Promise<void>) => {
  f.services.agentRunService.startForCycle = async (cycle: WorkCycle) => {
    await before?.(cycle);
    throw new InvariantError('the plan version of the work item');
  };
};

it.each([
  ['a round', false],
  ['the slow lane', true],
] as const)(
  'logs a broken invariant met in %s and names it in the step history (decision 8)',
  async (_, workers) => {
    const { warnings, runLog } = logged();
    const f = await createCycleFixture({ workers, runLog });
    brokenLaunch(f);
    const cycle = await startCycle(f, f.worktreeId);
    if (!workers) await f.services.workCycleService.tick();
    await waitUntil(
      () => storedCycle(f, cycle.id).stop?.code === 'controller-error',
      'the controller-error stop',
    );
    // The stop keeps its code and its text.
    expect(storedCycle(f, cycle.id).reason).toBe(
      'Controller could not advance this step. Inspect the run before resuming.',
    );
    expect(failureRows(f, cycle).map((row) => row.invariant)).toEqual([
      'the plan version of the work item',
    ]);
    const warning = warnings.find(
      (w) => w.message === 'The cycle controller met a broken invariant',
    );
    expect(warning?.detail).toMatchObject({
      cycleId: cycle.id,
      workspaceId: f.workspaceId,
      guard: 'no-run',
      decision: 'start-run',
      invariant: 'Invariant failed: the plan version of the work item',
    });
    expect(String(warning?.detail.stack)).toContain('InvariantError');
  },
);

it('keeps a broken invariant in the log alone when the cycle changed meanwhile (decision 8)', async () => {
  const { warnings, runLog } = logged();
  const f = await createCycleFixture({ runLog });
  brokenLaunch(f, async (cycle) => {
    const response = await f.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.workspaceId}/cycles/${cycle.id}/control`,
      headers: f.headers,
      payload: { action: 'pause', expectedVersion: storedCycle(f, cycle.id).version },
    });
    expect(response.statusCode, response.body).toBe(200);
  });
  const cycle = await startCycle(f, f.worktreeId);
  await f.services.workCycleService.tick();
  expect(storedCycle(f, cycle.id).status).toBe('paused');
  expect(failureRows(f, cycle).filter((row) => row.status !== 'paused')).toEqual([]);
  expect(failureRows(f, cycle).some((row) => row.invariant !== undefined)).toBe(false);
  expect(warnings.map((w) => w.message)).toContain('The cycle controller met a broken invariant');
});

it('records no invariant for an unexpected failure that is not one', async () => {
  const { warnings, runLog } = logged();
  const f = await createCycleFixture({ runLog });
  f.services.agentRunService.startForCycle = async () => {
    throw new Error('unexpected');
  };
  const cycle = await startCycle(f, f.worktreeId);
  await f.services.workCycleService.tick();
  expect(storedCycle(f, cycle.id).stop?.code).toBe('controller-error');
  expect(failureRows(f, cycle).map((row) => row.invariant)).toEqual([undefined]);
  expect(warnings).toEqual([]);
});

it("logs a command's hold older than ten minutes once (increment 5 review LOW-5)", async () => {
  const clock = new ManualClock();
  const { warnings, runLog } = logged();
  const f = await createCycleFixture({
    workers: true,
    now: clock.date,
    kernelClock: clock,
    runLog,
  });
  const cycle = await startCycle(f, f.worktreeId);
  const locks = (
    f.services.workCycleService as unknown as {
      locks: { holdForCommand(id: string): void; releaseCommand(id: string): void };
    }
  ).locks;
  locks.holdForCommand(cycle.id);
  const held = () => warnings.filter((w) => w.message.startsWith('A command has held'));
  // Ten minutes is not over ten minutes; the sweep after it is.
  clock.advance(10 * 60_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(held()).toEqual([]);
  clock.advance(30_000);
  await waitUntil(() => held().length === 1, 'the hold logged');
  clock.advance(60_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(held()).toHaveLength(1);
  expect(held()[0]?.detail).toEqual({ cycleId: cycle.id });
  locks.releaseCommand(cycle.id);
});

it("reports the controller's figures in the owner-only diagnostics (decision 9)", async () => {
  const clock = new ManualClock();
  const f = await createCycleFixture({ workers: true, now: clock.date, kernelClock: clock });
  const read = async () => {
    const response = await f.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${f.workspaceId}/diagnostics`,
      headers: f.headers,
    });
    expect(response.statusCode, response.body).toBe(200);
    const controller = daemonDiagnosticsResponseSchema.parse(response.json()).controller;
    if (!controller) throw new Error('no controller section');
    return controller;
  };
  const cycle = await startCycle(f, f.worktreeId);
  await waitUntil(
    () => storedCycle(f, cycle.id).currentRunId !== undefined && f.backend.sessions.length === 1,
    'the design run started',
  );
  const first = await read();
  const causes = new Map(first.marks.map((mark) => [mark.cause, mark.count]));
  expect(causes.get('start')).toBe(1);
  expect(causes.get('write')).toBeGreaterThan(0);
  expect(first.rounds).toBeGreaterThan(0);
  expect(first.lastMinute.rounds).toBeGreaterThan(0);
  expect(first.lane).toMatchObject({ running: false, waiting: 0 });
  expect(first.lane.jobs).toBeGreaterThan(0);
  // The running step's deadline is the one due time.
  expect(first.timers.due).toBe(1);
  expect(first.timers.nextDueInMs).toBe(
    Date.parse(storedCycle(f, cycle.id).runDeadlineAt) - clock.now(),
  );
  expect(first.lastSweepAgoMs).toBeUndefined();
  clock.advance(30_000);
  await waitUntil(
    () => kernelSweeps(f) === 1 && f.services.workCycleService.figures().rounds > first.rounds,
    "the sweep's round",
  );
  const second = await read();
  expect(second.marks.find((mark) => mark.cause === 'sweep')?.count).toBe(1);
  expect(second.lastSweepAgoMs).toBe(0);
  // Counters only grow: a phase's figures are the difference of two reads.
  for (const mark of first.marks)
    expect(second.marks.find((m) => m.cause === mark.cause)?.count).toBeGreaterThanOrEqual(
      mark.count,
    );
});

const kernelSweeps = (f: CycleFixture) =>
  (
    f.services.workCycleService as unknown as {
      kernel: { causes: ReadonlyMap<string, number> };
    }
  ).kernel.causes.get('sweep') ?? 0;
