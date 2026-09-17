import {
  nativeAuditSchema,
  nativeApprovalRequestSchema,
  configureRuntimeSchema,
  generatePlanEvidenceRequestSchema,
  discoverRuntimeRequestSchema,
  discoverRuntimeResponseSchema,
  evidenceSubmissionRequestSchema,
  evidenceDecisionRequestSchema,
  runtimeEvidenceViewSchema,
  inspectDependencyRequestSchema,
  inspectDependencyResponseSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import type { RuntimeEvidenceService } from '../services/runtime-evidence-service.js';
import { authenticate, authorizeMutation } from './request-security.js';
import { noStore, sendApiError } from './http.js';
export function registerRuntimeEvidenceRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: RuntimeEvidenceService,
  config: ServerConfig,
) {
  const base = '/api/workspaces/:workspaceId/concurrency-definitions/:id/runtime';
  app.get<{ Params: { workspaceId: string; id: string } }>(base, async (request, reply) => {
    const context = authenticate(request, auth),
      ws = workspaceIdSchema.safeParse(request.params.workspaceId);
    if (!ws.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
    return noStore(reply).send(
      runtimeEvidenceViewSchema.parse(await service.view(context, ws.data, request.params.id)),
    );
  });
  app.get<{ Params: { workspaceId: string; id: string; runId: string } }>(
    `${base}/runs/:runId/build-record`,
    async (request, reply) => {
      const context = authenticate(request, auth),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!ws.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      const record = service.buildRecord(context, ws.data, request.params.id, request.params.runId);
      return noStore(reply)
        .header('content-type', 'application/json')
        .header('content-disposition', 'attachment; filename="build-record.json"')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .send(JSON.stringify(record));
    },
  );
  for (const action of [
    'audit-native',
    'authorize-native',
    'configure',
    'inspect',
    'discover',
    'generate-plan',
    'submit',
    'decide',
  ] as const)
    app.post<{ Params: { workspaceId: string; id: string } }>(
      `${base}/${action}`,
      { bodyLimit: 5 * 1024 * 1024 },
      async (request, reply) => {
        const context = authorizeMutation(request, auth, config),
          ws = workspaceIdSchema.safeParse(request.params.workspaceId);
        if (!ws.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
        const id = request.params.id;
        if (action === 'audit-native')
          return noStore(reply).send(
            nativeAuditSchema.parse(await service.auditNative(context, ws.data, id)),
          );
        if (action === 'authorize-native') {
          const b = nativeApprovalRequestSchema.safeParse(request.body);
          if (!b.success)
            return sendApiError(
              reply,
              400,
              'invalid-request',
              'Choose the current native audit, approval and a rationale.',
            );
          return noStore(reply).send(
            runtimeEvidenceViewSchema.parse(
              await service.approveNative(context, ws.data, id, b.data),
            ),
          );
        }
        if (action === 'generate-plan') {
          const body = generatePlanEvidenceRequestSchema.safeParse(request.body);
          if (!body.success)
            return sendApiError(
              reply,
              400,
              'invalid-request',
              'Choose the current saved roadmap revision and snapshot.',
            );
          return noStore(reply).send(
            runtimeEvidenceViewSchema.parse(
              await service.generatePlanEvidence(context, ws.data, id, body.data),
            ),
          );
        }
        if (action === 'discover') {
          const b = discoverRuntimeRequestSchema.safeParse(request.body);
          if (!b.success)
            return sendApiError(
              reply,
              400,
              'invalid-request',
              'Choose the current binding and repository refs.',
            );
          return noStore(reply).send(
            discoverRuntimeResponseSchema.parse(
              await service.discover(context, ws.data, id, b.data),
            ),
          );
        }
        if (action === 'inspect') {
          const b = inspectDependencyRequestSchema.safeParse(request.body);
          if (!b.success)
            return sendApiError(reply, 400, 'invalid-request', 'Invalid dependency inspection.');
          return noStore(reply).send(
            inspectDependencyResponseSchema.parse(
              await service.inspect(context, ws.data, id, b.data),
            ),
          );
        }
        if (action === 'configure') {
          const b = configureRuntimeSchema.safeParse(request.body);
          if (!b.success)
            return sendApiError(
              reply,
              400,
              'invalid-request',
              'Invalid runtime configuration. Check identifiers, digests and package paths.',
            );
          return noStore(reply).send(
            runtimeEvidenceViewSchema.parse(await service.configure(context, ws.data, id, b.data)),
          );
        }
        if (action === 'submit') {
          const b = evidenceSubmissionRequestSchema.safeParse(request.body);
          if (!b.success)
            return sendApiError(
              reply,
              400,
              'invalid-request',
              'Invalid evidence package. Check required fields, SHA-256 digests and the 4 MiB artifact limit.',
            );
          return noStore(reply).send(
            runtimeEvidenceViewSchema.parse(await service.submit(context, ws.data, id, b.data)),
          );
        }
        const b = evidenceDecisionRequestSchema.safeParse(request.body);
        if (!b.success)
          return sendApiError(
            reply,
            400,
            'invalid-request',
            'Choose a submission, decision and rationale.',
          );
        return noStore(reply).send(
          runtimeEvidenceViewSchema.parse(await service.decide(context, ws.data, id, b.data)),
        );
      },
    );
}
