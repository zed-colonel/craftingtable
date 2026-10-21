import type { AgentLaunchRequest } from '@craftingtable/agents';
import type { LightMyRequestResponse } from 'fastify';
import {
  agentSelections,
  asConcurrencyDefinitionId,
  asMapAmendmentId,
  asPlanningTargetId,
  asRoadmapEntryId,
  asRoadmapId,
  asRoadmapWindDownId,
  heldStop,
  type Roadmap,
  type RoadmapId,
  type RoadmapStatus,
  type WorkCycle,
} from '@craftingtable/domain';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  cycleProfiles,
  designDone,
  implementationDone,
  mapCommand,
  mutationHeaders,
  parallelScheduling,
  type Ready,
  reviewText,
  roadmapControl,
  roadmapFixture,
  roadmapInput,
  type ScriptedReply,
  saveRoadmapRequest,
  storedRoadmap,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

/**
 * R-B7 scheduler half, increment 1 (characterization; operator decision 2 A): the roadmap-editable
 * precondition at each of its sites as the code has it before the copies become one rule. Each
 * site's refusals with their status and text, the order where two hold at once, and that nothing
 * is written; the two views' blockers on the same states, and that each view blocks exactly when
 * its command refuses. Decision 2 A keeps every one of these, so the rows pass before and after.
 *
 * Each site declares its refusals in the order it asks them; a row holds one or two states and
 * expects the first refusal that names one of them. The roadmap is paused by hand (no workers),
 * so a form's version is checked at every site that checks one (R-B6, decision 10).
 */

afterEach(cleanupExecutionFixtures);

/** The states a row sets by hand; a fixture's kind adds `cross-project` or `plain`. */
type Toggle = 'ended' | 'settling' | 'stale' | 'running' | 'amendment';
type State = Toggle | 'cross-project' | 'plain';
const TOGGLES: readonly Toggle[] = ['ended', 'settling', 'stale', 'running', 'amendment'];
/** Every state alone and every pair of them. */
const ROWS: readonly (readonly Toggle[])[] = [
  ...TOGGLES.map((t) => [t]),
  ...TOGGLES.flatMap((a, i) => TOGGLES.slice(i + 1).map((b) => [a, b])),
];

interface Refusal {
  readonly when: readonly State[];
  readonly message: string;
  readonly reason?: string;
}
const ENDED: Refusal = {
  when: ['ended'],
  message: 'This roadmap has ended. Ended roadmaps retain their history.',
};
const SETTLING: Refusal = {
  when: ['settling'],
  message: 'This roadmap is being stopped.',
  reason: 'wind-down-in-progress',
};
const AMENDMENT: Refusal = {
  when: ['amendment'],
  message: 'Decide the pending planning amendment first.',
};
const SHORT_AMENDMENT: Refusal = {
  when: ['amendment'],
  message: 'Decide the pending amendment first.',
};
/** `saveDefinition`'s order (`:1950-1968`): running, amendment, map form, ended, settling, stale. */
const DEFINITION_ORDER: readonly Refusal[] = [
  { when: ['running'], message: 'A roadmap command is in progress.' },
  {
    when: ['amendment'],
    message: 'Decide the pending planning amendment before editing settings.',
  },
  ENDED,
  SETTLING,
  { when: ['stale'], message: 'Roadmap changed; refresh before saving.' },
];

interface Fixture {
  readonly state: Ready;
  readonly kind: 'cross-project' | 'plain';
  readonly id: RoadmapId;
  /** The map fixture, for its supervision commands. */
  readonly map?: Awaited<ReturnType<typeof supervisedMapFixture>>;
}

/** A map roadmap over the supervised fixture, saved through its supervisor and paused. */
async function mapFixture(): Promise<Fixture> {
  const map = await supervisedMapFixture(true);
  await adoptSupervisedMap(map);
  const saved = map.service.save(map.auth, map.state.workspaceId, map.input).roadmap;
  const fx: Fixture = { state: map.state, kind: 'cross-project', id: saved.id, map };
  setStatus(fx, 'paused');
  return fx;
}

