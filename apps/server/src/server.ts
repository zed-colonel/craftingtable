import { readFileSync } from 'node:fs';
import cookie from '@fastify/cookie';
import { type FastifyInstance, fastify } from 'fastify';
import type { ServerConfig } from './config.js';
import { registerAgentRunRoutes } from './routes/agent-runs.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerCrossProjectRoutes } from './routes/cross-project.js';
import {
  DaemonDiagnostics,
  RequestLogController,
  registerDiagnosticsRoutes,
} from './routes/diagnostics.js';
import { registerExecutionRoutes } from './routes/execution.js';
import { registerFinalizationRoutes } from './routes/finalizations.js';
import { registerHealthRoute } from './routes/health.js';
import { registerHostSchedulingRoutes } from './routes/host-scheduling.js';
import { sendApiError } from './routes/http.js';
import { registerMapAmendmentRoutes } from './routes/map-amendments.js';
import { registerNotificationRoutes } from './routes/notifications.js';
import { registerOperatorWaitRoutes } from './routes/operator-wait.js';
import { registerAttentionRoutes } from './routes/attention.js';
import { registerPackageImportRoutes } from './routes/package-imports.js';
import { registerPageViewRoutes } from './routes/page-views.js';
import { registerPlanningRoutes } from './routes/planning.js';
import { registerRoadmapRoutes } from './routes/roadmaps.js';
import { installResponseEncoding } from './routes/response-encoding.js';
import { installRouteAccess } from './routes/route-access.js';
import { registerRuntimeEvidenceRoutes } from './routes/runtime-evidence.js';
import { registerStaticWebRoutes } from './routes/static-web.js';
import { registerStorageRoutes } from './routes/storage.js';
import { registerWorkCycleRoutes } from './routes/work-cycles.js';
import { registerWorkspaceEventRoute } from './routes/workspace-events.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import type { AgentRunService } from './services/agent-run-service.js';
import type { AuthService } from './services/auth-service.js';
import type { CrossProjectService } from './services/cross-project-service.js';
import type { DaemonDrain } from './services/daemon-drain.js';
import type { ModelCatalogService } from './services/model-catalog-service.js';
import {
  AuthenticationError,
  ExecutionRequestError,
  ForbiddenError,
  LoginRateLimitedError,
  NotFoundError,
  UnauthenticatedError,
} from './services/errors.js';
import type { ExecutionService, ExecutionStatus } from './services/execution-service.js';
import type { FinalizationService } from './services/finalization-service.js';
import type { HostSchedulingService } from './services/host-scheduling-service.js';
import type { MapAmendmentService } from './services/map-amendment-service.js';
import type { NotificationService } from './services/notification-service.js';
import type { OperatorWaitService } from './services/operator-wait-service.js';
import type { PackageImportService } from './services/package-import-service.js';
import type { PageViews } from './services/page-views.js';
import type { PlanImportService } from './services/plan-import-service.js';
import type { PlanningQueryService } from './services/planning-query-service.js';
import type { RoadmapService } from './services/roadmap-service.js';
import type { RunEventStreamService } from './services/run-event-stream-service.js';
import type { RepositoryChecksService } from './services/repository-checks-service.js';
import { registerRepositoryChecksRoutes } from './routes/repository-checks.js';
import type { RuntimeEvidenceService } from './services/runtime-evidence-service.js';
import type { StorageService } from './services/storage-service.js';
import type { WorkCycleService } from './services/work-cycle-service.js';
import type { WorkItemService } from './services/work-item-service.js';
import type { WorkspaceEventStreamService } from './services/workspace-event-stream-service.js';
import type { WorkspaceService } from './services/workspace-service.js';

export interface ServerDependencies {
  readonly crossProjectService: CrossProjectService;
  readonly mapAmendmentService: MapAmendmentService;
  readonly runtimeEvidenceService: RuntimeEvidenceService;
  readonly repositoryChecksService: RepositoryChecksService;
  readonly packageImportService: PackageImportService;
  readonly storageService: StorageService;
  readonly hostSchedulingService: HostSchedulingService;
  readonly operatorWaitService: OperatorWaitService;
  readonly attentionService: import('./services/attention-service.js').AttentionService;
  readonly roadmapService: RoadmapService;
  readonly finalizationService: FinalizationService;
  readonly notificationService: NotificationService;
  readonly authService: AuthService;
  readonly workspaceService: WorkspaceService;
  readonly planImportService: PlanImportService;
  readonly planningQueryService: PlanningQueryService;
  readonly workItemService: WorkItemService;
  readonly workspaceEventStreamService: WorkspaceEventStreamService;
  readonly executionService: ExecutionService;
  readonly agentRunService: AgentRunService;
  readonly workCycleService: WorkCycleService;
  readonly runEventStreamService: RunEventStreamService;
  readonly executionStatus: () => ExecutionStatus;
  readonly pageViews: PageViews;
  readonly modelCatalogService: ModelCatalogService;
  readonly daemonDrain: DaemonDrain;
}

export interface BuildServerOptions {
  readonly logger?: boolean;
  /**
   * Start the background workers when the server is ready (default). Tests that step the
   * controller themselves (`WorkCycleService.tick`) leave them stopped.
   */
  readonly startWorkers?: boolean;
  readonly loggerStream?: { write(message: string): void };
}

