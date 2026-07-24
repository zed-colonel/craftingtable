import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import type { MigrationStatus } from './types.js';

export interface MigrationDefinition {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

const MIGRATION_FILE = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.sql$/;
const LEDGER_SQL = `
  CREATE TABLE schema_migrations (
    version    INTEGER PRIMARY KEY CHECK (version > 0),
    name       TEXT NOT NULL UNIQUE,
    checksum   TEXT NOT NULL CHECK (length(checksum) = 64),
    applied_at TEXT NOT NULL
  ) STRICT
`;

export const DEFAULT_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);

export function checksumSql(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

export function discoverMigrations(
  directory = DEFAULT_MIGRATIONS_DIRECTORY,
): readonly MigrationDefinition[] {
  const migrations = readdirSync(directory)
    .map((filename) => {
      const match = MIGRATION_FILE.exec(filename);
      if (match === null) {
        throw new Error(`Invalid migration filename: ${filename}`);
      }
      const version = Number(match[1]);
      const name = match[2] as string;
      const sql = readFileSync(new URL(filename, `file://${directory}/`), 'utf8');
      return { version, name, sql, checksum: checksumSql(sql) };
    })
    .toSorted((left, right) => left.version - right.version);

  migrations.forEach((migration, index) => {
    const expected = index + 1;
    if (migration.version !== expected) {
      throw new Error(
        `Migration versions must be contiguous from 1; expected ${expected}, got ${migration.version}`,
      );
    }
  });
  return migrations;
}

function ledgerExists(database: Database.Database): boolean {
  const row = database
    .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get('schema_migrations');
  return row !== undefined;
}

function readApplied(database: Database.Database): readonly AppliedMigrationRow[] {
  if (!ledgerExists(database)) {
    return [];
  }
  return database
    .prepare(`SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC`)
    .all() as AppliedMigrationRow[];
}

function validateApplied(
  applied: readonly AppliedMigrationRow[],
  migrations: readonly MigrationDefinition[],
): void {
  for (const row of applied) {
    const migration = migrations.find((candidate) => candidate.version === row.version);
    if (migration === undefined) {
      throw new Error(
        `Database schema version ${row.version} is newer than or unknown to this application`,
      );
    }
    if (migration.name !== row.name) {
      throw new Error(`Applied migration ${row.version} name mismatch`);
    }
    if (migration.checksum !== row.checksum) {
      throw new Error(`Applied migration ${row.version} checksum mismatch`);
    }
  }
}

export function migrationStatus(
  database: Database.Database,
  migrations: readonly MigrationDefinition[] = discoverMigrations(),
): MigrationStatus {
  const applied = readApplied(database);
  validateApplied(applied, migrations);
  const currentVersion = applied.at(-1)?.version ?? 0;
  return {
    currentVersion,
    supportedVersion: migrations.at(-1)?.version ?? 0,
    pendingVersions: migrations
      .filter((migration) => migration.version > currentVersion)
      .map((migration) => migration.version),
  };
}

export function runMigrations(
  database: Database.Database,
  migrations: readonly MigrationDefinition[] = discoverMigrations(),
  now: () => string = () => new Date().toISOString(),
): MigrationStatus {
  const initialStatus = migrationStatus(database, migrations);
  for (const version of initialStatus.pendingVersions) {
    const migration = migrations.find((candidate) => candidate.version === version);
    if (migration === undefined) {
      throw new Error(`Missing migration ${version}`);
    }
    database
      .transaction(() => {
        if (!ledgerExists(database)) {
          database.exec(LEDGER_SQL);
        }
        database.exec(migration.sql);
        database
          .prepare(
            `INSERT INTO schema_migrations (version, name, checksum, applied_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(migration.version, migration.name, migration.checksum, now());
      })
      .immediate();
  }
  return migrationStatus(database, migrations);
}
