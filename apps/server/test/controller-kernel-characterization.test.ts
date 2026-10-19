import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WorkCycle } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { TypedRefusalError } from '../src/services/errors.js';
import {
  type CycleFixture,
  createCycleFixture,
  item2,
  ManualClock,
  secondWorktree,
  storedCycle,
  storedRun,
} from './cycle-test-support.js';
import {
  cleanupExecutionFixtures,
  designDone,
  startCycle,
  waitUntil,
} from './execution-test-support.js';

/**
 * What the controller's timing and ordering are today, where the replays cannot pin them
 * (R-B5 increment 1, characterize before refactoring). The replays step `tick()` and record
 * `decide()`; these pin what the free-running loop does between and around passes: the one-second
 * loop finding a deadline by itself, a slow launch holding up every other cycle, a stop or pause
 * that a launch past its preflight does not see, the seam's one pass, a drain's outcomes and a
 * command's transition. The assertions marked "flips" change with R-B5's part 1, as its entry says.
 */

afterEach(cleanupExecutionFixtures);

async function control(f: CycleFixture, cycle: WorkCycle, action: 'stop' | 'pause') {
  const response = await f.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.workspaceId}/cycles/${cycle.id}/control`,
    headers: f.headers,
    payload: { action, expectedVersion: storedCycle(f, cycle.id).version },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/**
 * Whether the cycles worker, by itself, lets a push opened at `opened` go: a pass begun after it
 * completed, or nothing to look at. Other workers are left out, so the roadmap worker's own
 * pace cannot stand in for it (mutation round 4).
 */
function cyclesQuiet(f: CycleFixture, opened: number): boolean {
  const passes = f.services.controllerPasses as unknown as {
    workers: ReadonlyMap<string, number>;
    idle: ReadonlyMap<string, () => boolean>;
  };
  return (passes.workers.get('cycles') ?? -1) > opened || passes.idle.get('cycles')?.() === true;
}

/** The cycle's reserved run is recorded and its session has started. */
const runLive = (f: CycleFixture, cycle: WorkCycle) =>
  storedRun(f, storedCycle(f, cycle.id).currentRunId)?.status === 'running';

/** Writes the cycle's step deadline into the past, as time passing would, and nothing else. */
function deadlinePassed(f: CycleFixture, cycle: WorkCycle): void {
  const current = storedCycle(f, cycle.id);
  const moved = {
    ...current,
    runDeadlineAt: new Date(Date.now() - 1000).toISOString(),
    version: current.version + 1,
  };
  expect(f.context.storage.execution.cycles.replace(moved, current.version)).toBeTruthy();
}

it('finds a passed step deadline by itself, with nothing written (its due time, R-B5)', async () => {
  // Since increment 3 the loop's one-second look is the kernel's due time: only the clock moves,
  // and the deadline's timer marks the cycle (`controller-kernel-marks.test.ts` has the rest).
  const clock = new ManualClock();
  const f = await createCycleFixture({ workers: true, now: clock.date, kernelClock: clock });
  const cycle = await startCycle(f, f.worktreeId);
  await waitUntil(() => runLive(f, cycle), 'the design run is live');
  const generation = f.services.workspaceEventNotifier.workflowGeneration;
  const deadline = Date.parse(storedCycle(f, cycle.id).runDeadlineAt);
  clock.advance(deadline - clock.now() - 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // Up to the deadline nothing is written or notified, and the cycle runs.
  expect(f.services.workspaceEventNotifier.workflowGeneration).toBe(generation);
  expect(storedCycle(f, cycle.id).status).toBe('running');
  clock.advance(1000);
  await waitUntil(
    () => storedCycle(f, cycle.id).stop?.code === 'step-time-limit',
    'the deadline stop',
  );
});

/** A free-running daemon whose Git preflight (`resolveBranch`) can be held, and a second item. */
async function heldPreflight() {
  const gate: { held?: Promise<void>; entered: boolean; release: () => void } = {
    entered: false,
    release: () => undefined,
  };
  const f = await createCycleFixture({
    workers: true,
    independent: true,
    git: (real) => ({
      ...real,
      resolveBranch: async (path, branch) => {
        if (gate.held) {
          gate.entered = true;
          await gate.held;
        }
        return real.resolveBranch(path, branch);
      },
    }),
  });
  const hold = () => {
    gate.held = new Promise((resolve) => {
      gate.release = () => {
        gate.held = undefined;
        resolve();
      };
    });
  };
  return { f, gate, hold, other: await secondWorktree(f) };
}

it("enforces another cycle's deadline while one launch waits in its Git preflight (the done-when; flipped by the slow lane)", async () => {
  // Before increment 5 the pass awaited A's launch, and B's passed deadline waited for it.
  const { f, gate, hold, other } = await heldPreflight();
  const b = await startCycle({ ...f, workItemId: item2 }, other);
  await waitUntil(() => runLive(f, b), "B's design run is live");
  hold();
  try {
    const a = await startCycle(f, f.worktreeId);
    await waitUntil(() => gate.entered, "A's launch is held in its Git preflight");
    // The held call is A's preflight: its cancel is registered for exactly that window.
    const launches = (
      f.services.agentRunService as unknown as {
        state: { pendingCycleLaunches: ReadonlyMap<string, unknown> };
      }
    ).state.pendingCycleLaunches;
    expect(launches.has(storedCycle(f, a.id).currentRunId)).toBe(true);
    deadlinePassed(f, b);
    // B's stop is written while A's preflight is still held: an ordering, not a time bound.
    await waitUntil(
      () => storedCycle(f, b.id).stop?.code === 'step-time-limit',
      "B's deadline stop while A is held",
    );
    expect(gate.held).toBeDefined();
    expect(storedRun(f, storedCycle(f, a.id).currentRunId)).toBeUndefined();
  } finally {
    gate.release();
  }
});

it('enforces the deadline of a cycle waiting for the slow lane behind a held launch (H-2)', async () => {
  const { f, gate, hold, other } = await heldPreflight();
  hold();
  try {
    const a = await startCycle(f, f.worktreeId);
    await waitUntil(() => gate.entered, "A's launch is held in its Git preflight");
    // B's reserved step needs the lane too: it waits, decided afresh, not queued with its launch.
    const b = await startCycle({ ...f, workItemId: item2 }, other);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(storedRun(f, storedCycle(f, b.id).currentRunId)).toBeUndefined();
    deadlinePassed(f, b);
    await waitUntil(
      () => storedCycle(f, b.id).stop?.code === 'step-time-limit',
      "B's deadline stop while it waits for the lane",
    );
    expect(gate.held).toBeDefined();
    expect(storedRun(f, storedCycle(f, a.id).currentRunId)).toBeUndefined();
  } finally {
    gate.release();
  }
  // Once A's launch returns, A's agent starts; B, stopped, launches nothing.
  await waitUntil(() => f.backend.sessions.length === 1, "A's agent started");
});

it("completes a cycles pass only when the round's slow job has ended (pushes wait for it, M-1)", async () => {
  const { f, gate, hold } = await heldPreflight();
  hold();
  try {
    await startCycle(f, f.worktreeId);
    await waitUntil(() => gate.entered, "A's launch is held in its Git preflight");
    // An item opened now (a stop the launch's job may yet take over): no cycles pass completes
    // while the job runs, whatever else marks a round meanwhile.
    const opened = f.services.controllerPasses.current;
    f.services.workCycleService.wake('test');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cyclesQuiet(f, opened)).toBe(false);
  } finally {
    gate.release();
  }
  await waitUntil(() => f.backend.sessions.length === 1, 'the agent started');
});

it.each(['stop', 'pause'] as const)(
  'withdraws a launch past its record on %s: no agent starts (decision 7; flipped by the launch job)',
  async (action) => {
    // Before increment 5 the launch went on and started its agent; a paused cycle's kept running.
    let held: Promise<void> | undefined;
    let entered = false;
    let release: () => void = () => undefined;
    const f = await createCycleFixture({
      workers: true,
      git: (real) => ({
        ...real,
        // The run's protected-ref snapshot, after its record and before its session (spawn.ts).
        branchHeads: async (...args: Parameters<typeof real.branchHeads>) => {
          if (held) {
            entered = true;
            await held;
          }
          return real.branchHeads(...args);
        },
      }),
    });
    held = new Promise((resolve) => {
      release = resolve;
    });
    let cycle: WorkCycle;
    try {
      cycle = await startCycle(f, f.worktreeId);
      await waitUntil(() => entered, 'the launch is past its record');
      expect(storedRun(f, storedCycle(f, cycle.id).currentRunId)).toBeDefined();
      await control(f, cycle, action);
    } finally {
      held = undefined;
      release();
    }
    const runId = storedCycle(f, cycle.id).currentRunId;
    await waitUntil(() => storedRun(f, runId)?.status === 'cancelled', 'the run withdrawn');
    expect(f.backend.sessions).toHaveLength(0);
    expect(storedCycle(f, cycle.id).status).toBe(action === 'stop' ? 'stopped' : 'paused');
  },
);

it('takes each active cycle once per tick: a write during the pass waits for the next (the seam)', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  const seen: string[] = [];
  f.services.workCycleService.observePass({ cycle: (c) => seen.push(c.id) });
  await f.services.workCycleService.tick();
  // The pass launched the reserved step (a write and a session start), and took the cycle once.
  expect(seen).toEqual([cycle.id]);
  expect(f.backend.sessions).toHaveLength(1);
  expect(storedRun(f, storedCycle(f, cycle.id).currentRunId)).toBeDefined();
  f.services.workCycleService.observePass(undefined);
});

it('takes the active cycles in their order, one after another, and passes again after a write', async () => {
  const f = await createCycleFixture({ independent: true });
  const other = await secondWorktree(f);
  const first = await startCycle(f, f.worktreeId);
  const second = await startCycle({ ...f, workItemId: item2 }, other);
  const seen: string[] = [];
  f.services.workCycleService.observePass({ cycle: (c) => seen.push(c.id) });
  await f.services.workCycleService.tick();
  // Neither roadmap-owned: the stored order, each once (`prioritizeRoadmapCycles` reorders only a
  // running parallel roadmap's own, `cycle-priority.test.ts`).
  expect(seen).toEqual([first.id, second.id]);
  f.services.workCycleService.observePass(undefined);
});

it('passes again at once after a pass that wrote (the free-running loop)', async () => {
  // On the kernel's manual clock no sweep or due time can stand in for the write's mark (inc. 1's
  // mutation round: with the one-second loop it could).
  const clock = new ManualClock();
  const f = await createCycleFixture({ workers: true, now: clock.date, kernelClock: clock });
  const seen: string[] = [];
  f.services.workCycleService.observePass({ cycle: (c) => seen.push(c.id) });
  const cycle = await startCycle(f, f.worktreeId);
  // The start wakes a pass, which launches the step (a write), and that wakes the next.
  await waitUntil(() => seen.filter((id) => id === cycle.id).length >= 2, 'a second pass');
  expect(runLive(f, cycle)).toBe(true);
  f.services.workCycleService.observePass(undefined);
});

it('applies a run outcome during a drain and launches nothing (a drain refuses only launches)', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  await f.services.workCycleService.tick();
  expect(f.backend.sessions).toHaveLength(1);
  f.services.agentRunService.beginDrain();
  try {
    f.backend.latest.release(designDone);
    // The turn's end, then its outcome: the implement step reserved.
    for (let step = 0; step < 2; step++) {
      await f.services.agentRunService.quiesce();
      await f.services.workCycleService.tick();
    }
    expect(storedCycle(f, cycle.id)).toMatchObject({ status: 'running', step: 'implement' });
    // The reserved step is not launched while the drain lasts.
    await f.services.agentRunService.quiesce();
    await f.services.workCycleService.tick();
    expect(f.backend.sessions).toHaveLength(1);
  } finally {
    f.services.agentRunService.cancelDrain();
  }
  // Once it is lifted, the next pass launches it.
  await f.services.workCycleService.tick();
  expect(f.backend.sessions).toHaveLength(2);
});

it('leaves a cycle to a command preparing its transition, and takes it once released (decision 15)', async () => {
  // Flipped in increment 4: before it, the pass launched the reserved step beside the command.
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  const locks = (
    f.services.workCycleService as unknown as {
      locks: { duringTransition<T>(id: string, operation: () => Promise<T>): Promise<T> };
    }
  ).locks;
  let release: () => void = () => undefined;
  const transition = locks.duringTransition(
    cycle.id,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const seen: string[] = [];
  f.services.workCycleService.observePass({ cycle: (c) => seen.push(c.id) });
  try {
    await f.services.workCycleService.tick();
    expect(seen).toEqual([]);
    expect(f.backend.sessions).toHaveLength(0);
  } finally {
    release();
    await transition;
  }
  await f.services.workCycleService.tick();
  expect(seen).toEqual([cycle.id]);
  expect(f.backend.sessions).toHaveLength(1);
  f.services.workCycleService.observePass(undefined);
});

/** The launch's state the drain and the withdrawal read, for "nothing left behind". */
const launchState = (f: CycleFixture) =>
  (
    f.services.agentRunService as unknown as {
      state: {
        pendingCycleLaunches: ReadonlyMap<string, unknown>;
        cycleLaunches: ReadonlyMap<string, unknown>;
        startingLaunches: ReadonlySet<unknown>;
      };
    }
  ).state;

it.each(['stop', 'pause'] as const)(
  'withdraws a launch before its record on %s: no run, no reservation, nothing left (decision 7)',
  async (action) => {
    // Held in the documents' repository-policy read: the preflight's `resolveBranch` is past
    // (its cancel is gone), the run not yet recorded.
    let held: Promise<void> | undefined;
    let entered = false;
    let release: () => void = () => undefined;
    let runId: string | undefined;
    const f = await createCycleFixture({
      workers: true,
      git: (real) => ({
        ...real,
        resolveBranch: async (path, branch) => {
          if (held && runId && !launchState(f).pendingCycleLaunches.has(runId)) {
            entered = true;
            await held;
          }
          return real.resolveBranch(path, branch);
        },
      }),
    });
    held = new Promise((resolve) => {
      release = resolve;
    });
    let cycle: WorkCycle;
    try {
      cycle = await startCycle(f, f.worktreeId);
      runId = storedCycle(f, cycle.id).currentRunId;
      await waitUntil(() => entered, 'the launch is in its documents');
      expect(f.context.storage.maintenance.launchReservation(runId as never)).toBeDefined();
      await control(f, cycle, action);
    } finally {
      held = undefined;
      release();
    }
    await waitUntil(
      () => launchState(f).startingLaunches.size === 0 && launchState(f).cycleLaunches.size === 0,
      'the launch ended',
    );
    expect(storedRun(f, runId as string)).toBeUndefined();
    expect(f.context.storage.maintenance.launchReservation(runId as never)).toBeUndefined();
    expect(existsSync(join(f.context.config.execution.runsRoot, runId as string))).toBe(false);
    expect(f.backend.sessions).toHaveLength(0);
    expect(storedCycle(f, cycle.id).status).toBe(action === 'stop' ? 'stopped' : 'paused');
  },
);

it('withdraws a launch paused while its session starts, and launches it again on Resume', async () => {
  const f = await createCycleFixture({ workers: true });
  let release: () => void = () => undefined;
  let entered = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const launch = f.backend.launch.bind(f.backend);
  f.backend.launch = async (request) => {
    entered = true;
    await held;
    return launch(request);
  };
  const cycle = await startCycle(f, f.worktreeId);
  await waitUntil(() => entered, "the backend's launch is under way");
  await control(f, cycle, 'pause');
  const runId = storedCycle(f, cycle.id).currentRunId;
  // The session's start is cancelled while the backend still holds it (mutation round 3).
  await waitUntil(() => storedRun(f, runId)?.status === 'cancelled', 'the run withdrawn');
  release();
  // A session the backend still made is ended at once: no agent runs under the paused cycle.
  await waitUntil(() => f.backend.sessions.every((s) => !s.send()), 'its session ended');
  expect(storedCycle(f, cycle.id).status).toBe('paused');
  f.backend.launch = launch;
  const resumed = await f.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.workspaceId}/cycles/${cycle.id}/control`,
    headers: f.headers,
    payload: { action: 'resume', expectedVersion: storedCycle(f, cycle.id).version },
  });
  expect(resumed.statusCode, resumed.body).toBe(200);
  await waitUntil(() => runLive(f, cycle), 'the resumed step runs');
});

