import {
  decisionPreparationSettingsSchema,
  finalizationsResponseSchema,
  roadmapAgentsSchema,
  runProfilesResponseSchema,
  workCyclesResponseSchema,
  workItemViewSchema,
} from '@craftingtable/contracts';
import { agentSelections } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginFinalization,
  cleanupExecutionFixtures,
  cycleFixture,
  cycleProfiles,
  entryIds,
  finalizationFixture,
  mutationHeaders,
  type Ready,
  ready,
  roadmapFixture,
  roadmapId,
  roadmapInput,
  saveRoadmapRequest,
  startCycle,
  storedRoadmap,
  supervisedMapFixture,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

/**
 * R-E5a (E5-2): every response the browser derived an agent selection from carries the
 * daemon's effective selection and its source, so the browser derives nothing.
 */
const get = async (state: Ready, path: string) => {
  const response = await state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${state.workspaceId}${path}`,
    headers: { cookie: state.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as unknown;
};
const post = (state: Ready, path: string, payload: unknown) =>
  state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}${path}`,
    headers: mutationHeaders(state),
    payload: payload as Record<string, unknown>,
  });
const claude = (model?: string) => ({ backend: 'claude-code', ...(model ? { model } : {}) });

describe('workspace defaults (run-profiles and the page reads)', () => {
  it('reports each purpose’s default with its source: saved, inherited or the daemon’s', async () => {
    const state = await ready();
    const saved = await post(state, '/run-profiles', {
      profiles: [
        { role: 'implement', backend: 'claude-code', model: 'implement', permissionMode: 'auto' },
        { role: 'review', backend: 'claude-code', model: 'review', permissionMode: 'edit-only' },
      ],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const listed = runProfilesResponseSchema.parse(await get(state, '/run-profiles'));
    expect(runProfilesResponseSchema.parse(saved.json()).agents).toEqual(listed.agents);
    expect(listed.agents?.implement).toEqual({
      selection: claude('implement'),
      source: { layer: 'workspace-default', slot: 'implement' },
      permissionMode: 'auto',
      inherited: { selection: claude(), source: { layer: 'daemon-default' } },
    });
    expect(listed.agents?.conflict).toMatchObject({
      selection: claude('implement'),
      source: { layer: 'workspace-default', slot: 'implement' },
    });
    expect(listed.agents?.security).toMatchObject({
      selection: claude('review'),
      source: { layer: 'workspace-default', slot: 'review' },
      permissionMode: 'edit-only',
    });
    expect(listed.agents?.design).toEqual({
      selection: claude(),
      source: { layer: 'daemon-default' },
      permissionMode: 'auto',
    });
    // Each listed profile is its purpose's effective selection.
    for (const profile of listed.profiles)
      expect(listed.agents?.[profile.role].selection.model).toBe(profile.model);
    const page = workItemViewSchema.parse(await get(state, `/work-items/${state.workItemId}/view`));
    expect(page.agents).toEqual(listed.agents);
  });
});

describe('a cycle’s projection', () => {
  it('reports each purpose’s future agent with its source and the step permissions it runs with', async () => {
    const f = await cycleFixture([]);
    const profiles = {
      ...cycleProfiles,
      review: { ...cycleProfiles.review, permissionMode: 'edit-only' as const },
      security: claude('security-model'),
    };
    const cycle = await startCycle(f.state, f.worktree.id, { profiles });
    const { cycles } = workCyclesResponseSchema.parse(
      await get(f.state, `/cycles?workItemId=${f.state.workItemId}`),
    );
    const agents = cycles.find((v) => v.cycle.id === cycle.id)?.projection.agents;
    expect(agents?.implement).toEqual({
      selection: claude('implement-model'),
      source: { layer: 'cycle-start', slot: 'implement' },
      permissionMode: 'auto',
    });
    expect(agents?.security).toEqual({
      selection: claude('security-model'),
      source: { layer: 'cycle-start', slot: 'security' },
      permissionMode: 'edit-only',
      inherited: {
        selection: claude('review-model'),
        source: { layer: 'cycle-start', slot: 'review' },
      },
    });
    expect(agents?.investigation).toMatchObject({
      selection: claude('design-model'),
      source: { layer: 'cycle-start', slot: 'design' },
    });
  });
});

describe('roadmap setup (roadmaps/agent-profiles)', () => {
  it('reports each entry’s saved definition as the lowest layer, and an applied assignment over it', async () => {
    const { state } = await roadmapFixture();
    expect((await saveRoadmapRequest(state, roadmapInput(state))).statusCode).toBe(200);
    const before = roadmapAgentsSchema.parse(await get(state, '/roadmaps/agent-profiles'));
    expect(before.roadmaps[0]?.entries[0]?.agents?.review).toEqual({
      selection: claude('review-model'),
      source: { layer: 'saved-definition', slot: 'review' },
      permissionMode: 'auto',
    });
    const applied = await post(state, `/roadmaps/${roadmapId}/agent-profiles`, {
      expectedVersion: storedRoadmap(state).version,
      entryIds: [entryIds[0]],
      selections: { ...agentSelections(cycleProfiles), review: claude('assigned-review') },
    });
    expect(applied.statusCode, applied.body).toBe(200);
    const assignmentId = storedRoadmap(state).agentAssignments?.[0]?.id;
    const after = roadmapAgentsSchema.parse(applied.json()).roadmaps[0]?.entries;
    expect(after?.[0]?.agents?.review).toEqual({
      selection: claude('assigned-review'),
      source: { layer: 'roadmap-assignment', slot: 'review', assignmentId },
      permissionMode: 'auto',
      inherited: {
        selection: claude('review-model'),
        source: { layer: 'saved-definition', slot: 'review' },
      },
    });
    expect(after?.[0]?.agents?.acceptance?.source).toEqual({
      layer: 'roadmap-assignment',
      slot: 'review',
      assignmentId,
    });
    expect(after?.[1]?.agents?.review?.source.layer).toBe('saved-definition');
  });
});

describe('decision preparation settings', () => {
  it('reports the preparation’s default with its source', async () => {
    // One shared architecture decision the local plan owns (as in the decision preparation tests).
    const f = await supervisedMapFixture(false, 'automatic', false, false, false, (source) => ({
      ...source,
      evidence_profiles: [
        ...source.evidence_profiles,
        {
          id: 'architecture-approval',
          independence_required: true,
          reviewer_roles: ['repository-maintainer'],
          required_evidence: [
            'accepted decision artifact digest and revision',
            'source contract and affected schema or protocol references',
            'decision owner approval and applicability to the active plan generation',
          ],
        },
      ],
      checkpoints: [
        ...source.checkpoints,
        {
          ...source.checkpoints[0]!,
          id: 'LOCAL-ADR-01',
          owner: 'local',
          kind: 'architecture_decision' as const,
          evidence_profile: 'architecture-approval',
          requires: [],
        },
      ],
    }));
    const saved = f.service.save(f.auth, f.state.workspaceId, f.input).roadmap;
    const settings = decisionPreparationSettingsSchema.parse(
      await get(f.state, `/roadmaps/${saved.id}/decision-preparations`),
    );
    expect(settings.decisions.length).toBeGreaterThan(0);
    for (const decision of settings.decisions)
      expect(decision.agent).toEqual({
        selection: decision.profile,
        source: { layer: 'saved-definition', slot: 'design' },
        permissionMode: 'edit-only',
      });
  });
});

describe('a finalization (E5-3)', () => {
  it('reports each stage’s profiles as per-action overrides over the workspace default, and the current step’s agent', async () => {
    const fixture = await finalizationFixture();
    const value = await beginFinalization(fixture);
    const { finalizations } = finalizationsResponseSchema.parse(
      await get(fixture.state, '/plans/version-1/finalizations'),
    );
    const agents = finalizations.find((v) => v.finalization.id === value.id)?.agents;
    expect(agents?.stages.map((s) => s.id)).toEqual(value.stages?.map((s) => s.id));
    expect(agents?.stages[1]?.review).toEqual({
      selection: claude(`${value.stages?.[1]?.kind}-review`),
      source: { layer: 'finalization-stage', slot: 'review', stageIndex: 1 },
      permissionMode: 'auto',
      inherited: { selection: claude(), source: { layer: 'daemon-default' } },
    });
    expect(agents?.stages[1]?.implement.source).toEqual({
      layer: 'finalization-stage',
      slot: 'implement',
      stageIndex: 1,
    });
    expect(agents?.current).toMatchObject({
      selection: claude('correctness-review'),
      source: { layer: 'finalization-stage', slot: 'review', stageIndex: 0 },
    });
  });
});
