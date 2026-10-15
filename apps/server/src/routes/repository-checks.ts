import {
  adoptCheckDeclarationRequestSchema,
  checkDefinitionDiagnosisSchema,
  repositoryCheckReceiptsSchema,
  worktreeIdSchema,
  checkDeclarationPreviewRequestSchema,
  checkDeclarationPreviewSchema,
  repositoryChecksViewSchema,
  sourceRepositoryIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type {
  CheckDefinitionDiagnosis,
  RepositoryChecksService,
} from '../services/repository-checks-service.js';
import { noStore, sendApiError } from './http.js';
import { type BodyOf, contextOf, workspaceParams, paramsOf } from './route-access.js';

/** Each route's path parameters (R-H7). */
const REPOSITORY = workspaceParams({ repositoryId: sourceRepositoryIdSchema });
const WORKTREE = workspaceParams({ worktreeId: worktreeIdSchema });

/** A repository's declared checks (R-G13): read them, preview a proposal, adopt it. */
export function registerRepositoryChecksRoutes(
  app: FastifyInstance,
  service: RepositoryChecksService,
) {
  const base = '/api/workspaces/:workspaceId/repositories/:repositoryId/checks';
  app.get(
    base,
    { config: { access: 'member', params: REPOSITORY, notFound: 'Repository not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, repositoryId } = paramsOf(request, REPOSITORY);
      return noStore(reply).send(
        repositoryChecksViewSchema.parse(service.view(context, workspaceId, repositoryId)),
      );
    },
  );
  app.get(
    `${base}/receipts`,
    { config: { access: 'member', params: REPOSITORY, notFound: 'Repository not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, repositoryId } = paramsOf(request, REPOSITORY);
      return noStore(reply).send(
        repositoryCheckReceiptsSchema.parse(service.receipts(context, workspaceId, repositoryId)),
      );
    },
  );
  app.post<{ Body: BodyOf<typeof checkDeclarationPreviewRequestSchema> }>(
    `${base}/preview`,
    {
      config: {
        access: 'editor',
        params: REPOSITORY,
        notFound: 'Repository not found',
        tag: 'config',
        body: checkDeclarationPreviewRequestSchema,
        invalidBody: 'Invalid preview',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, repositoryId } = paramsOf(request, REPOSITORY);
      return noStore(reply).send(
        checkDeclarationPreviewSchema.parse(
          await service.preview(context, workspaceId, repositoryId, request.body.ref),
        ),
      );
    },
  );
  app.get(
    '/api/workspaces/:workspaceId/worktrees/:worktreeId/check-definitions',
    { config: { access: 'member', params: WORKTREE, notFound: 'Worktree not found' } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, worktreeId } = paramsOf(request, WORKTREE);
      const diagnosis = await service.definitionsOf(context, workspaceId, worktreeId);
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
  app.post<{ Body: BodyOf<typeof adoptCheckDeclarationRequestSchema> }>(
    `${base}/adopt`,
    {
      config: {
        access: 'editor',
        params: REPOSITORY,
        notFound: 'Repository not found',
        tag: 'decision',
        body: adoptCheckDeclarationRequestSchema,
        invalidBody: 'Invalid adoption',
      },
    },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, repositoryId } = paramsOf(request, REPOSITORY);
      return noStore(reply).send(
        repositoryChecksViewSchema.parse(
          await service.adopt(context, workspaceId, repositoryId, request.body),
        ),
      );
    },
  );
}

/** The diagnosis as the browser reads it: the merge's proposal reduced to its checks. */
function diagnosisView(diagnosis: CheckDefinitionDiagnosis) {
  const { merge, ...rest } = diagnosis;
  if (!merge) return rest;
  const { proposal, ...adoption } = merge;
  return { ...rest, merge: { ...adoption, proposedChecks: proposal?.checks ?? [] } };
}
