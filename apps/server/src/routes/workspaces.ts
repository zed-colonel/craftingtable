import {
  createWorkspaceRequestSchema,
  createWorkspaceResponseSchema,
  renameWorkspaceRequestSchema,
  renameWorkspaceResponseSchema,
  workspaceAuditPageResponseSchema,
  workspaceIdSchema,
  workspaceListResponseSchema,
  workspaceSnapshotResponseSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SESSION_COOKIE_NAME, type ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import type { WorkspaceService } from '../services/workspace-service.js';
import { noStore, sendApiError } from './http.js';
import { authorizeMutation } from './request-security.js';

function workspaceId(value: string) {
  return workspaceIdSchema.safeParse(value);
}

function positiveCursor(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error('Invalid audit cursor');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error('Invalid audit cursor');
  }
  return parsed;
}

function authenticate(request: FastifyRequest, authService: AuthService) {
  return authService.authenticate(request.cookies[SESSION_COOKIE_NAME]);
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  authService: AuthService,
  workspaceService: WorkspaceService,
  config: ServerConfig,
): void {
  app.get('/api/workspaces', { config: { access: 'session' } }, async (request, reply) => {
    const context = authenticate(request, authService);
    return noStore(reply).send(
      workspaceListResponseSchema.parse({ workspaces: workspaceService.list(context) }),
    );
  });

  app.post('/api/workspaces', { config: { access: 'session' } }, async (request, reply) => {
    const context = authorizeMutation(request, authService, config);
    const body = createWorkspaceRequestSchema.safeParse(request.body ?? {});
    if (!body.success) {
      return sendApiError(reply, 400, 'invalid-request', 'Invalid workspace request');
    }
    const workspace = workspaceService.create(context, body.data.name, request.id);
    return noStore(reply).send(createWorkspaceResponseSchema.parse({ workspace }));
  });

  app.post<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/rename',
    { config: { access: 'owner' } },
    async (request, reply) => {
      const context = authorizeMutation(request, authService, config);
      const parsed = workspaceId(request.params.workspaceId);
      if (!parsed.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const body = renameWorkspaceRequestSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid workspace request');
      }
      return noStore(reply).send(
        renameWorkspaceResponseSchema.parse(
          workspaceService.rename(context, parsed.data, body.data.name, request.id),
        ),
      );
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/snapshot',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, authService);
      const parsed = workspaceId(request.params.workspaceId);
      if (!parsed.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      return noStore(reply).send(
        workspaceSnapshotResponseSchema.parse(
          workspaceService.snapshot(context, parsed.data, request.id),
        ),
      );
    },
  );

  app.get<{
    Params: { workspaceId: string };
    Querystring: { limit?: string; before?: string };
  }>(
    '/api/workspaces/:workspaceId/audit',
    { config: { access: 'owner' } },
    async (request, reply) => {
      const context = authenticate(request, authService);
      const parsed = workspaceId(request.params.workspaceId);
      if (!parsed.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      const limit = Number(request.query.limit ?? 50);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid audit pagination');
      }
      let before: number | undefined;
      try {
        before = positiveCursor(request.query.before);
      } catch {
        return sendApiError(reply, 400, 'invalid-request', 'Invalid audit pagination');
      }
      return noStore(reply).send(
        workspaceAuditPageResponseSchema.parse(
          workspaceService.auditPage(context, parsed.data, {
            limit,
            ...(before === undefined ? {} : { before }),
            requestId: request.id,
          }),
        ),
      );
    },
  );
}
