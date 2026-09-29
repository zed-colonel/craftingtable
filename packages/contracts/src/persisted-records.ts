import {
  type ArchiveImportAttempt,
  type AttentionItem,
  type ConcurrencyBindingRevision,
  type ConcurrencyDefinition,
  type ConcurrencySource,
  type MapAdoption,
  type MergeOperation,
  type NotificationDelivery,
  PLAN_BUNDLE_DIGEST_ALGORITHM,
  PLAN_BUNDLE_DIGEST_FORMAT_VERSION,
  PLAN_SOURCE_PROFILES,
  type PlanArchiveLink,
  type PlanVersion,
  type ProtectedRefMove,
  type RunBuildRecord,
  type RunCheckReceipt,
  type RunEnvironment,
  type ScopeIntegrationReuse,
  type ScopeReceipt,
  WORK_ITEM_RISKS,
  WORK_ITEM_STATUSES,
  type WorkItem,
} from '@craftingtable/domain';
import { z } from 'zod';
import {
  attentionItemActionSchema,
  attentionItemCodeSchema,
  attentionItemRefsSchema,
  attentionResolutionSchema,
} from './attention.js';
import {
  agentRunSummarySchema,
  gitBranchNameSchema,
  gitShaSchema,
  jsonValueSchema,
} from './execution.js';
import { executionScopeSchema, scopeReviewEvidenceSchema } from './execution-scope.js';
import {
  agentRunIdSchema,
  planArtifactIdSchema,
  planBundleIdSchema,
  planVersionIdSchema,
  projectIdSchema,
  sourceRepositoryIdSchema,
  userIdSchema,
  workItemIdSchema,
  workspaceIdSchema,
  worktreeIdSchema,
} from './ids.js';
import { notificationPreferencesSchema } from './notification.js';
import { importIssueSchema } from './package-imports.js';
import { storagePolicySchema } from './storage-policy.js';
import { equivalentSchema } from './type-equivalence.js';

/**
 * Schemas for records storage keeps that no wire contract already describes (R-H3). The
 * daemon validates every write against them and `pnpm db:verify` checks every stored row.
 * Each is pinned to its domain type, so a field added to one and not the other fails to
 * compile. Bounds here are the stored invariants, not display limits: a record that the
 * daemon wrote in normal use must pass.
 */

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().safe();
const positive = z.number().int().positive().safe();
const text = z.string();
const name = z.string().min(1);

/** A protected ref move the daemon flagged, and its acknowledgement once given (R-G5). */
export const protectedRefMoveSchema = equivalentSchema<ProtectedRefMove>()(
  z
    .strictObject({
      id: z.uuid(),
      workspaceId: workspaceIdSchema,
      repositoryId: name,
      runId: agentRunIdSchema,
      worktreeId: worktreeIdSchema,
      detectedAt: z.iso.datetime(),
      moves: z
        .array(
          z.strictObject({
            branch: z.string().min(1).max(1024),
            before: gitShaSchema.nullable(),
            after: gitShaSchema.nullable(),
          }),
        )
        .min(1)
        .max(1000),
      acknowledgedAt: z.iso.datetime().optional(),
      acknowledgedByUserId: userIdSchema.optional(),
    })
    .refine(
      (m) => (m.acknowledgedAt === undefined) === (m.acknowledgedByUserId === undefined),
      'An acknowledgement names both when and who.',
    ),
);

export const mergeOperationSchema = equivalentSchema<MergeOperation>()(
  z.strictObject({
    id: z.uuid(),
    workspaceId: workspaceIdSchema,
    worktreeId: worktreeIdSchema,
    status: z.enum(['reserved', 'failed', 'merged', 'cleaned']),
    sourceSha: gitShaSchema,
    targetSha: gitShaSchema,
    targetBranch: gitBranchNameSchema,
    reviewRunId: agentRunIdSchema,
    createdAt: z.iso.datetime(),
    authorizedByUserId: userIdSchema,
    roadmapId: z.uuid().optional(),
    definitionRevision: positive.optional(),
    mergeSha: gitShaSchema.optional(),
    cleanupError: text.optional(),
    removeIntegrationBranch: z.boolean().optional(),
  }),
);

export const runEnvironmentSchema = equivalentSchema<RunEnvironment>()(
  z.strictObject({
    architectureDecisionDigest: digest.optional(),
    nativeApprovalId: z.uuid().optional(),
    runId: name,
    workspaceId: workspaceIdSchema,
    runtimeId: z.uuid(),
    manifestPath: name,
    manifestDigest: digest,
    verificationMode: z.literal('current-upstream-build').optional(),
    receiptAuthority: z.literal('daemon').optional(),
  }),
);

export const runCheckReceiptSchema = equivalentSchema<RunCheckReceipt>()(
  z.strictObject({
    runId: name,
    workspaceId: workspaceIdSchema,
    sequence: positive,
    receipt: text,
    recordedAt: z.iso.datetime(),
  }),
);

