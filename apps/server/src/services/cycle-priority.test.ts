import type { Roadmap, WorkCycle } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import { prioritizeRoadmapCycles } from './cycle-priority.js';

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
  expect(prioritizeRoadmapCycles(cycles, [roadmap]).map((c) => c.id)).toEqual([
    'repair',
    'manual',
    'earlier',
    'later',
  ]);
  expect(prioritizeRoadmapCycles(cycles, [{ ...roadmap, status: 'paused' }])).toEqual(cycles);
  expect(
    prioritizeRoadmapCycles(cycles, [
      {
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
      },
    ]),
  ).toEqual(cycles);
});
