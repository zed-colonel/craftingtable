import {
  DIAGNOSTIC_SEVERITIES,
  PLAN_ARTIFACT_ROLES,
  WORK_ITEM_READINESS,
  WORK_ITEM_RISKS,
  WORK_ITEM_STATUSES,
} from '@craftingtable/domain';
import { z } from 'zod';
import {
  planArtifactIdSchema,
  planImportAttemptIdSchema,
  planVersionIdSchema,
  projectIdSchema,
  workItemIdSchema,
  worktreeIdSchema,
} from './ids.js';

/** Strict wire contracts for CT-03 planning (archive/CT-03/work-items/CT-03.md §5.13). */

const planImportDiagnosticSchema = z.strictObject({
  severity: z.enum(DIAGNOSTIC_SEVERITIES),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(500),
  artifactName: z.string().max(200).optional(),
  path: z.string().max(200).optional(),
  workItemSourceId: z.string().max(64).optional(),
});

const importOutcomeBase = {
  importAttemptId: planImportAttemptIdSchema,
};

const planImportSucceededSchema = z.strictObject({
  ...importOutcomeBase,
  outcome: z.literal('succeeded'),
  projectId: projectIdSchema,
  planVersionId: planVersionIdSchema,
  versionNumber: z.number().int().positive().safe(),
  isActiveVersion: z.boolean(),
  itemCount: z.number().int().nonnegative().safe(),
  requiredDependencyCount: z.number().int().nonnegative().safe(),
  warningCount: z.number().int().nonnegative().safe(),
  diagnostics: z.array(planImportDiagnosticSchema).max(500),
});

const planImportDuplicateSchema = z.strictObject({
  ...importOutcomeBase,
  outcome: z.literal('duplicate'),
  projectId: projectIdSchema,
  planVersionId: planVersionIdSchema,
  versionNumber: z.number().int().positive().safe(),
  isActiveVersion: z.boolean(),
});

const planImportFailedSchema = z.strictObject({
  ...importOutcomeBase,
  outcome: z.literal('failed-validation'),
  diagnostics: z.array(planImportDiagnosticSchema).max(500),
});

/**
 * A plan bundle upload's text fields, beside its artifact parts (R-H5). The route reads these three
 * and ignores any other field, as it always has.
 */
export const planImportFieldsSchema = z.object({
  projectName: z.string().optional(),
  projectId: z.string().optional(),
  bundleName: z.string().optional(),
});
/**
 * All three outcomes are HTTP 200: each is a recorded, durable result of a
 * valid request. 4xx stays reserved for transport and authorization faults,
 * which record no attempt because they are not import requests.
 */
export const planImportResponseSchema = z.discriminatedUnion('outcome', [
  planImportSucceededSchema,
  planImportDuplicateSchema,
  planImportFailedSchema,
]);

const planArtifactSummarySchema = z.strictObject({
  id: planArtifactIdSchema,
  logicalFilename: z.string().min(1).max(200),
  role: z.enum(PLAN_ARTIFACT_ROLES),
  mediaType: z.string().min(1).max(100),
  byteLength: z.number().int().nonnegative().safe(),
  sha256: z.string().length(64),
});

const riskCountsSchema = z.strictObject({
  low: z.number().int().nonnegative().safe(),
  medium: z.number().int().nonnegative().safe(),
  high: z.number().int().nonnegative().safe(),
  critical: z.number().int().nonnegative().safe(),
  unspecified: z.number().int().nonnegative().safe(),
});

export const planningStatusCountsSchema = z.strictObject({
  proposedCount: z.number().int().nonnegative().safe(),
  admittedCount: z.number().int().nonnegative().safe(),
  completedCount: z.number().int().nonnegative().safe(),
  planningReadyCount: z.number().int().nonnegative().safe(),
  dependencyBlockedCount: z.number().int().nonnegative().safe(),
  riskCounts: riskCountsSchema,
});

