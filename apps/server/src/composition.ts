import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type CrateChecksumAuthority, CratesIoChecksums } from './services/crate-checksums.js';
import {
  type AgentBackend,
  ClaudeCodeBackend,
  CodexBackend,
  parseModelList,
  syncDaemonCargoHome,
} from '@craftingtable/agents';
import {
  AGENT_BACKEND_LABELS,
  AGENT_BACKENDS,
  type AgentBackendKind,
  type AgentModel,
} from '@craftingtable/domain';
import {
  createGitOperations,
  type GitOperations,
  writeDaemonGitIdentity,
} from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import { openDaemonStorage } from './persisted-records.js';
import { CredentialFile } from './security/credential-file.js';
import { Argon2PasswordHasher, type PasswordHasher } from './security/password-hasher.js';
import { SessionTokenService } from './security/session-tokens.js';
import { type BuildServerOptions, buildServer } from './server.js';
import { AgentRunService, type RunLog } from './services/agent-run-service.js';
import { AuthService } from './services/auth-service.js';
import { BaselinePreparationService } from './services/baseline-preparation.js';
import { BootstrapService } from './services/bootstrap-service.js';
import { CrossProjectService } from './services/cross-project-service.js';
import { DaemonDrain } from './services/daemon-drain.js';
import { resolveExecutable } from './services/executables.js';
import { ExecutionService, type ExecutionStatus } from './services/execution-service.js';
import { FinalizationService } from './services/finalization-service.js';
import { HostSchedulingService } from './services/host-scheduling-service.js';
import { MapAmendmentService } from './services/map-amendment-service.js';
import { ModelCatalogService } from './services/model-catalog-service.js';
import { ControllerPasses, OperatorPresence } from './services/attention-gates.js';
import { AttentionProjector } from './services/attention-projector.js';
import { AttentionService } from './services/attention-service.js';
import { NotificationService } from './services/notification-service.js';
import {
  type NotificationTransport,
  PushoverTransport,
} from './services/notification-transport.js';
import { OperatorWaitService } from './services/operator-wait-service.js';
import { PackageImportService } from './services/package-import-service.js';
import { PlanImportService } from './services/plan-import-service.js';
import { PlanningQueryService } from './services/planning-query-service.js';
import { RoadmapService } from './services/roadmap-service.js';
import { RunEventStreamService } from './services/run-event-stream-service.js';
import { CheckRequestService } from './services/check-request-service.js';
import { GitFacts } from './services/git-facts.js';
import { PageViews } from './services/page-views.js';
import { RefWatch } from './services/ref-watch.js';
import { RepositoryChecksService } from './services/repository-checks-service.js';
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

export interface ServiceSet {
  readonly crossProjectService: CrossProjectService;
  readonly mapAmendmentService: MapAmendmentService;
  readonly runtimeEvidenceService: RuntimeEvidenceService;
  readonly repositoryChecksService: RepositoryChecksService;
  readonly checkRequestService: CheckRequestService;
  readonly packageImportService: PackageImportService;
  readonly storageService: StorageService;
  readonly hostSchedulingService: HostSchedulingService;
  readonly operatorWaitService: OperatorWaitService;
  readonly attentionService: AttentionService;
  readonly roadmapService: RoadmapService;
  readonly finalizationService: FinalizationService;
  readonly notificationService: NotificationService;
  /** The attention projection and the gates pushes wait on (R-A4). */
  readonly attention: AttentionProjector;
  readonly controllerPasses: ControllerPasses;
  readonly operatorPresence: OperatorPresence;
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
  /** One answer per page region (R-D5). */
  readonly pageViews: PageViews;
  /** Each backend's model catalog, read again at start, about hourly and on request (R-G15). */
  readonly modelCatalogService: ModelCatalogService;
  readonly daemonDrain: DaemonDrain;
}

export interface ServiceOverrides {
  readonly notificationTransport?: NotificationTransport;
  readonly passwordHasher?: PasswordHasher;
  readonly now?: () => Date;
  readonly streamHooks?: WorkspaceEventStreamHooks;
  /** Test seam: a Git operations implementation or `null` to simulate no Git. */
  readonly gitOperations?: GitOperations | null;
  /**
   * The agent backends: `host` finds the workstation's Claude Code and Codex, which the
   * production runtime does (`createRuntime`); otherwise the ones given, or none. A daemon asks
   * its CLIs for their model catalogs at start (R-G15), so nothing else resolves the host's.
   */
  readonly agentBackends?: ReadonlyMap<AgentBackendKind, AgentBackend> | 'host';
  readonly runLog?: RunLog;
  /** Test seam: where published crate checksums come from (crates.io's index by default). */
  readonly crateChecksums?: CrateChecksumAuthority;
  /**
   * Replay seam (R-I10): false takes the database as a live daemon's next pass would find it,
   * instead of recovering interrupted runs, cycles and roadmaps as a restart does.
   */
  readonly restartRecovery?: false;
}

