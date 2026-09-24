import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
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

export type MigrationValidationFailure =
  | 'unsupported-version'
  | 'name-mismatch'
  | 'checksum-mismatch';

export class MigrationValidationError extends Error {
  constructor(
    readonly failure: MigrationValidationFailure,
    message: string,
  ) {
    super(message);
    this.name = 'MigrationValidationError';
  }
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
      throw new MigrationValidationError(
        'unsupported-version',
        `Database schema version ${row.version} is newer than or unknown to this application`,
      );
    }
    if (migration.name !== row.name) {
      throw new MigrationValidationError(
        'name-mismatch',
        `Applied migration ${row.version} name mismatch`,
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new MigrationValidationError(
        'checksum-mismatch',
        `Applied migration ${row.version} checksum mismatch`,
      );
    }
  }
}

export function inspectMigrationStatus(
  databasePath: string,
  migrations: readonly MigrationDefinition[] = discoverMigrations(),
): MigrationStatus {
  if (!existsSync(databasePath)) {
    return {
      currentVersion: 0,
      supportedVersion: migrations.at(-1)?.version ?? 0,
      pendingVersions: migrations.map((migration) => migration.version),
    };
  }
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return migrationStatus(database, migrations);
  } finally {
    database.close();
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
    const foreignKeysOff = /^--\s*requires:\s*foreign_keys=off\s*$/m.test(migration.sql);
    if (foreignKeysOff) {
      if (database.inTransaction) throw new Error('Table rebuild requires an outermost migration');
      database.pragma('foreign_keys = OFF');
    }
    try {
      database
        .transaction(() => {
          if (!ledgerExists(database)) {
            database.exec(LEDGER_SQL);
          }
          database.exec(migration.sql);
          if (foreignKeysOff && database.prepare('PRAGMA foreign_key_check').all().length > 0) {
            throw new Error(`Migration ${migration.version} left foreign key violations`);
          }
          database
            .prepare(
              `INSERT INTO schema_migrations (version, name, checksum, applied_at)
             VALUES (?, ?, ?, ?)`,
            )
            .run(migration.version, migration.name, migration.checksum, now());
        })
        .immediate();
    } finally {
      if (foreignKeysOff) database.pragma('foreign_keys = ON');
    }
  }
  return migrationStatus(database, migrations);
}

/** Pre-migration snapshots kept per database directory; older ones are removed. */
export const PRE_MIGRATION_SNAPSHOTS_KEPT = 3;
const SNAPSHOT_FILE = /^craftingtable-schema-\d+-[0-9TZ-]+\.sqlite$/;

/**
 * Copies a populated database aside before pending migrations change it (HIST-13, R-B9).
 * The copy sits in `pre-migration/` next to the database and is consistent, because
 * `VACUUM INTO` reads one snapshot of the live file. Returns the copy's path, or
 * undefined when nothing is pending or the database is new.
 */
export function snapshotBeforeMigration(
  database: Database.Database,
  databasePath: string,
  migrations: readonly MigrationDefinition[] = discoverMigrations(),
  now: () => Date = () => new Date(),
): string | undefined {
  const status = migrationStatus(database, migrations);
  if (status.currentVersion === 0 || status.pendingVersions.length === 0) return undefined;
  const directory = join(dirname(databasePath), 'pre-migration');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stamp = now().toISOString().replace(/[:.]/g, '-');
  const path = join(directory, `craftingtable-schema-${status.currentVersion}-${stamp}.sqlite`);
  database.prepare('VACUUM INTO ?').run(path);
  chmodSync(path, 0o600);
  const snapshots = readdirSync(directory)
    .filter((name) => SNAPSHOT_FILE.test(name))
    .map((name) => ({ name, stamp: name.replace(/^craftingtable-schema-\d+-/, '') }))
    .toSorted((left, right) => right.stamp.localeCompare(left.stamp));
  for (const expired of snapshots.slice(PRE_MIGRATION_SNAPSHOTS_KEPT))
    rmSync(join(directory, expired.name), { force: true });
  return path;
}
