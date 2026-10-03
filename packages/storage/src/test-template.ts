import { createHash, randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { discoverMigrations, type MigrationDefinition, runMigrations } from './migrations.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** This run's directory of migrated template databases (`test-template-setup.ts`). */
    testTemplateDirectory: string;
  }
}

/**
 * Names a migration set by every migration's version, name and checksum: a template built from
 * one set is never used for another (TS-M13, R-I2).
 */
export function migrationSetKey(migrations: readonly MigrationDefinition[]): string {
  return createHash('sha256')
    .update(migrations.map((m) => `${m.version} ${m.name} ${m.checksum}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * The path of a database migrated through `migrations`, in `directory`, built on first use
 * (TS-M13, R-I2). Test daemons copy it instead of migrating a fresh database each, which cost
 * 350-600 ms per daemon against about 15 ms to open a current one.
 *
 * The file is keyed by the migration set, so a changed or added migration gets a new template.
 * It is checkpointed and closed before it gets its final name, so a copy is a whole database
 * with no write-ahead log beside it. Two workers that build the same template at once each
 * build their own file and rename it into place; the copies are identical.
 */
export function migratedTemplate(
  directory: string,
  migrations: readonly MigrationDefinition[] = discoverMigrations(),
): string {
  const path = join(directory, `schema-${migrations.length}-${migrationSetKey(migrations)}.sqlite`);
  if (existsSync(path)) return path;
  const building = join(directory, `building-${randomUUID()}.sqlite`);
  try {
    const database = openDatabase(building);
    try {
      runMigrations(database, migrations);
      database.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      database.close();
    }
    renameSync(building, path);
  } finally {
    for (const leftover of [building, `${building}-wal`, `${building}-shm`])
      rmSync(leftover, { force: true });
  }
  return path;
}

/** The migration ledger of a database, read in place without migrating it. */
export function migrationLedger(
  databasePath: string,
): readonly { version: number; name: string; checksum: string; applied_at: string }[] {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database
      .prepare('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version')
      .all() as { version: number; name: string; checksum: string; applied_at: string }[];
  } finally {
    database.close();
  }
}
