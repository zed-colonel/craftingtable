import { randomUUID } from 'node:crypto';
import type { ProtectedRefMove } from '@craftingtable/domain';
import { afterEach, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { seedWorkspace } from './planning-test-support.js';
import { type TemporaryStorage, temporaryStorage } from './test-support.js';

const fixtures: TemporaryStorage[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

it('lets a protected-ref move change only by its one acknowledgement (R-G5 review)', () => {
  const fixture = temporaryStorage();
  fixtures.push(fixture);
  const { storage } = fixture;
  const { workspaceId, userId } = seedWorkspace(storage);
  const move: ProtectedRefMove = {
    id: randomUUID(),
    workspaceId,
    repositoryId: 'repo',
    runId: 'run' as ProtectedRefMove['runId'],
    worktreeId: 'tree' as ProtectedRefMove['worktreeId'],
    detectedAt: '2026-09-28T12:00:00.000Z',
    moves: [{ branch: 'main', before: 'a'.repeat(40), after: 'b'.repeat(40) }],
  };
  storage.transaction((tx) => tx.protectedRefs.add(move));
  const db = openDatabase(fixture.databasePath);
  try {
    const write =
      (sql: string, ...args: unknown[]) =>
      () =>
        db.prepare(sql).run(...args);
    const acknowledged = {
      ...move,
      acknowledgedAt: '2026-09-28T13:00:00.000Z',
      acknowledgedByUserId: userId,
    };
    // An acknowledgement that also rewrites what moved is refused.
    expect(
      write(
        'UPDATE protected_ref_moves SET record_json=? WHERE id=?',
        JSON.stringify({ ...acknowledged, moves: [{ branch: 'main', before: null, after: null }] }),
        move.id,
      ),
    ).toThrow('acknowledged, once');
    // An edit without an acknowledgement is refused.
    expect(
      write(
        "UPDATE protected_ref_moves SET record_json = json_set(record_json, '$.detectedAt', '2026-01-01T00:00:00.000Z') WHERE id=?",
        move.id,
      ),
    ).toThrow('acknowledged, once');
    // Replacing the row, which fires no update or delete trigger, is refused.
    expect(
      write(
        'INSERT OR REPLACE INTO protected_ref_moves VALUES (?,?,?,?)',
        move.id,
        workspaceId,
        'repo',
        JSON.stringify({ ...move, moves: [{ branch: 'other', before: null, after: null }] }),
      ),
    ).toThrow('cannot be replaced');
  } finally {
    db.close();
  }
  // The acknowledgement itself goes through, once.
  expect(
    storage.protectedRefs.acknowledge(workspaceId, move.id, '2026-09-28T13:00:00.000Z', userId),
  ).toBe(true);
  expect(
    storage.protectedRefs.acknowledge(workspaceId, move.id, '2026-09-28T14:00:00.000Z', userId),
  ).toBe(false);
  expect(storage.protectedRefs.find(workspaceId, move.id)).toEqual({
    ...move,
    acknowledgedAt: '2026-09-28T13:00:00.000Z',
    acknowledgedByUserId: userId,
  });
});
