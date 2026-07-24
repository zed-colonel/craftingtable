import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { checksumSql, discoverMigrations, migrationStatus, runMigrations } from './migrations.js';

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
      currentVersion: 1,
      supportedVersion: 1,
      pendingVersions: [],
    });
    const row = database.prepare(`SELECT * FROM schema_migrations`).get() as {
      version: number;
      name: string;
      checksum: string;
    };
    expect(row).toMatchObject({
      version: 1,
      name: 'ct02-foundation',
      checksum: migrations[0]?.checksum,
    });
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
    ).toBe(1);
    second.close();
  });

  it('rejects a changed applied checksum without mutation', () => {
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
    ).toBe(1);
    database.close();
  });

  it('rejects a newer unsupported schema version', () => {
    const path = databasePath();
    const database = openDatabase(path);
    runMigrations(database);
    database
      .prepare(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES (2, 'future', ?, ?)`,
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
});
