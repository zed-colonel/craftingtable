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
  nativeAuditRequestSchema,
  upstreamTransitionRequestSchema,
  nativeAuditSchema,
  prepareCheckpointRequestSchema,
  proposeArchitectureDecisionSchema,
  runtimeEvidenceViewSchema,
  runtimeRefreshPreviewSchema,
  runtimeRefreshRequestSchema,
  workspaceIdSchema,
} from '@craftingtable/contracts';
import type { WorkspaceId } from '@craftingtable/domain';
import type { FastifyInstance } from 'fastify';
import type { RuntimeEvidenceService } from '../services/runtime-evidence-service.js';
import { noStore, sendApiError } from './http.js';
import { type BodyOf, type BodySchema, contextOf } from './route-access.js';
export function registerRuntimeEvidenceRoutes(
  app: FastifyInstance,
  service: RuntimeEvidenceService,
) {
  const base = '/api/workspaces/:workspaceId/concurrency-definitions/:id/runtime';
  app.get<{ Params: { workspaceId: string; id: string; worktreeId: string } }>(
    `${base}/checkpoint-recovery/:worktreeId`,
    { config: { access: 'editor' } },
    async (request, reply) => {
      const context = contextOf(request),
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
      const context = contextOf(request),
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
      const context = contextOf(request),
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
      const context = contextOf(request),
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
  /**
   * One route per runtime command (R-H5): its tag, its declared body and the refusal when the body
   * does not parse; the daemon parses the body before `run` reads it.
   */
  const command = <S extends BodySchema>(
    action: string,
    tag: 'decision' | 'config',
    body: S,
    invalidBody: string,
    run: (
      context: ReturnType<typeof contextOf>,
      ws: WorkspaceId,
      id: string,
      body: BodyOf<S>,
    ) => unknown,
  ) =>
    app.post<{ Params: { workspaceId: string; id: string }; Body: BodyOf<S> }>(
      `${base}/${action}`,
      { config: { access: 'editor', tag, body, invalidBody }, bodyLimit: 5 * 1024 * 1024 },
      async (request, reply) => {
        const context = contextOf(request),
          ws = workspaceIdSchema.safeParse(request.params.workspaceId);
        if (!ws.success) return sendApiError(reply, 404, 'not-found', 'Workspace not found');
        return noStore(reply).send(
          await run(context, ws.data, request.params.id, request.body as BodyOf<S>),
        );
      },
    );
  command(
    'audit-native',
    'decision',
    nativeAuditRequestSchema,
    'Invalid native audit request.',
    async (context, ws, id) => nativeAuditSchema.parse(await service.auditNative(context, ws, id)),
  );
  command(
    'authorize-native',
    'decision',
    nativeApprovalRequestSchema,
    'Choose the current native audit, approval and a rationale.',
    async (context, ws, id, body) =>
      runtimeEvidenceViewSchema.parse(await service.approveNative(context, ws, id, body)),
  );
  command(
    'declare-transitions',
    'decision',
    upstreamTransitionRequestSchema,
    'Choose the transition slices and provide a rationale.',
    async (context, ws, id, body) =>
      runtimeEvidenceViewSchema.parse(
        await service.declareUpstreamTransitions(context, ws, id, body),
      ),
  );
  command(
    'configure',
    'config',
    configureRuntimeSchema,
    'Invalid runtime configuration. Check identifiers, digests and package paths.',
    async (context, ws, id, body) =>
      runtimeEvidenceViewSchema.parse(await service.configure(context, ws, id, body)),
  );
  command(
    'preview-refresh',
    'decision',
    runtimeRefreshRequestSchema,
    'Choose the current dependency generation.',
    async (context, ws, id, body) =>
      runtimeRefreshPreviewSchema.parse(await service.previewRefresh(context, ws, id, body)),
  );
  command(
    'refresh',
    'decision',
    applyRuntimeRefreshSchema,
    'Review the dependency refresh preview and provide a rationale.',
    async (context, ws, id, body) =>
      runtimeEvidenceViewSchema.parse(await service.refresh(context, ws, id, body)),
  );
  command(
    'inspect',
    'config',
    inspectDependencyRequestSchema,
    'Invalid dependency inspection.',
    async (context, ws, id, body) =>
      inspectDependencyResponseSchema.parse(await service.inspect(context, ws, id, body)),
  );
  command(
    'discover',
    'config',
    discoverRuntimeRequestSchema,
    'Choose the current binding and repository refs.',
    async (context, ws, id, body) =>
      discoverRuntimeResponseSchema.parse(await service.discover(context, ws, id, body)),
  );
  command(
    'propose-decision',
    'decision',
    proposeArchitectureDecisionSchema,
    'Provide a complete architecture decision proposal.',
    async (context, ws, id, body) =>
      runtimeEvidenceViewSchema.parse(
        await service.proposeArchitectureDecision(context, ws, id, body),
      ),
  );
  command(
    'generate-plan',
    'decision',
    generatePlanEvidenceRequestSchema,
    'Choose the current saved roadmap revision and snapshot.',
    async (context, ws, id, body) =>
      runtimeEvidenceViewSchema.parse(await service.generatePlanEvidence(context, ws, id, body)),
  );
  command(
    'prepare-checkpoint',
    'decision',
    prepareCheckpointRequestSchema,
    'Select the exact checkpoint candidate preview.',
    async (context, ws, id, body) =>
      checkpointRecoverySchema.parse(await service.prepareCheckpoint(context, ws, id, body)),
  );
  command(
    'submit',
    'decision',
    evidenceSubmissionRequestSchema,
    'Invalid evidence package. Check required fields, SHA-256 digests and the 4 MiB artifact limit.',
    async (context, ws, id, body) =>
      runtimeEvidenceViewSchema.parse(await service.submit(context, ws, id, body)),
  );
  command(
    'decide',
    'decision',
    evidenceDecisionRequestSchema,
    'Choose a submission, decision and rationale.',
    async (context, ws, id, body) =>
      runtimeEvidenceViewSchema.parse(await service.decide(context, ws, id, body)),
  );
}
