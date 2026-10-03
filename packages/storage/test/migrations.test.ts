import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import {
  checksumSql,
  DEFAULT_MIGRATIONS_DIRECTORY,
  discoverMigrations,
  inspectMigrationStatus,
  type MigrationValidationError,
  migrationStatus,
  PRE_MIGRATION_SNAPSHOTS_KEPT,
  runMigrations,
  snapshotBeforeMigration,
} from '../src/migrations.js';
import { testDataRoot } from './test-support.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-test-'));
  directories.push(directory);
  return join(directory, 'craftingtable.sqlite');
}

interface PinnedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
}

/**
 * Every migration a deployed daemon has applied: its name and SHA-256, as literals (TS-M5). The
 * daemon refuses to start when an applied migration's checksum no longer matches its file, so
 * these rows are frozen: a row here is never changed or removed, and a change to a deployed
 * migration is a new migration. Rows are only ever appended, by moving them unchanged from
 * `PENDING_MIGRATIONS` in the commit that records the deploy which applied them.
 *
 * Deployed through schema 36: e0d33b8 applied 0036 on 2026-09-30 at 00:31 UTC (program.md,
 * post-deploy batch 2026-09-30), and no later deploy changed a migration. The rows match the live
 * daemon's ledger as of 2026-10-02.
 */
