import { SqliteRuntimeEvidenceRepository } from './repositories/runtime-evidence.js';
import { SqlitePhaseSchedulingRepository } from './repositories/phase-reservations.js';
import { SqliteScopeReceiptRepository } from './repositories/scope-receipts.js';
import { chmodSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { discoverMigrations, runMigrations } from './migrations.js';
import { SqliteAuditRepository } from './repositories/audit.js';
import { executionRepositories } from './repositories/execution/index.js';
import { SqliteImportRepository } from './repositories/imports.js';
import { SqliteStorageMaintenanceRepository } from './repositories/maintenance.js';
import { SqliteNotificationRepository } from './repositories/notifications.js';
import { planningRepositories } from './repositories/planning/index.js';
import { repositoryRegistryRepositories } from './repositories/repository-registry/index.js';
import { SqliteRoadmapRepository } from './repositories/roadmaps.js';
import { SqliteSessionRepository } from './repositories/sessions.js';
import { SqliteUserRepository } from './repositories/users.js';
import { SqliteWorkspaceEventRepository } from './repositories/workspace-events.js';
import { SqliteWorkspaceRepository } from './repositories/workspaces.js';
import type { CraftingTableStorage, MigrationStatus, StorageRepositories } from './types.js';

function repositories(database: Database.Database): StorageRepositories {
  return {
    runtimeEvidence: new SqliteRuntimeEvidenceRepository(database),
    phaseScheduling: new SqlitePhaseSchedulingRepository(database),
    scopeReceipts: new SqliteScopeReceiptRepository(database),
    imports: new SqliteImportRepository(database),
    maintenance: new SqliteStorageMaintenanceRepository(database),
    roadmaps: new SqliteRoadmapRepository(database),
    notifications: new SqliteNotificationRepository(database),
    users: new SqliteUserRepository(database),
    sessions: new SqliteSessionRepository(database),
    workspaces: new SqliteWorkspaceRepository(database),
    audit: new SqliteAuditRepository(database),
    workspaceEvents: new SqliteWorkspaceEventRepository(database),
    planning: planningRepositories(database),
    repositoryRegistry: repositoryRegistryRepositories(database),
    execution: executionRepositories(database),
  };
}

class SqliteCraftingTableStorage implements CraftingTableStorage {
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
  readonly repositoryRegistry;
  readonly execution;

  private closed = false;

  constructor(
    readonly databasePath: string,
    private readonly database: Database.Database,
    readonly migrationStatus: MigrationStatus,
  ) {
    const repos = repositories(database);
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
    this.repositoryRegistry = repos.repositoryRegistry;
    this.execution = repos.execution;
  }

  transaction<T>(operation: (tx: StorageRepositories) => T): T {
    return this.database.transaction(() => operation(repositories(this.database))).immediate();
  }

  readTransaction<T>(operation: (tx: StorageRepositories) => T): T {
    return this.database.transaction(() => operation(repositories(this.database))).deferred();
  }

  async backup(destination: string): Promise<void> {
    await this.database.backup(destination);
    chmodSync(destination, 0o600);
  }

  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.database.close();
    }
  }
}

export function openCraftingTableStorage(databasePath: string): CraftingTableStorage {
  const database = openDatabase(databasePath);
  try {
    const status = runMigrations(database, discoverMigrations());
    return new SqliteCraftingTableStorage(databasePath, database, status);
  } catch (error) {
    database.close();
    throw error;
  }
}