/** A plain parallel roadmap over the queue fixture, saved through its form and paused. */
async function plainFixture(): Promise<Fixture> {
  const { state } = await roadmapFixture();
  const saved = await saveRoadmapRequest(state, {
    ...roadmapInput(state),
    scheduling: parallelScheduling,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const fx: Fixture = { state, kind: 'plain', id: storedRoadmap(state).id };
  setStatus(fx, 'paused');
  return fx;
}

const stored = (fx: Fixture): Roadmap => {
  const roadmap = fx.state.context.storage.roadmaps.find(fx.state.workspaceId, fx.id);
  if (!roadmap) throw new Error('Missing roadmap');
  return roadmap;
};

function setStatus(fx: Fixture, status: RoadmapStatus) {
  const { attention: _attention, ...rest } = stored(fx);
  fx.state.context.storage.roadmaps.save(
    { ...rest, status, version: rest.version + 1 },
    rest.version,
  );
}

/** The service's own set of roadmaps a command holds (`controlling`). */
const controlling = (fx: Fixture) =>
  (fx.state.context.services.roadmapService as unknown as { controlling: Set<string> }).controlling;

function settle(fx: Fixture, on: boolean) {
  const windDowns = fx.state.context.storage.windDowns;
  const found = windDowns.find(fx.state.workspaceId, fx.id);
  const at = new Date().toISOString();
  if (!found)
    windDowns.insert({
      id: asRoadmapWindDownId(randomUUID()),
      workspaceId: fx.state.workspaceId,
      roadmapId: fx.id,
      version: 1,
      status: 'settling',
      retire: [],
      abandonResolutions: [],
      previewDigest: '0'.repeat(64),
      requestedAt: at,
      requestedByUserId: fx.state.userId,
      startedAt: at,
    });
  else {
    const { settledAt: _settledAt, ...record } = found;
    windDowns.replace(
      {
        ...record,
        version: found.version + 1,
        ...(on ? { status: 'settling' } : { status: 'settled', settledAt: at }),
      },
      found.version,
    );
  }
}

/** A pending planning amendment, as a proposal stores it; rejected again to clear it. */
function propose(fx: Fixture) {
  const cp = stored(fx).definition.crossProject;
  fx.state.context.storage.amendments.add({
    id: asMapAmendmentId(randomUUID()),
    workspaceId: fx.state.workspaceId,
    roadmapId: fx.id,
    baseRevision: stored(fx).definition.revision,
    candidate: {
      definitionId: cp?.definitionId ?? asConcurrencyDefinitionId(randomUUID()),
      bindingRevision: cp?.bindingRevision ?? 1,
      targetId: cp?.targetId ?? asPlanningTargetId('LOCAL'),
      selection: 'target-only',
    },
    summary: 'Characterize the editable precondition.',
    createdAt: new Date().toISOString(),
    createdByUserId: fx.state.userId,
  });
}
function reject(fx: Fixture) {
  const pending = fx.state.context.storage.amendments.pending(fx.state.workspaceId, fx.id);
  if (!pending) return;
  fx.state.context.storage.amendments.decide(fx.state.workspaceId, pending.id, {
    outcome: 'rejected',
    rationale: 'Cleared by the characterization.',
    decidedAt: new Date().toISOString(),
    decidedByUserId: fx.state.userId,
    impactDigest: '0'.repeat(64),
    previous: stored(fx),
    reusedIntegrationIds: [],
  });
}

/**
 * Sets the row's states, runs `act` with the form's view (one version behind when stale), and
 * clears them again, so one fixture serves every row.
 */
async function holding<T>(
  fx: Fixture,
  states: readonly Toggle[],
  act: (view: Record<string, number>) => Promise<T>,
): Promise<T> {
  if (states.includes('ended')) setStatus(fx, 'stopped');
  if (states.includes('settling')) settle(fx, true);
  if (states.includes('amendment')) propose(fx);
  if (states.includes('running')) controlling(fx).add(fx.id);
  const view: Record<string, number> = states.includes('stale')
    ? { expectedVersion: stored(fx).version - 1 }
    : {};
  try {
    return await act(view);
  } finally {
    controlling(fx).delete(fx.id);
    if (states.includes('amendment')) reject(fx);
    if (states.includes('settling')) settle(fx, false);
    if (states.includes('ended')) setStatus(fx, 'paused');
  }
}

function post(fx: Fixture, path: string, payload: Record<string, unknown>) {
  return fx.state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${fx.state.workspaceId}/roadmaps/${fx.id}${path ? `/${path}` : ''}`,
    headers: mutationHeaders(fx.state),
    payload: { expectedVersion: stored(fx).version, ...payload },
  });
}
const get = (fx: Fixture, path: string) =>
  fx.state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${fx.state.workspaceId}/roadmaps/${path}`,
    headers: mutationHeaders(fx.state),
  });

/** The first refusal in `order` that one of the row's states (with the fixture's kind) names. */
const first = (order: readonly Refusal[], states: readonly State[]) =>
  order.find((refusal) => refusal.when.some((s) => states.includes(s)));

interface Site {
  readonly name: string;
  readonly fixture: () => Promise<Fixture>;
  readonly send: (fx: Fixture, view: Record<string, number>) => Promise<LightMyRequestResponse>;
  /** Its refusals in the order it asks them. */
  readonly order: readonly Refusal[];
  /** What a row that passes every refusal answers: written (200), or a later refusal. */
  readonly passes: 'written' | Refusal;
}

/**
 * The six settings commands' order (`assertSettingsOpen`, then `:724-729`): ended, settling, a
 * stale form or a command running (one refusal, the site's own text), then `rest` (the
 * amendment; the three grants ask the cross-project check before it).
 */
const settings = (changed: string, rest: readonly Refusal[]): readonly Refusal[] => [
  ENDED,
  SETTLING,
  { when: ['stale', 'running'], message: changed },
  ...rest,
];

const agentProfiles = (fx: Fixture, view: Record<string, number>) =>
  post(fx, 'agent-profiles', {
    entryIds: [stored(fx).definition.entries[0]!.id],
    selections: agentSelections(cycleProfiles),
    ...view,
  });
const capacity = (fx: Fixture, view: Record<string, number>) =>
  post(fx, 'capacity', { maxInFlight: 1, maxPerRepository: 1, ...view });
const scopeRecovery = (fx: Fixture, view: Record<string, number>) =>
  post(fx, 'scope-recovery', { enabled: true, maxRoundsPerParent: 2, ...view });
const reverification = (fx: Fixture, view: Record<string, number>) =>
  post(fx, 'reverification', { enabled: true, ...view });
const decisionGrant = (fx: Fixture, view: Record<string, number>) =>
  post(fx, 'decision-preparation-grant', { enabled: true, minutes: 5, maxConcurrent: 1, ...view });
/** The plain roadmap form's save (`save`, then `saveDefinition`). */
const plainSave = (fx: Fixture, view: Record<string, number>) =>
  post(fx, '', {
    ...roadmapInput(fx.state),
    scheduling: parallelScheduling,
    expectedVersion: stored(fx).version,
    name: 'Renamed while characterizing',
    ...view,
  });

const prepare = (fx: Fixture, view: Record<string, number>) =>
  post(fx, 'prepare-decision', {
    checkpointId: 'NOT-A-DECISION',
    profile: { backend: 'claude-code', model: 'design-model' },
    minutes: 5,
    instructions: '',
    ...view,
  });
const PREPARE_ORDER: readonly Refusal[] = [
  { when: ['stale', 'running'], message: 'Roadmap changed. Refresh before preparing a decision.' },
  {
    when: ['ended', 'plain'],
    message: 'Decisions are prepared for a draft, running or paused cross-project roadmap.',
  },
  { when: ['amendment'], message: 'Resolve the pending planning amendment first.' },
];

const SCOPE_RECOVERY_CHANGED = 'Roadmap changed; refresh before changing recovery delegation.';
const REVERIFICATION_CHANGED =
  'Roadmap changed; refresh before changing automatic re-verification.';
const DECISION_GRANT_CHANGED = 'Roadmap changed; refresh before changing decision preparation.';
const NOT_CROSS_PROJECT = {
  scopeRecovery: {
    when: ['plain'],
    message: 'Recovery delegation is set on a cross-project roadmap.',
  },
  reverification: {
    when: ['plain'],
    message: 'Automatic re-verification is set on a cross-project roadmap.',
  },
  decisionGrant: {
    when: ['plain'],
    message: 'Decision preparation is set on a cross-project roadmap.',
  },
} satisfies Record<string, Refusal>;

const SITES: readonly Site[] = [
  {
    name: 'applyAgentSettings',
    fixture: mapFixture,
    send: agentProfiles,
    order: settings(
      'Roadmap changed. Refresh agent settings and review the current selection before applying.',
      [AMENDMENT],
    ),
    passes: 'written',
  },
  {
    name: 'applyDelegation',
    fixture: mapFixture,
    send: (fx, view) =>
      post(fx, 'delegation', {
        entryIds: [stored(fx).definition.entries[0]!.id],
        automation: { integrationMerge: 'manual', integrationConflicts: 'manual' },
        reviewerRoles: ['repository-maintainer'],
        rationale: 'Characterize the grant.',
        ...view,
      }),
    order: settings('Roadmap changed. Refresh before applying delegation.', [AMENDMENT]),
    passes: 'written',
  },
  {
    name: 'saveCapacity',
    fixture: mapFixture,
    send: capacity,
    order: settings('Roadmap changed; refresh before saving capacity.', [AMENDMENT]),
    passes: 'written',
  },
  {
    name: 'configureScopeRecovery',
    fixture: mapFixture,
    send: scopeRecovery,
    order: settings(SCOPE_RECOVERY_CHANGED, [NOT_CROSS_PROJECT.scopeRecovery, SHORT_AMENDMENT]),
    passes: 'written',
  },
  {
    name: 'configureScopeRecovery on a plain roadmap',
    fixture: plainFixture,
    send: scopeRecovery,
    order: settings(SCOPE_RECOVERY_CHANGED, [NOT_CROSS_PROJECT.scopeRecovery, SHORT_AMENDMENT]),
    passes: NOT_CROSS_PROJECT.scopeRecovery,
  },
  {
    name: 'configureReverification',
    fixture: mapFixture,
    send: reverification,
    order: settings(REVERIFICATION_CHANGED, [NOT_CROSS_PROJECT.reverification, SHORT_AMENDMENT]),
    passes: 'written',
  },
  {
    name: 'configureReverification on a plain roadmap',
    fixture: plainFixture,
    send: reverification,
    order: settings(REVERIFICATION_CHANGED, [NOT_CROSS_PROJECT.reverification, SHORT_AMENDMENT]),
    passes: NOT_CROSS_PROJECT.reverification,
  },
  {
    name: 'configureDecisionPreparation',
    fixture: mapFixture,
    send: decisionGrant,
    order: settings(DECISION_GRANT_CHANGED, [NOT_CROSS_PROJECT.decisionGrant, SHORT_AMENDMENT]),
    passes: 'written',
  },
  {
    name: 'configureDecisionPreparation on a plain roadmap',
    fixture: plainFixture,
    send: decisionGrant,
    order: settings(DECISION_GRANT_CHANGED, [NOT_CROSS_PROJECT.decisionGrant, SHORT_AMENDMENT]),
    passes: NOT_CROSS_PROJECT.decisionGrant,
  },
  {
    name: 'saveDefinition through the plain roadmap form',
    fixture: plainFixture,
    send: plainSave,
    order: DEFINITION_ORDER,
    passes: 'written',
  },
  {
    name: 'saveDefinition through the map roadmap’s supervisor (CrossProjectService)',
    fixture: mapFixture,
    send: (fx, view) =>
      mapCommand(fx.map!, 'roadmap', {
        ...fx.map!.input,
        expectedVersion: stored(fx).version,
        name: 'Renamed while characterizing',
        ...view,
      }),
    order: DEFINITION_ORDER,
    passes: 'written',
  },
  {
    // The map form's refusal sits between the amendment and the end (`:1964-1965`), so on an ended map roadmap the plain form is told to use the supervisor.
    name: 'saveDefinition through the plain form on a map roadmap',
    fixture: mapFixture,
    send: plainSave,
    order: [
      ...DEFINITION_ORDER.slice(0, 2),
      {
        when: ['cross-project'],
        message: 'Use the imported map supervisor to edit this roadmap.',
      },
    ],
    passes: { when: [], message: 'Use the imported map supervisor to edit this roadmap.' },
  },
  {
    // Its own rule (`:848-856`): a stopped form or a command, then the status and kind (an ended
    // roadmap among them), then the amendment; no settling refusal. A row that passes reaches the
    // checkpoint's own refusal, so nothing launches.
    name: 'prepareDecision',
    fixture: mapFixture,
    send: prepare,
    order: PREPARE_ORDER,
    passes: {
      when: [],
      message: 'Choose an architecture decision from the exact current map binding.',
    },
  },
  {
    name: 'prepareDecision on a plain roadmap',
    fixture: plainFixture,
    send: prepare,
    order: PREPARE_ORDER,
    passes: PREPARE_ORDER[1]!,
  },
];

/**
 * The two views' blockers in the order each asks (`:678-686`, `:1302-1311`), which is not their
 * commands': both put a command running first (the commands ask the end and settling first), the
 * agents view has its own text for an ended roadmap, and a view has no form, so a stale form
 * alone blocks nothing there while the command refuses it.
 */
const AGENTS_VIEW: readonly Refusal[] = [
  { when: ['running'], message: 'A roadmap command is in progress.' },
  { when: ['ended'], message: 'This roadmap has ended. Its agents can no longer change.' },
  { when: ['settling'], message: 'This roadmap is being stopped.' },
  { when: ['amendment'], message: 'Decide the pending planning amendment first.' },
];
/** An ended roadmap is not listed at all: its row's blocker reads as `undefined`. */
const CAPACITIES_VIEW: readonly Refusal[] = [
  { when: ['running'], message: 'A roadmap command is in progress.' },
  { when: ['settling'], message: 'This roadmap is being stopped.' },
  { when: ['amendment'], message: 'Decide the pending planning amendment first.' },
];
interface ViewRead {
  readonly blocker: unknown;
  /** The blocker the view's order gives the row's states. */
  readonly expect: (states: readonly Toggle[]) => unknown;
}
const VIEWS: Readonly<Record<string, (fx: Fixture) => Promise<ViewRead>>> = {
  applyAgentSettings: async (fx) => ({
    blocker: (await get(fx, `${fx.id}/agent-profiles`)).json().editBlocker,
    expect: (states) => first(AGENTS_VIEW, states)?.message ?? null,
  }),
  saveCapacity: async (fx) => ({
    blocker: (await get(fx, 'capacities'))
      .json()
      .roadmaps.find((r: { id: string }) => r.id === fx.id)?.editBlocker,
    expect: (states) =>
      states.includes('ended') ? undefined : (first(CAPACITIES_VIEW, states)?.message ?? null),
  }),
};

it.each(SITES)(
  '$name: each refusal alone and the first of any two, with nothing written',
  async (site) => {
    const fx = await site.fixture();
    for (const row of ROWS) {
      const states: readonly State[] = [...row, fx.kind];
      // Every row holds a state the site refuses, or passes to a later refusal.
      const refusal = (first(site.order, states) ?? site.passes) as Refusal;
      await holding(fx, row, async (view) => {
        const before = stored(fx);
        const read = await VIEWS[site.name]?.(fx);
        const response = await site.send(fx, view);
        const label = `${site.name} [${row.join(' + ')}]`;
        expect(response.statusCode, `${label}: ${response.body}`).toBe(409);
        const error = response.json().error;
        expect(error.message, label).toBe(refusal.message);
        expect(error.reason, label).toBe(refusal.reason);
        expect(stored(fx), label).toEqual(before);
        if (read) {
          // The view's text on the same states, and (a view has no form, so a row with a stale
          // form is left out) that it blocks exactly when its command refuses.
          expect(read.blocker, `${label} view`).toEqual(read.expect(row));
          if (!row.includes('stale')) expect(read.blocker !== null, `${label} agrees`).toBe(true);
        }
      });
    }
    // With none of them, the command passes the precondition.
    const before = stored(fx);
    const read = await VIEWS[site.name]?.(fx);
    if (read) expect(read.blocker, `${site.name} view, none`).toBeNull();
    const response = await site.send(fx, {});
    if (site.passes === 'written') {
      expect(response.statusCode, response.body).toBe(200);
      expect(stored(fx).version).toBeGreaterThan(before.version);
    } else {
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error.message).toBe(site.passes.message);
      expect(stored(fx)).toEqual(before);
    }
  },
);

