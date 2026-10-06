import {
  AGENT_BACKENDS,
  AGENT_PERMISSION_MODES,
  CYCLE_ACTIONS,
  CYCLE_ATTENTION_CODES,
  CYCLE_STATUSES,
  CYCLE_STEPS,
  type CycleAttentionCode,
  type CycleProjection,
  INVESTIGATION_WORKTREE_PARTS,
  type InvestigationWorktreePart,
  OUTPUT_REPAIR_LIMIT,
} from '@craftingtable/domain';
import { z } from 'zod';
import {
  agentSelectionsSchema,
  reasoningEffortSchema,
  specialistSelectionsShape,
} from './agent-profiles.js';
import { cycleAttentionSchema } from './attention.js';
import { designDependencySchema, designReportSchema } from './design-report.js';
import { investigationFindingSchema } from './investigation-report.js';
import { executionScopeSchema, phaseBlockerSchema } from './execution-scope.js';
import { finalizationProgressSchema } from './finalization-progress.js';
import {
  agentRunIdSchema,
  planArtifactIdSchema,
  planVersionIdSchema,
  projectIdSchema,
  sourceRepositoryIdSchema,
  userIdSchema,
  workItemIdSchema,
  workspaceIdSchema,
  worktreeIdSchema,
} from './ids.js';
import { providerFailureSchema } from './provider-failure.js';
import { reviewFindingSchema } from './review.js';
import { architectureDecisionInboxSchema } from './runtime-evidence.js';
import { equivalentSchema } from './type-equivalence.js';
import { cycleWorkflowSchema, workflowQuestionSchema } from './workflow.js';

