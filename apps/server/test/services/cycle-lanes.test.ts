import { expect, it } from 'vitest';
import { decisionLane, LANES } from '../../src/services/cycle/core/lanes.js';
import type { CycleDecision } from '../../src/services/cycle/core/machine.js';

/**
 * Which decisions the free-running controller applies in its round and which run as the slow
 * lane's job (R-B5, decision 4): only those whose application awaits nothing are fast. The tables
 * name every kind (the compiler refuses one left out); this pins each answer.
 */

it('applies at once only what awaits nothing', () => {
  expect(LANES.decisions).toEqual({
    idle: 'fast',
    complete: 'fast',
    attention: 'fast',
    wait: 'fast',
    launch: 'slow',
    'start-run': 'slow',
    effect: 'slow',
  });
  expect(LANES.outcomes).toEqual({
    'wait-for-run': 'fast',
    'end-turn': 'fast',
    attention: 'fast',
    'schedule-service-retry': 'fast',
    'continue-design': 'fast',
    'design-wait': 'fast',
    'resume-after-restart': 'slow',
    'repair-output': 'slow',
    'next-step': 'slow',
    'advance-resolution': 'slow',
    'finalize-implementation': 'slow',
    'advance-finalization-stage': 'slow',
    'remediate-review': 'slow',
    'approve-review': 'slow',
  });
});

it("reads a step outcome's lane from the outcome", () => {
  const outcome = (kind: string) =>
    ({ kind: 'outcome', guard: 'step-outcome', outcome: { kind } }) as unknown as CycleDecision;
  expect(decisionLane(outcome('end-turn'))).toBe('fast');
  expect(decisionLane(outcome('approve-review'))).toBe('slow');
  expect(decisionLane({ kind: 'start-run', guard: 'no-run' } as unknown as CycleDecision)).toBe(
    'slow',
  );
  expect(decisionLane({ kind: 'idle', guard: 'not-active' } as unknown as CycleDecision)).toBe(
    'fast',
  );
});
