import type { Roadmap, RoadmapEntryHold } from '@craftingtable/domain';
import {
  asRoadmapAttemptId,
  asRoadmapEntryId,
  asRoadmapId,
  asWorkCycleId,
} from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { carriedHold, carriedWait } from '../../src/services/attention-projector.js';

const hold = (reason: string, status: RoadmapEntryHold['status'] = 'needs-attention') =>
  ({ status, reason }) as RoadmapEntryHold;
const attempt = (fields: object) => fields as Roadmap['attempts'][number];
const owner = (entryId: string) => ({
  roadmapId: asRoadmapId('r'),
  attemptId: asRoadmapAttemptId('a'),
  entryId: asRoadmapEntryId(entryId),
  definitionRevision: 1,
});

it('carries the hold on its own entry, and none while a round from that entry is open (LIVE-20)', () => {
  const cycle = { id: asWorkCycleId('review'), owner: owner('parent') };
  expect(
    carriedHold({ attempts: [], entryHolds: { parent: hold('ambiguous') } }, cycle)?.reason,
  ).toBe('ambiguous');
  expect(
    carriedHold(
      {
        attempts: [
          attempt({ cycleId: 'repair', recovery: { sourceEntryId: 'parent', phase: 'repair' } }),
        ],
        entryHolds: { parent: hold('ambiguous') },
      },
      cycle,
    ),
  ).toBeUndefined();
  // An operator's own pause is not carried.
  expect(
    carriedHold({ attempts: [], entryHolds: { parent: hold('paused', 'paused') } }, cycle),
  ).toBeUndefined();
});

it("a round's repair carries the hold on the round's source entry, where its refused merge is held (LIVE-24)", () => {
  const roadmap = {
    attempts: [
      attempt({
        cycleId: 'repair',
        entryId: 'slice',
        recovery: { sourceEntryId: 'verification', phase: 'repair' },
      }),
    ],
    entryHolds: { verification: hold('The review needs a successful run of each declared check') },
  };
  expect(
    carriedHold(roadmap, { id: asWorkCycleId('repair'), owner: owner('slice') })?.reason,
  ).toContain('declared check');
  // Held on its own entry too, the repair's item says both.
  expect(
    carriedHold(
      { ...roadmap, entryHolds: { ...roadmap.entryHolds, slice: hold('own') } },
      { id: asWorkCycleId('repair'), owner: owner('slice') },
    )?.reason,
  ).toBe('own The review needs a successful run of each declared check');
  // Another cycle of the slice is not the round's repair.
  expect(
    carriedHold(roadmap, { id: asWorkCycleId('other'), owner: owner('slice') }),
  ).toBeUndefined();
});

it('carries a sequential roadmap’s stop on its entry as that entry’s hold (R-C10 follow-up, decision 3)', () => {
  // A slice's merge at a phase gate that does not wait: the sequential roadmap stops on the slice.
  const cycle = { id: asWorkCycleId('slice-cycle'), owner: owner('slice') };
  const stopped = {
    attempts: [],
    entryHolds: {},
    status: 'needs-attention' as const,
    reason: 'The map binding changed.',
    attention: {
      code: 'scheduler-error' as const,
      owner: 'operator' as const,
      refs: { entryId: asRoadmapEntryId('slice'), cause: 'phase-gate' as const },
    },
    definition: {
      scheduling: {
        mode: 'sequential' as const,
        maxInFlight: 1,
        maxPerRepository: 1,
        maxIntegrationRefreshes: 1,
      },
    },
  };
  expect(carriedHold(stopped, cycle)?.reason).toBe('The map binding changed.');
  // A stop on another entry, or a parallel roadmap's own stop, is not this entry's hold.
  expect(
    carriedHold(
      {
        ...stopped,
        attention: { ...stopped.attention, refs: { entryId: asRoadmapEntryId('other') } },
      },
      cycle,
    ),
  ).toBeUndefined();
  expect(
    carriedHold(
      {
        ...stopped,
        definition: { scheduling: { ...stopped.definition.scheduling, mode: 'parallel' as const } },
      },
      cycle,
    ),
  ).toBeUndefined();
});

it('carries a wait’s own reason on the cycle it waits on, unless a round from its entry is open (R-C10 follow-up, decision 1)', () => {
  const review = { id: asWorkCycleId('review') };
  const declined = {
    code: 'cycle-attention' as const,
    reason: 'Finding ownership is ambiguous.',
    since: '2026-10-16T00:00:00.000Z',
    refs: { cycleId: review.id, entryId: asRoadmapEntryId('verification') },
  };
  expect(carriedWait({ attempts: [], entryWaits: { verification: declined } }, review)).toBe(
    'Finding ownership is ambiguous.',
  );
  // A wait that only repeats the cycle's stop names no entry; another cycle's wait is not this one's.
  const { entryId: _entry, ...plain } = declined.refs;
  expect(
    carriedWait(
      { attempts: [], entryWaits: { verification: { ...declined, refs: plain } } },
      review,
    ),
  ).toBeUndefined();
  expect(
    carriedWait(
      { attempts: [], entryWaits: { verification: declined } },
      { id: asWorkCycleId('other') },
    ),
  ).toBeUndefined();
  // A controller-owned wait is not the operator's to read.
  expect(
    carriedWait(
      {
        attempts: [],
        entryWaits: { verification: { ...declined, code: 'cycle-waiting' as const } },
      },
      review,
    ),
  ).toBeUndefined();
  // Once a round from the entry is open, its repair's item carries the round's stops.
  expect(
    carriedWait(
      {
        attempts: [
          attempt({
            cycleId: 'repair',
            recovery: { sourceEntryId: 'verification', phase: 'repair' },
          }),
        ],
        entryWaits: { verification: declined },
      },
      review,
    ),
  ).toBeUndefined();
});
