import { randomUUID } from 'node:crypto';
import type { Roadmap } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { openCraftingTableStorage } from './storage.js';
import { seedWorkspace, SEED_NOW } from './planning-test-support.js';
import { temporaryStorage, type TemporaryStorage } from './test-support.js';
const fixtures: TemporaryStorage[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});
it('retains definitions across reopen, rejects stale writes, and rolls back revision failures', () => {
  const f = temporaryStorage();
  fixtures.push(f);
  const seed = seedWorkspace(f.storage);
  const id = randomUUID();
  const roadmap: Roadmap = {
    id,
    workspaceId: seed.workspaceId,
    version: 1,
    status: 'draft',
    reason: 'Saved',
    createdAt: SEED_NOW,
    updatedAt: SEED_NOW,
    createdByUserId: seed.userId,
    attempts: [],
    entryHolds: { [randomUUID()]: { status: 'paused', reason: 'Operator paused item.' } },
    definition: {
      roadmapId: id,
      revision: 1,
      name: 'Queue',
      scheduling: {
        mode: 'parallel',
        maxInFlight: 2,
        maxPerRepository: 2,
        maxIntegrationRefreshes: 3,
      },
      entries: [],
      createdAt: SEED_NOW,
      createdByUserId: seed.userId,
    },
  };
  f.storage.transaction((tx) => {
    expect(tx.roadmaps.save(roadmap, 0)).toBe(true);
    tx.roadmaps.addDefinition(roadmap.definition);
  });
  const next = {
    ...roadmap,
    version: 2,
    definition: { ...roadmap.definition, revision: 2, name: 'Changed' },
  };
  expect(() =>
    f.storage.transaction((tx) => {
      tx.roadmaps.save(next, 1);
      tx.roadmaps.addDefinition(roadmap.definition);
    }),
  ).toThrow();
  expect(f.storage.roadmaps.find(seed.workspaceId, id)).toEqual(roadmap);
  expect(f.storage.roadmaps.save(next, 9)).toBe(false);
  f.storage.close();
  const reopened = openCraftingTableStorage(f.databasePath);
  try {
    expect(reopened.roadmaps.find(seed.workspaceId, id)).toEqual(roadmap);
    expect(reopened.roadmaps.history(seed.workspaceId, id)).toEqual([roadmap.definition]);
    expect(reopened.roadmaps.definition(seed.workspaceId, id, 1)).toEqual(roadmap.definition);
    expect(reopened.roadmaps.definition(seed.workspaceId, id, 2)).toBeUndefined();
    expect(reopened.roadmaps.definition(seed.workspaceId, randomUUID(), 1)).toBeUndefined();
  } finally {
    reopened.close();
  }
  const db = openDatabase(f.databasePath);
  try {
    expect(() =>
      db
        .prepare(
          'UPDATE roadmap_definitions SET definition_json = definition_json WHERE roadmap_id = ?',
        )
        .run(id),
    ).toThrow('immutable');
    expect(() =>
      db.prepare('DELETE FROM roadmap_definitions WHERE roadmap_id = ?').run(id),
    ).toThrow('immutable');
  } finally {
    db.close();
  }
});
