import { phaseBlockerSchema } from './execution-scope.js';
import { executionScopeSchema } from './execution-scope.js';
import {
  AGENT_BACKENDS,
  AGENT_PERMISSION_MODES,
  CYCLE_STATUSES,
  CYCLE_STEPS,
} from '@craftingtable/domain';
import { z } from 'zod';
import { finalizationProgressSchema } from './finalization-progress.js';
import {
  agentRunIdSchema,
  planArtifactIdSchema,
  planVersionIdSchema,
  projectIdSchema,
  userIdSchema,
  workItemIdSchema,
  workspaceIdSchema,
  worktreeIdSchema,
} from './ids.js';
import { reviewFindingSchema } from './review.js';

export const completionPolicySchema = z.strictObject({
  maxNits: z.number().int().min(0).max(100),
  maxRemediationRounds: z.number().int().min(0).max(20),
  maxRunMinutes: z.number().int().min(1).max(1440),
});
const cycleProfileSchema = z.strictObject({
  backend: z.enum(AGENT_BACKENDS),
  permissionMode: z.enum(AGENT_PERMISSION_MODES),
  model: z.string().trim().min(1).max(100).optional(),
});
export const finalizationAgentSelectionSchema = cycleProfileSchema.pick({
  backend: true,
  model: true,
});
export const cycleProfilesSchema = z.strictObject({
  design: cycleProfileSchema,
  implement: cycleProfileSchema,
  review: cycleProfileSchema,
  remediate: cycleProfileSchema,
});
export const startWorkCycleRequestSchema = z.strictObject({
  worktreeId: worktreeIdSchema,
  policy: completionPolicySchema,
  profiles: cycleProfilesSchema,
  instructions: z.string().max(16000).default(''),
});
const commitShaSchema = z.string().regex(/^[0-9a-f]{40,64}$/);
export const integrationResolutionSchema = z.strictObject({
  runIds: z.array(agentRunIdSchema).max(3).optional(),
  id: z.string().uuid(),
  status: z.enum(['detected', 'preparing', 'resolving', 'committing', 'completed', 'abandoned']),
  headSha: commitShaSchema,
  targetSha: commitShaSchema,
  targetBranch: z.string().min(1).max(1024),
  paths: z.array(z.string().min(1)).max(1000),
  diagnostics: z.string().max(12000),
  createdAt: z.iso.datetime(),
  attempts: z.number().int().min(0).max(3),
  profile: cycleProfileSchema.optional(),
  instructions: z.string().max(16000).optional(),
  treeSha: commitShaSchema.optional(),
  commitSha: commitShaSchema.optional(),
});
export const integrationResolutionRequestSchema = z.strictObject({
  action: z.enum(['inspect', 'start', 'resume', 'abandon']),
  expectedVersion: z.number().int().positive(),
  profile: cycleProfileSchema.optional(),
  instructions: z.string().max(16000).optional(),
});
export type IntegrationResolutionRequest = z.infer<typeof integrationResolutionRequestSchema>;
export const designRecoverySourceSchema = z.strictObject({
  planVersionId: planVersionIdSchema,
  artifactId: planArtifactIdSchema.optional(),
  archiveId: z.string().uuid().optional(),
  archiveDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  name: z.string().min(1).max(500),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
const designAttachmentSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  content: z.string().min(1).max(64000),
});
export const recoverDesignRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
  mode: z.enum(['investigate', 'continue']),
  profile: finalizationAgentSelectionSchema,
  instructions: z.string().max(16000).default(''),
  attachments: z.array(designAttachmentSchema).max(4).default([]),
});
export type RecoverDesignRequest = z.infer<typeof recoverDesignRequestSchema>;
export const designRecoveryPreviewSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  sourceRunId: agentRunIdSchema,
  questions: z.string(),
  facts: z.string(),
  snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
  sources: z
    .array(
      z.strictObject({
        source: designRecoverySourceSchema,
        content: z.string(),
      }),
    )
    .max(32),
  notices: z.array(z.string()),
});
export type DesignRecoveryPreview = z.infer<typeof designRecoveryPreviewSchema>;
export const workCycleSchema = z
  .strictObject({
    designRecovery: z
      .strictObject({
        runId: agentRunIdSchema,
        sourceRunId: agentRunIdSchema,
        mode: z.enum(['investigate', 'continue']),
        profile: finalizationAgentSelectionSchema,
        instructions: z.string().max(16000),
        snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
        facts: z.string().max(128000),
        sources: z.array(designRecoverySourceSchema).max(32),
        attachments: z.array(designAttachmentSchema).max(4),
      })
      .optional(),
    executionScope: executionScopeSchema.optional(),
    id: z.string().uuid(),
    workspaceId: workspaceIdSchema,
    workItemId: workItemIdSchema.optional(),
    finalizationId: z.string().uuid().optional(),
    finalizationProgress: finalizationProgressSchema.optional(),
    planVersionId: planVersionIdSchema.optional(),
    polishRound: z.number().int().min(0).max(10).optional(),
    polishPhase: z.enum(['assess', 'polish', 'verify', 'final-review']).optional(),
    workItemSourceId: z.string().min(1).max(64),
    workItemTitle: z.string().min(1).max(500),
    projectId: projectIdSchema,
    worktreeId: worktreeIdSchema,
    createdByUserId: userIdSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    version: z.number().int().positive(),
    status: z.enum(CYCLE_STATUSES),
    step: z.enum(CYCLE_STEPS),
    policy: completionPolicySchema,
    profiles: cycleProfilesSchema,
    instructions: z.string().max(16000),
    currentRunId: agentRunIdSchema,
    parentRunId: agentRunIdSchema.optional(),
    runDeadlineAt: z.iso.datetime(),
    phaseWait: z
      .strictObject({ startedAt: z.iso.datetime(), blockers: z.array(phaseBlockerSchema) })
      .nullable()
      .optional(),
    resultContinuations: z.number().int().min(0).max(2).optional(),
    remediationRounds: z.number().int().nonnegative(),
    additionalRemediationRounds: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER - 20)
      .optional(),
    deferredNits: z
      .array(
        z.strictObject({
          finding: reviewFindingSchema,
          sourceRunId: agentRunIdSchema,
          headSha: commitShaSchema,
          targetSha: commitShaSchema,
          reason: z.string().trim().min(1).max(4000),
          createdAt: z.iso.datetime(),
          createdByUserId: userIdSchema,
        }),
      )
      .max(100)
      .optional(),
    finalizationAgentOverride: finalizationAgentSelectionSchema.nullable().optional(),
    findingFocus: z.array(z.string().min(1).max(64)).max(100).optional(),
    stalledReviews: z.number().int().nonnegative(),
    previousFindingFingerprint: z.string().max(128).optional(),
    reviewHeadSha: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/)
      .optional(),
    housekeepingInstructions: z.string().max(16000).optional(),
    checkpoint: z
      .strictObject({
        sourceRunId: agentRunIdSchema,
        previousHeadSha: z.string().regex(/^[0-9a-f]{40,64}$/),
        fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
        paths: z.array(z.string()).max(1000),
        createdAt: z.iso.datetime(),
        commitSha: z
          .string()
          .regex(/^[0-9a-f]{40,64}$/)
          .optional(),
      })
      .optional(),
    integrationResolution: integrationResolutionSchema.optional(),
    integrationRefreshes: z.number().int().nonnegative().optional(),
    reason: z.string().max(4000),
  })
  .refine(
    (cycle) =>
      cycle.workItemId !== undefined
        ? cycle.planVersionId === undefined &&
          cycle.finalizationId === undefined &&
          cycle.additionalRemediationRounds === undefined &&
          cycle.deferredNits === undefined &&
          cycle.findingFocus === undefined &&
          cycle.finalizationAgentOverride === undefined &&
          cycle.finalizationProgress === undefined
        : cycle.planVersionId !== undefined && cycle.finalizationId !== undefined,
    { message: 'A cycle requires a work item or an explicit plan finalization subject' },
  );
export const workCyclesResponseSchema = z.strictObject({ cycles: z.array(workCycleSchema) });
export const workCycleResponseSchema = z.strictObject({ cycle: workCycleSchema });
export const controlWorkCycleRequestSchema = z.strictObject({
  action: z.enum(['pause', 'resume', 'stop']),
  expectedVersion: z.number().int().positive(),
});
export type StartWorkCycleRequest = z.infer<typeof startWorkCycleRequestSchema>;
