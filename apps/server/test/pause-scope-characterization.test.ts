import type { LightMyRequestResponse } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  agentSelections,
  asRoadmapWindDownId,
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
 * R-B6: the roadmap commands that needed their roadmap paused (characterized in step 2). Since
 * increment 1 the agents, capacity, the standing grants and the queued settings are written while
 * the roadmap runs too (decisions 1, 3 to 5), each refused once the roadmap has ended or while its
 * wind-down settles; delegation still needs the pause until increment 2. A running roadmap's
 * command checks what it changes, not the roadmap's version (decision 10). The roadmap's status
 * is written by hand so nothing else runs (no workers).
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

function post(
  { f, saved, ws }: Fixture,
  path: string,
  payload: Record<string, unknown>,
  view: Record<string, number> = {},
) {
  return f.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws}/roadmaps/${saved.id}/${path}`,
    headers: mutationHeaders(f.state),
    payload: { expectedVersion: storedRoadmap(f.state).version, ...payload, ...view },
  });
}

interface Command {
  readonly name: string;
  /** `view` overrides what the form read (`expectedVersion`, `expectedRevision`). */
  readonly send: (fx: Fixture, view?: Record<string, number>) => Promise<LightMyRequestResponse>;
  /** Its refusal while the roadmap runs, for a command that still needs the pause. */
  readonly refusal?: string;
  /** A definition write, which checks the definition's revision while running (decision 10). */
  readonly definition?: boolean;
  /** What the command wrote, read from the stored roadmap. */
  readonly written: (roadmap: Roadmap, before: Roadmap) => unknown;
  readonly expected: unknown;
}

const COMMANDS: readonly Command[] = [
  {
    name: 'agent profiles (ADR-064 assignment)',
    send: (fx, view) =>
      post(
        fx,
        'agent-profiles',
        {
          entryIds: [fx.saved.definition.entries[0]!.id],
          selections: agentSelections(cycleProfiles),
        },
        view,
      ),
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
    // Increment 2 scopes delegation to its named entries (decision 2).
    written: (r, before) =>
      (r.delegationAssignments?.length ?? 0) - (before.delegationAssignments?.length ?? 0),
    expected: 1,
  },
  {
    name: 'capacity',
    send: (fx, view = {}) => post(fx, 'capacity', { maxInFlight: 1, maxPerRepository: 1, ...view }),
    definition: true,
    written: (r) => ({
      maxInFlight: r.definition.scheduling?.maxInFlight,
      maxPerRepository: r.definition.scheduling?.maxPerRepository,
    }),
    expected: { maxInFlight: 1, maxPerRepository: 1 },
  },
  {
    name: 'scope recovery delegation',
    send: (fx, view) => post(fx, 'scope-recovery', { enabled: true, maxRoundsPerParent: 2 }, view),
    written: (r) => r.scopeRecovery && { ...r.scopeRecovery, grantedAt: 'at' },
    expected: expect.objectContaining({ enabled: true, maxRoundsPerParent: 2 }),
  },
  {
    name: 'automatic re-verification grant',
    send: (fx, view) => post(fx, 'reverification', { enabled: true }, view),
    written: (r) => r.reverificationGrant?.enabled,
    expected: true,
  },
  {
    name: 'decision preparation grant',
    send: (fx, view) =>
      post(fx, 'decision-preparation-grant', { enabled: true, minutes: 5, maxConcurrent: 1 }, view),
    written: (r) =>
      r.decisionPreparationGrant && {
        enabled: r.decisionPreparationGrant.enabled,
        maxConcurrent: r.decisionPreparationGrant.maxConcurrent,
      },
    expected: { enabled: true, maxConcurrent: 1 },
  },
  {
    name: 'the map roadmap’s settings save (queued entries)',
    send: (fx, view = {}) =>
      mapCommand(fx.f, 'roadmap', {
        ...fx.f.input,
        expectedVersion: storedRoadmap(fx.f.state).version,
        name: 'Renamed while characterizing',
        ...view,
      }),
    definition: true,
    written: (r, before) => ({
      name: r.definition.name,
      revision: r.definition.revision - before.definition.revision,
    }),
    expected: { name: 'Renamed while characterizing', revision: 1 },
  },
];

const PAUSED = COMMANDS.filter((c) => c.refusal);
const RUNNING = COMMANDS.filter((c) => !c.refusal);

it.each(PAUSED)(
  '$name: still refused while the roadmap runs, written once it is paused or needs attention',
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

it.each(RUNNING)(
  '$name: written while the roadmap runs, paused or needs attention, leaving its status',
  async (command) => {
    const fx = await fixture();
    for (const status of ['running', 'paused', 'needs-attention'] as const) {
      setStatus(fx, storedRoadmap(fx.f.state), status);
      const before = storedRoadmap(fx.f.state);
      const accepted = await command.send(fx);
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(command.written(storedRoadmap(fx.f.state), before)).toEqual(command.expected);
      expect(storedRoadmap(fx.f.state).status).toBe(status);
    }
  },
);

it.each(RUNNING)(
  '$name: refused while the roadmap’s wind-down settles and once it has ended',
  async (command) => {
    const fx = await fixture();
    setStatus(fx, storedRoadmap(fx.f.state), 'running');
    const at = new Date().toISOString();
    fx.tx.windDowns.insert({
      id: asRoadmapWindDownId(randomUUID()),
      workspaceId: fx.ws,
      roadmapId: fx.saved.id,
      version: 1,
      status: 'settling',
      retire: [],
      abandonResolutions: [],
      previewDigest: '0'.repeat(64),
      requestedAt: at,
      requestedByUserId: fx.f.state.userId,
      startedAt: at,
    });
    const before = storedRoadmap(fx.f.state);
    const settling = await command.send(fx);
    expect(settling.statusCode, settling.body).toBe(409);
    expect(settling.json().error).toMatchObject({
      reason: 'wind-down-in-progress',
      message: 'This roadmap is being stopped.',
    });
    expect(storedRoadmap(fx.f.state)).toEqual(before);
    setStatus(fx, before, 'stopped');
    const stopped = storedRoadmap(fx.f.state);
    const ended = await command.send(fx);
    expect(ended.statusCode, ended.body).toBe(409);
    expect(storedRoadmap(fx.f.state)).toEqual(stopped);
  },
);

it.each(RUNNING)(
  '$name: while the roadmap runs, a form older than the roadmap’s version is taken unless its definition changed (decision 10)',
  async (command) => {
    const fx = await fixture();
    setStatus(fx, storedRoadmap(fx.f.state), 'paused');
    const paused = storedRoadmap(fx.f.state);
    const stale = { expectedVersion: paused.version - 1 };
    // Paused, the roadmap's version is checked, as before.
    const refused = await command.send(fx, stale);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(storedRoadmap(fx.f.state)).toEqual(paused);
    setStatus(fx, paused, 'running');
    const running = storedRoadmap(fx.f.state);
    const revision = running.definition.revision;
    if (command.definition) {
      // A definition write checks the revision the form showed: any but the current is refused.
      const outdated = await command.send(fx, { ...stale, expectedRevision: revision + 1 });
      expect(outdated.statusCode, outdated.body).toBe(409);
      expect(storedRoadmap(fx.f.state)).toEqual(running);
      // A form that sent no revision is held to the version, as before.
      expect((await command.send(fx, stale)).statusCode).toBe(409);
      const current = await command.send(fx, { ...stale, expectedRevision: revision });
      expect(current.statusCode, current.body).toBe(200);
    } else {
      // An assignment or a grant is taken as sent, last writer winning.
      const taken = await command.send(fx, stale);
      expect(taken.statusCode, taken.body).toBe(200);
    }
    expect(command.written(storedRoadmap(fx.f.state), running)).toEqual(command.expected);
  },
);
