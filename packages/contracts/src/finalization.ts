import { FINALIZATION_DECISIONS, FINALIZATION_STAGE_KINDS } from '@craftingtable/domain';
import { z } from 'zod';
import {
  agentRunSummarySchema,
  gitBranchNameSchema,
  gitShaSchema,
  worktreeSummarySchema,
} from './execution.js';
import {
  planVersionIdSchema,
  projectIdSchema,
  sourceRepositoryIdSchema,
  userIdSchema,
  workspaceIdSchema,
  worktreeIdSchema,
} from './ids.js';
import { reviewFindingSchema } from './review.js';
import {
  completionPolicySchema,
  cycleProfilesSchema,
  finalizationAgentSelectionSchema,
  workCycleSchema,
} from './work-cycle.js';

const profile = cycleProfilesSchema.shape.review;
export const finalizationStageSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  kind: z.enum(FINALIZATION_STAGE_KINDS),
  name: z.string().trim().min(1).max(200),
  workItemSourceIds: z.array(z.string().min(1).max(64)).max(2000),
  instructions: z.string().max(16000),
  review: profile,
  implement: profile,
  policy: completionPolicySchema,
  requiredChecks: z.array(z.string().trim().min(1).max(200)).max(100),
});
export const finalizationStagesSchema = z
  .array(finalizationStageSchema)
  .min(5)
  .max(24)
  .superRefine((stages, context) => {
    const kinds = stages.map((s) => s.kind);
    if (
      new Set(stages.map((s) => s.id)).size !== stages.length ||
      FINALIZATION_STAGE_KINDS.some((k) => !kinds.includes(k)) ||
      kinds.some(
        (k, i) =>
          i > 0 &&
          FINALIZATION_STAGE_KINDS.indexOf(k) <
            FINALIZATION_STAGE_KINDS.indexOf(kinds[i - 1] ?? 'correctness'),
      ) ||
      kinds.filter((k) => k === 'final-review').length !== 1
    )
      context.addIssue({
        code: 'custom',
        message:
          'Use unique stage IDs in correctness, conformance, simplification, polish, final-review order; final review occurs once.',
      });
    for (const kind of ['correctness', 'conformance', 'final-review'])
      if (stages.filter((s) => s.kind === kind).at(-1)?.workItemSourceIds.length)
        context.addIssue({
          code: 'custom',
          message: `${kind} must end with a whole-plan check across subsystem boundaries.`,
        });
  });
export const finalizationSettingsSchema = z.strictObject({
  rounds: z
    .array(
      z.strictObject({ review: profile, polish: profile, instructions: z.string().max(16000) }),
    )
    .max(10),
  stages: finalizationStagesSchema.optional(),
  finalReview: profile,
  policy: completionPolicySchema,
  instructions: z.string().max(16000),
});
/**
 * New finalizations are staged: improvement rounds are retired (R-B10). Stored records keep
 * `rounds` and optional `stages` (`finalizationSchema`), so the completed legacy record still
 * reads.
 */
