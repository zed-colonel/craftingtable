import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentBackend,
  CLAUDE_CODE_MODELS,
  ClaudeCodeBackend,
  CODEX_MODELS,
  CodexBackend,
  parseModelList,
} from '@craftingtable/agents';
import { AGENT_BACKEND_LABELS, AGENT_BACKENDS, type AgentBackendKind } from '@craftingtable/domain';
import { createGitOperations, type GitOperations } from '@craftingtable/git';
import { type CraftingTableStorage, openCraftingTableStorage } from '@craftingtable/storage';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import { Argon2PasswordHasher, type PasswordHasher } from './security/password-hasher.js';
import { SessionTokenService } from './security/session-tokens.js';
import { buildServer } from './server.js';
import { AgentRunService, type RunLog } from './services/agent-run-service.js';
import { AuthService } from './services/auth-service.js';
import { BaselinePreparationService } from './services/baseline-preparation.js';
import { BootstrapService } from './services/bootstrap-service.js';
import { CrossProjectService } from './services/cross-project-service.js';
import { resolveExecutable } from './services/executables.js';
import { ExecutionService, type ExecutionStatus } from './services/execution-service.js';
import { FinalizationService } from './services/finalization-service.js';
import { HostSchedulingService } from './services/host-scheduling-service.js';
import { MapAmendmentService } from './services/map-amendment-service.js';
import { NotificationService } from './services/notification-service.js';
import {
  type NotificationTransport,
  PushoverTransport,
} from './services/notification-transport.js';
import { PackageImportService } from './services/package-import-service.js';
import { PlanImportService } from './services/plan-import-service.js';
import { PlanningQueryService } from './services/planning-query-service.js';
import { RoadmapService } from './services/roadmap-service.js';
import { RunEventStreamService } from './services/run-event-stream-service.js';
import { RuntimeEvidenceService } from './services/runtime-evidence-service.js';
import { StorageService } from './services/storage-service.js';
import { WorkCycleService } from './services/work-cycle-service.js';
import { WorkItemService } from './services/work-item-service.js';
import { WorkspaceEventNotifier } from './services/workspace-event-notifier.js';
import {
  type WorkspaceEventStreamHooks,
  WorkspaceEventStreamService,
} from './services/workspace-event-stream-service.js';
import { WorkspaceService } from './services/workspace-service.js';
import { WorktreeMutationGuard } from './services/worktree-mutation-guard.js';
import { DaemonDrain } from './services/daemon-drain.js';

export interface ServiceSet {
  readonly crossProjectService: CrossProjectService;
  readonly mapAmendmentService: MapAmendmentService;
  readonly runtimeEvidenceService: RuntimeEvidenceService;
  readonly packageImportService: PackageImportService;
  readonly storageService: StorageService;
  readonly hostSchedulingService: HostSchedulingService;
  readonly roadmapService: RoadmapService;
  readonly finalizationService: FinalizationService;
  readonly notificationService: NotificationService;
  readonly bootstrapService: BootstrapService;
  readonly authService: AuthService;
  readonly workspaceService: WorkspaceService;
  readonly planImportService: PlanImportService;
  readonly planningQueryService: PlanningQueryService;
  readonly workItemService: WorkItemService;
  readonly workspaceEventNotifier: WorkspaceEventNotifier;
  readonly workspaceEventStreamService: WorkspaceEventStreamService;
  readonly executionService: ExecutionService;
  readonly agentRunService: AgentRunService;
  readonly workCycleService: WorkCycleService;
  readonly runEventStreamService: RunEventStreamService;
  readonly executionStatus: () => ExecutionStatus;
  readonly daemonDrain: DaemonDrain;
}

