import { describe, expect, it } from 'vitest';
import { type CycleTransitionRecord, summarizeOperatorWait } from '../src/operator-wait.js';

const at = (hour: number) => new Date(Date.UTC(2026, 8, 20, hour)).toISOString();
const window = { from: new Date(at(0)), to: new Date(at(24)) };
const operator = (code: 'merge-approval' | 'design-open-questions') => ({
  code,
  owner: 'operator' as const,
});

describe('operator wait (R-C1)', () => {
  it('counts wall time a cycle waits on the operator, and the part with no agent running', () => {
    const transitions: CycleTransitionRecord[] = [
      { cycleId: 'a', at: at(2), status: 'running' },
      {
        cycleId: 'a',
        at: at(4),
        status: 'needs-attention',
        attention: operator('design-open-questions'),
      },
      { cycleId: 'a', at: at(10), status: 'running' },
      // A second cycle overlaps the first stop: wall time counts once, cycle-hours twice.
      { cycleId: 'b', at: at(6), status: 'awaiting-merge', attention: operator('merge-approval') },
      { cycleId: 'b', at: at(12), status: 'completed' },
    ];
    const report = summarizeOperatorWait(
      transitions,
      [
        { startedAt: at(2), endedAt: at(4) },
        { startedAt: at(8), endedAt: at(11) },
      ],
      window,
    );
    expect(report).toMatchObject({ waitingHours: 8, idleWaitingHours: 5, agentHours: 5 });
    expect(report.kinds).toEqual([
      { kind: 'design-open-questions', stops: 1, cycleHours: 6 },
      { kind: 'merge-approval', stops: 1, cycleHours: 6 },
    ]);
  });

  it('ignores controller-owned stops and counts the operator pause', () => {
    const report = summarizeOperatorWait(
      [
        {
          cycleId: 'a',
          at: at(1),
          status: 'needs-attention',
          attention: { code: 'scheduling-held', owner: 'controller' },
        },
        { cycleId: 'a', at: at(3), status: 'paused' },
        { cycleId: 'a', at: at(5), status: 'running' },
      ],
      [],
      window,
    );
    expect(report).toMatchObject({ waitingHours: 2, idleWaitingHours: 2 });
    expect(report.kinds).toEqual([{ kind: 'paused', stops: 1, cycleHours: 2 }]);
  });

  it('clips to the window, runs a still-open stop and a live agent to its end, and counts a stop once', () => {
    const report = summarizeOperatorWait(
      [
        // Opened before the window: its hours count, the stop itself does not.
        {
          cycleId: 'a',
          at: at(-6),
          status: 'needs-attention',
          attention: operator('merge-approval'),
        },
        { cycleId: 'a', at: at(3), status: 'running' },
        {
          cycleId: 'b',
          at: at(20),
          status: 'needs-attention',
          attention: operator('merge-approval'),
        },
        // A bookkeeping write that keeps the same stop is not a second stop.
        {
          cycleId: 'b',
          at: at(21),
          status: 'needs-attention',
          attention: operator('merge-approval'),
        },
      ],
      [{ startedAt: at(22) }],
      window,
    );
    expect(report).toMatchObject({ waitingHours: 7, idleWaitingHours: 5, agentHours: 2 });
    expect(report.kinds).toEqual([{ kind: 'merge-approval', stops: 1, cycleHours: 7 }]);
  });

  it('counts a stop whose first record lasts no time, and follows an owner change', () => {
    const report = summarizeOperatorWait(
      [
        {
          cycleId: 'a',
          at: at(2),
          status: 'needs-attention',
          attention: operator('merge-approval'),
        },
        // Written in the same millisecond: the first record has no duration.
        {
          cycleId: 'a',
          at: at(2),
          status: 'needs-attention',
          attention: operator('merge-approval'),
        },
        // A roadmap claims the merge: the controller owns it from here.
        {
          cycleId: 'a',
          at: at(4),
          status: 'needs-attention',
          attention: { code: 'merge-approval', owner: 'controller' },
        },
        { cycleId: 'a', at: at(6), status: 'running' },
      ],
      [],
      window,
    );
    expect(report).toMatchObject({ waitingHours: 2, idleWaitingHours: 2 });
    expect(report.kinds).toEqual([{ kind: 'merge-approval', stops: 1, cycleHours: 2 }]);
  });
});