export const completionPolicySchema = z.strictObject({
  maxNits: z.number().int().min(0).max(100),
  maxRemediationRounds: z.number().int().min(0).max(20),
  maxRunMinutes: z.number().int().min(1).max(1440),
});
const cycleProfileSchema = z.strictObject({
  reasoningEffort: reasoningEffortSchema.optional(),
  backend: z.enum(AGENT_BACKENDS),
  permissionMode: z.enum(AGENT_PERMISSION_MODES),
  model: z.string().trim().min(1).max(100).optional(),
});
export const finalizationAgentSelectionSchema = cycleProfileSchema.pick({
  backend: true,
  model: true,
  reasoningEffort: true,
});
export const cycleProfilesSchema = z.strictObject({
  ...specialistSelectionsShape,
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
/**
 * Start a read-only investigation of a question stop (R-C16). The profile defaults to the
 * cycle's Evidence investigation profile, the limit to 30 minutes.
 */
export const startInvestigationRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  instructions: z.string().max(8000).default(''),
  minutes: z.number().int().min(5).max(60).default(30),
  profile: finalizationAgentSelectionSchema.optional(),
});
export type StartInvestigationRequest = z.infer<typeof startInvestigationRequestSchema>;
export const endInvestigationRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
});
/** Acknowledge that the worktree changed while the stop's investigation ran (R-C16). */
export const acknowledgeInvestigationChangeRequestSchema = endInvestigationRequestSchema;
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitObjectSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
/** The worktree an investigation recorded at its start (R-C16). */
const investigationWorktreeSchema = z.strictObject({
  headSha: gitObjectSchema,
  branch: z.string().max(1000),
  fingerprint: sha256Schema,
  trackedClean: z.boolean(),
  untrackedDigest: sha256Schema,
  ignoredDigest: sha256Schema,
  gitDigest: sha256Schema,
  metadataOnly: z.number().int().positive().optional(),
});
const investigationWorktreeChangeSchema = z.strictObject({
  parts: z
    .array(
      z.enum(
        INVESTIGATION_WORKTREE_PARTS as unknown as [
          InvestigationWorktreePart,
          ...InvestigationWorktreePart[],
        ],
      ),
    )
    .min(1)
    .max(INVESTIGATION_WORKTREE_PARTS.length),
  headBefore: gitObjectSchema,
  headAfter: gitObjectSchema.optional(),
  paths: z.array(z.string().max(4096)).max(20),
});
export const designRecoveryPreviewSchema = z.strictObject({
  decisionInbox: architectureDecisionInboxSchema.optional(),
  expectedVersion: z.number().int().positive(),
  sourceRunId: agentRunIdSchema,
  classifications: designReportSchema.optional(),
  classificationIssue: z.string().optional(),
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
const baselineRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((v) => !v.includes('..') && !v.endsWith('/') && !v.endsWith('.lock'));
export const baselineSourceSchema = z.strictObject({
  alias: z.string().min(1).max(100),
  repositoryId: sourceRepositoryIdSchema,
  directoryName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
  commitSha: commitShaSchema,
  tag: baselineRefSchema.optional(),
});
export const baselinePreparationSchema = z.strictObject({
  id: z.string().uuid(),
  contextDigest: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.iso.datetime(),
  createdByUserId: userIdSchema,
  status: z.enum(['preparing', 'prepared', 'failed']),
  directory: z.string(),
  consumerAlias: z.string(),
  sources: z.array(baselineSourceSchema).min(1).max(8),
  message: z.string(),
});
export const baselinePreviewSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  contextDigest: z.string().regex(/^[0-9a-f]{64}$/),
  consumerAlias: z.string(),
  sources: z
    .array(
      z.strictObject({
        alias: z.string(),
        repositoryId: sourceRepositoryIdSchema,
        directoryName: z.string(),
        ref: z.string(),
        tag: z.string(),
        explanation: z.string(),
        fixed: z.boolean(),
      }),
    )
    .max(8),
  notices: z.array(z.string()),
});
export const baselineEvidenceSchema = z.strictObject({
  artifacts: z
    .array(
      z.strictObject({
        runId: z.string(),
        name: z.string(),
        content: z.string(),
        truncated: z.boolean(),
      }),
    )
    .max(32),
  notice: z.string(),
});
export const prepareBaselineRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  contextDigest: z.string().regex(/^[0-9a-f]{64}$/),
  sources: z
    .array(
      z.strictObject({
        alias: z.string().min(1).max(100),
        ref: baselineRefSchema,
        tag: baselineRefSchema.optional(),
      }),
    )
    .min(1)
    .max(8),
});
export type BaselinePreview = z.infer<typeof baselinePreviewSchema>;
export type PrepareBaselineRequest = z.infer<typeof prepareBaselineRequestSchema>;
export const workCycleSchema = z
  .strictObject({
    owner: z
      .strictObject({
        roadmapId: z.uuid(),
        attemptId: z.uuid(),
        entryId: z.string().min(1),
        definitionRevision: z.number().int().positive(),
      })
      .nullable()
      .optional(),
    scopeRepair: z
      .strictObject({
        sourceCycleId: z.uuid(),
        sources: z
          .array(
            z.strictObject({
              runId: agentRunIdSchema,
              sequence: z.number().int().positive(),
              label: z.string().regex(/^R([1-9]|1[0-9]|20)$/),
            }),
          )
          .min(1)
          .max(20),
      })
      .optional(),
    baselinePreparation: baselinePreparationSchema.optional(),
    designRecovery: z
      .strictObject({
        runId: agentRunIdSchema,
        sourceRunId: agentRunIdSchema,
        mode: z.enum(['investigate', 'continue']),
        automatic: z.literal(true).optional(),
        profile: finalizationAgentSelectionSchema,
        instructions: z.string().max(16000),
        snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
        facts: z.string().max(128000),
        sources: z.array(designRecoverySourceSchema).max(32),
        attachments: z.array(designAttachmentSchema).max(4),
      })
      .optional(),
    investigation: z
      .strictObject({
        id: z.uuid(),
        runId: agentRunIdSchema,
        sourceRunId: agentRunIdSchema,
        code: z.enum(CYCLE_ATTENTION_CODES as [CycleAttentionCode, ...CycleAttentionCode[]]),
        questionsDigest: z.string().regex(/^[0-9a-f]{64}$/),
        profile: finalizationAgentSelectionSchema,
        instructions: z.string().max(8000),
        minutes: z.number().int().min(5).max(60),
        deadlineAt: z.iso.datetime(),
        startedAt: z.iso.datetime(),
        startedByUserId: userIdSchema,
        worktree: investigationWorktreeSchema.optional(),
        endRequestedAt: z.iso.datetime().optional(),
        endRequestedByUserId: userIdSchema.optional(),
        result: z
          .strictObject({
            endedAt: z.iso.datetime(),
            outcome: z.enum(['finished', 'failed', 'cancelled', 'interrupted']),
            code: z.literal('worktree-changed').optional(),
            worktreeChange: investigationWorktreeChangeSchema.optional(),
            acknowledgedAt: z.iso.datetime().optional(),
            acknowledgedByUserId: userIdSchema.optional(),
            restoredAt: z.iso.datetime().optional(),
            message: z.string().max(4000).optional(),
            findings: z.array(investigationFindingSchema).max(40).optional(),
          })
          // A worktree change is a failed investigation that says what changed, and an
          // acknowledgement names who gave it (R-C16 review).
          .refine(
            (r) =>
              (r.code === undefined) === (r.worktreeChange === undefined) &&
              (r.code === undefined || r.outcome === 'failed') &&
              (r.acknowledgedAt === undefined) === (r.acknowledgedByUserId === undefined) &&
              (r.code !== undefined ||
                (r.acknowledgedAt === undefined && r.restoredAt === undefined)),
            { message: 'An investigation result holds a worktree change only as a whole.' },
          )
          .optional(),
      })
      .optional(),
    workflow: cycleWorkflowSchema.optional(),
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
    designWait: z
      .object({
        startedAt: z.iso.datetime(),
        requirements: z.array(designDependencySchema).min(1).max(40),
      })
      .nullable()
      .optional(),
    designDependencyContinuations: z.number().int().min(0).max(2).optional(),
    resultContinuations: z.number().int().min(0).max(2).optional(),
    outputRepair: z
      .strictObject({
        attempts: z.number().int().min(1).max(OUTPUT_REPAIR_LIMIT),
        sourceRunId: agentRunIdSchema,
        code: z.enum(CYCLE_ATTENTION_CODES as [CycleAttentionCode, ...CycleAttentionCode[]]),
        issues: z.array(z.string().max(1000)).min(1).max(20),
      })
      .nullable()
      .optional(),
    providerRecovery: z
      .strictObject({
        attempts: z.number().int().min(0).max(3),
        sourceRunId: agentRunIdSchema,
        failure: providerFailureSchema,
        profile: cycleProfileSchema,
        nextRetryAt: z.iso.datetime().optional(),
      })
      .nullable()
      .optional(),
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
    stepGuidance: z.string().max(16000).optional(),
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
    attention: cycleAttentionSchema.optional(),
  })
  .refine(
    (cycle) =>
      cycle.workItemId !== undefined
        ? cycle.planVersionId === undefined &&
          cycle.finalizationId === undefined &&
          cycle.deferredNits === undefined &&
          cycle.findingFocus === undefined &&
          cycle.finalizationAgentOverride === undefined &&
          cycle.finalizationProgress === undefined
        : cycle.planVersionId !== undefined && cycle.finalizationId !== undefined,
    { message: 'A cycle requires a work item or an explicit plan finalization subject' },
  );
