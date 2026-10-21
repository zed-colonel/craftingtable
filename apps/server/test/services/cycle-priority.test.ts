import type { Roadmap, WorkCycle } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { expect, it } from 'vitest';
import { prioritizeRoadmapCycles } from '../../src/services/cycle-priority.js';
import { ownerPolicyOf } from '../../src/services/roadmap/owner-policy.js';

/**
 * Resolves each cycle to the attempt that names it, as `cycleOwnership` does, and gives its
 * roadmap's answer (R-B7: `OwnerPolicy`; the priority reads no storage).
 */
const ownedBy = (roadmap: Roadmap) => (cycle: WorkCycle) => {
  const attempt = roadmap.attempts.find((a) => a.cycleId === cycle.id);
  return attempt && ownerPolicyOf({} as StorageRepositories, roadmap, attempt);
};

it('dispatches reserved cycles in roadmap priority order while leaving unrelated work in place', () => {
  const cycles = ['later', 'manual', 'earlier', 'repair'].map((id) => ({ id }) as WorkCycle);
  const roadmap = {
    id: 'roadmap',
    status: 'running',
    definition: {
      scheduling: { mode: 'parallel' },
      entries: [{ id: 'first' }, { id: 'second' }, { id: 'last' }],
    },
    attempts: [
      { cycleId: 'later', entryId: 'last', status: 'active' },
      { cycleId: 'earlier', entryId: 'second', status: 'active' },
      { cycleId: 'repair', entryId: 'first', status: 'active', recovery: { phase: 'repair' } },
    ],
  } as unknown as Roadmap;
  expect(prioritizeRoadmapCycles(cycles, ownedBy(roadmap)).map((c) => c.id)).toEqual([
    'repair',
    'manual',
    'earlier',
    'later',
  ]);
  expect(prioritizeRoadmapCycles(cycles, ownedBy({ ...roadmap, status: 'paused' }))).toEqual(
    cycles,
  );
  expect(
    prioritizeRoadmapCycles(
      cycles,
      ownedBy({
        ...roadmap,
        definition: {
          ...roadmap.definition,
          scheduling: {
            mode: 'sequential',
            maxInFlight: 1,
            maxPerRepository: 1,
            maxIntegrationRefreshes: 3,
          },
        },
      }),
    ),
  ).toEqual(cycles);
});