it('saveDefinition: a new roadmap’s form is stale unless it read version 0', async () => {
  const fx = await plainFixture();
  const other = asRoadmapId('00000000-0000-4000-8000-000000000099');
  const response = await saveRoadmapRequest(
    fx.state,
    { ...roadmapInput(fx.state), expectedVersion: 1 },
    other,
  );
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().error.message).toBe('Roadmap changed; refresh before saving.');
  expect(fx.state.context.storage.roadmaps.find(fx.state.workspaceId, other)).toBe(undefined);
});

it('prepareDecision: a running roadmap’s version is not held, and a command running still is', async () => {
  const fx = await mapFixture();
  setStatus(fx, 'running');
  const stale = await prepare(fx, { expectedVersion: stored(fx).version - 1 });
  expect(stale.statusCode, stale.body).toBe(409);
  expect(stale.json().error.message).toBe(
    'Choose an architecture decision from the exact current map binding.',
  );
  const running = await holding(fx, ['running'], () => prepare(fx, {}));
  expect(running.json().error.message).toBe(
    'Roadmap changed. Refresh before preparing a decision.',
  );
});

it('assignCycleEntryAgents: a command running, then a pending amendment; ended and settling are not asked', async () => {
  const fx = await mapFixture();
  const roadmaps = fx.state.context.services.roadmapService;
  const auth = fx.map!.auth;
  const selections = agentSelections(cycleProfiles);
  const RUNNING = 'A roadmap command is running. Change this cycle’s agents once it ends.';
  // A row that passes both reaches the entry's own refusal, so nothing is written.
  const MISSING = 'This cycle’s roadmap entry is no longer in its roadmap.';
  const order: readonly Refusal[] = [
    { when: ['running'], message: RUNNING },
    { when: ['amendment'], message: 'Decide the pending planning amendment first.' },
  ];
  for (const row of ROWS.filter((r) => !r.includes('stale'))) {
    await holding(fx, row, async () => {
      const before = stored(fx);
      expect(() =>
        roadmaps.assignCycleEntryAgents(
          auth,
          fx.state.workspaceId,
          fx.id,
          asRoadmapEntryId(randomUUID()),
          selections,
        ),
      ).toThrow(
        expect.objectContaining({
          code: 'conflict',
          message: first(order, row)?.message ?? MISSING,
        }),
      );
      expect(stored(fx), row.join(' + ')).toEqual(before);
    });
  }
  // Ended and settling at once, the assignment is still written.
  await holding(fx, ['ended', 'settling'], async () => {
    const before = stored(fx).agentAssignments?.length ?? 0;
    roadmaps.assignCycleEntryAgents(
      auth,
      fx.state.workspaceId,
      fx.id,
      stored(fx).definition.entries[0]!.id,
      selections,
    );
    expect(stored(fx).agentAssignments?.length).toBe(before + 1);
  });
});