/** What the daemon derives for a cycle on each read (CTRL-22, R-D5); never stored. */
export const cycleProjectionSchema = equivalentSchema<CycleProjection>()(
  z.strictObject({
    nextAgentSelections: agentSelectionsSchema,
    actions: z.array(z.enum(CYCLE_ACTIONS)),
    unsettledDecisions: z.array(z.string().min(1).max(200)).max(200).optional(),
    scopeReviewWait: z.string().optional(),
    mergeRequirementsWait: z.string().optional(),
    questionRoutes: z.array(workflowQuestionSchema).max(40).optional(),
  }),
);
/** A cycle as reads and commands return it: the stored record beside its projection. */
export const cycleViewSchema = z.strictObject({
  cycle: workCycleSchema,
  projection: cycleProjectionSchema,
});
export const workCyclesResponseSchema = z.strictObject({ cycles: z.array(cycleViewSchema) });
export const workCycleResponseSchema = cycleViewSchema;
export const scopeRepairPreviewSchema = z.strictObject({
  cycleVersion: z.number().int().positive(),
  snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
  candidates: z.array(
    z.strictObject({
      scope: executionScopeSchema,
      title: z.string(),
      blockers: z.array(z.string()),
      profiles: cycleProfilesSchema.optional(),
      policy: completionPolicySchema.optional(),
      worktreeId: worktreeIdSchema.optional(),
      cycleId: z.uuid().optional(),
    }),
  ),
  sources: z.array(
    z.strictObject({
      runId: agentRunIdSchema,
      sequence: z.number().int().positive(),
      label: z.string(),
      scope: executionScopeSchema,
      findings: z.array(reviewFindingSchema.safeExtend({ originalId: z.string() })),
    }),
  ),
});
export const scopeRepairRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
  sourceId: z.string().min(1).max(200),
  instructions: z.string().trim().max(16000).default(''),
  maxRemediationRounds: z.number().int().min(1).max(20),
});
export type ScopeRepairRequest = z.infer<typeof scopeRepairRequestSchema>;
export type ScopeRepairPreview = z.infer<typeof scopeRepairPreviewSchema>;
export const controlWorkCycleRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.enum(['pause', 'stop', 'retry-provider']),
    expectedVersion: z.number().int().positive(),
  }),
  z.strictObject({
    action: z.literal('resume'),
    expectedVersion: z.number().int().positive(),
    instructions: z.string().trim().max(16000).optional(),
  }),
  z.strictObject({
    action: z.literal('review-again'),
    expectedVersion: z.number().int().positive(),
    instructions: z.string().trim().max(16000).optional(),
  }),
  z.strictObject({
    action: z.literal('authorize-remediation'),
    expectedVersion: z.number().int().positive(),
    additionalRounds: z.number().int().min(1).max(20),
    instructions: z.string().trim().max(16000).default(''),
  }),
]);
export type AuthorizeWorkCycleRemediationRequest = Extract<
  z.infer<typeof controlWorkCycleRequestSchema>,
  { action: 'authorize-remediation' }
>;
export type StartWorkCycleRequest = z.infer<typeof startWorkCycleRequestSchema>;
