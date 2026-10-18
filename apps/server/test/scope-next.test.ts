import type { AttentionItem, PhaseBlocker, WorkCycle } from '@craftingtable/domain';
import {
  asAttentionItemId,
  asCheckpointId,
  asRoadmapId,
  asWorkCycleId,
  stopRecord,
} from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { scopeNext } from '../src/services/scope-next.js';

/**
 * R-E4 review M1: who acts next on a slice, decided by the daemon by the status list's rule, so
 * the work item's slice strip and the roadmap's board say the same thing.
 */

const cycle = (status: WorkCycle['status'], extra: Partial<WorkCycle> = {}) =>
  ({
    id: 'cycle-1',
    worktreeId: 'tree-1',
    status,
    reason: `Cycle ${status}.`,
    ...extra,
  }) as WorkCycle;
const item = (refs: Partial<AttentionItem['refs']>, subjectKey = 'other') =>
  ({
    id: 'item-1',
    subjectKey,
    message: 'Answer the design questions.',
    refs,
    openedAt: '2026-10-09T00:00:00.000Z',
  }) as unknown as AttentionItem;
const blocker = (code: string, message: string, refs?: PhaseBlocker['refs']) =>
  ({ kind: 'evidence', code, message, ...(refs ? { refs } : {}) }) as PhaseBlocker;
const phases = (merge: PhaseBlocker[], start: PhaseBlocker[] = []) => [
  { phase: 'start' as const, blockers: start },
  { phase: 'merge' as const, blockers: merge },
  { phase: 'verify' as const, blockers: [blocker('slice-not-merged', 'Merge it first.')] },
];

it('is the operator’s, with its item, when an open item carries the slice’s cycle', () => {
  for (const found of [item({ cycleId: asWorkCycleId('cycle-1') }), item({}, 'cycle:cycle-1')])
    expect(
      scopeNext({
        kind: 'slice',
        status: 'started',
        phases: phases([]),
        cycles: [cycle('needs-attention')],
        items: [item({ cycleId: asWorkCycleId('another') }), found],
      }),
    ).toEqual({
      actor: 'operator',
      reason: 'Answer the design questions.',
      attentionItemId: 'item-1',
      cycleId: 'cycle-1',
    });
});

it('names the agent while the slice’s cycle runs', () => {
  expect(
    scopeNext({
      kind: 'slice',
      status: 'started',
      phases: phases([]),
      cycles: [cycle('running')],
      items: [],
    }),
  ).toEqual({ actor: 'agent', reason: 'Cycle running.', cycleId: 'cycle-1' });
});

it('gives a stopped cycle with no item to whoever its own wait names', () => {
  // A pause is the operator's; a cycle waiting on its own controller is not.
  expect(
    scopeNext({
      kind: 'slice',
      status: 'started',
      phases: phases([]),
      cycles: [cycle('paused')],
      items: [],
    })?.actor,
  ).toBe('operator');
  expect(
    scopeNext({
      kind: 'slice',
      status: 'started',
      phases: phases([]),
      cycles: [
        cycle('needs-attention', {
          stop: stopRecord(
            { code: 'controller-wait', owner: 'controller' },
            '2026-01-01T00:00:00.000Z',
          ),
        }),
      ],
      items: [],
    })?.actor,
  ).toBe('controller');
});

it('without a live cycle, reads the next phase’s blockers by the board’s rule', () => {
  // Every blocker the operator's own setup: the operator.
  expect(
    scopeNext({
      kind: 'slice',
      status: 'not-started',
      phases: phases([], [blocker('upstream-pin-missing', 'Pin aq exactly.')]),
      cycles: [],
      items: [],
    }),
  ).toEqual({ actor: 'operator', reason: 'Pin aq exactly.' });
  // An operator blocker beside a controller wait, or a checkpoint's: not the operator's here.
  expect(
    scopeNext({
      kind: 'slice',
      status: 'not-started',
      phases: phases(
        [],
        [
          blocker('upstream-pin-missing', 'Pin aq exactly.'),
          blocker('predecessor-not-accepted', 'Accept WI-00 first.'),
        ],
      ),
      cycles: [],
      items: [],
    }),
  ).toEqual({ actor: 'controller', reason: 'Pin aq exactly.' });
  expect(
    scopeNext({
      kind: 'slice',
      status: 'not-started',
      phases: phases(
        [],
        [
          blocker('decision-checkpoint-evidence', 'Approve WI-ADR-1.', {
            checkpointId: asCheckpointId('WI-ADR-1'),
          }),
        ],
      ),
      cycles: [],
      items: [],
    })?.actor,
  ).toBe('controller');
  // Merged: verification is next, not the merge phase's blockers.
  expect(
    scopeNext({ kind: 'slice', status: 'merged', phases: phases([]), cycles: [], items: [] }),
  ).toEqual({ actor: 'controller', reason: 'Merge it first.' });
  // Nothing in its way.
  expect(
    scopeNext({ kind: 'slice', status: 'started', phases: phases([]), cycles: [], items: [] }),
  ).toEqual({ actor: 'controller', reason: 'No requirement waiting.' });
});

it('ignores ended cycles, and has nothing next once done', () => {
  expect(
    scopeNext({
      kind: 'slice',
      status: 'started',
      phases: phases([]),
      cycles: [cycle('stopped'), cycle('completed')],
      items: [item({ cycleId: asWorkCycleId('cycle-1') })],
    })?.actor,
  ).toBe('controller');
  expect(
    scopeNext({ kind: 'slice', status: 'verified', phases: phases([]), cycles: [], items: [] }),
  ).toBeUndefined();
  expect(
    scopeNext({
      kind: 'parent-acceptance',
      status: 'accepted',
      phases: [{ phase: 'accept', blockers: [] }],
      cycles: [],
      items: [],
    }),
  ).toBeUndefined();
});

it('is the operator’s when a checkpoint it needs has an item of its own, by the typed subject', () => {
  const held = {
    kind: 'slice' as const,
    status: 'not-started' as const,
    phases: phases(
      [
        blocker('checkpoint-evidence', 'LOCAL-ADR-01 must pass.', {
          checkpointId: asCheckpointId('LOCAL-ADR-01'),
        }),
      ],
      [blocker('predecessor-not-accepted', 'Accept WI-00 first.')],
    ),
    cycles: [],
  };
  const decision = {
    ...item({ roadmapId: asRoadmapId('roadmap-1') }, 'roadmap:roadmap-1:checkpoint:LOCAL-ADR-01'),
    id: asAttentionItemId('decision-item'),
    message: 'Approve LOCAL-ADR-01.',
  };
  expect(scopeNext({ ...held, items: [decision] })).toEqual({
    actor: 'operator',
    reason: 'Approve LOCAL-ADR-01.',
    attentionItemId: 'decision-item',
  });
  // Another checkpoint's item, or one with no roadmap, does not count.
  expect(
    scopeNext({
      ...held,
      items: [
        { ...decision, subjectKey: 'roadmap:roadmap-1:checkpoint:LOCAL-ADR-02' },
        { ...decision, refs: {} },
      ],
    }),
  ).toEqual({ actor: 'controller', reason: 'Accept WI-00 first.' });
});
