import { AGENT_PROFILE_PURPOSES } from '@craftingtable/domain';
import { describe, expect, it } from 'vitest';
import {
  agentProfileSchema,
  agentSelectionSchema,
  effectiveAgentSchema,
  effectiveAgentsSchema,
  roadmapAgentsSchema,
} from '../src/agent-profiles.js';
import { runProfilesResponseSchema } from '../src/execution.js';
import { crossProjectConfigurationSchema } from '../src/cross-project.js';
import {
  finalizationSchema,
  finalizationStageSchema,
  finalizationViewSchema,
} from '../src/finalization.js';
import { decisionPreparationSettingsSchema, roadmapAutomationSchema } from '../src/roadmap.js';
import {
  cycleProfilesSchema,
  cycleProjectionSchema,
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

describe('effective selections on the wire (R-E5a)', () => {
  const agent = {
    selection: { backend: 'codex', model: 'm' },
    source: { layer: 'roadmap-assignment', slot: 'review', assignmentId: 'a' },
    permissionMode: 'edit-only',
    inherited: {
      selection: { backend: 'codex' },
      source: { layer: 'saved-definition', slot: 'review' },
    },
  };
  const all = Object.fromEntries(AGENT_PROFILE_PURPOSES.map((p) => [p, agent]));
  it('reads a selection, its source by code, its permissions and what it overrides', () => {
    expect(effectiveAgentSchema.parse(agent)).toEqual(agent);
    expect(effectiveAgentSchema.safeParse({ ...agent, source: { layer: 'browser' } }).success).toBe(
      false,
    );
    expect(
      effectiveAgentSchema.safeParse({ ...agent, source: { ...agent.source, reason: 'x' } })
        .success,
    ).toBe(false);
    expect(effectiveAgentsSchema.parse(all)).toEqual(all);
    const { conflict: _missing, ...partial } = all;
    expect(effectiveAgentsSchema.safeParse(partial).success).toBe(false);
  });
  it('is optional in each response that carries it, so an older daemon’s answer still reads', () => {
    expect(runProfilesResponseSchema.parse({ profiles: [] })).toEqual({ profiles: [] });
    expect(runProfilesResponseSchema.parse({ profiles: [], agents: all }).agents).toEqual(all);
    const projection = {
      nextAgentSelections: {
        design: { backend: 'codex' },
        implement: { backend: 'codex' },
        review: { backend: 'codex' },
        remediate: { backend: 'codex' },
      },
      actions: [],
    };
    expect(cycleProjectionSchema.parse(projection)).toEqual(projection);
    expect(cycleProjectionSchema.parse({ ...projection, agents: all }).agents).toEqual(all);
    expect(
      decisionPreparationSettingsSchema.shape.decisions.element.shape.agent.parse(agent),
    ).toEqual(agent);
    expect(
      finalizationViewSchema.shape.agents.parse({
        current: agent,
        stages: [{ id: 's', review: agent, implement: agent }],
      }),
    ).toMatchObject({ stages: [{ id: 's' }] });
    expect(
      roadmapAgentsSchema.shape.roadmaps.element.shape.entries.element.shape.agents.parse(all),
    ).toEqual(all);
  });
});
