import {
  archivePlanImportResponseSchema,
  archiveSelectionSchema,
  concurrencyDetailSchema,
  concurrencyImportResponseSchema,
  concurrencyListSchema,
  planArchivePreviewSchema,
  planVersionIdSchema,
  projectIdSchema,
  saveConcurrencyBindingsSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import { ARCHIVE_LIMITS } from '@craftingtable/planning';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ExecutionRequestError } from '../services/errors.js';
import type { PackageImportService } from '../services/package-import-service.js';
import { noStore, sendApiError } from './http.js';
import { importResponse } from './planning.js';
import { contextOf } from './route-access.js';

async function readArchiveUpload(request: FastifyRequest) {
  if (!request.isMultipart())
    throw new ExecutionRequestError('invalid-request', 'Upload a ZIP using multipart/form-data.');
  const fields: Record<string, string> = {};
  let file: { filename: string; bytes: Uint8Array } | undefined;
  try {
    for await (const part of request.parts({
      limits: {
        files: 1,
        fileSize: ARCHIVE_LIMITS.maxCompressedBytes + 1,
        fields: 8,
        fieldSize: 1024,
        parts: 10,
      },
    })) {
      if (part.type === 'field') {
        if (
          ![
            'implementationPlan',
            'workBreakdown',
            'projectId',
            'projectName',
            'archiveDigest',
            'activate',
            'expectedActivePlanVersionId',
          ].includes(part.fieldname) ||
          Object.hasOwn(fields, part.fieldname) ||
          part.fieldnameTruncated ||
          part.valueTruncated ||
          typeof part.value !== 'string'
        )
          throw new Error('Invalid archive field.');
        fields[part.fieldname] = part.value;
        continue;
      }
      if (part.fieldname !== 'archive' || file || !part.filename.toLowerCase().endsWith('.zip'))
        throw new Error('Choose one ZIP archive.');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of part.file) {
        size += chunk.length;
        if (size > ARCHIVE_LIMITS.maxCompressedBytes) throw new Error('ZIP exceeds 8 MiB.');
        chunks.push(chunk);
      }
      if (part.file.truncated) throw new Error('ZIP exceeds 8 MiB.');
      file = { filename: part.filename, bytes: Buffer.concat(chunks) };
    }
  } catch (error) {
    throw new ExecutionRequestError(
      'invalid-request',
      error instanceof Error ? error.message : 'Invalid ZIP upload.',
    );
  }
  if (!file) throw new ExecutionRequestError('invalid-request', 'Choose one ZIP archive.');
  return { ...file, fields };
}
export function registerPackageImportRoutes(app: FastifyInstance, imports: PackageImportService) {
  for (const action of ['preview', 'import'] as const)
    app.post<{ Params: { workspaceId: string } }>(
      `/api/workspaces/:workspaceId/plan-archives/${action}`,
      { config: { access: 'editor' }, bodyLimit: ARCHIVE_LIMITS.maxCompressedBytes + 16384 },
      async (request, reply) => {
        const context = contextOf(request);
        const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
        if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
        const upload = await readArchiveUpload(request);
        const fields = upload.fields;
        const selection = archiveSelectionSchema.safeParse({
          implementationPlan: fields.implementationPlan,
          workBreakdown: fields.workBreakdown,
        });
        if (action === 'preview') {
          if ((fields.implementationPlan || fields.workBreakdown) && !selection.success)
            return sendApiError(reply, 400, 'invalid-request', 'Choose both primary plan files.');
          return noStore(reply).send(
            planArchivePreviewSchema.parse(
              imports.previewPlan(
                context,
                workspace.data,
                upload.bytes,
                selection.success ? selection.data : undefined,
              ),
            ),
          );
        }
        const project = fields.projectId ? projectIdSchema.safeParse(fields.projectId) : undefined;
        const previous = fields.expectedActivePlanVersionId
          ? planVersionIdSchema.safeParse(fields.expectedActivePlanVersionId)
          : undefined;
        if (
          !selection.success ||
          (project && !project.success) ||
          (previous && !previous.success) ||
          !/^[a-f0-9]{64}$/.test(fields.archiveDigest ?? '') ||
          !['true', 'false'].includes(fields.activate ?? '') ||
          (!fields.projectId &&
            (!fields.projectName?.trim() || fields.projectName.trim().length > 120))
        )
          return sendApiError(
            reply,
            400,
            'invalid-request',
            'Preview the archive and choose a project or project name before importing.',
          );
        const result = imports.importPlan(context, workspace.data, upload.filename, upload.bytes, {
          ...selection.data,
          archiveDigest: fields.archiveDigest as string,
          activate: fields.activate === 'true',
          ...(project?.success ? { projectId: project.data } : {}),
          ...(previous?.success ? { expectedActivePlanVersionId: previous.data } : {}),
          ...(fields.projectName ? { projectName: fields.projectName.trim() } : {}),
        });
        return noStore(reply).send(
          archivePlanImportResponseSchema.parse({
            attempt: result.attempt,
            ...('plan' in result ? { plan: importResponse(result.plan) } : {}),
          }),
        );
      },
    );
  app.post<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/concurrency-imports',
    { config: { access: 'editor' }, bodyLimit: ARCHIVE_LIMITS.maxCompressedBytes + 16384 },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      const upload = await readArchiveUpload(request);
      if (Object.keys(upload.fields).length)
        return sendApiError(
          reply,
          400,
          'invalid-request',
          'Concurrency import accepts the archive only.',
        );
      return noStore(reply).send(
        concurrencyImportResponseSchema.parse(
          imports.importConcurrency(context, workspace.data, upload.filename, upload.bytes),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string } }>(
    '/api/workspaces/:workspaceId/concurrency-imports',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        concurrencyListSchema.parse(imports.list(context, workspace.data)),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; id: string } }>(
    '/api/workspaces/:workspaceId/concurrency-definitions/:id',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        concurrencyDetailSchema.parse(imports.detail(context, workspace.data, request.params.id)),
      );
    },
  );
  app.post<{ Params: { workspaceId: string; id: string } }>(
    '/api/workspaces/:workspaceId/concurrency-definitions/:id/bindings',
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      const body = saveConcurrencyBindingsSchema.safeParse(request.body);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      if (!body.success)
        return sendApiError(reply, 400, 'invalid-request', 'Invalid binding revision.');
      return noStore(reply).send(
        concurrencyDetailSchema.parse(
          imports.saveBindings(context, workspace.data, request.params.id, body.data),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; id: string } }>(
    '/api/workspaces/:workspaceId/import-archives/:id',
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = contextOf(request);
      const workspace = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!workspace.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      const archive = imports.archiveContent(context, workspace.data, request.params.id);
      return noStore(reply)
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${archive.filename}"`)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .send(Buffer.from(archive.content));
    },
  );
}
