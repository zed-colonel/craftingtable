import { z } from 'zod';
import {
  planVersionIdSchema,
  sourceRepositoryIdSchema,
  userIdSchema,
  workspaceIdSchema,
} from './ids.js';
import { gitBranchNameSchema, gitShaSchema } from './execution.js';

export const repositoryFreezeSchema = z.strictObject({
  branch: gitBranchNameSchema.refine((branch) => !branch.startsWith('-'), 'Use a branch name'),
  commitSha: gitShaSchema.refine(
    (s) => s.length === 40 || s.length === 64,
    'Use a full commit identity',
  ),
});
export const repositoryPolicySchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  planVersionId: planVersionIdSchema,
  repositoryId: sourceRepositoryIdSchema,
  integrationBranch: gitBranchNameSchema,
  branchSettingsVersion: z.number().int().positive(),
  version: z.number().int().positive(),
  controlMode: z.literal('controller-local'),
  experimentalFreeze: repositoryFreezeSchema.optional(),
  publicationRequirement: z.string().trim().min(1).max(2000),
  interpretation: z.string().trim().min(1).max(8000),
  adoptedAt: z.iso.datetime(),
  adoptedByUserId: userIdSchema,
});
export const saveRepositoryPolicyRequestSchema = z.strictObject({
  expectedVersion: z.number().int().nonnegative(),
  expectedBranchSettingsVersion: z.number().int().positive(),
  controlMode: z.literal('controller-local'),
  experimentalFreeze: repositoryFreezeSchema.optional(),
  publicationRequirement: z.string().trim().min(1).max(2000),
  interpretation: z.string().trim().min(1).max(8000),
});
export const repositoryPolicyEvidenceSchema = z.strictObject({
  kind: z.literal('repository-policy-evidence-v1'),
  observedAt: z.iso.datetime(),
  policy: repositoryPolicySchema.optional(),
  settingsVersion: z.number().int().nonnegative(),
  integrationBranch: gitBranchNameSchema.optional(),
  integrationSha: gitShaSchema.optional(),
  proposedFreeze: repositoryFreezeSchema.optional(),
  observedFreezeSha: gitShaSchema.optional(),
  issues: z.array(z.string()).max(100),
  manualApprovalBranches: z.array(gitBranchNameSchema).max(1000),
  controls: z.array(z.string()).max(30),
  limitations: z.array(z.string()).max(30),
});
export type SaveRepositoryPolicyRequest = z.infer<typeof saveRepositoryPolicyRequestSchema>;
export type RepositoryPolicyEvidence = z.infer<typeof repositoryPolicyEvidenceSchema>;
