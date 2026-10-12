import {
  AGENT_BACKENDS,
  AGENT_PERMISSION_MODES,
  AGENT_PROFILE_PURPOSES,
  AGENT_REASONING_EFFORTS,
  AGENT_SELECTION_LAYERS,
  type AgentAssignmentId,
  type AgentProfilePurpose,
  type AgentRunId,
  type CycleInvestigationId,
  type DecisionPreparationId,
  type DelegationAssignmentId,
  type EffectiveAgent,
  type RoadmapEntryId,
} from '@craftingtable/domain';
import { z } from 'zod';
import { equivalentSchema } from './type-equivalence.js';
import { branded } from './ids.js';
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
const agentSelectionSourceSchema = z.strictObject({
  layer: z.enum(AGENT_SELECTION_LAYERS),
  slot: z.enum(AGENT_PROFILE_PURPOSES).optional(),
  assignmentId: branded<AgentAssignmentId>(z.string().min(1).max(200)).optional(),
  delegationId: branded<DelegationAssignmentId>(z.string().min(1).max(200)).optional(),
  stageIndex: z.number().int().nonnegative().optional(),
  runId: branded<AgentRunId>(z.string().min(1).max(200)).optional(),
});
const agentResolutionSchema = z.strictObject({
  // Reported as held: a saved workspace default's model was never trimmed (`agentRunProfileSchema`).
  selection: agentSelectionSchema.extend({ model: z.string().min(1).max(100).optional() }),
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
/**
 * A run's hand-off as the daemon offers it (R-E5b): the role the next run takes, and the agent the
 * hand-off form starts from, with its source. The run's role decides the target: a design hands
 * to implementation, an implementation to review, a review to remediation (an implement run).
 */
const runHandoffSchema = z.strictObject({
  role: z.enum(['implement', 'review']),
  agent: effectiveAgentSchema,
});
/** Each listed run's hand-off, by run id. */
export const runHandoffsSchema = z.record(z.string().min(1).max(200), runHandoffSchema);
export const profileSelectionSchema = z.strictObject({
  purpose: z.enum(AGENT_PROFILE_PURPOSES),
  assignmentId: branded<AgentAssignmentId>(z.uuid()).optional(),
  delegationId: branded<DelegationAssignmentId>(z.uuid()).optional(),
  preparationId: branded<DecisionPreparationId>(z.uuid()).optional(),
  investigationId: branded<CycleInvestigationId>(z.uuid()).optional(),
});
export const applyRoadmapAgentsSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  entryIds: z.array(branded<RoadmapEntryId>(z.uuid())).min(1).max(2000),
  selections: agentSelectionsSchema,
});
export type ApplyRoadmapAgents = z.infer<typeof applyRoadmapAgentsSchema>;
