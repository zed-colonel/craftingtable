import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import type { SourceRepositoryId, WorktreeId } from '@craftingtable/domain';
import { copyDatabaseImmutably, relocateRehearsalCopy } from '../src/rehearsal-copy.js';
import { SEED_NOW, seedPlan, seedWorkspace } from './planning-test-support.js';
import { temporaryStorage } from './test-support.js';

/** The rehearsal's copy (R-B11): read immutably, relocated only as a closed copy. */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function source() {
  const fixture = temporaryStorage();
  const seed = seedPlan(fixture.storage, seedWorkspace(fixture.storage));
  for (const [id, rootPath] of [
    ['r1', '/live/one'],
    ['r2', '/live/two'],
  ] as const)
    fixture.storage.execution.sourceRepositories.insert({
      id: id as SourceRepositoryId,
      workspaceId: seed.workspaceId,
      displayName: id,
      rootPath,
      defaultBranch: 'main',
      registeredHeadSha: 'a'.repeat(40),
      registeredAt: SEED_NOW,
      registeredByUserId: seed.userId,
    });
  for (const id of ['w1', 'w2'])
    fixture.storage.execution.worktrees.insert({
      id: id as WorktreeId,
      workspaceId: seed.workspaceId,
      repositoryId: 'r1' as SourceRepositoryId,
      projectId: seed.projectId,
      planVersionId: seed.planVersionId,
      branchName: `ct/${id}`,
      baseSha: 'a'.repeat(40),
      baseBranch: 'main',
      path: `/live/worktrees/${id}`,
      createdAt: SEED_NOW,
      createdByUserId: seed.userId,
    });
  directories.push(fixture.directory);
  return { directory: fixture.directory, path: fixture.databasePath, database: fixture.storage };
}

it('copies a database it opens only immutably, and relocates the closed copy alone', () => {
  const live = source();
  // An immutable read never opens the write-ahead log: writes not yet checkpointed stay out.
  const early = join(live.directory, 'early.sqlite');
  copyDatabaseImmutably(live.path, early);
  const before = new Database(early, { readonly: true });
  try {
    expect(before.prepare('SELECT COUNT(*) AS n FROM source_repositories').get()).toEqual({ n: 0 });
  } finally {
    before.close();
  }
  // Checkpointed (here by closing), they are in the copy.
  live.database.close();
  const copy = join(live.directory, 'copy.sqlite');
  copyDatabaseImmutably(live.path, copy);
  // A copy is never written over.
  expect(() => copyDatabaseImmutably(live.path, copy)).toThrow(/already exists/);
  relocateRehearsalCopy(copy, {
    repositories: [{ id: 'r1', rootPath: '/copy/one' }],
    worktrees: [{ id: 'w1', path: '/copy/worktrees/w1' }],
    absentRoot: '/copy/absent',
  });
  const read = new Database(copy, { readonly: true });
  try {
    expect(read.prepare('SELECT id, root_path FROM source_repositories ORDER BY id').all()).toEqual(
      [
        { id: 'r1', root_path: '/copy/one' },
        // A repository not copied points nowhere a live checkout is.
        { id: 'r2', root_path: '/copy/absent/r2' },
      ],
    );
    // A worktree not copied points nowhere a live checkout is, either.
    expect(read.prepare('SELECT id, path FROM worktrees ORDER BY id').all()).toEqual([
      { id: 'w1', path: '/copy/worktrees/w1' },
      { id: 'w2', path: '/copy/absent/worktrees/w2' },
    ]);
  } finally {
    read.close();
  }
  // The source is unchanged.
  const original = new Database(live.path, { readonly: true });
  try {
    expect(original.prepare('SELECT root_path FROM source_repositories ORDER BY id').all()).toEqual(
      [{ root_path: '/live/one' }, { root_path: '/live/two' }],
    );
  } finally {
    original.close();
  }
  // A database with a write-ahead log beside it may be live: never relocated.
  writeFileSync(`${copy}-wal`, '');
  expect(() =>
    relocateRehearsalCopy(copy, { repositories: [], worktrees: [], absentRoot: '/x' }),
  ).toThrow(/never a live database/);
  expect(existsSync(copy)).toBe(true);
});
