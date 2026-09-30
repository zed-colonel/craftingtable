import type { Roadmap, RoadmapEntryHold } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { carriedHold } from './attention-projector.js';

const hold = (reason: string, status: RoadmapEntryHold['status'] = 'needs-attention') =>
  ({ status, reason }) as RoadmapEntryHold;
const attempt = (fields: object) => fields as Roadmap['attempts'][number];
const owner = (entryId: string) => ({
  roadmapId: 'r',
  attemptId: 'a',
  entryId,
  definitionRevision: 1,
});

it('carries the hold on its own entry, and none while a round from that entry is open (LIVE-20)', () => {
  const cycle = { id: 'review', owner: owner('parent') };
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
  expect(carriedHold(roadmap, { id: 'repair', owner: owner('slice') })?.reason).toContain(
    'declared check',
  );
  // Another cycle of the slice is not the round's repair.
  expect(carriedHold(roadmap, { id: 'other', owner: owner('slice') })).toBeUndefined();
});
