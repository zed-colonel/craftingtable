import { projectIdSchema } from './ids.js';
import {
  AGENT_BACKENDS,
  AGENT_PROFILE_PURPOSES,
  AGENT_REASONING_EFFORTS,
} from '@craftingtable/domain';
import { z } from 'zod';
export const reasoningEffortSchema = z.enum(AGENT_REASONING_EFFORTS);
export const agentSelectionSchema = z
  .strictObject({
    backend: z.enum(AGENT_BACKENDS),
    model: z.string().trim().min(1).max(100).optional(),
    reasoningEffort: reasoningEffortSchema.optional(),
  })
  .refine(
    (p) => p.backend === 'codex' || p.reasoningEffort === undefined,
    'Reasoning effort is supported for Codex profiles only.',
  );
export const specialistSelectionsShape = {
  security: agentSelectionSchema.optional(),
  checkpoint: agentSelectionSchema.optional(),
  acceptance: agentSelectionSchema.optional(),
  conflict: agentSelectionSchema.optional(),
  investigation: agentSelectionSchema.optional(),
};
export const agentSelectionsSchema = z.strictObject({
  design: agentSelectionSchema,
  implement: agentSelectionSchema,
  review: agentSelectionSchema,
  remediate: agentSelectionSchema,
  ...specialistSelectionsShape,
});
export const profileSelectionSchema = z.strictObject({
  purpose: z.enum(AGENT_PROFILE_PURPOSES),
  assignmentId: z.uuid().optional(),
  delegationId: z.uuid().optional(),
  preparationId: z.uuid().optional(),
});
export const applyRoadmapAgentsSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  entryIds: z.array(z.uuid()).min(1).max(2000),
  selections: agentSelectionsSchema,
});
export const roadmapAgentsSchema = z.strictObject({
  roadmaps: z.array(
    z.strictObject({
      id: z.uuid(),
      name: z.string(),
      version: z.number().int().positive(),
      status: z.string(),
      editBlocker: z.string().nullable(),
      entries: z.array(
        z.strictObject({
          id: z.uuid(),
          label: z.string(),
          projectId: projectIdSchema,
          projectName: z.string(),
          selections: agentSelectionsSchema,
          appliedAt: z.iso.datetime().optional(),
          started: z.boolean(),
        }),
      ),
    }),
  ),
});
export type RoadmapAgents = z.infer<typeof roadmapAgentsSchema>;
export type ApplyRoadmapAgents = z.infer<typeof applyRoadmapAgentsSchema>;
