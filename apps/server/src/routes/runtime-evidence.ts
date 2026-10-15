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
  evidenceSubmissionIdLookupSchema,
  worktreeIdLookupSchema,
  concurrencyDefinitionIdLookupSchema,
  agentRunIdLookupSchema,
} from '@craftingtable/contracts';
import type { ConcurrencyDefinitionId, WorkspaceId } from '@craftingtable/domain';
import type { FastifyInstance } from 'fastify';
import type { RuntimeEvidenceService } from '../services/runtime-evidence-service.js';
import { noStore } from './http.js';
import {
  type BodyOf,
  type BodySchema,
  contextOf,
  paramsOf,
  workspaceParams,
} from './route-access.js';

/** Each route's path parameters (R-H7). */
const DEFINITION = workspaceParams({ id: concurrencyDefinitionIdLookupSchema });
const DEFINITION_WORKTREE = workspaceParams({
  id: concurrencyDefinitionIdLookupSchema,
  worktreeId: worktreeIdLookupSchema,
});
const DEFINITION_SUBMISSION = workspaceParams({
  id: concurrencyDefinitionIdLookupSchema,
  submissionId: evidenceSubmissionIdLookupSchema,
});
const DEFINITION_RUN = workspaceParams({
  id: concurrencyDefinitionIdLookupSchema,
  runId: agentRunIdLookupSchema,
});
export function registerRuntimeEvidenceRoutes(
  app: FastifyInstance,
  service: RuntimeEvidenceService,
) {
  const base = '/api/workspaces/:workspaceId/concurrency-definitions/:id/runtime';
  app.get(
    `${base}/checkpoint-recovery/:worktreeId`,
    { config: { access: 'editor', params: DEFINITION_WORKTREE } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, id, worktreeId } = paramsOf(request, DEFINITION_WORKTREE);
      return noStore(reply).send(
        checkpointRecoverySchema.parse(
          await service.checkpointRecovery(context, workspaceId, id, worktreeId),
        ),
      );
    },
  );
  app.get(base, { config: { access: 'member', params: DEFINITION } }, async (request, reply) => {
    const context = contextOf(request);
    const { workspaceId, id } = paramsOf(request, DEFINITION);
    return noStore(reply).send(
      runtimeEvidenceViewSchema.parse(await service.view(context, workspaceId, id)),
    );
  });
  app.get(
    `${base}/submissions/:submissionId`,
    { config: { access: 'member', params: DEFINITION_SUBMISSION } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, id, submissionId } = paramsOf(request, DEFINITION_SUBMISSION);
      return noStore(reply).send(
        evidenceSubmissionSchema.parse(service.submission(context, workspaceId, id, submissionId)),
      );
    },
  );
  app.get(
    `${base}/runs/:runId/build-record`,
    { config: { access: 'member', params: DEFINITION_RUN } },
    async (request, reply) => {
      const context = contextOf(request);
      const { workspaceId, id, runId } = paramsOf(request, DEFINITION_RUN);
      const record = service.buildRecord(context, workspaceId, id, runId);
      return noStore(reply)
        .header('content-type', 'application/json')
        .header('content-disposition', 'attachment; filename="build-record.json"')
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .send(JSON.stringify(record));
    },
  );
  for (const c of runtimeCommands(service))
    app.post(
      `${base}/${c.action}`,
      {
        config: {
          access: 'editor',
          params: DEFINITION,
          tag: c.tag,
          body: c.body,
          invalidBody: c.invalidBody,
        },
        bodyLimit: 5 * 1024 * 1024,
      },
      async (request, reply) => {
        const context = contextOf(request);
        const { workspaceId, id } = paramsOf(request, DEFINITION);
        return noStore(reply).send(await c.run(context, workspaceId, id, request.body));
      },
    );
}

/** A runtime command: its route's last segment, tag, body and refusal, and what it runs (R-H5). */
export interface RuntimeCommand {
  readonly action: string;
  readonly tag: 'decision' | 'config';
  readonly body: BodySchema;
  readonly invalidBody: string;
  readonly run: (
    context: ReturnType<typeof contextOf>,
    ws: WorkspaceId,
    id: ConcurrencyDefinitionId,
    body: unknown,
  ) => Promise<unknown>;
}

/**
 * One route per runtime command (R-H5), without the loop-and-if chain: each has its tag, its
 * declared body and the refusal when the body does not parse; the daemon parses the body before
 * `run` reads it.
 */
