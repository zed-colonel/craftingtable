import { ROADMAP_STATUSES } from '@craftingtable/domain';
import { z } from 'zod';
import { agentSelectionsSchema } from './agent-profiles.js';
import { crossProjectConfigurationSchema } from './cross-project.js';
import { executionScopeSchema, phaseBlockerSchema } from './execution-scope.js';
import {
  agentRunIdSchema,
  planVersionIdSchema,
  projectIdSchema,
  sourceRepositoryIdSchema,
  userIdSchema,
  workItemIdSchema,
  workspaceIdSchema,
  worktreeIdSchema,
} from './ids.js';
import { completionPolicySchema, cycleProfilesSchema } from './work-cycle.js';
export const roadmapAutomationSchema = z.strictObject({
  integrationMerge: z.enum(['manual', 'automatic']),
  integrationConflicts: z.enum(['manual', 'automatic']),
  resolutionProfile: cycleProfilesSchema.shape.remediate.optional(),
});
export const roadmapIdSchema = z.string().uuid();
export const roadmapSchedulingSchema = z.strictObject({
  mode: z.enum(['sequential', 'parallel']),
  maxInFlight: z.number().int().min(1).max(16),
  maxPerRepository: z.number().int().min(1).max(16),
  maxIntegrationRefreshes: z.number().int().min(1).max(20),
});
export const roadmapEntryInputSchema = z.strictObject({
  reviewerRoles: z.array(z.string().min(1).max(200)).max(50).optional(),
  executionScope: executionScopeSchema.optional(),
  id: z.string().uuid(),
  workItemId: workItemIdSchema,
  profiles: cycleProfilesSchema,
  policy: completionPolicySchema,
  instructions: z.string().max(16000),
  automation: roadmapAutomationSchema.optional(),
  exclusionGroups: z
    .array(z.string().trim().min(1).max(80))
    .max(20)
    .refine((groups) => new Set(groups).size === groups.length, 'Exclusion groups must be unique')
    .optional(),
});
export const saveRoadmapRequestSchema = z
  .strictObject({
    expectedVersion: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(120),
    entries: z.array(roadmapEntryInputSchema).min(1).max(100),
    scheduling: roadmapSchedulingSchema.optional(),
    automation: roadmapAutomationSchema.optional(),
  })
  .refine(
    (x) =>
      new Set(x.entries.map((e) => e.id)).size === x.entries.length &&
      new Set(
        x.entries.map(
          (e) =>
            `${e.workItemId}:${e.executionScope?.definitionId ?? ''}:${e.executionScope?.bindingRevision ?? ''}:${e.executionScope?.kind ?? ''}:${e.executionScope?.sourceId ?? ''}`,
        ),
      ).size === x.entries.length &&
      x.entries.every(
        (e) =>
          !x.entries.some(
            (other) =>
              other.workItemId === e.workItemId &&
              (!!e.executionScope !== !!other.executionScope ||
                (e.executionScope &&
                  other.executionScope &&
                  (e.executionScope.definitionId !== other.executionScope.definitionId ||
                    e.executionScope.bindingRevision !== other.executionScope.bindingRevision))),
          ),
      ),
    'Entries and execution scopes must be unique; a parent cannot mix whole-item execution or map bindings',
  );
