import { z } from 'zod';
import type { CrossProjectConfiguration } from '@craftingtable/domain';
import { agentProfileSchema } from './agent-profiles.js';
import { workItemIdSchema } from './ids.js';
import {
  cycleProfilesSchema,
  completionPolicySchema,
  stepPermissionsSchema,
} from './work-cycle.js';
const automation = z.strictObject({
  integrationMerge: z.enum(['manual', 'automatic']),
  integrationConflicts: z.enum(['manual', 'automatic']),
  resolutionProfile: agentProfileSchema.optional(),
});
const mapSettingsSchema = z.strictObject({
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
/**
 * A settings level as the map's settings form saves it (R-E5b): each step's permission mode
 * instead of its profile. The daemon keeps a saved level's agents and gives a new level the
 * workspace defaults; agents are changed by ADR-064 assignments.
 */
const mapSettingsInputSchema = mapSettingsSchema
  .omit({ profiles: true })
  .extend({ permissions: stepPermissionsSchema });
const configurationOf = <S extends typeof mapSettingsSchema | typeof mapSettingsInputSchema>(
  settings: S,
) =>
  z.strictObject({
    definitionId: z.uuid(),
    bindingRevision: z.number().int().positive(),
    targetId: z.string().min(1).max(200),
    selection: z.enum(['target-only', 'prioritize-full']),
    parentAcceptance: z.enum(['manual', 'automatic']),
    defaults: settings,
    overrides: z
      .array(
        z.strictObject({
          level: z.enum(['project', 'activity', 'individual']),
          key: z.string().min(1).max(240),
          settings,
        }),
      )
      .max(300)
      .refine(
        (rows) => new Set(rows.map((r) => `${r.level}:${r.key}`)).size === rows.length,
        'Overrides must be unique',
      ),
  });
/** A map roadmap's settings as its definition stores them. */
export const crossProjectConfigurationSchema = configurationOf(mapSettingsSchema);
/** The same settings as the save request sends them: permissions, not profiles (R-E5b). */
const crossProjectConfigurationInputSchema = configurationOf(mapSettingsInputSchema);
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
  configuration: crossProjectConfigurationInputSchema,
  scheduling: z.strictObject({
    mode: z.literal('parallel'),
    maxInFlight: z.number().int().min(1).max(16),
    maxPerRepository: z.number().int().min(1).max(16),
    maxIntegrationRefreshes: z.number().int().min(1).max(20),
  }),
});
const mapNodeSchema = z.strictObject({
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
  reviewerRoles: z.array(z.string()).optional(),
  decisionCoverage: z
    .array(
      z.object({
        checkpoint: z.string(),
        submissionId: z.string(),
        phase: z.enum(['start', 'merge']),
      }),
    )
    .optional(),
  originalRequirements: z.array(z.string()).optional(),
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
        kind: z.enum(['binding', 'adoption', 'runtime', 'plan-acceptance']),
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
/** A map roadmap's save as the request sends it: permissions, not profiles (R-E5b). */
export type SaveCrossProjectRequest = z.infer<typeof saveCrossProjectSchema>;
/** The same save with its settings as the definition stores them (an amendment's re-save). */
export type CrossProjectSave = Omit<SaveCrossProjectRequest, 'configuration'> & {
  configuration: CrossProjectConfiguration;
};

export const adoptMapResponseSchema = z.strictObject({ adopted: z.literal(true) });