function privateDirectory(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

/**
 * The operator's `CRAFTINGTABLE_{CLAUDE,CODEX}_MODELS`, which replaces a backend's catalog; a
 * value with no valid entry leaves the catalog in use (R-G15).
 */
function operatorModels(value: string | undefined): { models?: readonly AgentModel[] } {
  const models = parseModelList(value, []);
  return models.length === 0 ? {} : { models };
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
  // Attention items follow every write from here on, in the writing transaction (R-A4).
  const controllerPasses = new ControllerPasses();
  const operatorPresence = new OperatorPresence();
  const attention = new AttentionProjector(storage, controllerPasses, now, () =>
    notifier.notify('activity'),
  );
  storage.observeWrites(attention);
  const dummyPasswordHash = await passwordHasher.hash('craftingtable dummy password');
  const authService = new AuthService(
    storage,
    passwordHasher,
    tokenService,
    dummyPasswordHash,
    config.sessionLifetimeSeconds,
    now,
    config.sessionIdleSeconds,
  );
  const workspaceService = new WorkspaceService(storage, now, notifier);
  const planImportService = new PlanImportService(storage, workspaceService, notifier, now);
  const workItemService = new WorkItemService(storage, workspaceService, notifier, now);
  const planningQueryService = new PlanningQueryService(storage, workspaceService, workItemService);
  const gitExecutable =
    overrides.gitOperations === undefined
      ? resolveExecutable('git', config.execution.gitExecutable)
      : undefined;
  // Every daemon Git operation that can move a branch records where it left it, so a run's
  // protected-ref snapshot can tell the daemon's moves from anyone else's (R-G5).
  const refWatch = new RefWatch();
  const unwatchedGit: GitOperations | undefined =
    overrides.gitOperations === undefined
      ? gitExecutable === undefined
        ? undefined
        : createGitOperations({
            gitExecutable,
            // The operator's identity, and nothing else of their global Git configuration (R-G5).
            identityConfigPath: writeDaemonGitIdentity(
              gitExecutable,
              join(config.dataDir, 'git-identity.gitconfig'),
            ),
          })
      : (overrides.gitOperations ?? undefined);
  // Ancestry between resolved commits is asked of Git once (R-D5, PERF-09).
  const gitOperations = unwatchedGit && refWatch.wrap(new GitFacts().wrap(unwatchedGit));
  const backends = new Map<AgentBackendKind, AgentBackend>(
    overrides.agentBackends === 'host' ? [] : overrides.agentBackends,
  );
  if (overrides.agentBackends === 'host') {
    const claude = resolveExecutable('claude', config.execution.claudeExecutable, process.env, [
      join(homedir(), '.local', 'bin'),
    ]);
    if (claude !== undefined) {
      backends.set(
        'claude-code',
        new ClaudeCodeBackend({
          executable: claude,
          allowEnvironment: config.execution.agentEnvironmentAllow,
          ...operatorModels(config.execution.claudeModels),
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
          allowEnvironment: config.execution.agentEnvironmentAllow,
          ...operatorModels(config.execution.codexModels),
          // An empty directory of the daemon's own: no project's Codex configuration applies.
          catalogDirectory: privateDirectory(join(config.dataDir, 'model-catalog')),
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
  storageService.attachAttention(attention);
  const runtimeEvidenceService = new RuntimeEvidenceService(
    storage,
    workspaceService,
    notifier,
    gitOperations,
    now,
  );
  const repositoryChecksService = new RepositoryChecksService(
    storage,
    workspaceService,
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
    repositoryChecksService,
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
  const checkRequests = new CheckRequestService(
    storage,
    config.execution,
    overrides.runLog ?? { warn: () => undefined },
    undefined,
    undefined,
    overrides.crateChecksums ?? new CratesIoChecksums(join(config.dataDir, 'crates-io')),
  );
  checkRequests.stopLeftoverUnits();
  agentRunService.attachChecks(checkRequests);
  if (gitOperations) agentRunService.attachRefWatch(refWatch, gitOperations);
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
  const recovering = overrides.restartRecovery !== false;
  const previousStop = recovering
    ? storage.transaction((tx) => tx.maintenance.takeCleanStop())
    : undefined;
  const cleanStop =
    recovering && agentRunService.recoverInterrupted() === 0 && previousStop !== undefined;
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
  workCycleService.attachPasses(controllerPasses);
  if (recovering) workCycleService.recoverInterrupted({ cleanStop });
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
  roadmapService.attachAttention(attention, controllerPasses);
  if (recovering) roadmapService.recoverInterrupted({ cleanStop });
  // Anything written while the daemon was down, or before items existed, is projected now.
  attention.rebuild();
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
        catalog: backend === undefined ? { source: 'fallback' } : backend.describe().catalog,
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
    repositoryChecksService,
    checkRequestService: checkRequests,
    storageService,
    hostSchedulingService: new HostSchedulingService(storage, workspaceService, notifier, now),
    operatorWaitService: new OperatorWaitService(storage, workspaceService, now),
    attentionService: new AttentionService(storage, workspaceService, attention, now),
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
      attention,
      controllerPasses,
      operatorPresence,
      now,
      (id, workspaceId) => workCycleService.holdsReminders(workspaceId, id),
      // The operator's credentials file, outside the database (R-G9).
      { credentials: new CredentialFile(config.configDir) },
    ),
    attention,
    controllerPasses,
    operatorPresence,
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
      operatorPresence,
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
    pageViews: new PageViews(
      storage,
      workspaceService,
      planningQueryService,
      executionService,
      workCycleService,
      agentRunService,
      executionStatus,
    ),
    modelCatalogService: new ModelCatalogService(backends, overrides.runLog),
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

export interface DaemonOptions {
  readonly overrides?: ServiceOverrides;
  readonly server?: BuildServerOptions;
  /**
   * Runs once the daemon has stopped (its server, workers and checks) and before its storage
   * closes, whether or not it throws. Test daemons check the records they leave here.
   */
  readonly beforeStorageCloses?: () => void;
}

/**
 * A daemon over storage the caller opened: its services, its server, and the one way it
 * closes. The production runtime and every test daemon are built here, so a test's teardown is
 * the daemon's own (TS-M14): stop the server and its workers, wait for running checks, then
 * close the storage. Once it is returned, its close owns the storage; if it throws instead,
 * the storage is still the caller's to close.
 */
export async function createDaemon(
  storage: CraftingTableStorage,
  config: ServerConfig,
  options: DaemonOptions = {},
): Promise<CraftingTableRuntime> {
  const services = await createServices(storage, config, options.overrides);
  // Pushover credentials still in the database move to the credentials file (R-G9).
  services.notificationService.adoptStoredCredentials();
  const app = buildServer(
    {
      crossProjectService: services.crossProjectService,
      mapAmendmentService: services.mapAmendmentService,
      runtimeEvidenceService: services.runtimeEvidenceService,
      repositoryChecksService: services.repositoryChecksService,
      packageImportService: services.packageImportService,
      storageService: services.storageService,
      hostSchedulingService: services.hostSchedulingService,
      operatorWaitService: services.operatorWaitService,
      attentionService: services.attentionService,
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
      pageViews: services.pageViews,
      modelCatalogService: services.modelCatalogService,
      daemonDrain: services.daemonDrain,
    },
    config,
    options.server,
  );
  // A daemon reads its CLIs' model catalogs now and about hourly (R-G15); a replay, built from
  // the services alone, keeps the lists it starts with.
  services.modelCatalogService.start();
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
      services.modelCatalogService.stop();
      // Every step runs even when one before it fails, so a server that fails to close leaves
      // no check running and no storage open; the first failure is the one the close throws.
      const failures: unknown[] = [];
      try {
        await app.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await services.checkRequestService.closeAll();
      } catch (error) {
        failures.push(error);
      }
      try {
        options.beforeStorageCloses?.();
      } catch (error) {
        failures.push(error);
      }
      try {
        storage.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0) throw failures[0];
    },
  };
}

export async function createRuntime(
  config: ServerConfig,
  options: { readonly logger?: boolean; readonly overrides?: ServiceOverrides } = {},
): Promise<CraftingTableRuntime> {
  // Agents and check units use the daemon's own Cargo home; bring in what the operator has
  // downloaded since the last start (R-G5 review). A failed copy leaves fetches and offline
  // builds to find out, so the daemon still starts.
  try {
    syncDaemonCargoHome(config.execution.cargoHome, config.execution.cargoSeedFrom);
  } catch (error) {
    console.warn(error instanceof Error ? error.message : error);
  }
  const storage = openDaemonStorage(config.databasePath);
  try {
    // The run service's and check service's warnings reach the daemon's log (LIVE-31
    // verification): its own once the server exists, the journal before that (the start's sweep).
    let log: { warn(detail: object, message: string): void } | undefined;
    const runLog: RunLog = {
      warn: (message, detail = {}) =>
        log ? log.warn(detail, message) : console.warn(message, JSON.stringify(detail)),
    };
    const daemon = await createDaemon(storage, config, {
      overrides: {
        agentBackends: 'host',
        ...(options.logger === false ? {} : { runLog }),
        ...options.overrides,
      },
      server: { logger: options.logger ?? true },
    });
    log = daemon.app.log;
    return daemon;
  } catch (error) {
    storage.close();
    throw error;
  }
}
