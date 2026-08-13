import { openCraftingTableStorage, type CraftingTableStorage } from '@craftingtable/storage';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import { Argon2PasswordHasher, type PasswordHasher } from './security/password-hasher.js';
import { SessionTokenService } from './security/session-tokens.js';
import { BootstrapService } from './services/bootstrap-service.js';
import { PlanImportService } from './services/plan-import-service.js';
import { PlanningQueryService } from './services/planning-query-service.js';
import { createRepositoryObservationPort } from './services/repository-observation-adapter.js';
import {
  PERFORMANCE_MONOTONIC_CLOCK,
  RepositoryInspectorProvider,
  type MonotonicClock,
  type RepositoryObservationPortFactory,
} from './services/repository-inspector-provider.js';
import { WorkItemService } from './services/work-item-service.js';
import { AuthService } from './services/auth-service.js';
import { WorkspaceEventNotifier } from './services/workspace-event-notifier.js';
import {
  WorkspaceEventStreamService,
  type WorkspaceEventStreamHooks,
} from './services/workspace-event-stream-service.js';
import { WorkspaceService } from './services/workspace-service.js';
import { buildServer } from './server.js';

export interface ServiceSet {
  readonly bootstrapService: BootstrapService;
  readonly authService: AuthService;
  readonly workspaceService: WorkspaceService;
  readonly planImportService: PlanImportService;
  readonly planningQueryService: PlanningQueryService;
  readonly workItemService: WorkItemService;
  readonly workspaceEventNotifier: WorkspaceEventNotifier;
  readonly workspaceEventStreamService: WorkspaceEventStreamService;
  readonly repositoryInspectorProvider: RepositoryInspectorProvider;
}

export interface ServiceOverrides {
  readonly passwordHasher?: PasswordHasher;
  readonly now?: () => Date;
  readonly streamHooks?: WorkspaceEventStreamHooks;
  readonly repositoryInspectorProvider?: RepositoryInspectorProvider;
  readonly repositoryObservationPortFactory?: RepositoryObservationPortFactory;
  readonly repositoryProviderClock?: MonotonicClock;
}

export async function createServices(
  storage: CraftingTableStorage,
  config: ServerConfig,
  overrides: ServiceOverrides = {},
): Promise<ServiceSet> {
  const passwordHasher = overrides.passwordHasher ?? new Argon2PasswordHasher();
  const now = overrides.now ?? (() => new Date());
  const tokenService = new SessionTokenService();
  const notifier = new WorkspaceEventNotifier();
  const dummyPasswordHash = await passwordHasher.hash('craftingtable dummy password');
  const authService = new AuthService(
    storage,
    passwordHasher,
    tokenService,
    dummyPasswordHash,
    config.sessionLifetimeSeconds,
    now,
  );
  const workspaceService = new WorkspaceService(storage, now);
  const planImportService = new PlanImportService(storage, workspaceService, notifier, now);
  const planningQueryService = new PlanningQueryService(storage, workspaceService);
  const workItemService = new WorkItemService(storage, workspaceService, notifier, now);
  const repositoryFeature = config.repositoryFeature;
  const repositoryInspectorProvider =
    overrides.repositoryInspectorProvider ??
    new RepositoryInspectorProvider(
      repositoryFeature,
      overrides.repositoryObservationPortFactory ??
        (repositoryFeature.enabled
          ? async (onInvariantFault) =>
              await createRepositoryObservationPort(repositoryFeature, onInvariantFault)
          : async () => {
              throw new Error('Disabled repository provider factory must not be called');
            }),
      overrides.repositoryProviderClock ?? PERFORMANCE_MONOTONIC_CLOCK,
    );
  return {
    bootstrapService: new BootstrapService(storage, passwordHasher, notifier, now),
    authService,
    workspaceService,
    planImportService,
    planningQueryService,
    workItemService,
    workspaceEventNotifier: notifier,
    workspaceEventStreamService: new WorkspaceEventStreamService(
      storage,
      authService,
      workspaceService,
      notifier,
      overrides.streamHooks,
    ),
    repositoryInspectorProvider,
  };
}

export interface CraftingTableRuntime {
  readonly app: FastifyInstance;
  readonly storage: CraftingTableStorage;
  readonly services: ServiceSet;
  close(): Promise<void>;
}

export async function createRuntime(
  config: ServerConfig,
  options: { readonly logger?: boolean; readonly overrides?: ServiceOverrides } = {},
): Promise<CraftingTableRuntime> {
  const storage = openCraftingTableStorage(config.databasePath);
  try {
    const services = await createServices(storage, config, options.overrides);
    const app = buildServer(
      {
        authService: services.authService,
        workspaceService: services.workspaceService,
        planImportService: services.planImportService,
        planningQueryService: services.planningQueryService,
        workItemService: services.workItemService,
        workspaceEventStreamService: services.workspaceEventStreamService,
      },
      config,
      { logger: options.logger ?? true },
    );
    let closed = false;
    return {
      app,
      storage,
      services,
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        await app.close();
        storage.close();
      },
    };
  } catch (error) {
    storage.close();
    throw error;
  }
}
