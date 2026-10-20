import { InvariantError, type WorkCycle } from '@craftingtable/domain';
import { daemonDiagnosticsResponseSchema } from '@craftingtable/contracts';
import { afterEach, expect, it } from 'vitest';
import {
  type CycleFixture,
  createCycleFixture,
  item2,
  ManualClock,
  secondWorktree,
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

it.each([
  ['a round', false],
  ['the slow lane', true],
] as const)(
  'keeps a broken invariant met in %s in the log alone when the cycle changed meanwhile (decision 8)',
  async (_, workers) => {
    const { warnings, runLog } = logged();
    const f = await createCycleFixture({ workers, runLog });
    // A newer version, still running: only the version check skips the failure's write.
    brokenLaunch(f, async (cycle) => {
      const current = storedCycle(f, cycle.id);
      expect(
        f.context.storage.execution.cycles.replace(
          { ...current, version: current.version + 1 },
          current.version,
        ),
      ).toBeTruthy();
    });
    const cycle = await startCycle(f, f.worktreeId);
    if (!workers) await f.services.workCycleService.tick();
    const met = () =>
      warnings.some((w) => w.message === 'The cycle controller met a broken invariant');
    await waitUntil(met, 'the invariant logged');
    expect(storedCycle(f, cycle.id).status).toBe('running');
    expect(failureRows(f, cycle)).toEqual([]);
  },
);

it("logs a job's failure that cannot itself be recorded (increment 5 review LOW-1)", async () => {
  const { warnings, runLog } = logged();
  const f = await createCycleFixture({ workers: true, runLog });
  const service = f.services.workCycleService as unknown as { stopAfterFailure: () => void };
  service.stopAfterFailure = () => {
    throw new Error('the database is full');
  };
  f.services.agentRunService.startForCycle = async () => {
    throw new Error('unexpected');
  };
  const cycle = await startCycle(f, f.worktreeId);
  await waitUntil(
    () =>
      warnings.some((w) => w.message === 'The cycle controller could not record a job’s failure'),
    'the failure logged',
  );
  const warning = warnings.find((w) => w.message.startsWith('The cycle controller could not'));
  expect(warning?.detail).toMatchObject({ cycleId: cycle.id, workspaceId: f.workspaceId });
  expect(String(warning?.detail.error)).toContain('the database is full');
});

it('logs a slow job past ten minutes once, and reports it in the figures (design review L-13)', async () => {
  const clock = new ManualClock();
  const { warnings, runLog } = logged();
  const queue: (() => void)[] = [];
  let holding = false;
  const f = await createCycleFixture({
    workers: true,
    independent: true,
    now: clock.date,
    kernelClock: clock,
    runLog,
    git: (real) => ({
      ...real,
      resolveBranch: async (path, branch) => {
        if (holding) await new Promise<void>((resolve) => queue.push(resolve));
        return real.resolveBranch(path, branch);
      },
    }),
  });
  const other = await secondWorktree(f);
  const service = f.services.workCycleService;
  const long = () => warnings.filter((w) => w.message.startsWith('A cycle controller job'));
  holding = true;
  try {
    const a = await startCycle(f, f.worktreeId);
    await waitUntil(() => queue.length === 1, "A's launch is held");
    await startCycle({ ...f, workItemId: item2 }, other);
    await waitUntil(() => service.figures().lane.waiting === 1, 'B waits for the lane');
    clock.advance(10 * 60_000);
    let rounds = service.figures().rounds;
    clock.advance(1);
    // Ten minutes is not over ten minutes.
    expect(service.figures().lane).toMatchObject({ running: true, runningForMs: 10 * 60_000 + 1 });
    clock.advance(30_000);
    await waitUntil(() => long().length === 1, 'the long job logged');
    expect(long()[0]?.detail).toEqual({ cycleId: a.id });
    rounds = service.figures().rounds;
    clock.advance(30_000);
    await waitUntil(() => service.figures().rounds > rounds, 'a later round');
    expect(long()).toHaveLength(1);
  } finally {
    holding = false;
    for (const release of queue.splice(0)) release();
  }
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
  // A second hold nine minutes on, nested in the first, does not make the hold younger
  // (mutation round 4).
  clock.step(9 * 60_000);
  locks.holdForCommand(cycle.id);
  clock.step(-9 * 60_000);
  // Ten minutes is not over ten minutes; the sweep after it is. Each look waits for a round
  // to have run (review L-5).
  const service = f.services.workCycleService;
  const busy = () => {
    const state = service as unknown as { rounding: boolean; passing: unknown };
    return state.rounding || state.passing !== undefined;
  };
  const aRound = async () => {
    const rounds = service.figures().rounds;
    await waitUntil(() => service.figures().rounds > rounds, 'a round');
  };
  clock.advance(10 * 60_000 - 30_000);
  const tenMinutes = aRound();
  clock.advance(30_000);
  await tenMinutes;
  expect(held()).toEqual([]);
  clock.advance(30_000);
  await waitUntil(() => held().length === 1, 'the hold logged');
  // The round that logged it has ended before the next is awaited (mutation round 4).
  await waitUntil(() => !busy(), 'that round ended');
  const later = aRound();
  clock.advance(30_000);
  await later;
  expect(held()).toHaveLength(1);
  expect(held()[0]?.detail).toEqual({ cycleId: cycle.id });
  locks.releaseCommand(cycle.id);
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
  // The scheduler's and delivery's drains beside it (R-B5 part 2).
  expect(first.drains?.map((drain) => drain.name)).toEqual(['roadmaps', 'delivery']);
  const drain = (name: string) => first.drains?.find((d) => d.name === name);
  // Each drain's own kernel: the scheduler's marks and rounds, delivery's start mark.
  expect(drain('roadmaps')?.rounds).toBeGreaterThan(0);
  expect(drain('roadmaps')?.marks.find((mark) => mark.cause === 'start')?.count).toBe(1);
  expect(drain('delivery')?.marks.find((mark) => mark.cause === 'start')?.count).toBe(1);
  expect(drain('delivery')?.timers.due).toBeGreaterThanOrEqual(0);
  clock.advance(30_000);
  await waitUntil(
    () => kernelSweeps(f) === 1 && f.services.workCycleService.figures().rounds > first.rounds,
    "the sweep's round",
  );
  const second = await read();
  expect(second.marks.find((mark) => mark.cause === 'sweep')?.count).toBe(1);
  // The sweep reaches the other drains too.
  for (const d of second.drains ?? [])
    expect(d.marks.find((mark) => mark.cause === 'sweep')?.count, d.name).toBe(1);
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
