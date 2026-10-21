import { roadmapAttention } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { PhaseGateError } from '../src/services/phase-resources.js';
import {
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  controlCycle,
  entryIds,
  parallelFixture,
  roadmapControl,
  roadmapFixture,
  roadmapId,
  saveRoadmapRequest,
  storedRoadmap,
  waitFor,
} from './execution-test-support.js';

/**
 * R-C10's follow-up, increment 2: what a hold or a roadmap's stop says it is. A non-waiting phase
 * gate holds with its typed cause, a sequential roadmap's stop keeps the hold's code and names its
 * entry, and an entry whose cycle ended has an item.
 */

afterEach(cleanupExecutionFixtures);

type Internals = {
  admission: { evaluateEntry: (...args: unknown[]) => Promise<unknown> };
  selection: { blocker: (...args: unknown[]) => unknown };
};
const internals = (state: { context: { services: { roadmapService: unknown } } }) =>
  state.context.services.roadmapService as unknown as Internals;

const bindingChanged = () =>
  new PhaseGateError([
    { kind: 'dependency', code: 'binding-changed', message: 'The map binding changed.' },
  ]);

it('holds a parallel entry at a phase gate that does not wait with `phase-gate` and its blockers (decision 2)', async () => {
  const { state, input } = await parallelFixture();
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  const evaluate = vi
    .spyOn(internals(state).admission, 'evaluateEntry')
    .mockImplementationOnce(async () => {
      throw bindingChanged();
    });
  await roadmapControl(state, 'start');
  await waitFor(() => !!storedRoadmap(state).entryHolds?.[entryIds[0]!], 'phase gate hold');
  expect(storedRoadmap(state).entryHolds?.[entryIds[0]!]).toEqual({
    status: 'needs-attention',
    reason: 'The map binding changed.',
    attention: {
      code: 'entry-preparation-failed',
      owner: 'operator',
      refs: { cause: 'phase-gate', blockers: ['binding-changed'] },
    },
  });
  evaluate.mockRestore();
});

it('stops a sequential roadmap at a phase gate with `phase-gate` and names the entry (decisions 2 and 3)', async () => {
  const { state } = await roadmapFixture();
  await saveRoadmapRequest(state);
  const evaluate = vi
    .spyOn(internals(state).admission, 'evaluateEntry')
    .mockImplementationOnce(async () => {
      throw bindingChanged();
    });
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'scheduler stop');
  expect(storedRoadmap(state).attention).toEqual({
    code: 'scheduler-error',
    owner: 'operator',
    refs: { entryId: entryIds[0], cause: 'phase-gate', blockers: ['binding-changed'] },
  });
  expect(storedRoadmap(state).entryHolds ?? {}).toEqual({});
  evaluate.mockRestore();
});

it('stops a sequential roadmap whose blocker refuses the attempt being made as `entry-blocked` on that entry (decision 3)', async () => {
  const { state } = await roadmapFixture();
  await saveRoadmapRequest(state);
  // The pass finds no blocker; the reserved attempt's own check, a moment later, does.
  const blocked = vi
    .spyOn(internals(state).selection, 'blocker')
    .mockImplementation((_roadmap, _entry, attempt) =>
      attempt
        ? {
            reason: 'AQ-01: Bound plan item is unavailable.',
            needsAttention: true,
            kind: 'dependency-blocked',
            cause: 'item-unavailable',
          }
        : undefined,
    );
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'scheduler stop');
  expect(storedRoadmap(state)).toMatchObject({
    attention: {
      code: 'entry-blocked',
      refs: { entryId: entryIds[0], cause: 'item-unavailable' },
    },
    reason: 'AQ-01: Bound plan item is unavailable.',
  });
  expect(storedRoadmap(state).entryHolds ?? {}).toEqual({});
  // No cycle carries it, so the roadmap's own item names the entry it stopped on.
  expect(
    state.context.storage.attention
      .recent(state.workspaceId, 100)
      .find((item) => item.state === 'open' && item.subjectKey === `roadmap:${roadmapId}`)?.refs,
  ).toEqual({ roadmapId, entryId: entryIds[0], workItemId: state.workItemId });
  // The status list shows the stop on its entry.
  expect(
    state.context.services.roadmapService
      .statusOf(storedRoadmap(state))
      .entries.find((e) => e.entryId === entryIds[0])?.waitsOn,
  ).toMatchObject({ source: 'attention-item', code: 'entry-blocked' });
  blocked.mockRestore();
});

