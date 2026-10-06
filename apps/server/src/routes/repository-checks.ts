import {
  adoptCheckDeclarationRequestSchema,
  checkDefinitionDiagnosisSchema,
  repositoryCheckReceiptsSchema,
  worktreeIdSchema,
  checkDeclarationPreviewRequestSchema,
  checkDeclarationPreviewSchema,
  repositoryChecksViewSchema,
  sourceRepositoryIdSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type {
  CheckDefinitionDiagnosis,
  RepositoryChecksService,
} from '../services/repository-checks-service.js';
import { noStore, sendApiError } from './http.js';
import { contextOf } from './route-access.js';

/** A repository's declared checks (R-G13): read them, preview a proposal, adopt it. */
export function registerRepositoryChecksRoutes(
  app: FastifyInstance,
  service: RepositoryChecksService,
) {
  const base = '/api/workspaces/:workspaceId/repositories/:repositoryId/checks';
  type Params = { Params: { workspaceId: string; repositoryId: string } };
  const ids = (params: Params['Params']) => {
    const ws = workspaceIdSchema.safeParse(params.workspaceId);
    const repository = sourceRepositoryIdSchema.safeParse(params.repositoryId);
    return ws.success && repository.success
      ? { ws: ws.data, repository: repository.data }
      : undefined;
  };
  app.get<Params>(base, { config: { access: 'member' } }, async (request, reply) => {
    const context = contextOf(request);
    const target = ids(request.params);
    if (!target) return sendApiError(reply, 404, 'not-found', 'Repository not found');
    return noStore(reply).send(
      repositoryChecksViewSchema.parse(service.view(context, target.ws, target.repository)),
    );
  });
  app.get<Params>(`${base}/receipts`, { config: { access: 'member' } }, async (request, reply) => {
    const context = contextOf(request);
    const target = ids(request.params);
    if (!target) return sendApiError(reply, 404, 'not-found', 'Repository not found');
    return noStore(reply).send(
      repositoryCheckReceiptsSchema.parse(service.receipts(context, target.ws, target.repository)),
    );
  });
  app.post<Params>(`${base}/preview`, { config: { access: 'editor' } }, async (request, reply) => {
    const context = contextOf(request);
    const target = ids(request.params);
    const input = checkDeclarationPreviewRequestSchema.safeParse(request.body);
    if (!target) return sendApiError(reply, 404, 'not-found', 'Repository not found');
    if (!input.success) return sendApiError(reply, 400, 'invalid-request', 'Invalid preview');
    return noStore(reply).send(
      checkDeclarationPreviewSchema.parse(
        await service.preview(context, target.ws, target.repository, input.data.ref),
      ),
    );
  });
  type TreeParams = { Params: { workspaceId: string; worktreeId: string } };
  app.get<TreeParams>(
    '/api/workspaces/:workspaceId/worktrees/:worktreeId/check-definitions',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = contextOf(request);
      const ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      const tree = worktreeIdSchema.safeParse(request.params.worktreeId);
      if (!ws.success || !tree.success)
        return sendApiError(reply, 404, 'not-found', 'Worktree not found');
      const diagnosis = await service.definitionsOf(context, ws.data, tree.data);
      if (!diagnosis)
        return sendApiError(
          reply,
          404,
          'not-found',
          'No review of this worktree was held to adopted checks',
        );
      return noStore(reply).send(checkDefinitionDiagnosisSchema.parse(diagnosisView(diagnosis)));
    },
  );
  app.post<Params>(`${base}/adopt`, { config: { access: 'editor' } }, async (request, reply) => {
    const context = contextOf(request);
    const target = ids(request.params);
    const input = adoptCheckDeclarationRequestSchema.safeParse(request.body);
    if (!target) return sendApiError(reply, 404, 'not-found', 'Repository not found');
    if (!input.success) return sendApiError(reply, 400, 'invalid-request', 'Invalid adoption');
    return noStore(reply).send(
      repositoryChecksViewSchema.parse(
        await service.adopt(context, target.ws, target.repository, input.data),
      ),
    );
  });
}

/** The diagnosis as the browser reads it: the merge's proposal reduced to its checks. */
function diagnosisView(diagnosis: CheckDefinitionDiagnosis) {
  const { merge, ...rest } = diagnosis;
  if (!merge) return rest;
  const { proposal, ...adoption } = merge;
  return { ...rest, merge: { ...adoption, proposedChecks: proposal?.checks ?? [] } };
}
