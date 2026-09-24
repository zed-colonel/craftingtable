import {
  ATTENTION_CLAIMS,
  CYCLE_ATTENTION,
  CYCLE_ATTENTION_CODES,
  type CycleAttentionCode,
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
