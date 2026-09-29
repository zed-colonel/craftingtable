import {
  ATTENTION_CLAIMS,
  ATTENTION_ITEM_ACTIONS,
  ATTENTION_ITEM_CODES,
  type AttentionItemCode,
  CYCLE_ATTENTION,
  CYCLE_ATTENTION_CODES,
  type CycleAttentionCode,
  OUTPUT_REPAIR_LIMIT,
  PHASE_BLOCKER_CODES,
  type PhaseBlockerCode,
  ROADMAP_ATTENTION,
  ROADMAP_ATTENTION_CODES,
  type RoadmapAttentionCode,
} from '@craftingtable/domain';
import { z } from 'zod';

/** Typed attention on the wire (R-A3). The owner must be the one the code declares. */
const attentionRefsSchema = z
  .strictObject({
    checkpointId: z.string().min(1).max(200).optional(),
    cycleId: z.string().min(1).max(200).optional(),
    entryId: z.string().min(1).max(200).optional(),
    definitionId: z.string().min(1).max(200).optional(),
    pins: z
      .array(
        z.strictObject({
          alias: z.string().min(1).max(200),
          pinnedCommitSha: z.string().regex(/^[0-9a-f]{40,64}$/),
          currentCommitSha: z.string().regex(/^[0-9a-f]{40,64}$/),
        }),
      )
      .min(1)
      .max(50)
      .optional(),
  })
  .optional();
const ownerSchema = z.enum(['operator', 'controller']);

export const cycleAttentionSchema = z
  .strictObject({
    code: z.enum(CYCLE_ATTENTION_CODES as [CycleAttentionCode, ...CycleAttentionCode[]]),
    owner: ownerSchema,
    claim: z.enum(ATTENTION_CLAIMS).optional(),
    refs: attentionRefsSchema,
    detail: z.string().max(2000).optional(),
    repairAttempts: z.number().int().min(1).max(OUTPUT_REPAIR_LIMIT).optional(),
  })
  .refine(
    (a) => a.owner === (a.claim ? 'controller' : CYCLE_ATTENTION[a.code]),
    'The attention owner must be the one its code declares, or the controller for a claim.',
  );

export const roadmapAttentionSchema = z
  .strictObject({
    code: z.enum(ROADMAP_ATTENTION_CODES as [RoadmapAttentionCode, ...RoadmapAttentionCode[]]),
    owner: ownerSchema,
    refs: attentionRefsSchema,
  })
  .refine(
    (a) => ROADMAP_ATTENTION[a.code] === a.owner,
    'The attention owner must be the one its code declares.',
  );

export const phaseBlockerCodeSchema = z.enum(
  PHASE_BLOCKER_CODES as [PhaseBlockerCode, ...PhaseBlockerCode[]],
);

/** Operator wait over a recent window (R-C1). */
export const operatorWaitReportSchema = z.strictObject({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  waitingHours: z.number().nonnegative(),
  idleWaitingHours: z.number().nonnegative(),
  agentHours: z.number().nonnegative(),
  kinds: z
    .array(
      z.strictObject({
        kind: z.union([
          z.enum(CYCLE_ATTENTION_CODES as [CycleAttentionCode, ...CycleAttentionCode[]]),
          z.literal('paused'),
        ]),
        stops: z.number().int().nonnegative(),
        cycleHours: z.number().nonnegative(),
      }),
    )
    .max(200),
});
export type OperatorWaitReportResponse = z.infer<typeof operatorWaitReportSchema>;

/** An attention item's code (R-A4): a cycle, roadmap or item-only stop. */
export const attentionItemCodeSchema = z.enum(
  ATTENTION_ITEM_CODES as [AttentionItemCode, ...AttentionItemCode[]],
);
const itemRef = z.string().min(1).max(200).optional();
export const attentionItemRefsSchema = z.strictObject({
  cycleId: itemRef,
  runId: itemRef,
  worktreeId: itemRef,
  workItemId: itemRef,
  projectId: itemRef,
  planVersionId: itemRef,
  roadmapId: itemRef,
  entryId: itemRef,
  finalizationId: itemRef,
});
export const attentionItemActionSchema = z.enum(ATTENTION_ITEM_ACTIONS);
export const attentionResolutionSchema = z.enum(['operator', 'automation', 'superseded']);

/** One open item as the inbox shows it (R-A5). Delivery internals stay on the daemon. */
export const attentionItemViewSchema = z.strictObject({
  id: z.string().min(1),
  subjectKey: z.string().min(1),
  code: attentionItemCodeSchema,
  kind: z.enum(['merge', 'attention']),
  title: z.string(),
  message: z.string(),
  /** Where the subject's own controls live. */
  path: z.string(),
  /** The item's page in the inbox; notifications link here. */
  inboxPath: z.string(),
  refs: attentionItemRefsSchema,
  members: z.array(z.string()).optional(),
  actions: z.array(attentionItemActionSchema).optional(),
  /** Work waiting on this item: dependent plan items, roadmap entries or map milestones. */
  blocks: z.number().int().nonnegative(),
  openedAt: z.iso.datetime(),
  pushedAt: z.iso.datetime().nullable(),
});
export type AttentionItemView = z.infer<typeof attentionItemViewSchema>;
export const attentionFeedSchema = z.strictObject({ items: z.array(attentionItemViewSchema) });
export type AttentionFeed = z.infer<typeof attentionFeedSchema>;
