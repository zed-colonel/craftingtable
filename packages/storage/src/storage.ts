import { chmodSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { discoverMigrations, runMigrations, snapshotBeforeMigration } from './migrations.js';
import {
  RETIRED_TABLES,
  type ScannedRecord,
  scanRecords,
  type UnreadableRecord,
} from './record-scan.js';
import type { RecordGuard, UpcastObserver } from './records.js';
import { SqliteAuditRepository } from './repositories/audit.js';
import { executionRepositories } from './repositories/execution/index.js';
import { SqliteImportRepository } from './repositories/imports.js';
import { SqliteStorageMaintenanceRepository } from './repositories/maintenance.js';
import { SqliteMapAmendmentRepository } from './repositories/map-amendments.js';
import { SqliteNotificationRepository } from './repositories/notifications.js';
import { SqlitePhaseSchedulingRepository } from './repositories/phase-reservations.js';
import { planningRepositories } from './repositories/planning/index.js';
import { SqliteRoadmapRepository } from './repositories/roadmaps.js';
import { SqliteRuntimeEvidenceRepository } from './repositories/runtime-evidence.js';
import { SqliteScopeReceiptRepository } from './repositories/scope-receipts.js';
import { SqliteSessionRepository } from './repositories/sessions.js';
import { SqliteUserRepository } from './repositories/users.js';
import { SqliteWorkspaceEventRepository } from './repositories/workspace-events.js';
import { SqliteWorkspaceRepository } from './repositories/workspaces.js';
import type { CraftingTableStorage, MigrationStatus, StorageRepositories } from './types.js';

function repositories(database: Database.Database, guard: RecordGuard): StorageRepositories {
  return {
    amendments: new SqliteMapAmendmentRepository(database, guard),
    runtimeEvidence: new SqliteRuntimeEvidenceRepository(database, guard),
    phaseScheduling: new SqlitePhaseSchedulingRepository(database),
    scopeReceipts: new SqliteScopeReceiptRepository(database, guard),
    imports: new SqliteImportRepository(database, guard),
    maintenance: new SqliteStorageMaintenanceRepository(database, guard),
    roadmaps: new SqliteRoadmapRepository(database, guard),
    notifications: new SqliteNotificationRepository(database, guard),
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
  readonly phaseScheduling;
  readonly scopeReceipts;
  readonly imports;
  readonly maintenance;
  readonly roadmaps;
  readonly notifications;
  readonly users;
  readonly sessions;
  readonly workspaces;
  readonly audit;
  readonly workspaceEvents;
  readonly planning;
  readonly execution;

  private closed = false;

  constructor(
    readonly databasePath: string,
    private readonly database: Database.Database,
    readonly migrationStatus: MigrationStatus,
    private readonly guard: RecordGuard,
  ) {
    const repos = repositories(database, guard);
    this.amendments = repos.amendments;
    this.runtimeEvidence = repos.runtimeEvidence;
    this.phaseScheduling = repos.phaseScheduling;
    this.scopeReceipts = repos.scopeReceipts;
    this.imports = repos.imports;
    this.maintenance = repos.maintenance;
    this.roadmaps = repos.roadmaps;
    this.notifications = repos.notifications;
    this.users = repos.users;
    this.sessions = repos.sessions;
    this.workspaces = repos.workspaces;
    this.audit = repos.audit;
    this.workspaceEvents = repos.workspaceEvents;
    this.planning = repos.planning;
    this.execution = repos.execution;
  }

  transaction<T>(operation: (tx: StorageRepositories) => T): T {
    return this.database
      .transaction(() => operation(repositories(this.database, this.guard)))
      .immediate();
  }

  readTransaction<T>(operation: (tx: StorageRepositories) => T): T {
    return this.database
      .transaction(() => operation(repositories(this.database, this.guard)))
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
    snapshotBeforeMigration(database, databasePath, migrations);
    const status = runMigrations(database, migrations);
    return new SqliteCraftingTableStorage(databasePath, database, status, guard);
  } catch (error) {
    database.close();
    throw error;
  }
}
