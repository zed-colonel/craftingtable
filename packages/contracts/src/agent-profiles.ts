import { projectIdSchema } from './ids.js';
import {
  AGENT_BACKENDS,
  AGENT_PERMISSION_MODES,
  AGENT_PROFILE_PURPOSES,
  AGENT_REASONING_EFFORTS,
  AGENT_SELECTION_LAYERS,
  type AgentProfilePurpose,
  type EffectiveAgent,
} from '@craftingtable/domain';
import { z } from 'zod';
import { equivalentSchema } from './type-equivalence.js';
export const reasoningEffortSchema = z.enum(AGENT_REASONING_EFFORTS);
/** Both backends take a reasoning effort (Claude since the operator's decision 2026-09-28). */
export const agentSelectionSchema = z.strictObject({
  backend: z.enum(AGENT_BACKENDS),
  model: z.string().trim().min(1).max(100).optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
});
/**
 * A selection with its step's permissions (`AgentProfile`). The keys keep the order saved
 * records were written in: a saved roadmap entry is compared with its resubmitted form as JSON.
 */
export const agentProfileSchema = z.strictObject({
  reasoningEffort: reasoningEffortSchema.optional(),
  backend: agentSelectionSchema.shape.backend,
  permissionMode: z.enum(AGENT_PERMISSION_MODES),
  model: agentSelectionSchema.shape.model,
});
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
/** Where an effective selection came from (R-E5a): its layer and the slot or record in it. */
export const agentSelectionSourceSchema = z.strictObject({
  layer: z.enum(AGENT_SELECTION_LAYERS),
  slot: z.enum(AGENT_PROFILE_PURPOSES).optional(),
  assignmentId: z.string().min(1).max(200).optional(),
  delegationId: z.string().min(1).max(200).optional(),
  stageIndex: z.number().int().nonnegative().optional(),
});
const agentResolutionSchema = z.strictObject({
  selection: agentSelectionSchema,
  source: agentSelectionSourceSchema,
});
/**
 * An effective selection as the daemon reports it (R-E5a, E5-2): the selection, its source, the
 * permissions it runs with where the place has them, and the value it overrides. The browser
 * shows these instead of deriving them.
 */
export const effectiveAgentSchema = equivalentSchema<EffectiveAgent>()(
  agentResolutionSchema.extend({
    permissionMode: z.enum(AGENT_PERMISSION_MODES).optional(),
    inherited: agentResolutionSchema.optional(),
  }),
);
/** An effective selection for every purpose. */
export const effectiveAgentsSchema = equivalentSchema<
  Readonly<Record<AgentProfilePurpose, EffectiveAgent>>
>()(
  z.strictObject(
    Object.fromEntries(AGENT_PROFILE_PURPOSES.map((p) => [p, effectiveAgentSchema])) as Record<
      AgentProfilePurpose,
      typeof effectiveAgentSchema
    >,
  ),
);
export const profileSelectionSchema = z.strictObject({
  purpose: z.enum(AGENT_PROFILE_PURPOSES),
  assignmentId: z.uuid().optional(),
  delegationId: z.uuid().optional(),
  preparationId: z.uuid().optional(),
  investigationId: z.uuid().optional(),
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
          /** Each purpose's effective selection and its source (R-E5a). */
          agents: effectiveAgentsSchema.optional(),
          appliedAt: z.iso.datetime().optional(),
          started: z.boolean(),
        }),
      ),
    }),
  ),
});
export type RoadmapAgents = z.infer<typeof roadmapAgentsSchema>;
export type ApplyRoadmapAgents = z.infer<typeof applyRoadmapAgentsSchema>;
