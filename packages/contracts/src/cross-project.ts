import { z } from 'zod';
import type { CrossProjectConfiguration } from '@craftingtable/domain';
import { workItemIdSchema } from './ids.js';
import { cycleProfilesSchema, completionPolicySchema } from './work-cycle.js';
const automation = z.strictObject({
  integrationMerge: z.enum(['manual', 'automatic']),
  integrationConflicts: z.enum(['manual', 'automatic']),
  resolutionProfile: cycleProfilesSchema.shape.remediate.optional(),
});
export const mapSettingsSchema = z.strictObject({
  reviewerRoles: z
    .array(z.string().min(1).max(200))
    .max(50)
    .refine((r) => new Set(r).size === r.length, 'Reviewer roles must be unique')
    .optional(),
  profiles: cycleProfilesSchema,
  policy: completionPolicySchema,
  instructions: z.string().max(16000),
  automation,
});
export const crossProjectConfigurationSchema = z.strictObject({
  definitionId: z.uuid(),
  bindingRevision: z.number().int().positive(),
  targetId: z.string().min(1).max(200),
  selection: z.enum(['target-only', 'prioritize-full']),
  parentAcceptance: z.enum(['manual', 'automatic']),
  defaults: mapSettingsSchema,
  overrides: z
    .array(
      z.strictObject({
        level: z.enum(['project', 'activity', 'individual']),
        key: z.string().min(1).max(240),
        settings: mapSettingsSchema,
      }),
    )
    .max(300)
    .refine(
      (rows) => new Set(rows.map((r) => `${r.level}:${r.key}`)).size === rows.length,
      'Overrides must be unique',
    ),
});
export const mapSelectionSchema = crossProjectConfigurationSchema.pick({
  definitionId: true,
  bindingRevision: true,
  targetId: true,
  selection: true,
});
export const adoptMapSchema = z.strictObject({
  bindingRevision: z.number().int().positive(),
  decisionIds: z.array(z.string().max(200)).max(200),
  rationale: z.string().trim().min(1).max(8000),
});
export const saveCrossProjectSchema = z.strictObject({
  roadmapId: z.uuid(),
  expectedVersion: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(120),
  configuration: crossProjectConfigurationSchema,
  scheduling: z.strictObject({
    mode: z.literal('parallel'),
    maxInFlight: z.number().int().min(1).max(16),
    maxPerRepository: z.number().int().min(1).max(16),
    maxIntegrationRefreshes: z.number().int().min(1).max(20),
  }),
});
export const mapNodeSchema = z.strictObject({
  key: z.string(),
  kind: z.enum(['slice', 'work_item', 'checkpoint']),
  sourceId: z.string(),
  state: z.string(),
  title: z.string(),
  repository: z.string(),
  parentId: z.string().optional(),
  workItemId: workItemIdSchema.optional(),
  included: z.boolean(),
  priority: z.boolean(),
  satisfied: z.boolean(),
  status: z.string(),
  requirements: z.array(z.string()),
  blockers: z.array(z.string()),
  action: z.enum(['work-item', 'evidence', 'adopt', 'none']),
});
export const crossProjectViewSchema = z.strictObject({
  reviewerRoles: z.array(z.string()),
  definitionId: z.uuid(),
  bindingRevision: z.number().int().nonnegative(),
  targets: z.array(
    z.strictObject({
      id: z.string(),
      checkpoint: z.string(),
      scope: z.string(),
      isRelease: z.boolean(),
    }),
  ),
  suggestedTarget: z.string(),
  decisions: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      proposal: z.string(),
      adopted: z.boolean(),
    }),
  ),
  adoptions: z.array(
    z.strictObject({
      id: z.uuid(),
      rationale: z.string(),
      createdAt: z.string(),
      createdByUserId: z.string(),
      bindingRevision: z.number(),
    }),
  ),
  blockers: z.array(z.string()),
  setupRequirements: z
    .array(
      z.strictObject({
        kind: z.enum(['binding', 'adoption', 'runtime']),
        message: z.string(),
      }),
    )
    .default([]),
  nodes: z.array(mapNodeSchema),
  targetReached: z.boolean(),
  selectedScopeComplete: z.boolean(),
  fullPlanAccepted: z.boolean(),
  finalized: z.boolean(),
  published: z.boolean(),
});
export type CrossProjectView = z.infer<typeof crossProjectViewSchema>;
export type SaveCrossProjectRequest = Omit<
  z.infer<typeof saveCrossProjectSchema>,
  'configuration'
> & { configuration: CrossProjectConfiguration };

export const adoptMapResponseSchema = z.strictObject({ adopted: z.literal(true) });