it("stops a cycle waiting for the lane at its own due time, with nothing written (H-2's timer)", async () => {
  const clock = new ManualClock();
  const gate: { held?: Promise<void>; entered: boolean; release: () => void } = {
    entered: false,
    release: () => undefined,
  };
  const f = await createCycleFixture({
    workers: true,
    independent: true,
    now: clock.date,
    kernelClock: clock,
    git: (real) => ({
      ...real,
      resolveBranch: async (path, branch) => {
        if (gate.held) {
          gate.entered = true;
          await gate.held;
        }
        return real.resolveBranch(path, branch);
      },
    }),
  });
  const other = await secondWorktree(f);
  gate.held = new Promise((resolve) => {
    gate.release = resolve;
  });
  try {
    await startCycle(f, f.worktreeId);
    await waitUntil(() => gate.entered, "A's launch is held");
    const b = await startCycle({ ...f, workItemId: item2 }, other);
    await new Promise((resolve) => setTimeout(resolve, 200));
    // Only the clock moves: B's deadline timer, armed while it waited, stops it.
    clock.advance(Date.parse(storedCycle(f, b.id).runDeadlineAt) - clock.now() + 1000);
    await waitUntil(
      () => storedCycle(f, b.id).stop?.code === 'step-time-limit',
      "B's deadline stop by its timer",
    );
  } finally {
    gate.release();
  }
});