export const runBuildRecordSchema = equivalentSchema<RunBuildRecord>()(
  z.strictObject({
    runId: name,
    workspaceId: workspaceIdSchema,
    runtimeId: z.uuid(),
    manifestDigest: digest,
    receipts: text,
    digest,
    error: text.optional(),
  }),
);

export const scopeReceiptSchema = equivalentSchema<ScopeReceipt>()(
  z.strictObject({
    reviewerRoles: z.array(name).optional(),
    id: z.uuid(),
    workspaceId: workspaceIdSchema,
    workItemId: workItemIdSchema,
    scope: executionScopeSchema,
    worktreeId: worktreeIdSchema,
    reviewRunId: agentRunIdSchema,
    headSha: gitShaSchema,
    integrationSha: gitShaSchema,
    evidence: scopeReviewEvidenceSchema,
    recordedAt: z.iso.datetime(),
    recordedByUserId: userIdSchema,
  }),
);

/** The stored attempt; the wire's `archiveAttemptSchema` is a view that adds the file name. */
export const archiveImportAttemptRecordSchema = equivalentSchema<ArchiveImportAttempt>()(
  z.strictObject({
    id: z.uuid(),
    workspaceId: workspaceIdSchema,
    archiveId: z.uuid(),
    kind: z.enum(['plan', 'concurrency']),
    outcome: z.enum(['succeeded', 'duplicate', 'failed-validation', 'conflict']),
    createdAt: z.iso.datetime(),
    createdByUserId: userIdSchema,
    diagnostics: z.array(importIssueSchema),
    definitionId: z.uuid().optional(),
    planVersionId: planVersionIdSchema.optional(),
  }),
);

/**
 * A saved v0.3 map. The source is the format's own document: its structure belongs to the
 * planning package's reviewed JSON Schema, which the daemon applies alongside this one.
 */
export const concurrencyDefinitionRecordSchema = equivalentSchema<ConcurrencyDefinition>()(
  z.strictObject({
    id: z.uuid(),
    workspaceId: workspaceIdSchema,
    archiveId: z.uuid(),
    mapId: name,
    revision: name,
    digest,
    source: z.custom<ConcurrencySource>(
      (value) => typeof value === 'object' && value !== null && !Array.isArray(value),
      { message: 'A concurrency map source must be an object' },
    ),
    graphNodeCount: count,
    graphEdgeCount: count,
    createdAt: z.iso.datetime(),
    createdByUserId: userIdSchema,
  }),
);

export const concurrencyBindingRecordSchema = equivalentSchema<ConcurrencyBindingRevision>()(
  z.strictObject({
    definitionId: z.uuid(),
    workspaceId: workspaceIdSchema,
    revision: positive,
    createdAt: z.iso.datetime(),
    createdByUserId: userIdSchema,
    bindings: z.array(
      z.strictObject({
        alias: name,
        projectId: projectIdSchema.optional(),
        planVersionId: planVersionIdSchema.optional(),
        repositoryId: sourceRepositoryIdSchema.optional(),
        integrationBranch: gitBranchNameSchema.optional(),
        branchSettingsVersion: positive.optional(),
        sourceArtifacts: z.array(
          z.strictObject({ sourceId: name, artifactId: planArtifactIdSchema, sha256: digest }),
        ),
        workItems: z.array(
          z.strictObject({
            sourceId: name,
            workItemId: workItemIdSchema,
            sourceRecordDigest: digest,
          }),
        ),
      }),
    ),
  }),
);

export const planArchiveLinkSchema = equivalentSchema<PlanArchiveLink>()(
  z.strictObject({
    workspaceId: workspaceIdSchema,
    planVersionId: planVersionIdSchema,
    archiveId: z.uuid(),
    implementationPlan: name,
    workBreakdown: name,
    selectedPaths: z.array(name),
  }),
);

export const mapAdoptionSchema = equivalentSchema<MapAdoption>()(
  z.strictObject({
    id: z.uuid(),
    workspaceId: workspaceIdSchema,
    definitionId: z.uuid(),
    bindingRevision: positive,
    decisionIds: z.array(name),
    rationale: name,
    createdAt: z.iso.datetime(),
    createdByUserId: userIdSchema,
  }),
);

export const scopeIntegrationReuseSchema = equivalentSchema<ScopeIntegrationReuse>()(
  z.strictObject({
    id: z.uuid(),
    amendmentId: z.uuid(),
    workspaceId: workspaceIdSchema,
    workItemId: workItemIdSchema,
    scope: executionScopeSchema,
    sourceWorktreeId: worktreeIdSchema,
    mergeSha: gitShaSchema,
    recordedAt: z.iso.datetime(),
  }),
);

/** A run as storage keeps it: the wire summary plus the brief the agent was given. */
export const agentRunRecordSchema = agentRunSummarySchema.safeExtend({ brief: text });

