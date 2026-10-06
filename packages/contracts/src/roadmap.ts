import {
  ENTRY_WAIT_CODES,
  type EntryWaitCode,
  ROADMAP_ATTENTION_CODES,
  ROADMAP_STATUSES,
  type RoadmapAttentionCode,
} from '@craftingtable/domain';
import { z } from 'zod';
import { agentSelectionSchema, agentSelectionsSchema } from './agent-profiles.js';
import { phaseBlockerCodeSchema, roadmapAttentionSchema } from './attention.js';
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
  action: z.enum(['start', 'pause', 'resume', 'stop', 'reverify']),
  entryId: z.string().uuid().optional(),
});
export const scopeRecoveryPolicyRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  enabled: z.boolean(),
  maxRoundsPerParent: z.number().int().min(1).max(20),
});
export type ScopeRecoveryPolicyRequest = z.infer<typeof scopeRecoveryPolicyRequestSchema>;
/** The standing decision preparation grant (R-C3b, ADR-065). */
export const decisionPreparationGrantRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  enabled: z.boolean(),
  minutes: z.number().int().min(5).max(60),
  maxConcurrent: z.number().int().min(1).max(3),
});
export type DecisionPreparationGrantRequest = z.infer<typeof decisionPreparationGrantRequestSchema>;
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
export const applyRoadmapDelegationSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  entryIds: z.array(z.uuid()).min(1).max(1000),
  automation: roadmapAutomationSchema,
  reviewerRoles: z.array(z.string().min(1).max(200)).max(50),
  rationale: z.string().trim().min(1).max(4000),
});
export type ApplyRoadmapDelegation = z.infer<typeof applyRoadmapDelegationSchema>;
export const prepareRoadmapDecisionSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  checkpointId: z.string().min(1).max(200),
  profile: agentSelectionSchema,
  minutes: z.number().int().min(5).max(60),
  instructions: z.string().trim().max(8000),
});
export type PrepareRoadmapDecision = z.infer<typeof prepareRoadmapDecisionSchema>;
export const decisionPreparationSchema = z.strictObject({
  id: z.uuid(),
  definitionId: z.uuid(),
  bindingRevision: z.number().int().positive(),
  bindingDigest: z.string(),
  checkpointId: z.string(),
  workspaceId: workspaceIdSchema,
  repositoryId: sourceRepositoryIdSchema,
  projectId: projectIdSchema,
  planVersionId: planVersionIdSchema,
  integrationBranch: z.string(),
  integrationSha: z.string(),
  worktreeId: worktreeIdSchema,
  runId: agentRunIdSchema,
  profile: agentSelectionSchema,
  deadlineAt: z.iso.datetime(),
  instructions: z.string(),
  createdAt: z.iso.datetime(),
  createdByUserId: userIdSchema,
  failure: z.string().optional(),
});
export const roadmapAttemptSchema = z.strictObject({
  reverification: z
    .strictObject({
      requestedAt: z.iso.datetime(),
      requestedByUserId: userIdSchema,
      sourceRunId: agentRunIdSchema,
    })
    .optional(),
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
      requestedByUserId: userIdSchema.optional(),
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
});
export const roadmapSchema = z.strictObject({
  decisionPreparations: z.array(decisionPreparationSchema).optional(),
  delegationAssignments: z
    .array(
      applyRoadmapDelegationSchema.omit({ expectedVersion: true }).extend({
        id: z.uuid(),
        appliedAt: z.iso.datetime(),
        appliedByUserId: userIdSchema,
      }),
    )
    .optional(),
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
  decisionPreparationGrant: decisionPreparationGrantRequestSchema
    .omit({ expectedVersion: true })
    .extend({ grantedByUserId: userIdSchema, grantedAt: z.iso.datetime() })
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
  attention: roadmapAttentionSchema.optional(),
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
        attention: roadmapAttentionSchema.optional(),
      }),
    )
    .optional(),
  entryWaits: z
    .record(
      z.string().uuid(),
      z.strictObject({
        code: z.enum(ENTRY_WAIT_CODES as [EntryWaitCode, ...EntryWaitCode[]]),
        reason: z.string().max(4000),
        since: z.iso.datetime(),
        refs: z
          .strictObject({
            cycleId: z.string().min(1).max(200).optional(),
            entryId: z.string().min(1).max(200).optional(),
            blockers: z.array(phaseBlockerCodeSchema).max(50).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
  attempts: z.array(roadmapAttemptSchema),
  retiredAttempts: z
    .array(
      roadmapAttemptSchema.extend({
        retiredAt: z.iso.datetime(),
        retiredByUserId: userIdSchema,
        reason: z.string().max(4000),
      }),
    )
    .optional(),
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
      reverifiable: z.literal(true).optional(),
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
/** A roadmap's read-only status list (R-E3a). */
export const roadmapStatusListSchema = z.strictObject({
  roadmapId: z.string().uuid(),
  name: z.string(),
  status: z.enum(ROADMAP_STATUSES),
  reason: z.string(),
  attentionCode: z
    .enum(ROADMAP_ATTENTION_CODES as [RoadmapAttentionCode, ...RoadmapAttentionCode[]])
    .optional(),
  completed: z.number().int().nonnegative(),
  entries: z.array(
    z.strictObject({
      entryId: z.string().uuid(),
      sourceId: z.string(),
      scope: z.enum(['item', 'slice', 'slice-verification', 'parent-acceptance']),
      title: z.string(),
      workItemId: workItemIdSchema,
      state: roadmapViewSchema.shape.progress.element.shape.status,
      actor: z.enum(['operator', 'controller', 'agent', 'none']),
      waitsOn: z
        .strictObject({
          source: z.enum(['attention-item', 'entry-hold', 'entry-wait', 'progress']),
          code: z.string().max(200).optional(),
          reason: z.string(),
          since: z.iso.datetime().optional(),
          attentionItemId: z.string().optional(),
          cycleId: z.string().optional(),
          runId: z.string().optional(),
          entryId: z.string().optional(),
          blockers: z.array(phaseBlockerCodeSchema).max(50).optional(),
        })
        .optional(),
    }),
  ),
});

/** A definition revision as a path names it. */
export const roadmapRevisionParamSchema = z.coerce.number().int().positive().safe();
/**
 * A roadmap page's region in one answer (R-D5, PERF-06/14): the roadmap's view without its
 * definition, the revision to read that by, and its status list, read in one transaction over
 * one map snapshot. The definition is read once per revision (`…/definitions/:revision`).
 */
export const roadmapPageSchema = z.strictObject({
  view: roadmapViewSchema.extend({ roadmap: roadmapSchema.omit({ definition: true }) }),
  definitionRevision: z.number().int().positive(),
  status: roadmapStatusListSchema,
});
/** The roadmaps list page's rows: no definition, no per-entry progress (R-D5, PERF-06). */
export const roadmapSummariesSchema = z.strictObject({
  roadmaps: z.array(
    z.strictObject({
      id: z.string().uuid(),
      name: z.string(),
      status: z.enum(ROADMAP_STATUSES),
      reason: z.string(),
      attentionCode: z
        .enum(ROADMAP_ATTENTION_CODES as [RoadmapAttentionCode, ...RoadmapAttentionCode[]])
        .optional(),
      completed: z.number().int().nonnegative(),
      entries: z.number().int().nonnegative(),
    }),
  ),
});
export type RoadmapStatusListResponse = z.infer<typeof roadmapStatusListSchema>;
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

export const decisionPreparationSettingsSchema = z.strictObject({
  version: z.number().int().positive(),
  status: z.enum(ROADMAP_STATUSES),
  decisions: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      profile: agentSelectionSchema,
      latest: z
        .strictObject({
          runId: agentRunIdSchema,
          status: z.string(),
          summary: z.string(),
          createdAt: z.iso.datetime(),
        })
        .optional(),
    }),
  ),
});
export type DecisionPreparationSettings = z.infer<typeof decisionPreparationSettingsSchema>;
export type RoadmapPage = z.infer<typeof roadmapPageSchema>;
export type RoadmapSummaries = z.infer<typeof roadmapSummariesSchema>;