it("records a job's refusal and an unexpected failure as a pass did (the slow lane's errors)", async () => {
  const f = await createCycleFixture({ workers: true, independent: true });
  const runs = f.services.agentRunService;
  const start = runs.startForCycle.bind(runs);
  runs.startForCycle = async () => {
    throw new TypedRefusalError('worktree-state', 'The worktree is not on its managed branch');
  };
  const refused = await startCycle(f, f.worktreeId);
  await waitUntil(
    () => storedCycle(f, refused.id).stop?.code === 'worktree-state',
    "the job's refusal stop",
  );
  runs.startForCycle = async () => {
    throw new Error('unexpected');
  };
  const other = await secondWorktree(f);
  const failed = await startCycle({ ...f, workItemId: item2 }, other);
  await waitUntil(
    () => storedCycle(f, failed.id).stop?.code === 'controller-error',
    "the job's failure stop",
  );
  runs.startForCycle = start;
});

/** A free-running daemon whose every Git preflight (`resolveBranch`) waits for its own release. */
async function queuedPreflights(options: { now?: () => Date } = {}) {
  const queue: (() => void)[] = [];
  let holding = false;
  const f = await createCycleFixture({
    workers: true,
    independent: true,
    ...options,
    git: (real) => ({
      ...real,
      resolveBranch: async (path, branch) => {
        if (holding) await new Promise<void>((resolve) => queue.push(resolve));
        return real.resolveBranch(path, branch);
      },
    }),
  });
  return {
    f,
    other: await secondWorktree(f),
    queue,
    hold: (on: boolean) => {
      holding = on;
    },
  };
}

