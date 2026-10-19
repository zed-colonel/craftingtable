import { expect, it } from 'vitest';
import { ControllerPasses } from '../../src/services/attention-gates.js';

/**
 * Controller quiescence for first pushes (R-A4) with a worker that waits for events (R-B5): one
 * that has nothing to look at has had its chance; one that has, has not until a pass completes.
 */

it('counts an idle worker as quiet, and a busy one only after a pass begun since', () => {
  const passes = new ControllerPasses();
  let idle = false;
  passes.register('cycles', () => idle);
  passes.register('roadmaps');
  const roadmaps = passes.started();
  passes.completed('roadmaps', roadmaps);
  const opened = passes.current;
  // The roadmap worker has completed no pass since; the cycles worker is busy.
  expect(passes.quietSince(opened)).toBe(false);
  const next = passes.started();
  passes.completed('roadmaps', next);
  expect(passes.quietSince(opened)).toBe(false);
  // Idle: nothing marked, no round running.
  idle = true;
  expect(passes.quietSince(opened)).toBe(true);
  idle = false;
  const cycles = passes.started();
  passes.completed('cycles', cycles);
  expect(passes.quietSince(opened)).toBe(true);
  passes.unregister('cycles');
  expect(passes.quietSince(passes.current)).toBe(false);
});
