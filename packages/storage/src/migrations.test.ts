import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import {
  checksumSql,
  discoverMigrations,
  inspectMigrationStatus,
  type MigrationValidationError,
  migrationStatus,
  runMigrations,
} from './migrations.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'craftingtable-migration-test-'));
  directories.push(directory);
  return join(directory, 'craftingtable.sqlite');
}

describe('ordered SQL migrations', () => {
  it('migrates a clean real file and records the expected checksum', () => {
    const path = databasePath();
    const database = openDatabase(path);
    const migrations = discoverMigrations();
    expect(runMigrations(database, migrations)).toEqual({
      currentVersion: 24,
      supportedVersion: 24,
      pendingVersions: [],
    });
    const rows = database
      .prepare(`SELECT version, name, checksum FROM schema_migrations ORDER BY version`)
      .all() as { version: number; name: string; checksum: string }[];
    expect(rows).toEqual([
      { version: 1, name: 'ct02-foundation', checksum: migrations[0]?.checksum },
      { version: 2, name: 'ct03-planning', checksum: migrations[1]?.checksum },
      { version: 3, name: 'ct04a2a-repository-model', checksum: migrations[2]?.checksum },
      { version: 4, name: 'ct04a2b-repository-journal', checksum: migrations[3]?.checksum },
      { version: 5, name: 'execution', checksum: migrations[4]?.checksum },
      { version: 6, name: 'workflow', checksum: migrations[5]?.checksum },
      { version: 7, name: 'agent-backends', checksum: migrations[6]?.checksum },
      { version: 8, name: 'run-profiles', checksum: migrations[7]?.checksum },
      { version: 9, name: 'work-cycles', checksum: migrations[8]?.checksum },
      { version: 10, name: 'branch-mechanics', checksum: migrations[9]?.checksum },
      { version: 11, name: 'notifications', checksum: migrations[10]?.checksum },
      { version: 12, name: 'roadmaps', checksum: migrations[11]?.checksum },
      { version: 13, name: 'delegated-merges', checksum: migrations[12]?.checksum },
      { version: 14, name: 'plan-finalizations', checksum: migrations[13]?.checksum },
      { version: 15, name: 'storage-management', checksum: migrations[14]?.checksum },
      { version: 16, name: 'package-imports', checksum: migrations[15]?.checksum },
      { version: 17, name: 'agenda-removal', checksum: migrations[16]?.checksum },
      { version: 18, name: 'execution-scopes', checksum: migrations[17]?.checksum },
      { version: 19, name: 'phase-reservations', checksum: migrations[18]?.checksum },
      { version: 20, name: 'runtime-evidence', checksum: migrations[19]?.checksum },
      { version: 21, name: 'map-adoptions', checksum: migrations[20]?.checksum },
      { version: 22, name: 'map-amendments', checksum: migrations[21]?.checksum },
      { version: 23, name: 'native-verification', checksum: migrations[22]?.checksum },
      { version: 24, name: 'repository-policy', checksum: migrations[23]?.checksum },
    ]);
    database.close();
  });

  it('is idempotent when reopened on the current schema', () => {
    const path = databasePath();
    const first = openDatabase(path);
    runMigrations(first);
    first.close();
    const second = openDatabase(path);
    runMigrations(second);
    expect(
      (second.prepare(`SELECT COUNT(*) AS count FROM schema_migrations`).get() as { count: number })
        .count,
    ).toBe(24);
    second.close();
  });

  it('rejects a changed applied checksum without mutation (A2A-MIG-004)', () => {
    const path = databasePath();
    const database = openDatabase(path);
    const migrations = discoverMigrations();
    runMigrations(database, migrations);
    const first = migrations[0];
    if (first === undefined) {
      throw new Error('Expected at least one migration');
    }
    const changedSql = `${first.sql}\n-- changed`;
    const changed = [{ ...first, sql: changedSql, checksum: checksumSql(changedSql) }];
    expect(() => migrationStatus(database, changed)).toThrow(/checksum mismatch/);
    expect(
      (
        database.prepare(`SELECT COUNT(*) AS count FROM schema_migrations`).get() as {
          count: number;
        }
      ).count,
    ).toBe(24);
    database.close();
  });

  it('rejects a newer unsupported schema version', () => {
    const path = databasePath();
    const database = openDatabase(path);
    runMigrations(database);
    database
      .prepare(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES (25, 'future', ?, ?)`,
      )
      .run('f'.repeat(64), new Date().toISOString());
    expect(() => migrationStatus(database)).toThrow(/newer than or unknown/);
    database.close();
  });

  it('rolls back the ledger and partial schema when the first migration fails', () => {
    const path = databasePath();
    const database = openDatabase(path);
    const sql = `CREATE TABLE partial (id INTEGER); INSERT INTO missing_table VALUES (1);`;
    expect(() =>
      runMigrations(database, [{ version: 1, name: 'broken', sql, checksum: checksumSql(sql) }]),
    ).toThrow();
    const tables = database
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN ('partial', 'schema_migrations')`,
      )
      .all();
    expect(tables).toEqual([]);
    database.close();
  });

  it('rejects a database opened independently with an unsupported ledger row', () => {
    const path = databasePath();
    const database = new Database(path);
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO schema_migrations VALUES (99, 'future', '${'f'.repeat(64)}', '2026-01-01T00:00:00.000Z');
    `);
    expect(() => migrationStatus(database)).toThrow(/99/);
    database.close();
  });

  it('inspects status read-only without changing journal mode or creating WAL companions', () => {
    const path = databasePath();
    const database = new Database(path);
    database.exec(`CREATE TABLE marker (id INTEGER PRIMARY KEY)`);
    expect(database.pragma('journal_mode', { simple: true })).toBe('delete');
    database.close();

    expect(inspectMigrationStatus(path)).toEqual({
      currentVersion: 0,
      supportedVersion: 24,
      pendingVersions: [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ],
    });

    const inspection = new Database(path, { readonly: true, fileMustExist: true });
    expect(inspection.pragma('journal_mode', { simple: true })).toBe('delete');
    inspection.close();
    expect(existsSync(`${path}-wal`)).toBe(false);
    expect(existsSync(`${path}-shm`)).toBe(false);
  });

  it('reports a missing database as pending without creating it', () => {
    const path = databasePath();
    expect(existsSync(path)).toBe(false);
    expect(inspectMigrationStatus(path)).toEqual({
      currentVersion: 0,
      supportedVersion: 24,
      pendingVersions: [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
      ],
    });
    expect(existsSync(path)).toBe(false);
  });

  it('classifies unsupported and tampered schemas for operator-facing callers', () => {
    const path = databasePath();
    const database = openDatabase(path);
    runMigrations(database);
    database
      .prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = 1`)
      .run('0'.repeat(64));
    database.close();
    expect(() => inspectMigrationStatus(path)).toThrow(
      expect.objectContaining<Partial<MigrationValidationError>>({
        failure: 'checksum-mismatch',
      }),
    );
  });
});
