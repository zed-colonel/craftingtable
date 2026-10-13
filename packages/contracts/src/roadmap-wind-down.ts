import {
  type AttentionItemId,
  CLEANUP_CODES,
  type CleanupAction,
  type CleanupPreview,
  CYCLE_STATUSES,
  type DecisionPreparationId,
  type MapAmendmentId,
  RETIREMENT_DISPOSITIONS,
  type RepositoryCleanup,
  type RepositoryCleanupId,
  type RepositoryCleanupView,
  ROADMAP_STATUSES,
  type RoadmapEntryId,
  type RoadmapWindDown,
  type RoadmapWindDownId,
  type RoadmapWindDownView,
  type SourceRepositoryId,
  WIND_DOWN_REFUSALS,
  WIND_DOWN_STEPS,
  type WindDownPreview,
  type WorkCycleId,
} from '@craftingtable/domain';
import { z } from 'zod';
import { attentionItemCodeSchema } from './attention.js';
import { gitBranchNameSchema } from './execution.js';
import {
  agentRunIdSchema,
  branded,
  planVersionIdSchema,
  projectIdSchema,
  userIdSchema,
  workspaceIdSchema,
  worktreeIdSchema,
} from './ids.js';
import { roadmapIdSchema } from './roadmap.js';
import { equivalentSchema } from './type-equivalence.js';

/** Winding down a roadmap (R-B11, ADR-073): its records and the commands' wire shapes. */

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const message = z.string().min(1).max(4000);
const fullSha = z.string().regex(/^[0-9a-f]{40,64}$/);

const retirementChoiceSchema = z.strictObject({
  planVersionId: planVersionIdSchema,
  disposition: z.enum(RETIREMENT_DISPOSITIONS),
});

const retirementChoicesSchema = z
  .array(retirementChoiceSchema)
  .max(50)
  .refine(
    (choices) => new Set(choices.map((c) => c.planVersionId)).size === choices.length,
    'Each plan version is chosen once.',
  );

/** A roadmap's settlement record (R-B11). */
export const roadmapWindDownSchema = equivalentSchema<RoadmapWindDown>()(
  z
    .strictObject({
      id: branded<RoadmapWindDownId>(z.uuid()),
      workspaceId: workspaceIdSchema,
      roadmapId: roadmapIdSchema,
      version: z.number().int().positive().safe(),
      status: z.enum(['settling', 'settled']),
      retire: retirementChoicesSchema,
      abandonResolutions: z.array(branded<WorkCycleId>(z.uuid())).max(1000),
      previewDigest: digest,
      requestedAt: z.iso.datetime(),
      requestedByUserId: userIdSchema,
      startedAt: z.iso.datetime(),
      settledAt: z.iso.datetime().optional(),
      incomplete: z
        .strictObject({ step: z.enum(WIND_DOWN_STEPS), at: z.iso.datetime(), message })
        .optional(),
    })
    .refine(
      (r) => (r.status === 'settled') === (r.settledAt !== undefined),
      'A settled wind-down records when; a settling one does not.',
    )
    .refine((r) => r.status === 'settling' || r.incomplete === undefined, {
      message: 'Only a settling wind-down can be incomplete.',
      path: ['incomplete'],
    }),
);

const actionStateSchema = z.enum(['planned', 'authorized', 'done', 'kept', 'refused']);
const cleanupCodeSchema = z.enum(CLEANUP_CODES);
const repositoryIdSchema = branded<SourceRepositoryId>(z.string().min(1));

const cleanupActionSchema = equivalentSchema<CleanupAction>()(
  z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('remove-worktree'),
      worktreeId: worktreeIdSchema,
      repositoryId: repositoryIdSchema,
      branchName: gitBranchNameSchema,
      state: actionStateSchema,
      code: cleanupCodeSchema.optional(),
      note: message.optional(),
    }),
    z.strictObject({
      kind: z.literal('delete-branch'),
      repositoryId: repositoryIdSchema,
      branchName: gitBranchNameSchema,
      tipSha: fullSha,
      keeper: z.discriminatedUnion('kind', [
        z.strictObject({
          kind: z.literal('integration'),
          branch: gitBranchNameSchema,
          pinnedSha: fullSha,
        }),
        z.strictObject({ kind: z.literal('parked-tag'), tag: gitBranchNameSchema }),
      ]),
      state: actionStateSchema,
      code: cleanupCodeSchema.optional(),
      note: message.optional(),
    }),
  ]),
);

