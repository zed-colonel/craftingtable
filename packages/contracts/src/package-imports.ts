import { z } from 'zod';
import {
  planVersionIdSchema,
  projectIdSchema,
  sourceRepositoryIdSchema,
  workItemIdSchema,
} from './ids.js';
import { planImportResponseSchema } from './planning.js';

const id = z.string().min(1).max(200);
const text = z.string().max(16000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const importIssueSchema = z.strictObject({
  severity: z.enum(['error', 'warning', 'info']),
  code: z.string().max(80),
  message: z.string().max(16000),
  path: z.string().max(500).optional(),
});
export const archiveSelectionSchema = z.strictObject({
  implementationPlan: z.string().min(1).max(400),
  workBreakdown: z.string().min(1).max(400),
});
export const planArchivePreviewSchema = z.strictObject({
  archiveDigest: digest,
  entries: z
    .array(
      z.strictObject({
        path: z.string().max(400),
        byteLength: z.number().int().nonnegative(),
        sha256: digest,
      }),
    )
    .max(512),
  implementationPlans: z.array(text),
  workBreakdowns: z.array(text),
  selectedPaths: z.array(text).optional(),
  diagnostics: z.array(importIssueSchema),
  itemCount: z.number().int().nonnegative().optional(),
  valid: z.boolean().optional(),
});
export const archiveAttemptSchema = z.strictObject({
  id: z.uuid(),
  archiveId: z.uuid(),
  filename: z.string().max(200),
  kind: z.enum(['plan', 'concurrency']),
  outcome: z.enum(['succeeded', 'duplicate', 'failed-validation', 'conflict']),
  createdAt: z.string(),
  diagnostics: z.array(importIssueSchema),
  definitionId: z.uuid().optional(),
  planVersionId: planVersionIdSchema.optional(),
});
export const archivePlanImportResponseSchema = z.strictObject({
  attempt: archiveAttemptSchema,
  plan: planImportResponseSchema.optional(),
});
export const concurrencyImportResponseSchema = z.strictObject({ attempt: archiveAttemptSchema });
export const concurrencySummarySchema = z.strictObject({
  id: z.uuid(),
  mapId: id,
  revision: id,
  digest,
  document: text,
  createdAt: z.string(),
  parentCount: z.number().int(),
  sliceCount: z.number().int(),
  checkpointCount: z.number().int(),
  graphNodeCount: z.number().int(),
  graphEdgeCount: z.number().int(),
  bindingRevision: z.number().int(),
  status: z.literal('imported-draft'),
  executable: z.literal(false),
});
export const concurrencyListSchema = z.strictObject({
  definitions: z.array(concurrencySummarySchema),
  attempts: z.array(archiveAttemptSchema),
});
export const saveConcurrencyBindingsSchema = z
  .strictObject({
    expectedRevision: z.number().int().nonnegative(),
    bindings: z
      .array(
        z.strictObject({
          alias: id,
          planVersionId: planVersionIdSchema.optional(),
          repositoryId: sourceRepositoryIdSchema.optional(),
        }),
      )
      .max(32),
  })
  .refine(
    (v) => new Set(v.bindings.map((b) => b.alias)).size === v.bindings.length,
    'Choose each repository alias once.',
  );
export type SaveConcurrencyBindings = z.infer<typeof saveConcurrencyBindingsSchema>;
const planOption = z.strictObject({
  projectId: projectIdSchema,
  projectName: text,
  planVersionId: planVersionIdSchema,
  versionNumber: z.number().int(),
  document: text,
  exactSources: z.boolean(),
  archiveMatched: z.boolean(),
  issues: z.array(importIssueSchema),
  repositoryId: sourceRepositoryIdSchema.optional(),
  integrationBranch: text.optional(),
});
const requirement = z.strictObject({
  phase: z.enum(['start', 'merge', 'verify', 'accept', 'evaluate']),
  kind: z.enum(['work_item', 'slice', 'checkpoint']),
  id,
  state: z.enum(['started', 'merged', 'verified', 'accepted', 'passed']),
});
export const concurrencyDetailSchema = z.strictObject({
  summary: concurrencySummarySchema,
  archiveId: z.uuid(),
  archiveDigest: digest,
  repositories: z.array(
    z.strictObject({
      alias: id,
      name: text,
      role: z.enum(['planned_application', 'implemented_upstream']),
      suggestedBranch: text.nullable(),
      archiveFilename: text,
      archiveDigest: digest,
      sources: z.array(z.strictObject({ id, path: text, sha256: digest })),
      options: z.array(planOption),
      selectedPlanVersionId: planVersionIdSchema.optional(),
      selectedRepositoryId: sourceRepositoryIdSchema.optional(),
      boundWorkItems: z.array(z.strictObject({ sourceId: id, workItemId: workItemIdSchema })),
      issues: z.array(importIssueSchema),
    }),
  ),
  sourceRepositories: z.array(z.strictObject({ id: sourceRepositoryIdSchema, name: text })),
  blockers: z.array(importIssueSchema),
  nodes: z.array(
    z.strictObject({
      id,
      kind: z.enum(['work-item', 'slice', 'checkpoint']),
      title: text,
      description: text,
      parentId: id.optional(),
      evidenceProfile: id,
      requirements: z.array(requirement),
      resources: z.array(z.strictObject({ phase: z.enum(['start', 'merge', 'verify']), id })),
      sourceIds: z.array(id),
      decisionIds: z.array(id),
      caseIds: z.array(id),
      criteria: z.array(text),
    }),
  ),
  decisions: z.array(z.strictObject({ id, title: text, proposal: text })),
  evidenceProfiles: z.array(
    z.strictObject({ id, requiredEvidence: z.array(text), reviewerRoles: z.array(text) }),
  ),
  resources: z.array(
    z.strictObject({
      id,
      description: text,
      requiresHardware: z.boolean(),
      requiresAuthorization: z.boolean(),
    }),
  ),
  targets: z.array(z.strictObject({ id, checkpoint: id, scope: text, isRelease: z.boolean() })),
  suggestedTarget: id,
  limitations: z.array(text),
  history: z.array(
    z.strictObject({ revision: z.number().int(), createdAt: z.string(), aliases: z.array(id) }),
  ),
});
export type ConcurrencyDetail = z.infer<typeof concurrencyDetailSchema>;
export type ConcurrencyList = z.infer<typeof concurrencyListSchema>;
export type PlanArchivePreview = z.infer<typeof planArchivePreviewSchema>;
export type ArchivePlanImportResponse = z.infer<typeof archivePlanImportResponseSchema>;
export type ConcurrencyImportResponse = z.infer<typeof concurrencyImportResponseSchema>;
