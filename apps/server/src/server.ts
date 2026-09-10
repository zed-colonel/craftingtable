import { readFileSync } from 'node:fs';
import cookie from '@fastify/cookie';
import { type FastifyInstance, fastify } from 'fastify';
import type { ServerConfig } from './config.js';
import { registerAgentRunRoutes } from './routes/agent-runs.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerExecutionRoutes } from './routes/execution.js';
import { registerHealthRoute } from './routes/health.js';
import { sendApiError } from './routes/http.js';
import { registerPlanningRoutes } from './routes/planning.js';
import { registerStaticWebRoutes } from './routes/static-web.js';
import { registerWorkCycleRoutes } from './routes/work-cycles.js';
import { registerWorkspaceEventRoute } from './routes/workspace-events.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import type { AgentRunService } from './services/agent-run-service.js';
import type { AuthService } from './services/auth-service.js';
import {
  AuthenticationError,
  ExecutionRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from './services/errors.js';
import type { ExecutionService, ExecutionStatus } from './services/execution-service.js';
import type { PlanImportService } from './services/plan-import-service.js';
import type { PlanningQueryService } from './services/planning-query-service.js';
import type { RunEventStreamService } from './services/run-event-stream-service.js';
import type { WorkCycleService } from './services/work-cycle-service.js';
import type { WorkItemService } from './services/work-item-service.js';
import type { WorkspaceEventStreamService } from './services/workspace-event-stream-service.js';
import type { WorkspaceService } from './services/workspace-service.js';

export interface ServerDependencies {
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
}

export interface BuildServerOptions {
  readonly logger?: boolean;
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
            paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'],
            censor: '[REDACTED]',
          },
          ...(options.loggerStream === undefined ? {} : { stream: options.loggerStream }),
        };
  // The HTTPS and HTTP instances differ only in the raw server generic; the
  // routes never touch it, so one FastifyInstance type serves both.
  const app: FastifyInstance =
    config.tls === undefined
      ? fastify({ logger })
      : (fastify({
          logger,
          https: {
            cert: readFileSync(config.tls.certPath),
            key: readFileSync(config.tls.keyPath),
          },
        }) as unknown as FastifyInstance);
  void app.register(cookie);

  app.addHook('onReady', async () => {
    deps.workCycleService.startWorker();
  });
  app.addHook('preClose', async () => {
    await deps.workCycleService.shutdown();
  });
  registerWorkCycleRoutes(app, deps.authService, deps.workCycleService, config);
  registerHealthRoute(app);
  registerAuthRoutes(app, deps.authService, config);
  registerWorkspaceRoutes(app, deps.authService, deps.workspaceService, config);
  registerPlanningRoutes(
    app,
    deps.authService,
    deps.planImportService,
    deps.planningQueryService,
    deps.workItemService,
    config,
  );
  registerWorkspaceEventRoute(
    app,
    deps.authService,
    deps.workspaceService,
    deps.workspaceEventStreamService,
    config,
  );
  registerExecutionRoutes(
    app,
    deps.authService,
    deps.executionService,
    deps.agentRunService,
    deps.executionStatus,
    config,
  );
  registerAgentRunRoutes(
    app,
    deps.authService,
    deps.workspaceService,
    deps.agentRunService,
    deps.runEventStreamService,
    config,
  );
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
          return sendApiError(reply, 409, 'conflict', error.message);
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
