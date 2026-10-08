import { expect, it } from 'vitest';
import { agentProfileSchema, agentSelectionSchema } from '../src/agent-profiles.js';
import { crossProjectConfigurationSchema } from '../src/cross-project.js';
import { finalizationSchema, finalizationStageSchema } from '../src/finalization.js';
import { roadmapAutomationSchema } from '../src/roadmap.js';
import {
  cycleProfilesSchema,
  integrationResolutionSchema,
  recoverDesignRequestSchema,
  startInvestigationRequestSchema,
} from '../src/work-cycle.js';

/** R-E5a (DATA-11): one selection schema and one profile schema, wherever a choice is held. */
it('holds every step profile and every selection in the one profile and selection schema', () => {
  for (const step of ['design', 'implement', 'review', 'remediate'] as const)
    expect(cycleProfilesSchema.shape[step]).toBe(agentProfileSchema);
  expect(finalizationStageSchema.shape.review).toBe(agentProfileSchema);
  expect(finalizationStageSchema.shape.implement).toBe(agentProfileSchema);
  expect(finalizationSchema.shape.finalReview).toBe(agentProfileSchema);
  expect(roadmapAutomationSchema.shape.resolutionProfile.unwrap()).toBe(agentProfileSchema);
  expect(
    crossProjectConfigurationSchema.shape.defaults.shape.automation.shape.resolutionProfile.unwrap(),
  ).toBe(agentProfileSchema);
  expect(integrationResolutionSchema.shape.profile.unwrap()).toBe(agentProfileSchema);
  expect(recoverDesignRequestSchema.shape.profile).toBe(agentSelectionSchema);
  expect(startInvestigationRequestSchema.shape.profile.unwrap()).toBe(agentSelectionSchema);
});

it('reads a profile in the key order saved records were written in', () => {
  // A saved roadmap entry is compared with its resubmitted form as JSON (`saveDefinition`).
  expect(
    Object.keys(
      agentProfileSchema.parse({
        model: 'm',
        permissionMode: 'auto',
        backend: 'codex',
        reasoningEffort: 'low',
      }),
    ),
  ).toEqual(['reasoningEffort', 'backend', 'permissionMode', 'model']);
  expect(
    Object.keys(
      agentSelectionSchema.parse({ reasoningEffort: 'low', model: 'm', backend: 'codex' }),
    ),
  ).toEqual(['backend', 'model', 'reasoningEffort']);
  expect(
    agentProfileSchema.safeParse({ backend: 'codex', permissionMode: 'auto', role: 'x' }).success,
  ).toBe(false);
});
