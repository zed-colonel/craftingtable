import type { LightMyRequestResponse } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import {
  agentSelections,
  roadmapAttention,
  type Roadmap,
  type RoadmapStatus,
} from '@craftingtable/domain';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  cycleProfiles,
  mapCommand,
  mutationHeaders,
  storedRoadmap,
  supervisedMapFixture,
} from './execution-test-support.js';

/**
 * R-B6 characterization (step 2): each roadmap command that today needs its roadmap paused,
 * as it is before scoping. While the roadmap runs it is refused with its message and writes
 * nothing; once the roadmap is paused, or needs attention (which the guards count as paused), it
 * writes its field. The roadmap's status is written by hand so nothing else runs (no workers).
 */

afterEach(cleanupExecutionFixtures);

async function fixture() {
  const f = await supervisedMapFixture(true);
  await adoptSupervisedMap(f);
  const saved = f.service.save(f.auth, f.state.workspaceId, f.input).roadmap;
  return { f, saved, ws: f.state.workspaceId, tx: f.state.context.storage };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function setStatus({ tx }: Fixture, roadmap: Roadmap, status: RoadmapStatus) {
  const { attention: _attention, ...rest } = roadmap;
  tx.roadmaps.save(
    {
      ...rest,
      status,
      version: roadmap.version + 1,
      // A scheduler error is the stop a running roadmap takes by itself (R-A3).
      ...(status === 'needs-attention' ? { attention: roadmapAttention('scheduler-error') } : {}),
    },
    roadmap.version,
  );
}

function post({ f, saved, ws }: Fixture, path: string, payload: Record<string, unknown>) {
  return f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/roadmaps/${saved.id}/${path}`,
    headers: mutationHeaders(f.state),
    payload: { expectedVersion: storedRoadmap(f.state).version, ...payload },
  });
}

interface Command {
  readonly name: string;
  readonly send: (fx: Fixture) => Promise<LightMyRequestResponse>;
  /** Today's refusal while the roadmap runs. */
  readonly refusal: string;
  /** What the command wrote, read from the stored roadmap. */
  readonly written: (roadmap: Roadmap, before: Roadmap) => unknown;
  readonly expected: unknown;
}

const COMMANDS: readonly Command[] = [
  {
    name: 'agent profiles (ADR-064 assignment)',
    send: (fx) =>
      post(fx, 'agent-profiles', {
        entryIds: [fx.saved.definition.entries[0]!.id],
        selections: agentSelections(cycleProfiles),
      }),
    refusal: 'Pause roadmap scheduling before applying agent profiles.',
    written: (r, before) =>
      (r.agentAssignments?.length ?? 0) - (before.agentAssignments?.length ?? 0),
    expected: 1,
  },
  {
    name: 'delegation (ADR-065 grant)',
    send: (fx) =>
      post(fx, 'delegation', {
        entryIds: [fx.saved.definition.entries[0]!.id],
        automation: { integrationMerge: 'manual', integrationConflicts: 'manual' },
        reviewerRoles: ['repository-maintainer'],
        rationale: 'Characterize the grant.',
      }),
    refusal: 'Pause scheduling before changing delegation.',
    written: (r, before) =>
      (r.delegationAssignments?.length ?? 0) - (before.delegationAssignments?.length ?? 0),
    expected: 1,
  },
  {
    name: 'capacity',
    send: (fx) => post(fx, 'capacity', { maxInFlight: 1, maxPerRepository: 1 }),
    refusal: 'Pause the roadmap before changing capacity. Ended roadmaps retain their history.',
    written: (r) => ({
      maxInFlight: r.definition.scheduling?.maxInFlight,
      maxPerRepository: r.definition.scheduling?.maxPerRepository,
    }),
    expected: { maxInFlight: 1, maxPerRepository: 1 },
  },
  {
    name: 'scope recovery delegation',
    send: (fx) => post(fx, 'scope-recovery', { enabled: true, maxRoundsPerParent: 2 }),
    refusal: 'Pause this cross-project roadmap before changing recovery delegation.',
    written: (r) => r.scopeRecovery && { ...r.scopeRecovery, grantedAt: 'at' },
    expected: expect.objectContaining({ enabled: true, maxRoundsPerParent: 2 }),
  },
  {
    name: 'automatic re-verification grant',
    send: (fx) => post(fx, 'reverification', { enabled: true }),
    refusal: 'Pause this cross-project roadmap before changing automatic re-verification.',
    written: (r) => r.reverificationGrant?.enabled,
    expected: true,
  },
  {
    name: 'decision preparation grant',
    send: (fx) =>
      post(fx, 'decision-preparation-grant', { enabled: true, minutes: 5, maxConcurrent: 1 }),
    refusal: 'Pause this cross-project roadmap before changing decision preparation.',
    written: (r) =>
      r.decisionPreparationGrant && {
        enabled: r.decisionPreparationGrant.enabled,
        maxConcurrent: r.decisionPreparationGrant.maxConcurrent,
      },
    expected: { enabled: true, maxConcurrent: 1 },
  },
  {
    name: 'the map roadmap’s settings save (queued entries)',
    send: (fx) =>
      mapCommand(fx.f, 'roadmap', {
        ...fx.f.input,
        expectedVersion: storedRoadmap(fx.f.state).version,
        name: 'Renamed while characterizing',
      }),
    refusal:
      'Pause the roadmap before editing queued entries. Ended roadmaps retain their history.',
    written: (r, before) => ({
      name: r.definition.name,
      revision: r.definition.revision - before.definition.revision,
    }),
    expected: { name: 'Renamed while characterizing', revision: 1 },
  },
];

it.each(COMMANDS)(
  '$name: refused while the roadmap runs, written once it is paused or needs attention',
  async (command) => {
    const fx = await fixture();
    for (const status of ['paused', 'needs-attention'] as const) {
      setStatus(fx, storedRoadmap(fx.f.state), 'running');
      const running = storedRoadmap(fx.f.state);
      const refused = await command.send(fx);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().error.message).toBe(command.refusal);
      expect(storedRoadmap(fx.f.state)).toEqual(running);
      setStatus(fx, running, status);
      const before = storedRoadmap(fx.f.state);
      const accepted = await command.send(fx);
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(command.written(storedRoadmap(fx.f.state), before)).toEqual(command.expected);
      expect(storedRoadmap(fx.f.state).status).toBe(status);
    }
  },
);