export const startFinalizationRequestSchema = finalizationSettingsSchema.extend({
  rounds: z.array(z.never()).max(0),
  stages: finalizationStagesSchema,
  expectedBranchVersion: z.number().int().positive(),
  targetBranch: gitBranchNameSchema,
});
export const finalizationSchema = finalizationSettingsSchema.extend({
  mapContext: z
    .strictObject({
      definitionId: z.uuid(),
      bindingRevision: z.number().int().positive(),
      runtimeId: z.uuid(),
      alias: z.string(),
    })
    .optional(),
  id: z.string().uuid(),
  workspaceId: workspaceIdSchema,
  planVersionId: planVersionIdSchema,
  projectId: projectIdSchema,
  repositoryId: sourceRepositoryIdSchema,
  integrationBranch: gitBranchNameSchema,
  integrationSha: gitShaSchema,
  targetBranch: gitBranchNameSchema,
  targetSha: gitShaSchema,
  worktreeId: worktreeIdSchema,
  cycleId: z.string().uuid(),
  status: z.enum(['preparing', 'active', 'stopped', 'completed']),
  integrationCleanup: z
    .strictObject({
      status: z.enum(['pending', 'blocked', 'removed']),
      requestedAt: z.iso.datetime(),
      requestedByUserId: userIdSchema,
      completedAt: z.iso.datetime().optional(),
      error: z.string().max(4000).optional(),
    })
    .optional(),
  reason: z.string().max(4000),
  version: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  createdByUserId: userIdSchema,
});
export const finalizationViewSchema = z.strictObject({
  finalization: finalizationSchema,
  cycle: workCycleSchema.optional(),
  worktree: worktreeSummarySchema.optional(),
  runs: z.array(agentRunSummarySchema),
  mergeRecoveryPending: z.boolean(),
  /** The decisions the finalization offers now, as the daemon decides them (R-A6 2b). */
  actions: z.array(z.enum(FINALIZATION_DECISIONS)).default([]),
  checkpointFindings: z.array(reviewFindingSchema).default([]),
  canAuthorizeRemediation: z.boolean().default(false),
});
export const finalizationsResponseSchema = z.strictObject({
  finalizations: z.array(finalizationViewSchema),
});
export const controlFinalizationRequestSchema = z
  .strictObject({
    expectedVersion: z.number().int().positive(),
    expectedCycleVersion: z.number().int().positive().optional(),
    action: z.enum([
      'resume',
      'pause',
      'stop',
      'merge',
      'remove-worktree',
      'retry-cleanup',
      'remove-integration-branch',
      'authorize-remediation',
      'remediate-findings',
      'select-stage-findings',
      'approve-plan-change',
    ]),
    findingIds: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    agentOverride: finalizationAgentSelectionSchema.nullable().optional(),
    /** With `remove-worktree`: discard uncommitted changes instead of refusing. */
    discardChanges: z.boolean().optional(),
    selectedFindingIds: z.array(z.string().min(1).max(64)).max(100).optional(),
    obligationId: z.string().min(1).max(64).optional(),
    rationale: z.string().trim().min(1).max(4000).optional(),
    additionalRounds: z.number().int().min(1).max(20).optional(),
    instructions: z.string().max(16000).optional(),
    removeIntegrationBranch: z.boolean().optional(),
    expectedHeadSha: gitShaSchema.optional(),
    expectedTargetSha: gitShaSchema.optional(),
  })
  .refine((r) => r.removeIntegrationBranch === undefined || r.action === 'merge', {
    message: 'Branch retention can only be chosen with final merge approval',
    path: ['removeIntegrationBranch'],
  })
  .refine(
    (r) =>
      r.agentOverride === undefined ||
      [
        'resume',
        'authorize-remediation',
        'remediate-findings',
        'select-stage-findings',
        'approve-plan-change',
      ].includes(r.action),
    {
      message: 'Agent selection is only available with finalization recovery',
      path: ['agentOverride'],
    },
  )
  .refine(
    (request) =>
      request.action === 'select-stage-findings' ||
      ['authorize-remediation', 'remediate-findings'].includes(request.action) ===
        (request.additionalRounds !== undefined),
    {
      message: 'Only remediation authorization requires an additionalRounds allowance',
      path: ['additionalRounds'],
    },
  )
  .refine(
    (r) =>
      r.action === 'remediate-findings'
        ? r.findingIds !== undefined && r.rationale !== undefined
        : r.findingIds === undefined &&
          (['select-stage-findings', 'approve-plan-change'].includes(r.action)
            ? r.rationale !== undefined
            : r.rationale === undefined),
    { message: 'Only finding decisions require selected IDs and a rationale' },
  )
  .refine(
    (r) =>
      (r.action === 'select-stage-findings') === (r.selectedFindingIds !== undefined) &&
      (r.action === 'approve-plan-change') === (r.obligationId !== undefined),
    { message: 'Stage selection and plan changes require their specific decision fields' },
  );
export type StartFinalizationRequest = z.infer<typeof startFinalizationRequestSchema>;
export type ControlFinalizationRequest = z.infer<typeof controlFinalizationRequestSchema>;
export type FinalizationView = z.infer<typeof finalizationViewSchema>;
