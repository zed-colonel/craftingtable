import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { discoverMigrations, type MigrationDefinition, runMigrations } from './migrations.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** This run's directory of migrated template databases (`template-test-support-setup.ts`). */
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

/** Errors with which a filesystem refuses hard links. */
const NO_HARD_LINKS = new Set(['EPERM', 'EXDEV', 'ENOTSUP', 'EOPNOTSUPP', 'EMLINK']);

/**
 * Gives the whole file `built` the name `path`, keeping a file another build already put there.
 * A hard link does that in one step and never replaces. A filesystem that refuses hard links
 * gets an atomic rename instead, so `path` never shows a partly written file (an exclusive copy
 * would), at the cost that a build racing another may replace its template: two lazy builds of
 * one migration set at once, which needs a migration changed during a watch-mode run.
 */
export function publishOnce(
  built: string,
  path: string,
  link: (from: string, to: string) => void = linkSync,
): void {
  try {
    link(built, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code === 'EEXIST') return;
    if (!NO_HARD_LINKS.has(code)) throw error;
    if (!existsSync(path)) renameSync(built, path);
  }
}

/**
 * The path of a database migrated through `migrations`, in `directory`, built on first use
 * (TS-M13, R-I2). Test daemons copy it instead of migrating a fresh database each, which cost
 * 350-600 ms per daemon against about 15 ms to open a current one.
 *
 * The file is keyed by the migration set, so a changed or added migration gets a new template.
 * It is checkpointed and closed before it gets its final name, so a copy is a whole database
 * with no write-ahead log beside it. The final name never replaces an existing file
 * (`publishOnce`): when two workers build the same template at once, the first one's stays and
 * every copy is of that one.
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
    publishOnce(building, path);
  } finally {
    for (const leftover of [building, `${building}-wal`, `${building}-shm`])
      rmSync(leftover, { force: true });
  }
  return path;
}

type LedgerRow = { version: number; name: string; checksum: string; applied_at: string };
const LEDGER = 'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version';

/** The migration ledger of a live database, read in place without migrating it. */
export function migrationLedger(databasePath: string): readonly LedgerRow[] {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    return database.prepare(LEDGER).all() as LedgerRow[];
  } finally {
    database.close();
  }
}

/**
 * Runs a read-only query on a template without opening the file: a reader opened in place
 * would add a write-ahead log beside it while other workers copy it. The template is
 * checkpointed, so its bytes are the whole database; in memory it is read as a rollback-journal
 * database (header bytes 18-19), since an in-memory database has no log.
 */
export function readTemplate<T>(templatePath: string, query: string): T[] {
  const bytes = readFileSync(templatePath);
  bytes[18] = 1;
  bytes[19] = 1;
  const database = new Database(bytes, { readonly: true });
  try {
    return database.prepare(query).all() as T[];
  } finally {
    database.close();
  }
}

/** The migration ledger of a template (`readTemplate`). */
export function templateLedger(templatePath: string): readonly LedgerRow[] {
  return readTemplate<LedgerRow>(templatePath, LEDGER);
}
