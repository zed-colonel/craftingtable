import { roadmapAgentSettingsSchema } from '@craftingtable/contracts';
import { agentSelections } from '@craftingtable/domain';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupExecutionFixtures,
  cycleProfiles,
  mapCommand,
  mutationHeaders,
  roadmapFixture,
  roadmapId,
  roadmapInput,
  saveRoadmapRequest,
  stepPermissions,
  stepUp,
  storedRoadmap,
  supervisedMapFixture,
  useStepModels,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

/**
 * R-E5b, E5-1 as amended (operator 2026-10-11): a roadmap's settings save sends each step's
 * permission mode, never an agent. A saved entry or map settings level keeps the agents it
 * stored; a new one stores the workspace defaults as they are when it is saved. Agents change
 * only through an ADR-064 assignment.
 */
const model = (step: keyof typeof cycleProfiles, name: string) => ({
  ...cycleProfiles,
  [step]: { ...cycleProfiles[step], model: name },
});

describe('a roadmap’s save', () => {
  it('stores the workspace defaults for a new entry, with the permissions it sends, and refuses an agent', async () => {
    const { state } = await roadmapFixture();
    const input = roadmapInput(state, [state.workItemId]);
    const naming = await saveRoadmapRequest(state, {
      ...input,
      entries: input.entries.map(({ permissions: _, ...entry }) => ({
        ...entry,
        profiles: cycleProfiles,
      })),
    });
    expect(naming.statusCode).toBe(400);
    const saved = await saveRoadmapRequest(state, {
      ...input,
      entries: input.entries.map((e) => ({
        ...e,
        permissions: { ...stepPermissions, review: 'edit-only' },
      })),
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(storedRoadmap(state).definition.entries[0]?.profiles).toEqual({
      ...cycleProfiles,
      review: { ...cycleProfiles.review, permissionMode: 'edit-only' },
    });
  });

  it('keeps a saved entry’s agents: later defaults and assignments leave them, a new entry takes the defaults now', async () => {
    const { state, second } = await roadmapFixture();
    const one = roadmapInput(state, [state.workItemId]);
    expect((await saveRoadmapRequest(state, one)).statusCode).toBe(200);
    await useStepModels(state, model('design', 'later-default'));
    const assigned = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/roadmaps/${roadmapId}/agent-profiles`,
      headers: mutationHeaders(state),
      payload: {
        expectedVersion: storedRoadmap(state).version,
        entryIds: [one.entries[0]!.id],
        selections: { ...agentSelections(cycleProfiles), design: { backend: 'claude-code' } },
      },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const both = roadmapInput(state, [state.workItemId, second]);
    const resaved = await saveRoadmapRequest(state, {
      ...both,
      expectedVersion: storedRoadmap(state).version,
      entries: both.entries.map((e, index) =>
        index === 0 ? { ...e, permissions: { ...e.permissions, design: 'edit-only' } } : e,
      ),
    });
    expect(resaved.statusCode, resaved.body).toBe(200);
    const [first, added] = storedRoadmap(state).definition.entries;
    // The saved entry: its stored agent, the permission the save changed.
    expect(first?.profiles.design).toEqual({
      ...cycleProfiles.design,
      permissionMode: 'edit-only',
    });
    expect(first?.profiles.implement).toEqual(cycleProfiles.implement);
    // The new entry: the workspace defaults when it was saved.
    expect(added?.profiles.design.model).toBe('later-default');
    // The assignment still holds the saved entry's agent.
    expect(storedRoadmap(state).agentAssignments?.at(-1)?.entryIds).toEqual([first?.id]);
  });
});

describe('a map roadmap’s settings save', () => {
  it('keeps a saved level’s agents, gives a new level the defaults now, and asks the password for unrestricted', async () => {
    const f = await supervisedMapFixture();
    const save = (configuration: typeof f.input.configuration) =>
      mapCommand(f, 'roadmap', {
        ...f.input,
        expectedVersion:
          f.state.context.storage.roadmaps.find(f.state.workspaceId, roadmapId)?.version ?? 0,
        configuration,
      });
    const first = await save(f.input.configuration);
    expect(first.statusCode, first.body).toBe(200);
    const stored = () =>
      f.state.context.storage.roadmaps.find(f.state.workspaceId, roadmapId)!.definition
        .crossProject!;
    expect(stored().defaults.profiles).toEqual(cycleProfiles);
    await useStepModels(f.state, model('design', 'later-default'));
    const override = {
      level: 'activity' as const,
      key: 'development',
      settings: {
        ...f.input.configuration.defaults,
        permissions: { ...stepPermissions, review: 'edit-only' as const },
      },
    };
    const second = await save({ ...f.input.configuration, overrides: [override] });
    expect(second.statusCode, second.body).toBe(200);
    expect(stored().defaults.profiles).toEqual(cycleProfiles);
    expect(stored().overrides[0]?.settings.profiles.design.model).toBe('later-default');
    expect(stored().overrides[0]?.settings.profiles.review.permissionMode).toBe('edit-only');
    // The setup view names each entry's settings level, so its form can apply a level's agents.
    const view = await f.state.context.app.inject({
      method: 'GET',
      url: `/api/workspaces/${f.state.workspaceId}/roadmaps/${roadmapId}/agent-profiles`,
      headers: { cookie: f.state.cookie },
    });
    const { entries } = roadmapAgentSettingsSchema.parse(view.json());
    expect(entries.length).toBeGreaterThan(1);
    for (const entry of entries)
      expect(entry.settingsLevel).toEqual(
        entry.activity === 'development' ? { level: 'activity', key: 'development' } : 'defaults',
      );
    expect(entries.some((e) => e.activity !== 'development')).toBe(true);
    expect(entries.find((e) => e.activity === 'development')?.permissions.review).toBe('edit-only');
    const granting = {
      ...f.input.configuration,
      overrides: [
        {
          ...override,
          settings: {
            ...override.settings,
            permissions: { ...stepPermissions, implement: 'unrestricted' as const },
          },
        },
      ],
    };
    const refused = await save(granting);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.reason).toBe('step-up-required');
    await stepUp(f.state);
    const granted = await save(granting);
    expect(granted.statusCode, granted.body).toBe(200);
    expect(stored().overrides[0]?.settings.profiles.implement).toEqual({
      ...cycleProfiles.implement,
      model: cycleProfiles.implement.model,
      permissionMode: 'unrestricted',
    });
  });
});
