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
 * Migration 0049 (R-C17 part 4, decisions 8 and 9): a workspace's default step time limit for new
 * cycles and entries, one row per workspace, and its audit action. A new table and catalog row, so
 * the deploy preflight (R-H3) refuses a rollback to a release without them.
 */

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const migrations = discoverMigrations();

function temporaryPath() {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-0049-'));
  directories.push(directory);
  return join(directory, 'state.sqlite');
}

describe('migration 0049: the workspace’s default step time limit', () => {
  it('adds the table and its audit action, and keeps everything that existed', () => {
    const database = openDatabase(temporaryPath());
    runMigrations(database, migrations.slice(0, 48));
    const before = imageOf(database);
    runMigrations(database, migrations.slice(0, 49));
    expect(preservationProblems(before, imageOf(database))).toEqual([]);
    expect(
      database
        .prepare('SELECT action FROM audit_action_kinds WHERE introduced_in_schema = 49')
        .all(),
    ).toEqual([{ action: 'cycle-defaults.updated' }]);
    database
      .prepare(
        `INSERT INTO users (id, username, username_normalized, password_hash, status, created_at, updated_at)
         VALUES ('u', 'u', 'u', '$argon2id$x', 'active', 't', 't')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO workspaces (id, name, slug, status, created_by_user_id, created_at, updated_at, version)
         VALUES ('w', 'W', 'w', 'active', 'u', 't', 't', 1)`,
      )
      .run();
    const insert = (minutes: number) =>
      database
        .prepare('INSERT OR REPLACE INTO workspace_cycle_defaults VALUES (?, ?, ?, ?)')
        .run('w', minutes, 't', 'u');
    insert(45);
    expect(database.prepare('SELECT * FROM workspace_cycle_defaults').all()).toEqual([
      { workspace_id: 'w', max_run_minutes: 45, updated_at: 't', updated_by_user_id: 'u' },
    ]);
    for (const minutes of [0, 1441]) expect(() => insert(minutes)).toThrow();
    database.close();
  });

  it('is refused by a schema-48 release, so a rollback across it is refused', () => {
    const path = temporaryPath();
    const database = openDatabase(path);
    runMigrations(database, migrations.slice(0, 49));
    database.close();
    expect(() => inspectMigrationStatus(path, migrations.slice(0, 48))).toThrow(
      MigrationValidationError,
    );
  });
});
