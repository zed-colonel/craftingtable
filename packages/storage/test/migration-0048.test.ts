import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
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
 * Migration 0048 (R-C17 part 4, decision 0): a Claude result held while tracked background work
 * ran, journaled at exit after the session worked on past it, is marked `afterLaterWork` on its
 * `turn-completed` event. An older release's strict run-event contract refuses to read it, so it
 * is recorded in migration 0042's catalog, and the deploy preflight (R-H3) refuses a rollback to a
 * release without it.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const migrations = discoverMigrations();

function temporaryPath() {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-0048-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

const rows = (database: Database.Database, schema: number) =>
  database
    .prepare(
      'SELECT kind, value FROM stored_vocabulary WHERE introduced_in_schema = ? ORDER BY kind, value',
    )
    .all(schema);

describe('migration 0048: the held result’s mark in the stored vocabulary', () => {
  it('appends its row to the catalog and keeps everything that existed', () => {
    const database = openDatabase(temporaryPath());
    runMigrations(database, migrations.slice(0, 47));
    const before = imageOf(database);
    runMigrations(database, migrations.slice(0, 48));
    expect(preservationProblems(before, imageOf(database))).toEqual([]);
    expect(rows(database, 48)).toEqual([{ kind: 'run-event-field', value: 'afterLaterWork' }]);
    expect(rows(database, 47)).toHaveLength(9);
    expect(
      (
        database.prepare('SELECT COUNT(*) AS count FROM stored_vocabulary').get() as {
          count: number;
        }
      ).count,
    ).toBe(29);
    database.close();
  });

  it('is refused by a schema-47 release, so a rollback across it is refused', () => {
    const path = temporaryPath();
    const database = openDatabase(path);
    runMigrations(database, migrations.slice(0, 48));
    database.close();
    expect(() => inspectMigrationStatus(path, migrations.slice(0, 47))).toThrow(
      MigrationValidationError,
    );
  });
});