it("completes a round that left a cycle waiting only once that cycle's own job has run (review MEDIUM-2)", async () => {
  const { f, other, queue, hold } = await queuedPreflights();
  hold(true);
  try {
    await startCycle(f, f.worktreeId);
    await waitUntil(() => queue.length === 1, "A's launch is held");
    const b = await startCycle({ ...f, workItemId: item2 }, other);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(storedRun(f, storedCycle(f, b.id).currentRunId)).toBeUndefined();
    const opened = f.services.controllerPasses.current;
    // A's launch returns; B, which waited, takes the lane and is held in its own preflight.
    queue.shift()?.();
    await waitUntil(() => queue.length === 1, "B's launch is held");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(cyclesQuiet(f, opened)).toBe(false);
  } finally {
    hold(false);
    for (const release of queue.splice(0)) release();
  }
  await waitUntil(() => f.backend.sessions.length === 2, 'both agents started');
});

it('withdraws a launch at its step deadline by its own timer, its cycle left out of rounds (decision 7)', async () => {
  // Past its record, in the protected-ref snapshot; the deadline comes while it is held there.
  let shift = 0;
  let held: Promise<void> | undefined;
  let entered = false;
  let release: () => void = () => undefined;
  const f = await createCycleFixture({
    workers: true,
    now: () => new Date(Date.now() + shift),
    git: (real) => ({
      ...real,
      branchHeads: async (...args: Parameters<typeof real.branchHeads>) => {
        if (held) {
          entered = true;
          await held;
        }
        return real.branchHeads(...args);
      },
    }),
  });
  const runs = f.services.agentRunService;
  const start = runs.startForCycle.bind(runs);
  runs.startForCycle = async (cycle) => {
    // The step's time runs out 300 ms into its launch.
    shift = Date.parse(cycle.runDeadlineAt) - Date.now() - 300;
    return start(cycle);
  };
  held = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const cycle = await startCycle(f, f.worktreeId);
    await waitUntil(() => entered, 'the launch is past its record');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(storedCycle(f, cycle.id).status).toBe('running');
  } finally {
    held = undefined;
    release();
  }
  await waitUntil(
    () =>
      (runs as unknown as { state: { cycleLaunches: Map<string, unknown> } }).state.cycleLaunches
        .size === 0,
    'the launch ended',
  );
  expect(f.backend.sessions).toHaveLength(0);
});
