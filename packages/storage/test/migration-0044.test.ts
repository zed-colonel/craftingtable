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
 * Migration 0044 (R-C10's follow-up, decision 4): the roadmap's re-verification grant, a new
 * optional roadmap field that an older release's strict contract refuses, recorded in migration
 * 0042's catalog, so the deploy preflight (R-H3) refuses a rollback to a release without it.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const migrations = discoverMigrations();

function temporaryPath() {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-0044-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

const rows = (database: Database.Database, schema: number) =>
  database
    .prepare(
      'SELECT kind, value FROM stored_vocabulary WHERE introduced_in_schema = ? ORDER BY kind, value',
    )
    .all(schema);

describe('migration 0044: the re-verification grant’s stored vocabulary', () => {
  it('appends its row to the catalog and keeps everything that existed', () => {
    const database = openDatabase(temporaryPath());
    runMigrations(database, migrations.slice(0, 43));
    const before = imageOf(database);
    runMigrations(database, migrations.slice(0, 44));
    expect(preservationProblems(before, imageOf(database))).toEqual([]);
    expect(rows(database, 44)).toEqual([{ kind: 'roadmap-field', value: 'reverificationGrant' }]);
    expect(rows(database, 43)).toHaveLength(2);
    expect(rows(database, 42)).toHaveLength(15);
    database.close();
  });

  it('is refused by a schema-43 release, so a rollback across it is refused', () => {
    const path = temporaryPath();
    const database = openDatabase(path);
    runMigrations(database, migrations.slice(0, 44));
    database.close();
    expect(() => inspectMigrationStatus(path, migrations.slice(0, 43))).toThrow(
      MigrationValidationError,
    );
  });
});