/** A roadmap's repository cleanup: its pinned plan and each action's state (R-B11). */
export const repositoryCleanupSchema = equivalentSchema<RepositoryCleanup>()(
  z
    .strictObject({
      id: branded<RepositoryCleanupId>(z.uuid()),
      workspaceId: workspaceIdSchema,
      roadmapId: roadmapIdSchema,
      version: z.number().int().positive().safe(),
      status: z.enum(['running', 'done']),
      planDigest: digest,
      discardDirty: z.boolean(),
      actions: z.array(cleanupActionSchema).max(5000),
      requestedAt: z.iso.datetime(),
      requestedByUserId: userIdSchema,
      finishedAt: z.iso.datetime().optional(),
      incomplete: z.strictObject({ at: z.iso.datetime(), message }).optional(),
    })
    .refine(
      (c) => (c.status === 'done') === (c.finishedAt !== undefined),
      'A finished cleanup records when; a running one does not.',
    )
    .refine(
      (c) =>
        c.status === 'running' ||
        c.actions.every((a) => a.state !== 'planned' && a.state !== 'authorized'),
      'A finished cleanup has no action left to do.',
    ),
);

const refusalSchema = z.strictObject({ code: z.enum(WIND_DOWN_REFUSALS), message });
const id = <T extends string>() => branded<T>(z.string().min(1).max(200));

/** What a wind-down would do now, with its digest (ADR-073). */
const windDownPreviewSchema = equivalentSchema<WindDownPreview>()(
  z.strictObject({
    roadmapId: roadmapIdSchema,
    status: z.enum(ROADMAP_STATUSES),
    digest,
    cycles: z
      .array(
        z.strictObject({
          cycleId: id<WorkCycleId>(),
          entryId: id<RoadmapEntryId>().optional(),
          label: z.string().max(200),
          status: z.enum(CYCLE_STATUSES),
          liveRunId: agentRunIdSchema.optional(),
          investigation: z.boolean(),
          abandonsResolution: z.boolean(),
          reservedMerge: z.boolean(),
        }),
      )
      .max(5000),
    preparations: z
      .array(
        z.strictObject({
          preparationId: id<DecisionPreparationId>(),
          checkpointId: z.string().min(1).max(200),
          runId: agentRunIdSchema,
          live: z.boolean(),
        }),
      )
      .max(5000),
    amendmentId: id<MapAmendmentId>().optional(),
    attention: z
      .array(
        z.strictObject({
          itemId: id<AttentionItemId>(),
          code: attentionItemCodeSchema,
          title: z.string().max(400),
        }),
      )
      .max(5000),
    versions: z
      .array(
        z.strictObject({
          planVersionId: planVersionIdSchema,
          projectId: projectIdSchema,
          projectName: z.string().max(300),
          versionNumber: z.number().int().positive(),
          active: z.boolean(),
          admittedItems: z.number().int().nonnegative(),
          activeWorktrees: z.number().int().nonnegative(),
          retired: z.enum(RETIREMENT_DISPOSITIONS).optional(),
          refusal: refusalSchema.optional(),
        }),
      )
      .max(500),
    refusals: z.array(refusalSchema).max(20),
  }),
);

/** A roadmap's settlement record and what winding it down would do now (R-B11). */
export const roadmapWindDownViewSchema = equivalentSchema<RoadmapWindDownView>()(
  z.strictObject({
    record: roadmapWindDownSchema.optional(),
    preview: windDownPreviewSchema,
  }),
);

/** Wind down a roadmap: the preview's digest and the versions to retire (R-B11, decision 5). */
export const windDownRequestSchema = z.strictObject({
  expectedDigest: digest,
  retire: retirementChoicesSchema,
});

const cleanupPreviewSchema = equivalentSchema<CleanupPreview>()(
  z.strictObject({
    roadmapId: roadmapIdSchema,
    digest,
    actions: z.array(cleanupActionSchema).max(5000),
    refusals: z.array(refusalSchema).max(20),
  }),
);

/** A roadmap's running or latest cleanup, or what one would do now (R-B11). */
export const repositoryCleanupViewSchema = equivalentSchema<RepositoryCleanupView>()(
  z.strictObject({
    running: repositoryCleanupSchema.optional(),
    latest: repositoryCleanupSchema.optional(),
    preview: cleanupPreviewSchema.optional(),
  }),
);

/** Clean up a wound-down roadmap's repositories: the plan's digest and the discard choice. */
export const cleanupRequestSchema = z.strictObject({
  expectedDigest: digest,
  discardDirty: z.boolean(),
});