/** An implementation that works on, with no result, until the step's deadline cancels it. */
const working: ScriptedReply = {
  resultText: '',
  claudeStream: [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Still testing.' }] } },
  ],
};

it('assignCycleEntryAgents through a stopped roadmap cycle’s settings change: the same texts and order over the route, nothing written', async () => {
  let now = new Date('2026-10-18T12:00:00Z');
  const { state, backend } = await roadmapFixture(
    [designDone, working, implementationDone, { resultText: reviewText([]) }],
    { now: () => now },
  );
  expect((await saveRoadmapRequest(state, roadmapInput(state))).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).attempts.length === 1, 'the first attempt');
  const cycle = (): WorkCycle => {
    const found = state.context.storage.execution.cycles.find(
      state.workspaceId,
      storedRoadmap(state).attempts[0]!.cycleId,
    );
    if (!found) throw new Error('Missing cycle');
    return found;
  };
  await waitFor(
    () => backend.sessions.length === 2 && cycle().step === 'implement',
    'the implementation',
  );
  await waitFor(
    () =>
      state.context.storage.execution.runEvents.latestOfKind(
        state.workspaceId,
        cycle().currentRunId,
        'assistant-message',
      ) !== undefined,
    'the implementation at work',
  );
  now = new Date(Date.parse(cycle().runDeadlineAt) + 1);
  await waitFor(() => heldStop(cycle())?.code === 'step-time-limit', 'the step time limit');
  const stopped = cycle();
  const fx: Fixture = { state, kind: 'plain', id: storedRoadmap(state).id };
  const change = () =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${stopped.id}/control`,
      headers: mutationHeaders(state),
      payload: {
        action: 'change-settings',
        expectedVersion: stopped.version,
        agents: { review: { backend: 'claude-code', model: 'changed-review' } },
      },
    });
  const assignments = storedRoadmap(state).agentAssignments ?? [];
  for (const [row, message] of [
    [['running'], 'A roadmap command is running. Change this cycle’s agents once it ends.'],
    [['amendment'], 'Decide the pending planning amendment first.'],
    [
      ['running', 'amendment'],
      'A roadmap command is running. Change this cycle’s agents once it ends.',
    ],
  ] as const) {
    const refused = await holding(fx, row, change);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error.message).toBe(message);
    expect(cycle().version).toBe(stopped.version);
    expect(storedRoadmap(state).agentAssignments ?? []).toEqual(assignments);
  }
  expect(
    backend.launches.some((launch: AgentLaunchRequest) => launch.model === 'changed-review'),
  ).toBe(false);
});