const planCompletionSchema = z.strictObject({
  finalizationId: z.string().uuid(),
  targetBranch: z.string().min(1).max(255),
  mergeSha: z.string().regex(/^[0-9a-f]{40,64}$/),
  completedAt: z.iso.datetime(),
});

export const projectSummarySchema = planningStatusCountsSchema.extend({
  id: projectIdSchema,
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(120),
  activePlanVersionId: planVersionIdSchema.optional(),
  completion: planCompletionSchema.optional(),
  document: z.string().max(300).optional(),
  versionCount: z.number().int().nonnegative().safe(),
  warningCount: z.number().int().nonnegative().safe(),
  createdAt: z.iso.datetime(),
});

const planVersionSummarySchema = z.strictObject({
  completion: planCompletionSchema.optional(),
  id: planVersionIdSchema,
  versionNumber: z.number().int().positive().safe(),
  contentDigest: z.string().length(64),
  document: z.string().min(1).max(300),
  itemCount: z.number().int().nonnegative().safe(),
  requiredDependencyCount: z.number().int().nonnegative().safe(),
  createdAt: z.iso.datetime(),
  isActive: z.boolean(),
});

/** Readiness vocabulary carried on the wire; see `WORK_ITEM_READINESS`. */
const workItemSummarySchema = z.strictObject({
  id: workItemIdSchema,
  sourceId: z.string().min(1).max(64),
  ordinal: z.number().int().nonnegative().safe(),
  title: z.string().min(1).max(300),
  status: z.enum(WORK_ITEM_STATUSES),
  risk: z.enum(WORK_ITEM_RISKS),
  phase: z.string().max(64).optional(),
  primaryAreas: z.array(z.string().max(64)).max(32),
  exitGate: z.string().min(1).max(1000),
  requiredPredecessorCount: z.number().int().nonnegative().safe(),
  recommendedPredecessorCount: z.number().int().nonnegative().safe(),
  blockerSourceIds: z.array(z.string().max(64)).max(64),
  readiness: z.enum(WORK_ITEM_READINESS),
});

const workItemDependencySummarySchema = z.strictObject({
  workItemId: workItemIdSchema,
  sourceId: z.string().min(1).max(64),
  title: z.string().min(1).max(300),
  status: z.enum(WORK_ITEM_STATUSES),
  risk: z.enum(WORK_ITEM_RISKS),
  kind: z.enum(['required', 'recommended']),
});

/**
 * A plan version's dependency structure (R-E4): its work items in plan order, and each required
 * predecessor as an edge `[predecessor, successor]` between their indices. A plan version never
 * changes, so this is read once per version; the items' states come from the version's detail.
 */
export const planVersionGraphSchema = z.strictObject({
  planVersionId: planVersionIdSchema,
  nodes: z
    .array(
      z.strictObject({
        workItemId: workItemIdSchema,
        sourceId: z.string().min(1).max(64),
        title: z.string().min(1).max(300),
      }),
    )
    .max(2000),
  edges: z
    .array(z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]))
    .max(20000),
});
export type PlanVersionGraph = z.infer<typeof planVersionGraphSchema>;