export const planVersionRecordSchema = equivalentSchema<PlanVersion>()(
  z.strictObject({
    id: planVersionIdSchema,
    workspaceId: workspaceIdSchema,
    projectId: projectIdSchema,
    bundleId: planBundleIdSchema,
    versionNumber: positive,
    contentDigest: digest,
    digestAlgorithm: z.literal(PLAN_BUNDLE_DIGEST_ALGORITHM),
    digestFormatVersion: z.literal(PLAN_BUNDLE_DIGEST_FORMAT_VERSION),
    sourceProfile: z.enum(PLAN_SOURCE_PROFILES),
    document: name,
    normalizedSource: jsonValueSchema,
    itemCount: count,
    requiredDependencyCount: count,
    createdAt: z.iso.datetime(),
    createdByUserId: userIdSchema,
  }),
);

export const workItemRecordSchema = equivalentSchema<WorkItem>()(
  z.strictObject({
    id: workItemIdSchema,
    workspaceId: workspaceIdSchema,
    projectId: projectIdSchema,
    planVersionId: planVersionIdSchema,
    sourceId: name,
    ordinal: count,
    title: name,
    status: z.enum(WORK_ITEM_STATUSES),
    risk: z.enum(WORK_ITEM_RISKS),
    phase: text.optional(),
    primaryAreas: z.array(text),
    exitGate: text,
    sourceFields: jsonValueSchema,
    admittedAt: z.iso.datetime().optional(),
    admittedByUserId: userIdSchema.optional(),
    completedAt: z.iso.datetime().optional(),
    completedByUserId: userIdSchema.optional(),
    completionWorktreeId: worktreeIdSchema.optional(),
    mergeSha: gitShaSchema.optional(),
    version: positive,
  }),
);

/**
 * Storage-private records. Their types live in the storage package, which contracts cannot
 * import; the daemon pins these schemas to them where it maps kinds to schemas.
 */
export const storedNotificationSettingsSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  ownerUserId: userIdSchema,
  preferences: notificationPreferencesSchema,
  applicationToken: text.nullable(),
  userKey: text.nullable(),
  version: positive,
  blockedReason: text.nullable(),
  retryAt: z.iso.datetime().nullable(),
});

export const notificationRecordSchema = z.strictObject({
  id: name,
  workspaceId: workspaceIdSchema,
  sourceKey: name,
  kind: z.enum(['merge', 'attention', 'test']),
  title: text,
  message: text,
  path: text,
  state: z.enum(['active', 'resolved']),
  createdAt: z.iso.datetime(),
  firstSentAt: z.iso.datetime().nullable(),
  lastSentAt: z.iso.datetime().nullable(),
  nextAttemptAt: z.iso.datetime(),
  deliveredCount: count,
  failures: count,
  lastError: text.nullable(),
  leaseToken: text.nullable(),
  leaseUntil: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().optional(),
  members: z.array(name).optional(),
});

/** An attention occurrence (R-A4). Resolved items are immutable; storage refuses updates. */
export const attentionItemSchema = equivalentSchema<AttentionItem>()(
  z.strictObject({
    id: name,
    workspaceId: workspaceIdSchema,
    scopeKey: name,
    subjectKey: name,
    code: attentionItemCodeSchema,
    kind: z.enum(['merge', 'attention']),
    title: text.max(250),
    message: text.max(4000),
    path: name,
    refs: attentionItemRefsSchema,
    members: z.array(name).optional(),
    actions: z.array(attentionItemActionSchema).optional(),
    blocks: count.optional(),
    state: z.enum(['open', 'resolved']),
    openedAt: z.iso.datetime(),
    resolvedAt: z.iso.datetime().optional(),
    resolvedBy: attentionResolutionSchema.optional(),
    continues: name.optional(),
    delivery: z.strictObject({
      firstSentAt: z.iso.datetime().nullable(),
      lastSentAt: z.iso.datetime().nullable(),
      deliveredCount: count,
      nextAttemptAt: z.iso.datetime(),
      failures: count,
      lastError: text.nullable(),
      leaseToken: text.nullable(),
      leaseUntil: z.iso.datetime().nullable(),
      since: z.iso.datetime().optional(),
    }),
  }),
);

/** One push attempt; the log is append-only (R-A4). */
export const notificationDeliverySchema = equivalentSchema<NotificationDelivery>()(
  z.strictObject({
    id: name,
    workspaceId: workspaceIdSchema,
    attemptedAt: z.iso.datetime(),
    itemIds: z.array(name),
    reminderItemIds: z.array(name),
    testId: name.optional(),
    title: text.max(250),
    message: text.max(1024),
    result: z.enum(['accepted', 'retry', 'blocked']),
    error: text.optional(),
  }),
);

const storageRootSchema = z.strictObject({ path: name, device: count });
export const storedStorageSettingsSchema = z.strictObject({
  version: positive,
  policy: storagePolicySchema,
  mergeRoot: storageRootSchema,
  roots: z.strictObject({
    worktreeRoot: storageRootSchema,
    runsRoot: storageRootSchema,
    backupRoot: storageRootSchema,
  }),
});