// biome-ignore format: one row per migration, appended in order.
const DEPLOYED_MIGRATIONS: readonly PinnedMigration[] = [
  { version: 1, name: 'ct02-foundation', checksum: '42ade0fefd2174cd79e9c2e2035eb40ce34379dca61f8654618619f6c4483273' },
  { version: 2, name: 'ct03-planning', checksum: '6d2789c5f283cbd3e2fe639b32c58617c049c3bb561a928b099836ad34464247' },
  { version: 3, name: 'ct04a2a-repository-model', checksum: '526df194257806b2a2e9582da8df8058ad86e819d52eae6b9b2525f972123bc4' },
  { version: 4, name: 'ct04a2b-repository-journal', checksum: '409553eb1c6a7eb978be9fc2dae6ddb9eb1d51e0f016f4b5c6d571edbaf5f29e' },
  { version: 5, name: 'execution', checksum: '2f7bf2d8d22f5d5a33eba15a56ae19afa97f1369da7fb94b6c5d590cfe6a1053' },
  { version: 6, name: 'workflow', checksum: 'fa54a76f2230b1309d6d87d81370e10068d1e3da2ed389683aae8999170f1741' },
  { version: 7, name: 'agent-backends', checksum: 'afc67f4ef9120d4fcc1134e19ac7fe68f108e9c75d89435e6f1a9787df2ff4e8' },
  { version: 8, name: 'run-profiles', checksum: '7abe864ec44806ac796758a126a9a4b02d31a6ae19e6a35807a5c9d992e61349' },
  { version: 9, name: 'work-cycles', checksum: 'f804afa98da884bdd593bb238a82fed7ab1d9bbc16c2029c1de1fc27146287d8' },
  { version: 10, name: 'branch-mechanics', checksum: '30ba85cef16e25811dc8ba216170bcabbcf5084fc31f3256f54f43d49b2560ba' },
  { version: 11, name: 'notifications', checksum: '396906cf218a3b82c15d78bf8629097b287696de38fade4f2c1d9c7eee885b02' },
  { version: 12, name: 'roadmaps', checksum: '0b27fa381d9ea3e903873a56150f61f3ae55bc4f9a44e6ed05c8b5ed4e5ea7b4' },
  { version: 13, name: 'delegated-merges', checksum: '9c56279034dcc35104cde997693d37a60fe89f39f9a86801824954b51406377d' },
  { version: 14, name: 'plan-finalizations', checksum: 'b6165bc4122a5a043749c7ef07941676a79c9fce6b2d116f43fc3ea9b071e09b' },
  { version: 15, name: 'storage-management', checksum: '093b97a9aa23540a4ea4078757eb98f6009126e1038f66c608b9262d25076a23' },
  { version: 16, name: 'package-imports', checksum: 'b5b6d70d4191b6dd334231fd070276e710fe4acae51ad4a88dad69203a9b4c29' },
  { version: 17, name: 'agenda-removal', checksum: 'afb984f6e6a454bcbabd488b16e63c28a10023168504e67ab06d110e37ce4e80' },
  { version: 18, name: 'execution-scopes', checksum: '7f3a8151caa3845fc9e789d019e36f13619f670bf510b1643c4aca3483fa8652' },
  { version: 19, name: 'phase-reservations', checksum: '665413ab5cb7572de529ad80ba8ebada1e5277ec5f7028fa635501b8788bc66d' },
  { version: 20, name: 'runtime-evidence', checksum: '3d00bb358dc26b0cf36d3bf067e4cd6c3487adbed86b95eac4e4c4e2cfc83607' },
  { version: 21, name: 'map-adoptions', checksum: '1cc608429516fc902ad49ae2d01b6e0d2a87fbb020270cfb552ce2ea42579cf1' },
  { version: 22, name: 'map-amendments', checksum: 'b66798aa6d07f44233a48e6755587f3e88b2536b4736813c57390c9d9a1cd389' },
  { version: 23, name: 'native-verification', checksum: 'cab5b0792e10b718cf4359ef764a9d68174e03eccd853ad60545f83e48cba929' },
  { version: 24, name: 'repository-policy', checksum: '6cfb2868d1ac88fc93a31a6048882b89b1da41a0a4dd4dd44ea4cd62e346feda' },
  { version: 25, name: 'host-verification-settings', checksum: '0d90851586d47af179274205084170d5b5e9b8f9c5089a6632c36fcf9078654b' },
  { version: 26, name: 'agent-profiles', checksum: '215f33a301402bc89d8e07103c533fd24bed899d4745789d2c1fcbcab9179bd4' },
  { version: 27, name: 'daemon-stops', checksum: '73c930aa60f5febe8d0bf421d454fd446905419debac6ae3a80634d6120d505c' },
  { version: 28, name: 'journal-compaction', checksum: 'b7dc48e843ef297f43ed86b84bad436f05a20a5ffc4245911066771864aacbc3' },
  { version: 29, name: 'roadmap-definition-revision', checksum: '7a667b31ff6f4003c38f7970e218ba247b6e3409814b916df96abad02df96e50' },
  { version: 30, name: 'worktree-build-caches', checksum: 'f50253807d8cc96dd29dacdd4980001c48a92c5a93a31c98bb15d17e2c8cd987' },
  { version: 31, name: 'upstream-transition-records', checksum: 'f85c28e713af7eef7371b51064b9aaf4fa403f12e3d0aa4787928e864fc8f219' },
  { version: 32, name: 'attention-items', checksum: 'cdbbcb196ce394a010ec05ccbe30bb40148e7346bc73ac09e30c8645d64f5628' },
  { version: 33, name: 'run-check-receipts', checksum: '87f8ecd5f166b344ceae3c49816dc89330ecf4382c4d5d2843c5ea5a4766e252' },
  { version: 34, name: 'protected-ref-moves', checksum: '571fb0b274910edc0085c57262c6f582ec84ae989531c2caff415e1e525a8bb2' },
  { version: 35, name: 'protected-ref-flags', checksum: '1415fc510cec99c02e256b43dfdd8ad9138c3a74c3912d6f37cbeb2d29043291' },
  { version: 36, name: 'repository-check-declarations', checksum: '0af2441a2ab015ac5d284c169da1f2912bf7383a3d1b88c76288cce04c1090d2' },
];

/**
 * Migrations added since the last deploy, pinned the same way. A pending row may be re-pinned
 * together with its file while no daemon has applied it; the deploy that applies it moves it to
 * `DEPLOYED_MIGRATIONS`, unchanged.
 */
const PENDING_MIGRATIONS: readonly PinnedMigration[] = [];

const PINNED_MIGRATIONS = [...DEPLOYED_MIGRATIONS, ...PENDING_MIGRATIONS];

