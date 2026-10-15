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
import type { FastifyInstance } from 'fastify';
import type { WorkspaceService } from '../services/workspace-service.js';
import { noStore, sendApiError } from './http.js';
import { type BodyOf, contextOf, WORKSPACE_PARAMS } from './route-access.js';

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

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  workspaceService: WorkspaceService,
): void {
  app.get('/api/workspaces', { config: { access: 'session' } }, async (request, reply) => {
    const context = contextOf(request);
    return noStore(reply).send(
      workspaceListResponseSchema.parse({ workspaces: workspaceService.list(context) }),
    );
  });

  app.post<{ Body: BodyOf<typeof createWorkspaceRequestSchema> }>(
    '/api/workspaces',
    {
      config: {
        access: 'session',
        tag: 'config',
        body: createWorkspaceRequestSchema,
        invalidBody: 'Invalid workspace request',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceService.create(context, request.body.name, request.id);
      return noStore(reply).send(createWorkspaceResponseSchema.parse({ workspace }));
    },
  );

  app.post<{ Params: { workspaceId: string }; Body: BodyOf<typeof renameWorkspaceRequestSchema> }>(
    '/api/workspaces/:workspaceId/rename',
    {
      config: {
        access: 'owner',
        params: WORKSPACE_PARAMS,
        tag: 'config',
        body: renameWorkspaceRequestSchema,
        invalidBody: 'Invalid workspace request',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const parsed = workspaceId(request.params.workspaceId);
      if (!parsed.success) {
        return sendApiError(reply, 404, 'not-found', 'Resource not found');
      }
      return noStore(reply).send(
        renameWorkspaceResponseSchema.parse(
          workspaceService.rename(context, parsed.data, request.body.name, request.id),
        ),
      );
    },
  );

  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/snapshot',
    { config: { access: 'member', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
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
    { config: { access: 'owner', params: WORKSPACE_PARAMS } },
    async (request, reply) => {
      const context = contextOf(request);
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