export const planVersionDetailResponseSchema = z.strictObject({
  version: planVersionSummarySchema.extend({
    sourceProfile: z.literal('exo-work-breakdown-v1'),
    digestAlgorithm: z.literal('sha-256'),
    digestFormatVersion: z.literal(1),
  }),
  projectId: projectIdSchema,
  counts: planningStatusCountsSchema,
  artifacts: z.array(planArtifactSummarySchema).max(64),
  archives: z
    .array(
      z.strictObject({
        id: z.uuid(),
        filename: z.string().max(200),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        byteLength: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  diagnostics: z.array(planImportDiagnosticSchema).max(500),
  workItems: z.array(workItemSummarySchema).max(2000),
});

export const projectDetailResponseSchema = z.strictObject({
  project: projectSummarySchema,
  versions: z.array(planVersionSummarySchema).max(100),
  activeVersion: planVersionDetailResponseSchema.nullable(),
});

export const workItemDetailResponseSchema = z.strictObject({
  agendaRemoval: z
    .strictObject({
      allowed: z.boolean(),
      expectedVersion: z.number().int().positive().safe(),
      reason: z.string().max(500).optional(),
    })
    .optional(),
  workItem: workItemSummarySchema.extend({
    projectId: projectIdSchema,
    planVersionId: planVersionIdSchema,
    admittedAt: z.iso.datetime().optional(),
    completedAt: z.iso.datetime().optional(),
    completionWorktreeId: worktreeIdSchema.optional(),
    mergeSha: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/)
      .optional(),
  }),
  projectName: z.string().min(1).max(120),
  requiredPredecessors: z.array(workItemDependencySummarySchema).max(64),
  recommendedPredecessors: z.array(workItemDependencySummarySchema).max(64),
  dependents: z.array(workItemDependencySummarySchema).max(2000),
});

const removeFromAgendaRequestSchema = z.strictObject({
  expectedVersion: z.number().int().positive().safe(),
});
export const removeFromAgendaResponseSchema = z.strictObject({
  workItemId: workItemIdSchema,
  status: z.literal('proposed'),
  removed: z.boolean(),
});

export const admitWorkItemResponseSchema = z.strictObject({
  workItemId: workItemIdSchema,
  status: z.literal('admitted'),
  /** True when this request performed the transition rather than repeating it. */
  admitted: z.boolean(),
});

export const completeWorkItemResponseSchema = z.strictObject({
  workItemId: workItemIdSchema,
  status: z.literal('completed'),
  /** True when this request performed the transition rather than repeating it. */
  completed: z.boolean(),
});

/** Cross-project work item listing for the workspace overview. */
export const workspaceWorkItemFilterSchema = z.enum([
  'all',
  'admitted',
  'planning-ready',
  'dependency-blocked',
  'completed',
]);

export const workspaceWorkItemListResponseSchema = z.strictObject({
  filter: workspaceWorkItemFilterSchema,
  items: z
    .array(
      workItemSummarySchema.extend({
        projectId: projectIdSchema,
        projectName: z.string().min(1).max(120),
        executionScopes: z
          .array(
            z.strictObject({
              worktreeId: worktreeIdSchema,
              sourceId: z.string(),
              title: z.string(),
              kind: z.enum(['slice', 'slice-verification', 'parent-acceptance']),
              earlyDevelopment: z.boolean(),
              startRequirements: z.array(z.string()),
            }),
          )
          .optional(),
      }),
    )
    .max(500),
});

export type PlanImportDiagnosticPayload = z.infer<typeof planImportDiagnosticSchema>;
export type PlanImportResponse = z.infer<typeof planImportResponseSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type PlanVersionDetailResponse = z.infer<typeof planVersionDetailResponseSchema>;
export type ProjectDetailResponse = z.infer<typeof projectDetailResponseSchema>;
export type WorkItemSummary = z.infer<typeof workItemSummarySchema>;
export type WorkItemDetailResponse = z.infer<typeof workItemDetailResponseSchema>;
export type AdmitWorkItemResponse = z.infer<typeof admitWorkItemResponseSchema>;
export type CompleteWorkItemResponse = z.infer<typeof completeWorkItemResponseSchema>;
export type WorkspaceWorkItemFilter = z.infer<typeof workspaceWorkItemFilterSchema>;
export type WorkspaceWorkItemListResponse = z.infer<typeof workspaceWorkItemListResponseSchema>;

/** A work item's agenda commands in one route (R-H5, H5-2): admit, remove from the agenda, complete. */
export const workItemControlRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('admit') }),
  removeFromAgendaRequestSchema.extend({ action: z.literal('remove-from-agenda') }),
  z.strictObject({ action: z.literal('complete') }),
]);