export function buildServer(
  deps: ServerDependencies,
  config: ServerConfig,
  options: BuildServerOptions = {},
): FastifyInstance {
  const logger =
    options.logger === false
      ? false
      : {
          level: config.logLevel,
          redact: {
            paths: [
              'req.headers.cookie',
              'req.headers.authorization',
              'res.headers.set-cookie',
              'req.body.applicationToken',
              'req.body.userKey',
            ],
            censor: '[REDACTED]',
          },
          ...(options.loggerStream === undefined ? {} : { stream: options.loggerStream }),
        };
  // The HTTPS and HTTP instances differ only in the raw server generic; the
  // routes never touch it, so one FastifyInstance type serves both.
  // One completion line per request carries route, status, duration and bytes (R-D3).
  const logController = new RequestLogController();
  const app: FastifyInstance =
    config.tls === undefined
      ? fastify({ logger, logController })
      : (fastify({
          logger,
          logController,
          https: {
            cert: readFileSync(config.tls.certPath),
            key: readFileSync(config.tls.keyPath),
          },
        }) as unknown as FastifyInstance);
  void app.register(cookie);
  installRouteAccess(app, deps.authService, deps.workspaceService, config);
  installResponseEncoding(app);
  registerDiagnosticsRoutes(app, deps.workspaceService, new DaemonDiagnostics());

  app.addHook('onReady', async () => {
    if (options.startWorkers === false) return;
    deps.roadmapService.startWorker();
    deps.workCycleService.startWorker();
    deps.notificationService.startWorker();
    deps.storageService.startWorker();
    deps.daemonDrain.startWatching();
  });
  // A stop drains live agent turns before the HTTP server closes, so the browser keeps
  // showing progress; the drain then records a clean stop for automatic resume (R-B9).
  app.addHook('preClose', async () => {
    deps.daemonDrain.stopWatching();
    await deps.storageService.shutdown();
    await deps.daemonDrain.drain(config.drainTimeoutMs, app.log);
    await deps.notificationService.shutdown();
  });
  registerPackageImportRoutes(app, deps.packageImportService);
  registerCrossProjectRoutes(app, deps.crossProjectService);
  registerMapAmendmentRoutes(app, deps.mapAmendmentService);
  registerRuntimeEvidenceRoutes(app, deps.runtimeEvidenceService);
  registerRepositoryChecksRoutes(app, deps.repositoryChecksService);
  registerStorageRoutes(app, deps.storageService);
  registerHostSchedulingRoutes(app, deps.hostSchedulingService);
  registerOperatorWaitRoutes(app, deps.operatorWaitService);
  registerAttentionRoutes(app, deps.attentionService);
  registerFinalizationRoutes(app, deps.finalizationService);
  registerRoadmapRoutes(app, deps.roadmapService);
  registerNotificationRoutes(app, deps.notificationService);
  registerWorkCycleRoutes(app, deps.workCycleService, deps.roadmapService);
  registerHealthRoute(app);
  registerAuthRoutes(app, deps.authService, config);
  registerWorkspaceRoutes(app, deps.workspaceService);
  registerPlanningRoutes(
    app,
    deps.planImportService,
    deps.planningQueryService,
    deps.workItemService,
  );
  registerWorkspaceEventRoute(app, deps.workspaceService, deps.workspaceEventStreamService, config);
  registerExecutionRoutes(
    app,
    deps.executionService,
    deps.agentRunService,
    deps.executionStatus,
    deps.modelCatalogService,
  );
  registerAgentRunRoutes(
    app,
    deps.workspaceService,
    deps.agentRunService,
    deps.runEventStreamService,
    config,
  );
  registerPageViewRoutes(app, deps.pageViews);
  if (config.webDistDir !== undefined) {
    registerStaticWebRoutes(app, config.webDistDir);
  }

  app.setErrorHandler((error, request, reply) => {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE'
    ) {
      return sendApiError(reply, 400, 'invalid-request', 'Invalid authentication request');
    }
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
        error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY')
    ) {
      return sendApiError(reply, 400, 'invalid-request', 'Request body is not valid JSON');
    }
    if (error instanceof LoginRateLimitedError) {
      reply.header(
        'retry-after',
        String(Math.max(1, Math.ceil((error.until.getTime() - Date.now()) / 1000))),
      );
      return sendApiError(reply, 429, 'rate-limited', error.message, {
        reason: 'login-rate-limited',
      });
    }
    if (error instanceof AuthenticationError) {
      return sendApiError(reply, 401, 'invalid-credentials', 'Invalid username or password');
    }
    if (error instanceof UnauthenticatedError) {
      return sendApiError(reply, 401, 'unauthenticated', 'Authentication required');
    }
    if (error instanceof ForbiddenError) {
      return sendApiError(reply, 403, 'forbidden', 'Request forbidden');
    }
    if (error instanceof NotFoundError) {
      return sendApiError(reply, 404, 'not-found', 'Resource not found');
    }
    if (error instanceof ExecutionRequestError) {
      switch (error.code) {
        case 'invalid-request':
          return sendApiError(reply, 400, 'invalid-request', error.message);
        case 'conflict':
          return sendApiError(reply, 409, 'conflict', error.message, error.detail);
        case 'unavailable':
          return sendApiError(reply, 503, 'unavailable', error.message);
      }
    }
    request.log.error(
      { err: { name: error instanceof Error ? error.name : 'Error' } },
      'request failed',
    );
    return sendApiError(reply, 500, 'internal-error', 'Internal server error');
  });

  return app;
}
