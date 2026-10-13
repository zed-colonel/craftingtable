import {
  type CleanupAction,
  CLEANUP_CODES,
  RETIREMENT_DISPOSITIONS,
  type RepositoryCleanup,
  type RepositoryCleanupId,
  type RoadmapWindDown,
  type RoadmapWindDownId,
  type SourceRepositoryId,
  WIND_DOWN_STEPS,
  type WorkCycleId,
} from '@craftingtable/domain';
import { z } from 'zod';
import { gitBranchNameSchema } from './execution.js';
import {
  branded,
  planVersionIdSchema,
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
