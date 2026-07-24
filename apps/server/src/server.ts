import cookie from '@fastify/cookie';
import { fastify, type FastifyInstance } from 'fastify';
import type { ServerConfig } from './config.js';
import { registerAuthRoutes } from './routes/auth.js';
import { sendApiError } from './routes/http.js';
import { registerWorkspaceEventRoute } from './routes/workspace-events.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerHealthRoute } from './routes/health.js';
import type { AuthService } from './services/auth-service.js';
import {
  AuthenticationError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
} from './services/errors.js';
import type { WorkspaceEventStreamService } from './services/workspace-event-stream-service.js';
import type { WorkspaceService } from './services/workspace-service.js';

export interface ServerDependencies {
  readonly authService: AuthService;
  readonly workspaceService: WorkspaceService;
  readonly workspaceEventStreamService: WorkspaceEventStreamService;
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
  const app = fastify({ logger });
  void app.register(cookie);

  registerHealthRoute(app);
  registerAuthRoutes(app, deps.authService, config);
  registerWorkspaceRoutes(app, deps.authService, deps.workspaceService);
  registerWorkspaceEventRoute(
    app,
    deps.authService,
    deps.workspaceService,
    deps.workspaceEventStreamService,
  );

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
    request.log.error(
      { err: { name: error instanceof Error ? error.name : 'Error' } },
      'request failed',
    );
    return sendApiError(reply, 500, 'internal-error', 'Internal server error');
  });

  return app;
}
