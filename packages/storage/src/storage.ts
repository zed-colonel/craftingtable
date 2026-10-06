import { chmodSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import {
  discoverMigrations,
  retirePreMigrationSnapshots,
  runMigrations,
  snapshotBeforeMigration,
} from './migrations.js';
import {
  RETIRED_TABLES,
  type ScannedRecord,
  scanRecords,
  type UnreadableRecord,
} from './record-scan.js';
import type { RecordGuard, UpcastObserver } from './records.js';
import { SqliteAttentionRepository } from './repositories/attention.js';
import { SqliteAuditRepository } from './repositories/audit.js';
import { executionRepositories } from './repositories/execution/index.js';
import { SqliteImportRepository } from './repositories/imports.js';
import { SqliteStorageMaintenanceRepository } from './repositories/maintenance.js';
import { SqliteMapAmendmentRepository } from './repositories/map-amendments.js';
import { SqliteNotificationRepository } from './repositories/notifications.js';
import { SqlitePhaseSchedulingRepository } from './repositories/phase-reservations.js';
import { planningRepositories } from './repositories/planning/index.js';
import { DefinitionCache, SqliteRoadmapRepository } from './repositories/roadmaps.js';
import { SqliteProtectedRefRepository } from './repositories/protected-refs.js';
import {
  SqliteRuntimeEvidenceRepository,
  SubmissionCache,
} from './repositories/runtime-evidence.js';
import { SqliteScopeReceiptRepository } from './repositories/scope-receipts.js';
import { SqliteSessionRepository } from './repositories/sessions.js';
import { SqliteUserRepository } from './repositories/users.js';
import { SqliteWorkspaceEventRepository } from './repositories/workspace-events.js';
import { SqliteWorkspaceRepository } from './repositories/workspaces.js';
import type {
  CraftingTableStorage,
  MigrationStatus,
  StorageRepositories,
  WriteObserver,
} from './types.js';

function repositories(
  database: Database.Database,
  guard: RecordGuard,
  definitions: DefinitionCache,
  submissions: SubmissionCache,
): StorageRepositories {
  return {
    amendments: new SqliteMapAmendmentRepository(database, guard),
    runtimeEvidence: new SqliteRuntimeEvidenceRepository(database, guard, submissions),
    protectedRefs: new SqliteProtectedRefRepository(database, guard),
    phaseScheduling: new SqlitePhaseSchedulingRepository(database),
    scopeReceipts: new SqliteScopeReceiptRepository(database, guard),
    imports: new SqliteImportRepository(database, guard),
    maintenance: new SqliteStorageMaintenanceRepository(database, guard),
    roadmaps: new SqliteRoadmapRepository(database, guard, definitions),
    notifications: new SqliteNotificationRepository(database, guard),
    attention: new SqliteAttentionRepository(database, guard),
    users: new SqliteUserRepository(database),
    sessions: new SqliteSessionRepository(database),
    workspaces: new SqliteWorkspaceRepository(database),
    audit: new SqliteAuditRepository(database, guard),
    workspaceEvents: new SqliteWorkspaceEventRepository(database, guard),
    planning: planningRepositories(database, guard),
    execution: executionRepositories(database, guard),
  };
}

class SqliteCraftingTableStorage implements CraftingTableStorage {
  readonly amendments;
  readonly runtimeEvidence;
  readonly protectedRefs;
  readonly phaseScheduling;
  readonly scopeReceipts;
  readonly imports;
  readonly maintenance;
  readonly roadmaps;
  readonly notifications;
  readonly attention;
  readonly users;
  readonly sessions;
  readonly workspaces;
  readonly audit;
  readonly workspaceEvents;
  readonly planning;
  readonly execution;

  private closed = false;
  /** Parsed roadmap definitions, shared by every transaction on this database (R-B3). */
  private readonly definitions = new DefinitionCache();
  /** Decoded evidence submissions, shared by every read on this database (R-D5). */
  private readonly submissions = new SubmissionCache();
  private observer: WriteObserver | undefined;
  private depth = 0;
  /** Every write passes the contract guard, then the observer sees it. */
  private readonly guard: RecordGuard;

  constructor(
    readonly databasePath: string,
    private readonly database: Database.Database,
    readonly migrationStatus: MigrationStatus,
    contractGuard: RecordGuard,
  ) {
    this.guard = (kind, record) => {
      contractGuard(kind, record);
      this.observer?.written(kind, record);
    };
    const repos = repositories(database, this.guard, this.definitions, this.submissions);
    this.amendments = repos.amendments;
    this.runtimeEvidence = repos.runtimeEvidence;
    this.protectedRefs = repos.protectedRefs;
    this.phaseScheduling = repos.phaseScheduling;
    this.scopeReceipts = repos.scopeReceipts;
    this.imports = repos.imports;
    this.maintenance = repos.maintenance;
    this.roadmaps = repos.roadmaps;
    this.notifications = repos.notifications;
    this.attention = repos.attention;
    this.users = repos.users;
    this.sessions = repos.sessions;
    this.workspaces = repos.workspaces;
    this.audit = repos.audit;
    this.workspaceEvents = repos.workspaceEvents;
    this.planning = repos.planning;
    this.execution = repos.execution;
  }

  observeWrites(observer: WriteObserver): void {
    this.observer = observer;
  }

  transaction<T>(operation: (tx: StorageRepositories) => T): T {
    // A nested call runs as a savepoint of the outer transaction, which owns the commit.
    const outermost = this.depth === 0;
    this.definitions.begin();
    this.submissions.begin();
    this.depth += 1;
    try {
      const result = this.database
        .transaction(() => {
          const tx = repositories(this.database, this.guard, this.definitions, this.submissions);
          const value = operation(tx);
          if (outermost) this.observer?.beforeCommit(tx);
          return value;
        })
        .immediate();
      this.definitions.commit();
      if (outermost) this.observer?.ended(true);
      return result;
    } catch (error) {
      this.definitions.rollback();
      if (outermost) this.observer?.ended(false);
      throw error;
    } finally {
      this.submissions.end();
      this.depth -= 1;
    }
  }

  readTransaction<T>(operation: (tx: StorageRepositories) => T): T {
    return this.database
      .transaction(() =>
        operation(repositories(this.database, this.guard, this.definitions, this.submissions)),
      )
      .deferred();
  }

  async backup(destination: string): Promise<void> {
    await this.database.backup(destination);
    chmodSync(destination, 0o600);
  }

  scanRecords(
    visit: (record: ScannedRecord) => void,
    unreadable: (record: UnreadableRecord) => void,
    observe?: UpcastObserver,
  ): void {
    scanRecords(this.database, visit, unreadable, observe);
  }

  integrityProblems(): readonly string[] {
    const problems = (this.database.pragma('quick_check') as { quick_check: string }[])
      .map((row) => row.quick_check)
      .filter((result) => result !== 'ok');
    for (const row of this.database.pragma('foreign_key_check') as {
      table: string;
      rowid: number;
      parent: string;
    }[])
      problems.push(`${row.table} row ${row.rowid} references a missing ${row.parent} row`);
    for (const table of RETIRED_TABLES) {
      const { count } = this.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      if (count) problems.push(`${table} is retired but holds ${count} rows`);
    }
    return problems;
  }

  vacuum(): void {
    this.database.exec('VACUUM');
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.database.close();
    }
  }
}

/**
 * Opens the database, migrating it forward first. `guard` checks every record before it is
 * written (R-H3): the daemon passes its contract guard; storage's own SQL tests pass
 * `acceptAnyRecord`.
 */
export function openCraftingTableStorage(
  databasePath: string,
  guard: RecordGuard,
): CraftingTableStorage {
  const database = openDatabase(databasePath);
  try {
    const migrations = discoverMigrations();
    retirePreMigrationSnapshots(databasePath);
    snapshotBeforeMigration(database, databasePath, migrations);
    const status = runMigrations(database, migrations);
    return new SqliteCraftingTableStorage(databasePath, database, status, guard);
  } catch (error) {
    database.close();
    throw error;
  }
}
