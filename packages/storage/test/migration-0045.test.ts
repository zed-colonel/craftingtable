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
 * Migration 0045 (R-C17 part 1): a declared check's own time limit, a new optional field of the
 * adopted check declaration that an older release's strict contract refuses to read, recorded in
 * migration 0042's catalog, so the deploy preflight (R-H3) refuses a rollback to a release
 * without it.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const migrations = discoverMigrations();

function temporaryPath() {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-0045-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

const rows = (database: Database.Database, schema: number) =>
  database
    .prepare(
      'SELECT kind, value FROM stored_vocabulary WHERE introduced_in_schema = ? ORDER BY kind, value',
    )
    .all(schema);

describe('migration 0045: the check time limit’s stored vocabulary', () => {
  it('appends its row to the catalog and keeps everything that existed', () => {
    const database = openDatabase(temporaryPath());
    runMigrations(database, migrations.slice(0, 44));
    const before = imageOf(database);
    runMigrations(database, migrations.slice(0, 45));
    expect(preservationProblems(before, imageOf(database))).toEqual([]);
    expect(rows(database, 45)).toEqual([
      { kind: 'check-declaration-field', value: 'timeoutMinutes' },
    ]);
    expect(rows(database, 44)).toEqual([{ kind: 'roadmap-field', value: 'reverificationGrant' }]);
    expect(rows(database, 43)).toHaveLength(2);
    expect(rows(database, 42)).toHaveLength(15);
    database.close();
  });

  it('is refused by a schema-44 release, so a rollback across it is refused', () => {
    const path = temporaryPath();
    const database = openDatabase(path);
    runMigrations(database, migrations.slice(0, 45));
    database.close();
    expect(() => inspectMigrationStatus(path, migrations.slice(0, 44))).toThrow(
      MigrationValidationError,
    );
  });
});