export function runtimeCommands(service: RuntimeEvidenceService): readonly RuntimeCommand[] {
  const command = <S extends BodySchema>(
    action: string,
    tag: 'decision' | 'config',
    body: S,
    invalidBody: string,
    run: (
      context: ReturnType<typeof contextOf>,
      ws: WorkspaceId,
      id: ConcurrencyDefinitionId,
      body: BodyOf<S>,
    ) => Promise<unknown>,
  ): RuntimeCommand => ({
    action,
    tag,
    body,
    invalidBody,
    run: (context, ws, id, parsed) => run(context, ws, id, parsed as BodyOf<S>),
  });
  return [
    command(
      'audit-native',
      'decision',
      nativeAuditRequestSchema,
      'Invalid native audit request.',
      async (context, ws, id) =>
        nativeAuditSchema.parse(await service.auditNative(context, ws, id)),
    ),
    command(
      'authorize-native',
      'decision',
      nativeApprovalRequestSchema,
      'Choose the current native audit, approval and a rationale.',
      async (context, ws, id, body) =>
        runtimeEvidenceViewSchema.parse(await service.approveNative(context, ws, id, body)),
    ),
    command(
      'declare-transitions',
      'decision',
      upstreamTransitionRequestSchema,
      'Choose the transition slices and provide a rationale.',
      async (context, ws, id, body) =>
        runtimeEvidenceViewSchema.parse(
          await service.declareUpstreamTransitions(context, ws, id, body),
        ),
    ),
    command(
      'configure',
      'config',
      configureRuntimeSchema,
      'Invalid runtime configuration. Check identifiers, digests and package paths.',
      async (context, ws, id, body) =>
        runtimeEvidenceViewSchema.parse(await service.configure(context, ws, id, body)),
    ),
    command(
      'preview-refresh',
      'decision',
      runtimeRefreshRequestSchema,
      'Choose the current dependency generation.',
      async (context, ws, id, body) =>
        runtimeRefreshPreviewSchema.parse(await service.previewRefresh(context, ws, id, body)),
    ),
    command(
      'refresh',
      'decision',
      applyRuntimeRefreshSchema,
      'Review the dependency refresh preview and provide a rationale.',
      async (context, ws, id, body) =>
        runtimeEvidenceViewSchema.parse(await service.refresh(context, ws, id, body)),
    ),
    command(
      'inspect',
      'config',
      inspectDependencyRequestSchema,
      'Invalid dependency inspection.',
      async (context, ws, id, body) =>
        inspectDependencyResponseSchema.parse(await service.inspect(context, ws, id, body)),
    ),
    command(
      'discover',
      'config',
      discoverRuntimeRequestSchema,
      'Choose the current binding and repository refs.',
      async (context, ws, id, body) =>
        discoverRuntimeResponseSchema.parse(await service.discover(context, ws, id, body)),
    ),
    command(
      'propose-decision',
      'decision',
      proposeArchitectureDecisionSchema,
      'Provide a complete architecture decision proposal.',
      async (context, ws, id, body) =>
        runtimeEvidenceViewSchema.parse(
          await service.proposeArchitectureDecision(context, ws, id, body),
        ),
    ),
    command(
      'generate-plan',
      'decision',
      generatePlanEvidenceRequestSchema,
      'Choose the current saved roadmap revision and snapshot.',
      async (context, ws, id, body) =>
        runtimeEvidenceViewSchema.parse(await service.generatePlanEvidence(context, ws, id, body)),
    ),
    command(
      'prepare-checkpoint',
      'decision',
      prepareCheckpointRequestSchema,
      'Select the exact checkpoint candidate preview.',
      async (context, ws, id, body) =>
        checkpointRecoverySchema.parse(await service.prepareCheckpoint(context, ws, id, body)),
    ),
    command(
      'submit',
      'decision',
      evidenceSubmissionRequestSchema,
      'Invalid evidence package. Check required fields, SHA-256 digests and the 4 MiB artifact limit.',
      async (context, ws, id, body) =>
        runtimeEvidenceViewSchema.parse(await service.submit(context, ws, id, body)),
    ),
    command(
      'decide',
      'decision',
      evidenceDecisionRequestSchema,
      'Choose a submission, decision and rationale.',
      async (context, ws, id, body) =>
        runtimeEvidenceViewSchema.parse(await service.decide(context, ws, id, body)),
    ),
  ];
}
