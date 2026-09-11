import { ROADMAP_STATUSES } from '@craftingtable/domain';
import { z } from 'zod';
import {
  workspaceIdSchema,
  workItemIdSchema,
  projectIdSchema,
  planVersionIdSchema,
  sourceRepositoryIdSchema,
  userIdSchema,
  worktreeIdSchema,
} from './ids.js';
import { cycleProfilesSchema, completionPolicySchema } from './work-cycle.js';
export const roadmapIdSchema = z.string().uuid();
export const roadmapEntryInputSchema = z.strictObject({
  id: z.string().uuid(),
  workItemId: workItemIdSchema,
  profiles: cycleProfilesSchema,
  policy: completionPolicySchema,
  instructions: z.string().max(16000),
});
export const saveRoadmapRequestSchema = z
  .strictObject({
    expectedVersion: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(120),
    entries: z.array(roadmapEntryInputSchema).min(1).max(100),
  })
  .refine(
    (x) =>
      new Set(x.entries.map((e) => e.id)).size === x.entries.length &&
      new Set(x.entries.map((e) => e.workItemId)).size === x.entries.length,
    'Entries and work items must be unique',
  );
export type SaveRoadmapRequest = z.infer<typeof saveRoadmapRequestSchema>;
export const controlRoadmapRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  action: z.enum(['start', 'pause', 'resume', 'stop']),
});
const entrySchema = roadmapEntryInputSchema.extend({
  projectId: projectIdSchema,
  planVersionId: planVersionIdSchema,
  sourceId: z.string(),
  title: z.string(),
  repositoryId: sourceRepositoryIdSchema,
  integrationBranch: z.string(),
});
export const roadmapDefinitionSchema = z.strictObject({
  roadmapId: z.string().uuid(),
  revision: z.number().int().positive(),
  name: z.string(),
  entries: z.array(entrySchema),
  createdAt: z.iso.datetime(),
  createdByUserId: userIdSchema,
});
export const roadmapSchema = z.strictObject({
  id: z.string().uuid(),
  workspaceId: workspaceIdSchema,
  version: z.number().int().positive(),
  definition: roadmapDefinitionSchema,
  status: z.enum(ROADMAP_STATUSES),
  reason: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  createdByUserId: userIdSchema,
  delegatedByUserId: userIdSchema.optional(),
  attempts: z.array(
    z.strictObject({
      id: z.string().uuid(),
      entryId: z.string().uuid(),
      definitionRevision: z.number().int().positive(),
      worktreeId: worktreeIdSchema,
      cycleId: z.string().uuid(),
      status: z.enum(['preparing', 'active', 'completed']),
      createdAt: z.iso.datetime(),
      completedAt: z.iso.datetime().optional(),
    }),
  ),
});
export const roadmapViewSchema = z.strictObject({
  roadmap: roadmapSchema,
  progress: z.array(
    z.strictObject({
      entryId: z.string().uuid(),
      status: z.enum([
        'queued',
        'dependency-blocked',
        'running',
        'awaiting-merge',
        'needs-attention',
        'completed',
      ]),
      reason: z.string(),
    }),
  ),
});
export const roadmapsResponseSchema = z.strictObject({ roadmaps: z.array(roadmapViewSchema) });
export const roadmapHistoryResponseSchema = z.strictObject({
  definitions: z.array(roadmapDefinitionSchema),
});
