import {
  asPlanVersionId,
  asRepositoryCleanupId,
  asRoadmapId,
  asRoadmapWindDownId,
  type RepositoryCleanup,
  type RoadmapWindDown,
} from '@craftingtable/domain';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SEED_NOW, seedPlan, seedWorkspace } from './planning-test-support.js';
import { type TemporaryStorage, temporaryStorage } from './test-support.js';

/** The wind-down repository (R-B11, ADR-073): records move forward, retirements never change. */

const fixtures: TemporaryStorage[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

const ROADMAP = asRoadmapId('00000000-0000-4000-8000-000000000001');
const OTHER_ROADMAP = asRoadmapId('00000000-0000-4000-8000-000000000004');

function fixture() {
  const storage = temporaryStorage();
  fixtures.push(storage);
  const seed = seedWorkspace(storage.storage);
  const plan = seedPlan(storage.storage, seed);
  const raw = new Database(storage.databasePath);
  try {
    for (const id of [ROADMAP, OTHER_ROADMAP])
      raw
        .prepare('INSERT INTO roadmaps VALUES (?,?,?,?,?)')
        .run(
          id,
          seed.workspaceId,
          'stopped',
          1,
          JSON.stringify({ id, workspaceId: seed.workspaceId, version: 1, status: 'stopped' }),
        );
  } finally {
    raw.close();
  }
  const record: RoadmapWindDown = {
    id: asRoadmapWindDownId('00000000-0000-4000-8000-000000000002'),
    workspaceId: seed.workspaceId,
    roadmapId: ROADMAP,
    version: 1,
    status: 'settling',
    retire: [{ planVersionId: plan.planVersionId, disposition: 'superseded' }],
    abandonResolutions: [],
    previewDigest: 'a'.repeat(64),
    requestedAt: SEED_NOW,
    requestedByUserId: seed.userId,
    startedAt: SEED_NOW,
  };
  return { storage: storage.storage, seed, plan, record };
}

describe('wind-down storage (R-B11)', () => {
  it('keeps one settlement record per roadmap and lists the ones still settling', () => {
    const { storage, record } = fixture();
    storage.transaction((tx) => tx.windDowns.insert(record));
    expect(storage.windDowns.find(record.workspaceId, ROADMAP)).toEqual(record);
    expect(storage.windDowns.find(record.workspaceId, OTHER_ROADMAP)).toBeUndefined();
    expect(storage.windDowns.settling()).toEqual([record]);
    const settled: RoadmapWindDown = {
      ...record,
      version: 2,
      status: 'settled',
      settledAt: SEED_NOW,
    };
    // A stale writer loses; the current one wins.
    expect(storage.transaction((tx) => tx.windDowns.replace({ ...settled, version: 3 }, 2))).toBe(
      false,
    );
    expect(storage.transaction((tx) => tx.windDowns.replace(settled, 1))).toBe(true);
    expect(storage.windDowns.find(record.workspaceId, ROADMAP)).toEqual(settled);
    expect(storage.windDowns.settling()).toEqual([]);
  });

  it('records a retirement once, and reads it per workspace', () => {
    const { storage, seed, plan, record } = fixture();
    storage.transaction((tx) => tx.windDowns.insert(record));
    const retirement = {
      workspaceId: seed.workspaceId,
      planVersionId: plan.planVersionId,
      disposition: 'parked' as const,
      windDownId: record.id,
      retiredAt: SEED_NOW,
      retiredByUserId: seed.userId,
    };
    expect(storage.transaction((tx) => tx.windDowns.retire(retirement))).toBe(true);
    // A second retirement of the same version changes nothing.
    expect(
      storage.transaction((tx) =>
        tx.windDowns.retire({ ...retirement, disposition: 'superseded' }),
      ),
    ).toBe(false);
    expect(storage.windDowns.retirement(seed.workspaceId, plan.planVersionId)).toEqual(retirement);
    expect(storage.windDowns.retirement(seed.workspaceId, asPlanVersionId('other'))).toBe(
      undefined,
    );
    expect(storage.windDowns.retirements(seed.workspaceId)).toEqual([retirement]);
    expect(storage.windDowns.retirements()).toEqual([retirement]);
  });

  it('resumes the running cleanup and keeps the finished ones as history', () => {
    const { storage, seed } = fixture();
    const cleanup: RepositoryCleanup = {
      id: asRepositoryCleanupId('00000000-0000-4000-8000-000000000003'),
      workspaceId: seed.workspaceId,
      roadmapId: ROADMAP,
      version: 1,
      status: 'running',
      planDigest: 'b'.repeat(64),
      discardDirty: false,
      actions: [],
      requestedAt: SEED_NOW,
      requestedByUserId: seed.userId,
    };
    storage.transaction((tx) => tx.windDowns.insertCleanup(cleanup));
    expect(storage.windDowns.runningCleanup(seed.workspaceId, ROADMAP)).toEqual(cleanup);
    expect(storage.windDowns.runningCleanups()).toEqual([cleanup]);
    const done: RepositoryCleanup = {
      ...cleanup,
      version: 2,
      status: 'done',
      finishedAt: SEED_NOW,
    };
    expect(storage.transaction((tx) => tx.windDowns.replaceCleanup(done, 1))).toBe(true);
    expect(storage.windDowns.runningCleanup(seed.workspaceId, ROADMAP)).toBeUndefined();
    const next: RepositoryCleanup = {
      ...cleanup,
      id: asRepositoryCleanupId('00000000-0000-4000-8000-000000000005'),
    };
    storage.transaction((tx) => tx.windDowns.insertCleanup(next));
    expect(storage.windDowns.latestCleanup(seed.workspaceId, ROADMAP)).toEqual(next);
    expect(storage.windDowns.cleanup(seed.workspaceId, cleanup.id)).toEqual(done);
    expect(storage.windDowns.latestCleanup(seed.workspaceId, OTHER_ROADMAP)).toBeUndefined();
  });
});

describe('project summaries (R-B11)', () => {
  it('name a project whose newest version is retired and that has no active version', () => {
    const { storage, seed, plan, record } = fixture();
    const summary = () =>
      storage.planning.queries
        .projectSummaries(seed.workspaceId, 10)
        .find((p) => p.id === plan.projectId);
    storage.transaction((tx) => {
      tx.windDowns.insert(record);
      tx.windDowns.retire({
        workspaceId: seed.workspaceId,
        planVersionId: plan.planVersionId,
        disposition: 'parked',
        windDownId: record.id,
        retiredAt: SEED_NOW,
        retiredByUserId: seed.userId,
      });
    });
    // Still the active version: no label.
    if (summary()?.activePlanVersionId === plan.planVersionId)
      expect(summary()?.retired).toBeUndefined();
    storage.transaction((tx) =>
      tx.imports.deactivatePlan(seed.workspaceId, plan.projectId, plan.planVersionId),
    );
    expect(summary()?.activePlanVersionId).toBeUndefined();
    expect(summary()?.retired).toBe('parked');
  });
});
