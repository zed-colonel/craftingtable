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
export const finalizationSettingsSchema = z.strictObject({
  rounds: z
    .array(
      z.strictObject({ review: profile, polish: profile, instructions: z.string().max(16000) }),
    )
    .max(10),
  finalReview: profile,
  policy: completionPolicySchema,
  instructions: z.string().max(16000),
});
export const startFinalizationRequestSchema = finalizationSettingsSchema.extend({
  expectedBranchVersion: z.number().int().positive(),
  targetBranch: gitBranchNameSchema,
});
export const finalizationSchema = finalizationSettingsSchema.extend({
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
      'authorize-remediation',
      'defer-nits',
      'remediate-findings',
    ]),
    findingIds: z
      .array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/))
      .min(1)
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    agentOverride: finalizationAgentSelectionSchema.nullable().optional(),
    rationale: z.string().trim().min(1).max(4000).optional(),
    additionalRounds: z.number().int().min(1).max(20).optional(),
    instructions: z.string().max(16000).optional(),
    expectedHeadSha: gitShaSchema.optional(),
    expectedTargetSha: gitShaSchema.optional(),
  })
  .refine(
    (r) =>
      r.agentOverride === undefined ||
      ['resume', 'authorize-remediation', 'remediate-findings', 'defer-nits'].includes(r.action),
    {
      message: 'Agent selection is only available with finalization recovery',
      path: ['agentOverride'],
    },
  )
  .refine(
    (request) =>
      ['authorize-remediation', 'remediate-findings'].includes(request.action) ===
      (request.additionalRounds !== undefined),
    {
      message: 'Only remediation authorization requires an additionalRounds allowance',
      path: ['additionalRounds'],
    },
  )
  .refine(
    (r) =>
      ['defer-nits', 'remediate-findings'].includes(r.action)
        ? r.findingIds !== undefined && r.rationale !== undefined
        : r.findingIds === undefined && r.rationale === undefined,
    { message: 'Only finding decisions require selected IDs and a rationale' },
  );
export type StartFinalizationRequest = z.infer<typeof startFinalizationRequestSchema>;
export type ControlFinalizationRequest = z.infer<typeof controlFinalizationRequestSchema>;
export type FinalizationView = z.infer<typeof finalizationViewSchema>;