export type SaveRoadmapRequest = z.infer<typeof saveRoadmapRequestSchema>;
export const controlRoadmapRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  action: z.enum(['start', 'pause', 'resume', 'stop']),
  entryId: z.string().uuid().optional(),
});
export const scopeRecoveryPolicyRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  enabled: z.boolean(),
  maxRoundsPerParent: z.number().int().min(1).max(20),
});
export type ScopeRecoveryPolicyRequest = z.infer<typeof scopeRecoveryPolicyRequestSchema>;
const entrySchema = roadmapEntryInputSchema.extend({
  projectId: projectIdSchema,
  planVersionId: planVersionIdSchema,
  sourceId: z.string(),
  title: z.string(),
  repositoryId: sourceRepositoryIdSchema,
  integrationBranch: z.string(),
});
export const roadmapDefinitionSchema = z.strictObject({
  crossProject: crossProjectConfigurationSchema.optional(),
  roadmapId: z.string().uuid(),
  revision: z.number().int().positive(),
  name: z.string(),
  entries: z.array(entrySchema),
  scheduling: roadmapSchedulingSchema.optional(),
  automation: roadmapAutomationSchema.optional(),
  createdAt: z.iso.datetime(),
  createdByUserId: userIdSchema,
});
export const roadmapSchema = z.strictObject({
  agentAssignments: z
    .array(
      z.strictObject({
        id: z.uuid(),
        entryIds: z.array(z.uuid()),
        selections: agentSelectionsSchema,
        appliedAt: z.iso.datetime(),
        appliedByUserId: userIdSchema,
      }),
    )
    .optional(),
  scopeRecovery: z
    .strictObject({
      enabled: z.boolean(),
      maxRoundsPerParent: z.number().int().min(1).max(20),
      grantedByUserId: userIdSchema,
      grantedAt: z.iso.datetime(),
    })
    .optional(),
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
  entryHolds: z
    .record(
      z.string().uuid(),
      z.strictObject({
        status: z.enum(['paused', 'needs-attention']),
        reason: z.string().max(4000),
      }),
    )
    .optional(),
  attempts: z.array(
    z.strictObject({
      dependencyRefresh: z
        .strictObject({
          runtimeId: z.uuid(),
          generation: z.number().int().positive(),
          sourceRunId: agentRunIdSchema,
        })
        .optional(),
      recovery: z
        .strictObject({
          sourceEntryId: z.string().uuid(),
          sourceRunId: agentRunIdSchema,
          sourceSequence: z.number().int().positive(),
          findingFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          phase: z.enum(['repair', 'verification', 'parent-review', 'completed']),
          reviewRunIds: z.record(z.string().uuid(), z.string().uuid()),
          reviewRestarts: z.record(z.string().uuid(), z.number().int().nonnegative()).optional(),
        })
        .optional(),
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
  hostCapacity: z
    .strictObject({
      development: z.strictObject({
        limit: z.number().int().min(1).max(32),
        inUse: z.number().int().nonnegative(),
      }),
      verification: z.strictObject({
        limit: z.number().int().min(1).max(32),
        inUse: z.number().int().nonnegative(),
      }),
    })
    .optional(),
  progress: z.array(
    z.strictObject({
      phase: z.enum(['start', 'merge', 'verify', 'accept']).optional(),
      blockers: z.array(phaseBlockerSchema).optional(),
      entryId: z.string().uuid(),
      effectiveAutomation: roadmapAutomationSchema.optional(),
      status: z.enum([
        'queued',
        'dependency-blocked',
        'capacity-blocked',
        'exclusion-blocked',
        'paused',
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

export const saveRoadmapCapacitySchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  maxInFlight: roadmapSchedulingSchema.shape.maxInFlight,
  maxPerRepository: roadmapSchedulingSchema.shape.maxPerRepository,
});
export type SaveRoadmapCapacity = z.infer<typeof saveRoadmapCapacitySchema>;
export const roadmapCapacitiesSchema = z.strictObject({
  roadmaps: z.array(
    z.strictObject({
      id: roadmapIdSchema,
      version: z.number().int().positive(),
      name: z.string(),
      status: z.enum(ROADMAP_STATUSES),
      crossProject: z.boolean(),
      revision: z.number().int().positive(),
      scheduling: roadmapSchedulingSchema,
      editBlocker: z.string().nullable(),
      inFlight: z.array(
        z.strictObject({
          workItemId: workItemIdSchema,
          label: z.string(),
          attemptId: z.string(),
        }),
      ),
    }),
  ),
});
export type RoadmapCapacities = z.infer<typeof roadmapCapacitiesSchema>;
