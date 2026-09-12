import { z } from 'zod';
import {
  planVersionIdSchema,
  projectIdSchema,
  sourceRepositoryIdSchema,
  workspaceIdSchema,
  worktreeIdSchema,
  userIdSchema,
} from './ids.js';
import { cycleProfilesSchema, completionPolicySchema, workCycleSchema } from './work-cycle.js';
import {
  agentRunSummarySchema,
  gitBranchNameSchema,
  gitShaSchema,
  worktreeSummarySchema,
} from './execution.js';
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
});
export const finalizationsResponseSchema = z.strictObject({
  finalizations: z.array(finalizationViewSchema),
});
export const controlFinalizationRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  expectedCycleVersion: z.number().int().positive().optional(),
  action: z.enum(['resume', 'pause', 'stop', 'merge', 'remove-worktree', 'retry-cleanup']),
  instructions: z.string().max(16000).optional(),
  expectedHeadSha: gitShaSchema.optional(),
  expectedTargetSha: gitShaSchema.optional(),
});
export type StartFinalizationRequest = z.infer<typeof startFinalizationRequestSchema>;
export type ControlFinalizationRequest = z.infer<typeof controlFinalizationRequestSchema>;
export type FinalizationView = z.infer<typeof finalizationViewSchema>;
