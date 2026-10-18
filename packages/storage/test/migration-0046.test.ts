import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import {
  discoverMigrations,
  inspectMigrationStatus,
  MigrationValidationError,
  runMigrations,
} from '../src/migrations.js';
import { imageOf, preservationProblems } from './migration-preservation.js';
import { testDataRoot } from './test-support.js';

/**
 * Migration 0046 (R-B7 decision 1, AGT-12): a launch's reservation, its durable record before
 * its first file, and the one-time start-up task that removes the run directories refused
 * launches left before it.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const migrations = discoverMigrations();

function temporaryPath() {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-0046-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

describe('migration 0046: launch reservations', () => {
  it('adds the two tables, asks the next start to remove the orphans, and keeps everything that existed', () => {
    const database = openDatabase(temporaryPath());
    runMigrations(database, migrations.slice(0, 45));
    const before = imageOf(database);
    runMigrations(database, migrations.slice(0, 46));
    expect(preservationProblems(before, imageOf(database))).toEqual([]);
    expect(database.prepare('SELECT task FROM startup_tasks').all()).toEqual([
      { task: 'remove-orphan-run-directories' },
    ]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM run_launches').get()).toEqual({
      count: 0,
    });
    // Only the one task is known.
    expect(() =>
      database.prepare("INSERT INTO startup_tasks (task) VALUES ('other')").run(),
    ).toThrow(/CHECK constraint failed/);
    // A reservation names absolute directories of an existing workspace and worktree.
    expect(() =>
      database
        .prepare(
          `INSERT INTO run_launches VALUES ('run-1', 'missing', 'missing', '/runs/run-1', 1,
             '/check-logs/run-1/replies', 1, '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
    // And only its own run's directories (increment 11b review, LOW-2): the checks alone, so
    // without the parent rows.
    database.pragma('foreign_keys = OFF');
    const reserve = (runId: string, run: string, reply: string) =>
      database
        .prepare(
          `INSERT INTO run_launches VALUES (?, 'ws', 'tree', ?, 1, ?, 1, '2026-01-01T00:00:00.000Z')`,
        )
        .run(runId, run, reply);
    for (const [runId, run, reply] of [
      ['..', '/runs/..', '/check-logs/../replies'],
      ['', '/runs/', '/check-logs//replies'],
      ['run-2', '/runs', '/check-logs/run-2/replies'],
      ['run-2', '/runs/run-20', '/check-logs/run-2/replies'],
      ['run-2', '/runs/run-2', '/check-logs/run-2'],
      ['run-2', '/runs/run-2', '/check-logs/run-2/replies/x'],
    ] as const)
      expect(() => reserve(runId, run, reply), `${runId} ${run} ${reply}`).toThrow(
        /CHECK constraint failed/,
      );
    reserve('run-2', '/runs/run-2', '/check-logs/run-2/replies');
    expect(database.prepare('SELECT run_id FROM run_launches').all()).toEqual([
      { run_id: 'run-2' },
    ]);

    database.close();
  });

  it('is refused by a schema-45 release, so a rollback across it is refused', () => {
    const path = temporaryPath();
    const database = openDatabase(path);
    runMigrations(database, migrations.slice(0, 46));
    database.close();
    expect(() => inspectMigrationStatus(path, migrations.slice(0, 45))).toThrow(
      MigrationValidationError,
    );
  });
});
