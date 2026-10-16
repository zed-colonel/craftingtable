import { describe, expect, it } from 'vitest';
import {
  type CycleTransitionRecord,
  type RoadmapWaitRecord,
  summarizeOperatorWait,
} from '../src/operator-wait.js';
import { asWorkCycleId } from '../src/ids.js';

const cycleA = asWorkCycleId('a');
const cycleB = asWorkCycleId('b');
const at = (hour: number) => new Date(Date.UTC(2026, 8, 20, hour)).toISOString();
const window = { from: new Date(at(0)), to: new Date(at(24)) };
const operator = (code: 'merge-approval' | 'design-open-questions') => ({
  code,
  owner: 'operator' as const,
});

describe('operator wait (R-C1)', () => {
  it('counts wall time a cycle waits on the operator, and the part with no agent running', () => {
    const transitions: CycleTransitionRecord[] = [
      { cycleId: cycleA, at: at(2), status: 'running' },
      {
        cycleId: cycleA,
        at: at(4),
        status: 'needs-attention',
        attention: operator('design-open-questions'),
      },
      { cycleId: cycleA, at: at(10), status: 'running' },
      // A second cycle overlaps the first stop: wall time counts once, cycle-hours twice.
      {
        cycleId: cycleB,
        at: at(6),
        status: 'awaiting-merge',
        attention: operator('merge-approval'),
      },
      { cycleId: cycleB, at: at(12), status: 'completed' },
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
          cycleId: cycleA,
          at: at(1),
          status: 'needs-attention',
          attention: { code: 'scheduling-held', owner: 'controller' },
        },
        { cycleId: cycleA, at: at(3), status: 'paused' },
        { cycleId: cycleA, at: at(5), status: 'running' },
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
          cycleId: cycleA,
          at: at(-6),
          status: 'needs-attention',
          attention: operator('merge-approval'),
        },
        { cycleId: cycleA, at: at(3), status: 'running' },
        {
          cycleId: cycleB,
          at: at(20),
          status: 'needs-attention',
          attention: operator('merge-approval'),
        },
        // A bookkeeping write that keeps the same stop is not a second stop.
        {
          cycleId: cycleB,
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
          cycleId: cycleA,
          at: at(2),
          status: 'needs-attention',
          attention: operator('merge-approval'),
        },
        // Written in the same millisecond: the first record has no duration.
        {
          cycleId: cycleA,
          at: at(2),
          status: 'needs-attention',
          attention: operator('merge-approval'),
        },
        // A roadmap claims the merge: the controller owns it from here.
        {
          cycleId: cycleA,
          at: at(4),
          status: 'needs-attention',
          attention: { code: 'merge-approval', owner: 'controller' },
        },
        { cycleId: cycleA, at: at(6), status: 'running' },
      ],
      [],
      window,
    );
    expect(report).toMatchObject({ waitingHours: 2, idleWaitingHours: 2 });
    expect(report.kinds).toEqual([{ kind: 'merge-approval', stops: 1, cycleHours: 2 }]);
  });

  it("counts a roadmap stop and an entry hold, and a hold over its own cycle's stop once (R-C10)", () => {
    const transitions: CycleTransitionRecord[] = [
      {
        cycleId: cycleA,
        at: at(2),
        status: 'needs-attention',
        attention: { code: 'work-item-questions', owner: 'operator' },
      },
      { cycleId: cycleA, at: at(6), status: 'running' },
      // Another cycle's stop is not the hold's: it overlaps the hold and adds up beside it.
      { cycleId: cycleB, at: at(3), status: 'paused' },
      { cycleId: cycleB, at: at(4), status: 'running' },
    ];
    const roadmapWaits: RoadmapWaitRecord[] = [
      // The entry holds from 1 to 8 for the same fact its cycle A stops on from 2 to 6.
      { waitId: 'r:e', at: at(1), kind: 'entry-preparation-failed', cycleIds: [cycleA] },
      { waitId: 'r:e', at: at(5), kind: 'entry-preparation-failed', cycleIds: [cycleA] },
      { waitId: 'r:e', at: at(8), cycleIds: [cycleA] },
      // The roadmap's own stop, with nothing running behind it.
      { waitId: 'r', at: at(10), kind: 'scheduler-error', cycleIds: [] },
      { waitId: 'r', at: at(12), cycleIds: [] },
    ];
    const report = summarizeOperatorWait(transitions, [], window, roadmapWaits);
    expect(report).toMatchObject({ waitingHours: 9, idleWaitingHours: 9 });
    expect(report.kinds).toEqual([
      { kind: 'work-item-questions', stops: 1, cycleHours: 4 },
      { kind: 'entry-preparation-failed', stops: 1, cycleHours: 3 },
      { kind: 'scheduler-error', stops: 1, cycleHours: 2 },
      { kind: 'paused', stops: 1, cycleHours: 1 },
    ]);
  });

  it("counts a hold wholly inside its cycle's stop as a stop of no hours, and runs an open one to the end", () => {
    const report = summarizeOperatorWait(
      [
        { cycleId: cycleA, at: at(1), status: 'paused' },
        { cycleId: cycleA, at: at(9), status: 'running' },
      ],
      [],
      window,
      [
        { waitId: 'r:e', at: at(2), kind: 'paused', cycleIds: [cycleA] },
        { waitId: 'r:e', at: at(4), cycleIds: [cycleA] },
        // Opened before the window and never closed: 24 hours, no stop inside the window.
        { waitId: 'r', at: at(-3), kind: 'restart-resume', cycleIds: [cycleB] },
      ],
    );
    expect(report).toMatchObject({ waitingHours: 24 });
    expect(report.kinds).toEqual([
      { kind: 'restart-resume', stops: 0, cycleHours: 24 },
      { kind: 'paused', stops: 2, cycleHours: 8 },
    ]);
  });
});