it('carries a sequential stop by its own entry’s cycle, not an earlier unfinished attempt’s (decision 3, review L-3)', async () => {
  const { state } = await roadmapFixture();
  await saveRoadmapRequest(state);
  await roadmapControl(state, 'start');
  const first = await awaitRoadmapMerge(state, 0);
  // The first entry's cycle is at its merge with its own item, its attempt unfinished; the stop
  // names the next entry, which has no cycle yet, so the roadmap's own item shows it.
  const running = storedRoadmap(state);
  const next = running.definition.entries[1]!;
  state.context.storage.transaction((tx) =>
    tx.roadmaps.save(
      {
        ...running,
        version: running.version + 1,
        status: 'needs-attention',
        reason: 'AQ-02: Bound plan item is unavailable.',
        attention: roadmapAttention('entry-blocked', {
          entryId: next.id,
          cause: 'item-unavailable',
        }),
      },
      running.version,
    ),
  );
  const open = state.context.storage.attention
    .recent(state.workspaceId, 100)
    .filter((item) => item.state === 'open');
  expect(open.some((item) => item.subjectKey === `cycle:${first.cycleId}`)).toBe(true);
  expect(open.find((item) => item.subjectKey === `roadmap:${roadmapId}`)).toMatchObject({
    code: 'entry-blocked',
    refs: { roadmapId, entryId: next.id },
  });
});

it('carries a sequential stop on an entry at its merge in that cycle’s one item, as a hold (decision 3, LIVE-24)', async () => {
  const { state } = await roadmapFixture();
  await saveRoadmapRequest(state);
  await roadmapControl(state, 'start');
  const first = await awaitRoadmapMerge(state, 0);
  const open = () =>
    state.context.storage.attention
      .recent(state.workspaceId, 100)
      .filter((item) => item.state === 'open');
  expect(open().find((item) => item.subjectKey === `cycle:${first.cycleId}`)?.kind).toBe('merge');
  // The stop a sequential pass writes when the entry's merge meets a phase gate that stops.
  const running = storedRoadmap(state);
  state.context.storage.transaction((tx) =>
    tx.roadmaps.save(
      {
        ...running,
        version: running.version + 1,
        status: 'needs-attention',
        reason: 'The map binding changed.',
        attention: roadmapAttention('scheduler-error', {
          entryId: first.entryId,
          cause: 'phase-gate',
          blockers: ['binding-changed'],
        }),
      },
      running.version,
    ),
  );
  // The cycle's item carries it: the held merge did not happen, so it is no merge to approve,
  // and the roadmap's own item for the same stop is not a second one.
  expect(open().find((item) => item.subjectKey === `cycle:${first.cycleId}`)).toMatchObject({
    kind: 'attention',
    message: expect.stringContaining('The roadmap holds this item: The map binding changed.'),
  });
  expect(open().some((item) => item.subjectKey === `roadmap:${roadmapId}`)).toBe(false);
});

it('gives an entry whose cycle ended an item, which opens the board (decision 7)', async () => {
  const { state, input } = await parallelFixture();
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  const first = await awaitRoadmapMerge(state, 0);
  const cycle = state.context.storage.execution.cycles.find(state.workspaceId, first.cycleId)!;
  await controlCycle(state, cycle, 'stop');
  await waitFor(
    () => storedRoadmap(state).entryWaits?.[first.entryId]?.code === 'cycle-ended',
    'the ended cycle’s wait',
  );
  const scheduler = state.context.services.roadmapService;
  scheduler.syncAttention(true);
  const items = state.context.storage.attention
    .recent(state.workspaceId, 100)
    .filter((item) => item.state === 'open' && item.subjectKey.endsWith(':cycle-ended'));
  expect(items).toEqual([
    expect.objectContaining({
      subjectKey: `roadmap:${roadmapId}:entry:${first.entryId}:cycle-ended`,
      code: 'cycle-needs-attention',
      path: `/workspaces/${state.workspaceId}/roadmaps/${roadmapId}`,
      refs: expect.objectContaining({ entryId: first.entryId, cycleId: cycle.id }),
    }),
  ]);
  // A slice's entry has nothing to re-verify.
  expect(items[0]?.actions).toBeUndefined();
});
