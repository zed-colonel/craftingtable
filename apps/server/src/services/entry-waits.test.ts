import {
  cycleAttention,
  ENTRY_WAIT,
  type RoadmapEntryWait,
  type WorkCycle,
} from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import {
  blockerWait,
  cycleStep,
  type EntryStep,
  MOVED,
  nextEntryWaits,
  phaseWait,
  roundStep,
  sameEntryWaits,
  waiting,
} from './entry-waits.js';
import { PhaseGateError } from './phase-resources.js';

/**
 * Every path through the scheduler's evaluation of an entry returns an `EntryStep`
 * (`RoadmapService.advanceEntry` and `advanceScopeRecovery` are typed so a bare return does
 * not compile). These tables pin what each kind of path records (R-C12).
 */

const cycle = (status: WorkCycle['status'], attention?: WorkCycle['attention']) =>
  ({ id: 'cycle-1', status, reason: `Cycle is ${status}.`, attention }) as WorkCycle;

describe('the wait a cycle the scheduler leaves alone implies', () => {
  it.each<[string, WorkCycle, EntryStep]>([
    ['a running cycle is at work', cycle('running'), MOVED],
    [
      'the operator paused it',
      cycle('paused', cycleAttention('scope-review-recovery')),
      waiting('cycle-paused', 'Cycle is paused.', { cycleId: 'cycle-1' }),
    ],
    [
      'it stopped for the operator',
      cycle('needs-attention', cycleAttention('controller-error')),
      waiting('cycle-attention', 'Cycle is needs-attention.', { cycleId: 'cycle-1' }),
    ],
    [
      'it awaits the operator’s merge',
      cycle('awaiting-merge', cycleAttention('merge-approval')),
      waiting('cycle-attention', 'Cycle is awaiting-merge.', { cycleId: 'cycle-1' }),
    ],
    [
      'it waits on its own controller',
      cycle('awaiting-merge', cycleAttention('controller-wait')),
      waiting('cycle-waiting', 'Cycle is awaiting-merge.', { cycleId: 'cycle-1' }),
    ],
    [
      'automation claims its stop',
      cycle(
        'needs-attention',
        cycleAttention('review-needs-attention', undefined, { claim: 'roadmap-merge' }),
      ),
      waiting('cycle-waiting', 'Cycle is needs-attention.', { cycleId: 'cycle-1' }),
    ],
    [
      'the operator stopped it',
      cycle('stopped'),
      waiting('cycle-ended', 'Cycle is stopped.', { cycleId: 'cycle-1' }),
    ],
    [
      'it completed without the entry completing',
      cycle('completed'),
      waiting('cycle-ended', 'Cycle is completed.', { cycleId: 'cycle-1' }),
    ],
  ])('%s', (_name, input, expected) => {
    expect(cycleStep(input)).toEqual(expected);
  });
});

describe('the waits the scheduler’s own gates imply', () => {
  it.each(['dependency-blocked', 'capacity-blocked', 'exclusion-blocked'] as const)(
    'a %s blocker names the entry it blocks',
    (kind) => {
      expect(blockerWait({ kind, reason: 'Held.', needsAttention: false }, 'owner')).toEqual(
        waiting(kind, 'Held.', { entryId: 'owner' }),
      );
    },
  );

  it('a phase gate that clears by itself records its blocker codes once each', () => {
    const error = new PhaseGateError([
      { kind: 'resource', code: 'resource-busy', message: 'Busy.' },
      { kind: 'resource', code: 'resource-busy', message: 'Still busy.' },
      { kind: 'dependency', code: 'slice-requirement', message: 'Slice a must be verified.' },
    ]);
    expect(phaseWait(error)).toEqual({
      code: 'phase-blocked',
      reason: 'Busy.\nStill busy.\nSlice a must be verified.',
      refs: { blockers: ['resource-busy', 'slice-requirement'] },
    });
  });

  it('a stopped review a round carries waits on what holds the round, or on the round', () => {
    const held = waiting('capacity-blocked', 'No slot.');
    expect(roundStep(held, 'Roadmap recovery.', { entryId: 'owner' })).toBe(held);
    expect(roundStep(MOVED, 'Roadmap recovery.', { entryId: 'owner', cycleId: 'repair' })).toEqual(
      waiting('recovery-round', 'Roadmap recovery.', { entryId: 'owner', cycleId: 'repair' }),
    );
  });

  it('every wait code declares who acts next', () => {
    expect(ENTRY_WAIT).toMatchObject({
      'capacity-blocked': 'controller',
      'recovery-round': 'controller',
      'cycle-waiting': 'controller',
      'cycle-attention': 'operator',
      'cycle-paused': 'operator',
      'entry-held': 'operator',
    });
  });
});

describe('the waits a pass records', () => {
  const since = '2026-09-27T01:00:00.000Z';
  const now = '2026-09-27T02:00:00.000Z';
  const prior: Record<string, RoadmapEntryWait> = {
    a: { code: 'capacity-blocked', reason: 'Two slots used.', since, refs: { entryId: 'owner' } },
    b: { code: 'cycle-waiting', reason: 'Waiting.', since, refs: { cycleId: 'c' } },
  };

  it.each<[string, Map<string, EntryStep | 'keep'>, Record<string, RoadmapEntryWait> | undefined]>([
    [
      'a first wait starts now',
      new Map([['c', waiting('review-running', 'Running.')]]),
      { c: { code: 'review-running', reason: 'Running.', since: now } },
    ],
    [
      'an unchanged wait keeps its since and takes the current reason',
      new Map([['a', waiting('capacity-blocked', 'Three slots used.', { entryId: 'owner' })]]),
      { a: { ...prior.a!, reason: 'Three slots used.' } },
    ],
    [
      'a different code starts again',
      new Map([['a', waiting('dependency-blocked', 'Needs a.', { entryId: 'owner' })]]),
      {
        a: {
          code: 'dependency-blocked',
          reason: 'Needs a.',
          since: now,
          refs: { entryId: 'owner' },
        },
      },
    ],
    [
      'a different subject starts again',
      new Map([['b', waiting('cycle-waiting', 'Waiting.', { cycleId: 'd' })]]),
      { b: { code: 'cycle-waiting', reason: 'Waiting.', since: now, refs: { cycleId: 'd' } } },
    ],
    ['an entry that moved loses its wait', new Map([['a', MOVED]]), undefined],
    ['a transient retry keeps the last wait', new Map([['b', 'keep' as const]]), { b: prior.b! }],
    ['a retry with no earlier wait records none', new Map([['c', 'keep' as const]]), undefined],
    ['an entry the pass did not evaluate loses its wait', new Map(), undefined],
  ])('%s', (_name, evaluated, expected) => {
    expect(nextEntryWaits(prior, evaluated, now)).toEqual(expected);
  });

  it('compares recorded waits by value', () => {
    expect(sameEntryWaits(prior, { ...prior })).toBe(true);
    expect(sameEntryWaits(prior, { a: prior.a! })).toBe(false);
    expect(sameEntryWaits(undefined, undefined)).toBe(true);
  });
});
