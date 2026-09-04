import type Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { discoverMigrations, runMigrations } from './migrations.js';
import { SqliteAuditRepository } from './repositories/audit.js';
import { planningRepositories } from './repositories/planning/index.js';
import { repositoryRegistryRepositories } from './repositories/repository-registry/index.js';
import { SqliteSessionRepository } from './repositories/sessions.js';
import { SqliteUserRepository } from './repositories/users.js';
import { SqliteWorkspaceEventRepository } from './repositories/workspace-events.js';
import { SqliteWorkspaceRepository } from './repositories/workspaces.js';
import type { CraftingTableStorage, MigrationStatus, StorageRepositories } from './types.js';

function repositories(database: Database.Database): StorageRepositories {
  return {
    users: new SqliteUserRepository(database),
    sessions: new SqliteSessionRepository(database),
    workspaces: new SqliteWorkspaceRepository(database),
    audit: new SqliteAuditRepository(database),
    workspaceEvents: new SqliteWorkspaceEventRepository(database),
    planning: planningRepositories(database),
    repositoryRegistry: repositoryRegistryRepositories(database),
  };
}

class SqliteCraftingTableStorage implements CraftingTableStorage {
  readonly users;
  readonly sessions;
  readonly workspaces;
  readonly audit;
  readonly workspaceEvents;
  readonly planning;
  readonly repositoryRegistry;

  private closed = false;

  constructor(
    readonly databasePath: string,
    private readonly database: Database.Database,
    readonly migrationStatus: MigrationStatus,
  ) {
    const repos = repositories(database);
    this.users = repos.users;
    this.sessions = repos.sessions;
    this.workspaces = repos.workspaces;
    this.audit = repos.audit;
    this.workspaceEvents = repos.workspaceEvents;
    this.planning = repos.planning;
    this.repositoryRegistry = repos.repositoryRegistry;
  }

  transaction<T>(operation: (tx: StorageRepositories) => T): T {
    return this.database.transaction(() => operation(repositories(this.database))).immediate();
  }

  readTransaction<T>(operation: (tx: StorageRepositories) => T): T {
    return this.database.transaction(() => operation(repositories(this.database))).deferred();
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