/** The versions whose file is missing, unpinned, or differs from its row in name or checksum. */
function migrationDrift(directory?: string): number[] {
  const discovered = discoverMigrations(directory);
  const versions = new Set([
    ...discovered.map((migration) => migration.version),
    ...PINNED_MIGRATIONS.map((migration) => migration.version),
  ]);
  return [...versions]
    .filter((version) => {
      const file = discovered.find((migration) => migration.version === version);
      const pinned = PINNED_MIGRATIONS.find((migration) => migration.version === version);
      return file?.name !== pinned?.name || file?.checksum !== pinned?.checksum;
    })
    .toSorted((left, right) => left - right);
}

describe('ordered SQL migrations', () => {
  it('migrates a clean real file and records the expected checksum', () => {
    const path = databasePath();
    const database = openDatabase(path);
    const migrations = discoverMigrations();
    expect(runMigrations(database, migrations)).toEqual({
      currentVersion: PINNED_MIGRATIONS.length,
      supportedVersion: PINNED_MIGRATIONS.length,
      pendingVersions: [],
    });
    const rows = database
      .prepare(`SELECT version, name, checksum FROM schema_migrations ORDER BY version`)
      .all() as { version: number; name: string; checksum: string }[];
    // The ledger records the pinned checksums, not ones computed from today's files.
    expect(rows).toEqual(PINNED_MIGRATIONS);
    database.close();
  });

  it('matches every migration file to its pinned checksum (TS-M5)', () => {
    expect(migrationDrift()).toEqual([]);
    // Deployed rows come first, from schema 1 without a gap, and pending ones follow them.
    expect(PINNED_MIGRATIONS.map((migration) => migration.version)).toEqual(
      PINNED_MIGRATIONS.map((_, index) => index + 1),
    );
  });

  it('fails the pinned table when any migration file is edited, even by a comment (TS-M5)', () => {
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-migration-files-'));
    directories.push(directory);
    cpSync(DEFAULT_MIGRATIONS_DIRECTORY, directory, { recursive: true });
    // The copy starts pinned, so each edit below is the only drift.
    expect(migrationDrift(directory)).toEqual([]);
    const files = readdirSync(directory).toSorted();
    expect(files).toHaveLength(PINNED_MIGRATIONS.length);
    for (const [index, file] of files.entries()) {
      const path = join(directory, file);
      const sql = readFileSync(path, 'utf8');
      writeFileSync(path, `${sql}-- edited\n`);
      expect(migrationDrift(directory), file).toEqual([index + 1]);
      writeFileSync(path, sql);
    }
    // A new migration fails it too, until its row is added to PENDING_MIGRATIONS.
    writeFileSync(join(directory, `${String(files.length + 1).padStart(4, '0')}-next.sql`), '');
    expect(migrationDrift(directory)).toEqual([files.length + 1]);
  });

  it('preserves configured host limits when upgrading from schema 24', () => {
    const database = openDatabase(databasePath());
    const migrations = discoverMigrations();
    runMigrations(
      database,
      migrations.filter((m) => m.version <= 24),
    );
    database
      .prepare(
        "UPDATE phase_resource_limits SET capacity=4 WHERE resource_key='local-verification'",
      )
      .run();
    runMigrations(database, migrations);
    expect(
      database
        .prepare(
          "SELECT capacity, version, updated_at, updated_by_user_id FROM phase_resource_limits WHERE resource_key='local-verification'",
        )
        .get(),
    ).toEqual({ capacity: 4, version: 1, updated_at: null, updated_by_user_id: null });
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
    ).toBe(36);
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
    ).toBe(36);
    database.close();
  });

  it('rejects a newer unsupported schema version', () => {
    const path = databasePath();
    const database = openDatabase(path);
    runMigrations(database);
    database
      .prepare(
        `INSERT INTO schema_migrations (version, name, checksum, applied_at)
         VALUES (?, 'future', ?, ?)`,
      )
      .run(discoverMigrations().length + 1, 'f'.repeat(64), new Date().toISOString());
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
      supportedVersion: 36,
      pendingVersions: [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
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
      supportedVersion: 36,
      pendingVersions: [
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25,
        26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
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

it('upgrades legacy workspace profiles without changing models or permissions', () => {
  const database = openDatabase(databasePath());
  const migrations = discoverMigrations();
  runMigrations(
    database,
    migrations.filter((m) => m.version <= 25),
  );
  database.exec(`INSERT INTO users(id,username,username_normalized,password_hash,status,created_at,updated_at) VALUES ('owner','owner','owner','$argon2id$fixture','active','2026-09-21','2026-09-21');
 INSERT INTO workspaces(id,name,slug,status,created_by_user_id,created_at,updated_at) VALUES ('workspace','Workspace','workspace','active','owner','2026-09-21','2026-09-21');
 INSERT INTO workspace_run_profiles VALUES ('workspace','implement','codex','gpt-6-astra','auto','2026-09-21','owner'),('workspace','review','claude-code','fable','edit-only','2026-09-21','owner');`);
  const prior = database.prepare('SELECT * FROM workspace_run_profiles ORDER BY role').all();
  runMigrations(database, migrations);
  expect(database.prepare('SELECT * FROM workspace_run_profiles ORDER BY role').all()).toEqual(
    prior.map((p) => ({ ...(p as object), reasoning_effort: null })),
  );
  expect(database.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  database.close();
});

/**
 * Table rebuilds are the riskiest migrations (ADR-013). Each one has a preservation test,
 * and each written after R-H3 also carries an in-migration count guard, as 0002 does, so a
 * truncated copy rolls the migration back instead of losing rows.
 */
it('pairs every table-rebuild migration with a preservation test and later ones with a guard (R-H3)', () => {
  const preservationTests: Record<number, string> = {
    2: 'migration-0002.test.ts',
    4: 'migration-0004.test.ts',
    7: 'migration-0007.test.ts',
    14: 'migration-0014.test.ts',
    26: 'migrations.test.ts',
  };
  const rebuilds = discoverMigrations().filter((migration) =>
    /ALTER\s+TABLE\s+\w+\s+RENAME\s+TO/i.test(migration.sql),
  );
  for (const migration of rebuilds) {
    const test = preservationTests[migration.version];
    expect(
      test,
      `migration ${migration.version} rebuilds a table without a preservation test`,
    ).toBeDefined();
    expect(existsSync(new URL(`./${test}`, import.meta.url))).toBe(true);
    if (migration.version > 27)
      expect(migration.sql).toMatch(
        /CREATE\s+TABLE\s+migration_\d{4}_guard[\s\S]*CHECK\s*\(\s*ok\s*=\s*1\s*\)/i,
      );
  }
  expect(rebuilds.map((migration) => migration.version)).toEqual([2, 4, 7, 14, 26]);
});

describe('pre-migration snapshots (R-B9)', () => {
  it('copies a populated database aside before pending migrations and keeps the newest few', () => {
    const path = databasePath();
    const migrations = discoverMigrations();
    const database = openDatabase(path);
    expect(snapshotBeforeMigration(database, path, migrations)).toBeUndefined();
    runMigrations(database, migrations.slice(0, -1));
    database.exec(`CREATE TABLE snapshot_marker (value TEXT) STRICT`);
    database.prepare(`INSERT INTO snapshot_marker VALUES ('before')`).run();

    let second = 0;
    const clock = () => new Date(Date.UTC(2026, 8, 23, 12, 0, second++));
    const first = snapshotBeforeMigration(database, path, migrations, clock);
    expect(first).toMatch(
      new RegExp(
        `pre-migration/craftingtable-schema-${migrations.length - 1}-2026-09-23T12-00-00-000Z\\.sqlite$`,
      ),
    );
    expect(statSync(first as string).mode & 0o777).toBe(0o600);
    const copy = new Database(first as string, { readonly: true });
    expect(copy.prepare(`SELECT value FROM snapshot_marker`).get()).toEqual({ value: 'before' });
    copy.close();

    for (let index = 0; index < PRE_MIGRATION_SNAPSHOTS_KEPT + 1; index++)
      snapshotBeforeMigration(database, path, migrations, clock);
    const kept = readdirSync(join(path, '..', 'pre-migration')).toSorted();
    expect(kept).toHaveLength(PRE_MIGRATION_SNAPSHOTS_KEPT);
    expect(kept).not.toContain(first?.split('/').at(-1));

    runMigrations(database, migrations);
    expect(snapshotBeforeMigration(database, path, migrations, clock)).toBeUndefined();
    database.close();
  });
});
