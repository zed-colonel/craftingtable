import {
  applyRuntimeRefreshSchema,
  checkpointRecoverySchema,
  configureRuntimeSchema,
  discoverRuntimeRequestSchema,
  discoverRuntimeResponseSchema,
  evidenceDecisionRequestSchema,
  evidenceSubmissionSchema,
  evidenceSubmissionRequestSchema,
  generatePlanEvidenceRequestSchema,
  inspectDependencyRequestSchema,
  inspectDependencyResponseSchema,
  nativeApprovalRequestSchema,
  upstreamTransitionRequestSchema,
  nativeAuditSchema,
  prepareCheckpointRequestSchema,
  proposeArchitectureDecisionSchema,
  runtimeEvidenceViewSchema,
  runtimeRefreshPreviewSchema,
  runtimeRefreshRequestSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { FastifyInstance } from 'fastify';
import type { ServerConfig } from '../config.js';
import type { AuthService } from '../services/auth-service.js';
import type { RuntimeEvidenceService } from '../services/runtime-evidence-service.js';
import { noStore, sendApiError } from './http.js';
import { authenticate, authorizeMutation } from './request-security.js';
export function registerRuntimeEvidenceRoutes(
  app: FastifyInstance,
  auth: AuthService,
  service: RuntimeEvidenceService,
  config: ServerConfig,
) {
  const base = '/api/workspaces/:workspaceId/concurrency-definitions/:id/runtime';
  app.get<{ Params: { workspaceId: string; id: string; worktreeId: string } }>(
    `${base}/checkpoint-recovery/:worktreeId`,
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = authenticate(request, auth),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!ws.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        checkpointRecoverySchema.parse(
          await service.checkpointRecovery(
            context,
            ws.data,
            request.params.id,
            request.params.worktreeId,
          ),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; id: string } }>(
    base,
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, auth),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!ws.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        runtimeEvidenceViewSchema.parse(await service.view(context, ws.data, request.params.id)),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; id: string; submissionId: string } }>(
    `${base}/submissions/:submissionId`,
    { config: { access: 'member' } },
    async (request, reply) => {
      const context = authenticate(request, auth),
        ws = workspaceIdSchema.safeParse(request.params.workspaceId);
      if (!ws.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
      return noStore(reply).send(
        evidenceSubmissionSchema.parse(
          service.submission(context, ws.data, request.params.id, request.params.submissionId),
        ),
      );
    },
  );
  app.get<{ Params: { workspaceId: string; id: string; runId: string } }>(
    `${base}/runs/:runId/build-record`,
    { config: { access: 'member' } },
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
    'declare-transitions',
    'configure',
    'preview-refresh',
    'refresh',
    'inspect',
    'discover',
    'propose-decision',
    'generate-plan',
    'prepare-checkpoint',
    'submit',
    'decide',
  ] as const)
    app.post<{ Params: { workspaceId: string; id: string } }>(
      `${base}/${action}`,
      { config: { access: 'editor' }, bodyLimit: 5 * 1024 * 1024 },
      async (request, reply) => {
        const context = authorizeMutation(request, auth, config),
          ws = workspaceIdSchema.safeParse(request.params.workspaceId);
        if (!ws.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
        const id = request.params.id;
        if (action === 'prepare-checkpoint') {
          const body = prepareCheckpointRequestSchema.safeParse(request.body);
          if (!body.success)
            return sendApiError(
              reply,
              400,
              'invalid-request',
              'Select the exact checkpoint candidate preview.',
            );
          return noStore(reply).send(
            checkpointRecoverySchema.parse(
              await service.prepareCheckpoint(context, ws.data, id, body.data),
            ),
          );
        }
        if (action === 'propose-decision') {
          const body = proposeArchitectureDecisionSchema.safeParse(request.body);
          if (!body.success)
            return sendApiError(
              reply,
              400,
              'invalid-request',
              'Provide a complete architecture decision proposal.',
            );
          return noStore(reply).send(
            runtimeEvidenceViewSchema.parse(
              await service.proposeArchitectureDecision(context, ws.data, id, body.data),
            ),
          );
        }
        if (action === 'preview-refresh') {
          const b = runtimeRefreshRequestSchema.safeParse(request.body);
          if (!b.success)
            return sendApiError(
              reply,
              400,
              'invalid-request',
              'Choose the current dependency generation.',
            );
          return noStore(reply).send(
            runtimeRefreshPreviewSchema.parse(
              await service.previewRefresh(context, ws.data, id, b.data),
            ),
          );
        }
        if (action === 'refresh') {
          const b = applyRuntimeRefreshSchema.safeParse(request.body);
          if (!b.success)
            return sendApiError(
              reply,
              400,
              'invalid-request',
              'Review the dependency refresh preview and provide a rationale.',
            );
          return noStore(reply).send(
            runtimeEvidenceViewSchema.parse(await service.refresh(context, ws.data, id, b.data)),
          );
        }
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
        if (action === 'declare-transitions') {
          const b = upstreamTransitionRequestSchema.safeParse(request.body);
          if (!b.success)
            return sendApiError(
              reply,
              400,
              'invalid-request',
              'Choose the transition slices and provide a rationale.',
            );
          return noStore(reply).send(
            runtimeEvidenceViewSchema.parse(
              await service.declareUpstreamTransitions(context, ws.data, id, b.data),
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
