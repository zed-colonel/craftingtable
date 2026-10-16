import { cycleAttention, type WorkCycle } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import {
  CYCLE_TRANSITIONS,
  CycleTransitionError,
  checkTransition,
} from '../../src/services/cycle-transitions.js';

/**
 * The cycle's explicit state machine over today's fields (R-B4 increment 6): which status changes
 * are allowed, and what each status may carry. The allowed rows are the status changes the whole
 * server suite takes (recorded at e9e69ad, by action); the refused ones are outside the table.
 */

const at = (status: WorkCycle['status'], code?: Parameters<typeof cycleAttention>[0]) =>
  ({
    status,
    ...(code ? { attention: cycleAttention(code) } : {}),
  }) as WorkCycle;

describe('CYCLE_TRANSITIONS', () => {
  it.each([
    // The controller's own moves.
    [at('running'), at('awaiting-merge', 'merge-approval'), 'advance'],
    [at('running'), at('needs-attention', 'step-incomplete'), 'advance'],
    [at('running'), at('running'), 'checkpoint-completed'],
    [at('running'), at('completed'), 'advance'],
    [at('awaiting-merge', 'merge-approval'), at('completed'), 'advance'],
    [at('awaiting-merge', 'merge-approval'), at('running'), 'workflow-review'],
    [at('awaiting-merge', 'merge-approval'), at('needs-attention', 'item-not-admitted'), 'advance'],
    [at('awaiting-merge', 'controller-wait'), at('awaiting-merge', 'merge-approval'), 'advance'],
    [at('needs-attention', 'design-open-questions'), at('completed'), 'advance'],
    // Commands.
    [at('running'), at('paused'), 'pause'],
    [at('running'), at('paused'), 'stop'],
    [at('running'), at('stopped'), 'stop'],
    [at('awaiting-merge', 'merge-approval'), at('paused'), 'pause'],
    [at('awaiting-merge', 'merge-approval'), at('stopped'), 'roadmap-wound-down'],
    [at('needs-attention', 'step-incomplete'), at('paused', 'step-incomplete'), 'pause'],
    [at('needs-attention', 'step-incomplete'), at('running'), 'resume'],
    [at('needs-attention', 'step-incomplete'), at('stopped'), 'amendment-retired'],
    [
      at('paused', 'remediation-exhausted'),
      at('needs-attention', 'remediation-exhausted'),
      'resume',
    ],
    [at('paused'), at('running'), 'retry-provider'],
    [at('paused'), at('paused'), 'resolution-inspected'],
    [at('paused'), at('stopped'), 'stop'],
    [
      at('needs-attention', 'step-incomplete'),
      at('needs-attention', 'step-incomplete'),
      'investigation-started',
    ],
    // A completed independent review is reopened only by review again.
    [at('completed'), at('running'), 'review-again'],
    // A write that keeps an ended cycle's status is not a status change.
    [at('completed'), at('completed'), 'advance'],
    // A record written before codes (increment 6 review, LOW-1): its derived code is an
    // operator's stop, kept by a pause, and one with no stored code keeps none until the first
    // pass fills it in.
    [at('needs-attention', 'legacy-attention'), at('paused', 'legacy-attention'), 'pause'],
    [
      at('needs-attention', 'legacy-attention'),
      at('needs-attention', 'legacy-attention'),
      'investigation-started',
    ],
    [at('needs-attention'), at('needs-attention'), 'advance'],
    [at('awaiting-merge'), at('awaiting-merge'), 'advance'],
  ] as const)('%#: %o to %o by %s', (from, to, action) =>
    expect(() => checkTransition(from, to, action)).not.toThrow(),
  );

  it.each([
    ['a stopped cycle never runs again', at('stopped'), at('running'), 'resume'],
    ['a stopped cycle never pauses', at('stopped'), at('paused'), 'pause'],
    ['a completed cycle resumes only by review again', at('completed'), at('running'), 'resume'],
    ['a completed cycle is not stopped', at('completed'), at('stopped'), 'stop'],
    [
      'a stop does not jump to the merge boundary',
      at('needs-attention', 'step-incomplete'),
      at('awaiting-merge', 'merge-approval'),
      'advance',
    ],
    [
      'a pause does not jump to the merge boundary',
      at('paused'),
      at('awaiting-merge', 'merge-approval'),
      'resume',
    ],
    // What each status may carry.
    ['a running cycle carries no stop', at('running'), at('running', 'step-incomplete'), 'advance'],
    ['an operator stop needs its code', at('running'), at('needs-attention'), 'advance'],
    [
      'an operator stop is not a gate',
      at('running'),
      at('needs-attention', 'merge-approval'),
      'advance',
    ],
    [
      'the merge boundary carries a gate',
      at('running'),
      at('awaiting-merge', 'step-incomplete'),
      'advance',
    ],
    ['the merge boundary needs its gate', at('running'), at('awaiting-merge'), 'advance'],
    [
      'a pause keeps no gate',
      at('awaiting-merge', 'merge-approval'),
      at('paused', 'merge-approval'),
      'pause',
    ],
    ['an ended cycle carries no stop', at('running'), at('stopped', 'step-incomplete'), 'stop'],
    [
      'the merge boundary carries no legacy stop',
      at('running'),
      at('awaiting-merge', 'legacy-attention'),
      'advance',
    ],
    [
      'a record without a code gains no stop without one',
      at('awaiting-merge'),
      at('needs-attention'),
      'advance',
    ],
  ] as const)('refuses: %s', (_name, from, to, action) =>
    expect(() => checkTransition(from, to, action)).toThrow(CycleTransitionError),
  );

  it('lists every status, and ends nothing that can still run', () => {
    expect(Object.keys(CYCLE_TRANSITIONS).sort()).toEqual([
      'awaiting-merge',
      'completed',
      'needs-attention',
      'paused',
      'running',
      'stopped',
    ]);
    expect(CYCLE_TRANSITIONS.stopped.to).toEqual([]);
  });
});
