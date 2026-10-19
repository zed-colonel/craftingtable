import { expect, it } from 'vitest';
import { ControllerKernel } from '../../src/services/kernel/controller-kernel.js';
import { ControllerFigures } from '../../src/services/kernel/figures.js';

/** The controller's figures (R-B5, decision 9): cumulative counters, the last minute's rounds. */

const idleClock = { now: () => 0, setTimeout: () => undefined, clearTimeout: () => undefined };

it("counts rounds since start and takes the last minute's durations", () => {
  let at = 0;
  const figures = new ControllerFigures(() => at);
  const kernel = new ControllerKernel(idleClock);
  for (const ms of [1, 2, 3, 4, 100]) {
    const began = figures.started();
    at += ms;
    figures.rounded(began);
  }
  const lane = { runningForMs: undefined, waiting: 0 };
  expect(figures.summary(kernel, lane, 0)).toMatchObject({
    rounds: 5,
    lastMinute: { rounds: 5, p50Ms: 3, p95Ms: 100, maxMs: 100 },
  });
  // A minute later the rounds are counted still, but none is the last minute's.
  at += 60_001;
  expect(figures.summary(kernel, lane, 0)).toMatchObject({
    rounds: 5,
    lastMinute: { rounds: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
  });
});

it('reports the marks by cause, the lane and the timers', () => {
  const figures = new ControllerFigures(() => 0);
  const kernel = new ControllerKernel(idleClock);
  kernel.mark('write');
  kernel.mark('write', ['a']);
  kernel.mark('due', ['a']);
  kernel.dueAt('a', 5_000);
  kernel.dueAt('b', 9_000);
  figures.jobStarted();
  expect(figures.summary(kernel, { runningForMs: 1234.4, waiting: 2 }, 1_000)).toEqual({
    rounds: 0,
    lastMinute: { rounds: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 },
    marks: [
      { cause: 'due', count: 1 },
      { cause: 'write', count: 2 },
    ],
    lane: { jobs: 1, running: true, runningForMs: 1234, waiting: 2 },
    timers: { due: 2, nextDueInMs: 4_000 },
  });
  // A due time already past shows as due now, not as a negative wait.
  expect(figures.summary(kernel, { runningForMs: undefined, waiting: 0 }, 6_000).timers).toEqual({
    due: 2,
    nextDueInMs: 0,
  });
});
