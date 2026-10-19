import { DEFAULT_COMPLETION_POLICY, type WorkCycle } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { CYCLE_GUARDS, type CycleDecision } from '../../src/services/cycle/core/machine.js';
import {
  nextLook,
  RESTORED_CHECK_MS,
  STUCK_INVESTIGATION_MS,
} from '../../src/services/cycle/core/next-look.js';

/**
 * When a cycle next needs the controller's look by itself (R-B5): a row per time a guard reads,
 * and the rule over every guard and decision kind that a time is armed only when it is ahead
 * (design review H-3).
 */

const NOW = new Date('2026-10-19T12:00:00.000Z');
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();
const cycleOf = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'cycle-1',
    status: 'running',
    step: 'implement',
    runDeadlineAt: at(30),
    policy: DEFAULT_COMPLETION_POLICY,
    ...overrides,
  }) as unknown as WorkCycle;
const idle = (guard: CycleDecision['guard'], dueAt?: string): CycleDecision =>
  ({ kind: 'idle', reason: 'busy', guard, ...(dueAt ? { dueAt } : {}) }) as CycleDecision;
const memory = (last?: number) => ({ restoredCheckedAt: () => last });

it("arms a running cycle's step deadline when a guard after it decided", () => {
  for (const guard of ['provider-retry-due', 'no-run', 'step-outcome'] as const)
    expect(nextLook(cycleOf(), idle(guard), memory(), NOW)).toBe(Date.parse(at(30)));
  // Not for a cycle that is not running (a stop, a pause, awaiting merge).
  for (const status of ['needs-attention', 'paused', 'awaiting-merge'])
    expect(nextLook(cycleOf({ status }), idle('step-outcome'), memory(), NOW)).toBeUndefined();
});

it('leaves a deadline an earlier guard pre-empts to that guard', () => {
  // A phase wait records before the deadline is asked; `phase-wait-cleared` moves it on later.
  for (const guard of ['scope-phase-gates', 'merge-reserved', 'kernel-busy', 'roadmap-settling'])
    expect(
      nextLook(cycleOf(), idle(guard as CycleDecision['guard']), memory(), NOW),
    ).toBeUndefined();
});

it("arms a provider retry's due time, or the step deadline when it comes first (MEDIUM-3)", () => {
  expect(nextLook(cycleOf(), idle('provider-retry-due', at(5)), memory(), NOW)).toBe(
    Date.parse(at(5)),
  );
  expect(nextLook(cycleOf(), idle('provider-retry-due', at(45)), memory(), NOW)).toBe(
    Date.parse(at(30)),
  );
  // Not running (a paused retry's cycle): only the retry.
  expect(
    nextLook(cycleOf({ status: 'paused' }), idle('provider-retry-due', at(45)), memory(), NOW),
  ).toBe(Date.parse(at(45)));
});

it("arms an investigation's stuck time and an open change's next comparison", () => {
  const investigating = cycleOf({
    status: 'needs-attention',
    investigation: { id: 'inv-1', deadlineAt: at(10) },
  });
  expect(nextLook(investigating, idle('investigation-live'), memory(), NOW)).toBe(
    Date.parse(at(10)) + STUCK_INVESTIGATION_MS,
  );
  const changed = cycleOf({ status: 'needs-attention', investigation: { id: 'inv-1' } });
  const last = NOW.getTime() - 20_000;
  expect(nextLook(changed, idle('worktree-change-open'), memory(last), NOW)).toBe(
    last + RESTORED_CHECK_MS,
  );
  // Never compared: the effect compares now, and its next look follows from that.
  expect(nextLook(changed, idle('worktree-change-open'), memory(), NOW)).toBeUndefined();
});

it('arms nothing already due, for any guard and any decision kind (H-3)', () => {
  const past = cycleOf({
    runDeadlineAt: at(-1),
    investigation: { id: 'inv-1', deadlineAt: at(-30) },
  });
  const kinds = ['idle', 'wait', 'attention', 'launch', 'start-run', 'effect', 'outcome'];
  for (const guard of CYCLE_GUARDS)
    for (const kind of kinds) {
      const decision = {
        kind,
        guard,
        ...(kind === 'idle' ? { reason: 'retry-not-due', dueAt: at(-2) } : {}),
      } as unknown as CycleDecision;
      for (const last of [undefined, NOW.getTime() - 5 * 60_000]) {
        const time = nextLook(past, decision, memory(last), NOW);
        expect(time === undefined || time > NOW.getTime(), `${guard} ${kind}`).toBe(true);
      }
    }
});

it('arms nothing at all for a time exactly now', () => {
  expect(
    nextLook(cycleOf({ runDeadlineAt: NOW.toISOString() }), idle('no-run'), memory(), NOW),
  ).toBeUndefined();
});
