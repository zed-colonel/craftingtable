import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentBackend,
  CLAUDE_CODE_MODELS,
  ClaudeCodeBackend,
  CodexBackend,
  CODEX_MODELS,
  parseModelList,
} from '@craftingtable/agents';
import { AGENT_BACKENDS, AGENT_BACKEND_LABELS, type AgentBackendKind } from '@craftingtable/domain';
import { createGitOperations, type GitOperations } from '@craftingtable/git';
import { type CraftingTableStorage, openCraftingTableStorage } from '@craftingtable/storage';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import { Argon2PasswordHasher, type PasswordHasher } from './security/password-hasher.js';
import { SessionTokenService } from './security/session-tokens.js';
import { buildServer } from './server.js';
import { AgentRunService, type RunLog } from './services/agent-run-service.js';
import { AuthService } from './services/auth-service.js';
import { BootstrapService } from './services/bootstrap-service.js';
import { resolveExecutable } from './services/executables.js';
import { ExecutionService, type ExecutionStatus } from './services/execution-service.js';
import { PlanImportService } from './services/plan-import-service.js';
import { PlanningQueryService } from './services/planning-query-service.js';
import {
  type MonotonicClock,
  PERFORMANCE_MONOTONIC_CLOCK,
  RepositoryInspectorProvider,
  type RepositoryObservationPortFactory,
} from './services/repository-inspector-provider.js';
import { createRepositoryObservationPort } from './services/repository-observation-adapter.js';
import { RunEventStreamService } from './services/run-event-stream-service.js';
import { WorkItemService } from './services/work-item-service.js';
import { WorkspaceEventNotifier } from './services/workspace-event-notifier.js';
import {
  type WorkspaceEventStreamHooks,
  WorkspaceEventStreamService,
} from './services/workspace-event-stream-service.js';
import { WorkspaceService } from './services/workspace-service.js';

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
  readonly executionService: ExecutionService;
  readonly agentRunService: AgentRunService;
  readonly runEventStreamService: RunEventStreamService;
  readonly executionStatus: () => ExecutionStatus;
}

export interface ServiceOverrides {
  readonly passwordHasher?: PasswordHasher;
  readonly now?: () => Date;
  readonly streamHooks?: WorkspaceEventStreamHooks;
  readonly repositoryInspectorProvider?: RepositoryInspectorProvider;
  readonly repositoryObservationPortFactory?: RepositoryObservationPortFactory;
  readonly repositoryProviderClock?: MonotonicClock;
  /** Test seam: a Git operations implementation or `null` to simulate no Git. */
  readonly gitOperations?: GitOperations | null;
  /** Test seam: an agent backend or `null` to simulate a missing executable. */
  readonly agentBackends?: ReadonlyMap<AgentBackendKind, AgentBackend>;
  readonly runLog?: RunLog;
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
  const workspaceService = new WorkspaceService(storage, now, notifier);
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
  const gitExecutable =
    overrides.gitOperations === undefined
      ? resolveExecutable('git', config.execution.gitExecutable)
      : undefined;
  const gitOperations: GitOperations | undefined =
    overrides.gitOperations === undefined
      ? gitExecutable === undefined
        ? undefined
        : createGitOperations({ gitExecutable })
      : (overrides.gitOperations ?? undefined);
  const backends = new Map<AgentBackendKind, AgentBackend>(overrides.agentBackends);
  if (overrides.agentBackends === undefined) {
    const claude = resolveExecutable('claude', config.execution.claudeExecutable, process.env, [
      join(homedir(), '.local', 'bin'),
    ]);
    if (claude !== undefined) {
      backends.set(
        'claude-code',
        new ClaudeCodeBackend({
          executable: claude,
          models: parseModelList(config.execution.claudeModels, CLAUDE_CODE_MODELS),
        }),
      );
    }
    const codex = resolveExecutable('codex', config.execution.codexExecutable, process.env, [
      join(homedir(), '.local', 'bin'),
    ]);
    if (codex !== undefined) {
      backends.set(
        'codex',
        new CodexBackend({
          executable: codex,
          models: parseModelList(config.execution.codexModels, CODEX_MODELS),
        }),
      );
    }
  }
  const executionService = new ExecutionService(
    storage,
    workspaceService,
    notifier,
    gitOperations,
    config.execution,
    workItemService,
    now,
  );
  const agentRunService = new AgentRunService(
    storage,
    workspaceService,
    notifier,
    backends,
    config.execution,
    overrides.runLog,
    now,
  );
  agentRunService.recoverInterrupted();
  const executionStatus = (): ExecutionStatus => ({
    git: {
      available: gitOperations !== undefined,
      ...(gitExecutable === undefined ? {} : { executable: gitExecutable }),
    },
    backends: AGENT_BACKENDS.map((kind) => {
      const backend = backends.get(kind);
      return {
        kind,
        label: AGENT_BACKEND_LABELS[kind],
        available: backend !== undefined,
        ...(backend === undefined ? {} : { executable: backend.describe().executable }),
        models: backend === undefined ? [] : backend.describe().models,
      };
    }),
  });
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
    executionService,
    agentRunService,
    runEventStreamService: new RunEventStreamService(
      storage,
      authService,
      workspaceService,
      notifier,
      overrides.streamHooks,
    ),
    executionStatus,
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
        executionService: services.executionService,
        agentRunService: services.agentRunService,
        runEventStreamService: services.runEventStreamService,
        executionStatus: services.executionStatus,
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
