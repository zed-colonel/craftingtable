import { asWorkItemId, type WorkCycle, type WorktreeId } from '@craftingtable/domain';
import { createWorktreeResponseSchema } from '@craftingtable/contracts';
import { afterEach, expect, it } from 'vitest';
import {
  type CycleFixture,
  createCycleFixture,
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

const item2 = asWorkItemId('item-2');

/** A worktree for the fixture's second item, admitted, so its cycle runs beside the first's. */
async function secondWorktree(f: CycleFixture): Promise<WorktreeId> {
  const post = async (url: string, payload: Record<string, unknown>) => {
    const response = await f.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${f.workspaceId}${url}`,
      headers: f.headers,
      payload,
    });
    if (response.statusCode !== 200) throw new Error(`${url}: ${response.body}`);
    return response.json();
  };
  const { worktree } = createWorktreeResponseSchema.parse(
    await post(`/work-items/${item2}/worktrees`, { repositoryId: f.repositoryId }),
  );
  await post(`/work-items/${item2}/control`, { action: 'admit' });
  return worktree.id;
}

async function control(f: CycleFixture, cycle: WorkCycle, action: 'stop' | 'pause') {
  const response = await f.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${f.workspaceId}/cycles/${cycle.id}/control`,
    headers: f.headers,
    payload: { action, expectedVersion: storedCycle(f, cycle.id).version },
  });
  expect(response.statusCode, response.body).toBe(200);
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

it('finds a passed step deadline by itself, with nothing written (the one-second loop)', async () => {
  let clock = Date.now();
  const f = await createCycleFixture({ workers: true, now: () => new Date(clock) });
  const cycle = await startCycle(f, f.worktreeId);
  await waitUntil(() => runLive(f, cycle), 'the design run is live');
  // Only the clock moves: no write, no notification.
  clock = Date.parse(storedCycle(f, cycle.id).runDeadlineAt) + 1000;
  await waitUntil(
    () => storedCycle(f, cycle.id).stop?.code === 'step-time-limit',
    'the deadline stop',
  );
});

it("holds another cycle's deadline while one launch waits in its Git preflight (flips with the slow lane)", async () => {
  let held: Promise<void> | undefined;
  let entered = false;
  let release: () => void = () => undefined;
  const f = await createCycleFixture({
    workers: true,
    independent: true,
    git: (real) => ({
      ...real,
      resolveBranch: async (path, branch) => {
        if (held) {
          entered = true;
          await held;
        }
        return real.resolveBranch(path, branch);
      },
    }),
  });
  const other = await secondWorktree(f);
  const b = await startCycle({ ...f, workItemId: item2 }, other);
  await waitUntil(() => runLive(f, b), "B's design run is live");
  held = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const a = await startCycle(f, f.worktreeId);
    await waitUntil(() => entered, "A's launch is held in its Git preflight");
    deadlinePassed(f, b);
    // Three loop intervals: the pass awaits A's launch, so B's passed deadline is not enforced.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect(storedCycle(f, b.id).status).toBe('running');
    expect(storedRun(f, storedCycle(f, a.id).currentRunId)).toBeUndefined();
  } finally {
    release();
  }
  await waitUntil(
    () => storedCycle(f, b.id).stop?.code === 'step-time-limit',
    "B's deadline stop once A's launch returns",
  );
});

it.each(['stop', 'pause'] as const)(
  'does not cancel a launch past its preflight on %s (flips with the launch job)',
  async (action) => {
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
    // The launch goes on and starts its agent.
    await waitUntil(() => f.backend.sessions.length === 1, 'the agent started');
    const runId = storedCycle(f, cycle.id).currentRunId;
    if (action === 'stop') {
      // The spawn ends the session of a cycle that stopped meanwhile.
      await waitUntil(() => storedRun(f, runId)?.status === 'cancelled', 'the run ended');
      expect(storedCycle(f, cycle.id).status).toBe('stopped');
    } else {
      // A paused cycle's agent keeps running.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(storedCycle(f, cycle.id).status).toBe('paused');
      expect(storedRun(f, runId)?.status).toBe('running');
    }
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

it('applies a run outcome during a drain and launches nothing (a drain refuses only launches)', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  await f.services.workCycleService.tick();
  expect(f.backend.sessions).toHaveLength(1);
  f.services.agentRunService.beginDrain();
  try {
    f.backend.latest.release(designDone);
    await f.services.agentRunService.quiesce();
    await f.services.workCycleService.tick();
    await f.services.agentRunService.quiesce();
    await f.services.workCycleService.tick();
    expect(storedCycle(f, cycle.id)).toMatchObject({ status: 'running', step: 'implement' });
    expect(f.backend.sessions).toHaveLength(1);
  } finally {
    f.services.agentRunService.cancelDrain();
  }
});

it("takes a cycle while a command prepares its transition (flips with the kernel's holds)", async () => {
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
  try {
    await f.services.workCycleService.tick();
    // The pass launched the reserved step beside the command's transition.
    expect(f.backend.sessions).toHaveLength(1);
  } finally {
    release();
    await transition;
  }
});
