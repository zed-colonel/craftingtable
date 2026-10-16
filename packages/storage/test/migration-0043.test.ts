import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ENTRY_WAIT_CODES } from '@craftingtable/domain';
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
 * Migration 0043 (R-B4, decision 15): the stored vocabulary R-B4's increment 5 adds, recorded in
 * migration 0042's catalog, so the deploy preflight (R-H3) refuses a rollback to a release
 * without it: the roadmap entry wait `predecessor-merge-missing` (decision 1) and the holds'
 * typed cause (`refs.cause`, decision 3).
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const migrations = discoverMigrations();

/** The entry waits a schema-42 release could store, before the catalog recorded them. Frozen. */
const STORED_BEFORE_THE_CATALOG = [
  'dependency-blocked',
  'capacity-blocked',
  'exclusion-blocked',
  'phase-blocked',
  'integration-held',
  'review-running',
  'recovery-round',
  'cycle-waiting',
  'cycle-attention',
  'cycle-paused',
  'cycle-ended',
  'entry-held',
];

function temporaryPath() {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-0043-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

const rows = (database: Database.Database, schema: number) =>
  database
    .prepare(
      'SELECT kind, value FROM stored_vocabulary WHERE introduced_in_schema = ? ORDER BY kind, value',
    )
    .all(schema);

describe('migration 0043: increment 5’s stored vocabulary', () => {
  it('appends its rows to the catalog and keeps everything that existed', () => {
    const database = openDatabase(temporaryPath());
    runMigrations(database, migrations.slice(0, 42));
    const before = imageOf(database);
    runMigrations(database, migrations.slice(0, 43));
    expect(preservationProblems(before, imageOf(database))).toEqual([]);
    expect(rows(database, 43)).toEqual([
      { kind: 'attention-ref', value: 'cause' },
      { kind: 'entry-wait', value: 'predecessor-merge-missing' },
    ]);
    expect(rows(database, 42)).toHaveLength(15);
    database.close();
  });

  it('is refused by a schema-42 release, so a rollback across it is refused', () => {
    const path = temporaryPath();
    const database = openDatabase(path);
    runMigrations(database, migrations.slice(0, 43));
    database.close();
    expect(() => inspectMigrationStatus(path, migrations.slice(0, 42))).toThrow(
      MigrationValidationError,
    );
  });

  it('catalogs every entry wait stored since the catalog exists', () => {
    // A wait added later needs a migration adding its row (R-B4, decision 15).
    const database = openDatabase(temporaryPath());
    runMigrations(database, migrations);
    const catalogued = new Set(
      (
        database.prepare("SELECT value FROM stored_vocabulary WHERE kind = 'entry-wait'").all() as {
          value: string;
        }[]
      ).map((row) => row.value),
    );
    database.close();
    const known = new Set<string>([...STORED_BEFORE_THE_CATALOG, ...catalogued]);
    expect(ENTRY_WAIT_CODES.filter((code) => !known.has(code))).toEqual([]);
    expect(
      [...known].filter((code) => !(ENTRY_WAIT_CODES as readonly string[]).includes(code)),
    ).toEqual([]);
    expect(STORED_BEFORE_THE_CATALOG.filter((code) => catalogued.has(code))).toEqual([]);
  });
});
