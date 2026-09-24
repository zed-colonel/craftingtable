import type { Roadmap, WorkCycle } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { describe, expect, it, vi } from 'vitest';
import { cycleOwnership } from './cycle-ownership.js';
import { mapReadSnapshot } from './map-read-snapshot.js';

const attempt = { id: 'attempt-1', entryId: 'entry-1', definitionRevision: 2, cycleId: 'cycle-1' };
const roadmap = { id: 'roadmap-1', status: 'running', attempts: [attempt] } as unknown as Roadmap;
const other = { id: 'roadmap-2', status: 'running', attempts: [] } as unknown as Roadmap;

function storage() {
  const roadmaps = {
    find: vi.fn((_ws: string, id: string) => [roadmap, other].find((r) => r.id === id)),
    list: vi.fn(() => [other, roadmap]),
  };
  const tx = {
    roadmaps,
    planning: { workItems: {}, projects: {}, dependencies: {} },
    execution: {
      worktrees: {},
      cycles: {},
      runs: {},
      runEvents: {},
      branchSettings: {},
      sourceRepositories: {},
    },
    scopeReceipts: {},
    phaseScheduling: {},
    imports: {},
    amendments: {},
    runtimeEvidence: {},
  } as unknown as StorageRepositories;
  return { roadmaps, tx };
}
const cycle = (owner: WorkCycle['owner']) =>
  ({ id: 'cycle-1', workspaceId: 'ws', ...(owner === undefined ? {} : { owner }) }) as WorkCycle;

describe('cycleOwnership (R-B3)', () => {
  it('reads the recorded owner with one lookup and never scans the roadmaps', () => {
    const { roadmaps, tx } = storage();
    const owner = {
      roadmapId: 'roadmap-1',
      attemptId: 'attempt-1',
      entryId: 'entry-1',
      definitionRevision: 2,
    };
    expect(cycleOwnership(tx, cycle(owner))).toEqual({ roadmap, attempt });
    expect(roadmaps.find).toHaveBeenCalledWith('ws', 'roadmap-1');
    expect(roadmaps.list).not.toHaveBeenCalled();
    // An attempt that an amendment dropped no longer owns the cycle.
    expect(cycleOwnership(tx, cycle({ ...owner, attemptId: 'dropped' }))).toBeUndefined();
  });

  it('treats a cycle recorded as unowned as manual work without reading roadmaps', () => {
    const { roadmaps, tx } = storage();
    expect(cycleOwnership(tx, cycle(null))).toBeUndefined();
    expect(roadmaps.find).not.toHaveBeenCalled();
    expect(roadmaps.list).not.toHaveBeenCalled();
  });

  it('resolves a record without an owner from the attempts, once per read snapshot', () => {
    const { roadmaps, tx } = storage();
    expect(cycleOwnership(tx, cycle(undefined))).toEqual({ roadmap, attempt });
    const snapshot = mapReadSnapshot(tx);
    cycleOwnership(snapshot, cycle(undefined));
    cycleOwnership(snapshot, cycle(undefined));
    expect(roadmaps.list).toHaveBeenCalledTimes(2);
  });
});