export interface ServiceOverrides {
  readonly notificationTransport?: NotificationTransport;
  readonly passwordHasher?: PasswordHasher;
  readonly now?: () => Date;
  readonly streamHooks?: WorkspaceEventStreamHooks;
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
  const workItemService = new WorkItemService(storage, workspaceService, notifier, now);
  const planningQueryService = new PlanningQueryService(storage, workspaceService, workItemService);
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
  const worktreeMutations = new WorktreeMutationGuard();
  const storageService = new StorageService(
    storage,
    config,
    workspaceService,
    now,
    worktreeMutations,
  );
  const runtimeEvidenceService = new RuntimeEvidenceService(
    storage,
    workspaceService,
    notifier,
    gitOperations,
    now,
  );
  const executionService = new ExecutionService(
    storage,
    workspaceService,
    notifier,
    gitOperations,
    storageService.executionConfig,
    workItemService,
    now,
    worktreeMutations,
    runtimeEvidenceService,
  );
  const baselineService = new BaselinePreparationService(
    storage,
    gitOperations,
    storageService.executionConfig,
  );
  const agentRunService = new AgentRunService(
    storage,
    workspaceService,
    notifier,
    backends,
    storageService.executionConfig,
    overrides.runLog,
    now,
    worktreeMutations,
    executionService.branches,
    storageService,
    runtimeEvidenceService,
    baselineService,
  );
  storage.transaction((tx) => {
    tx.phaseScheduling.initializeCapacity(
      'local-development',
      config.execution.developmentCapacity ?? 2,
    );
    tx.phaseScheduling.initializeCapacity(
      'local-verification',
      config.execution.verificationCapacity ?? 1,
    );
  });
  // A completed drain left a clean-stop record (R-B9). It only counts when no run was
  // still live in the database, i.e. the drain really finished before the process ended.
  const previousStop = storage.transaction((tx) => tx.maintenance.takeCleanStop());
  const cleanStop = agentRunService.recoverInterrupted() === 0 && previousStop !== undefined;
  const workCycleService = new WorkCycleService(
    storage,
    workspaceService,
    agentRunService,
    gitOperations,
    notifier,
    now,
    worktreeMutations,
    executionService.branches,
    baselineService,
    executionService,
    runtimeEvidenceService,
  );
  const restartedCycleIds = workCycleService.recoverInterrupted({ cleanStop });
  const roadmapService = new RoadmapService(
    storage,
    workspaceService,
    workItemService,
    executionService,
    workCycleService,
    notifier,
    now,
    runtimeEvidenceService,
    agentRunService,
    gitOperations,
  );
  const restartedRoadmapIds = roadmapService.recoverInterrupted({ cleanStop });
  const crossProjectService = new CrossProjectService(
    storage,
    workspaceService,
    roadmapService,
    notifier,
  );
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
    crossProjectService,
    mapAmendmentService: new MapAmendmentService(
      storage,
      workspaceService,
      crossProjectService,
      workCycleService,
      gitOperations,
      notifier,
    ),
    runtimeEvidenceService,
    storageService,
    hostSchedulingService: new HostSchedulingService(storage, workspaceService, notifier, now),
    finalizationService: new FinalizationService(
      storage,
      workspaceService,
      executionService,
      workCycleService,
      gitOperations,
      notifier,
      now,
    ),
    roadmapService,
    notificationService: new NotificationService(
      storage,
      workspaceService,
      notifier,
      overrides.notificationTransport ?? new PushoverTransport(fetch, now),
      config.publicOrigin,
      now,
      () => storageService.alerts(),
      (id) => workCycleService.isTransitioning(id),
      {
        restartedAtBoot: { cycleIds: restartedCycleIds, roadmapIds: restartedRoadmapIds },
        roadmapAlerts: (tx, workspaceId) => roadmapService.attentionAlerts(tx, workspaceId),
      },
    ),
    packageImportService: new PackageImportService(
      storage,
      workspaceService,
      planImportService,
      notifier,
      now,
    ),
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
    executionService,
    agentRunService,
    workCycleService,
    runEventStreamService: new RunEventStreamService(
      storage,
      authService,
      workspaceService,
      notifier,
      overrides.streamHooks,
    ),
    executionStatus,
    daemonDrain: new DaemonDrain(
      storage,
      agentRunService,
      workCycleService,
      roadmapService,
      config.dataDir,
      config.drainTimeoutMs,
      now,
    ),
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
        crossProjectService: services.crossProjectService,
        mapAmendmentService: services.mapAmendmentService,
        runtimeEvidenceService: services.runtimeEvidenceService,
        packageImportService: services.packageImportService,
        storageService: services.storageService,
        hostSchedulingService: services.hostSchedulingService,
        authService: services.authService,
        workspaceService: services.workspaceService,
        planImportService: services.planImportService,
        planningQueryService: services.planningQueryService,
        workItemService: services.workItemService,
        workspaceEventStreamService: services.workspaceEventStreamService,
        executionService: services.executionService,
        agentRunService: services.agentRunService,
        workCycleService: services.workCycleService,
        finalizationService: services.finalizationService,
        notificationService: services.notificationService,
        roadmapService: services.roadmapService,
        runEventStreamService: services.runEventStreamService,
        executionStatus: services.executionStatus,
        daemonDrain: services.daemonDrain,
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
