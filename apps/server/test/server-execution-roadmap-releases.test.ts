import { roadmapAttention } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import {
  adoptSupervisedMap,
  awaitRoadmapMerge,
  cleanupExecutionFixtures,
  entryIds,
  itNeedsCargo,
  parallelFixture,
  type Ready,
  roadmapControl,
  roadmapFixture,
  roadmapId,
  roadmapInput,
  saveRoadmapRequest,
  storedRoadmap,
  supervisedMapFixture,
  useIntegration,
  waitFor,
} from './execution-test-support.js';

/**
 * R-C10's follow-up, increment 4 (decision 2): a stored hold, or a sequential roadmap's stop,
 * whose typed fact cleared is released on the first pass after, by the scheduler, audited as the
 * system's; and not held again for the same cause. What stays the operator's stays.
 */

afterEach(cleanupExecutionFixtures);

type Internals = {
  authority: (...args: unknown[]) => unknown;
  blocker: (...args: unknown[]) => unknown;
  assertRunnable: (...args: unknown[]) => void;
  execution: { branches: { missingPredecessorMerge: (...args: unknown[]) => Promise<unknown> } };
};
const internals = (state: Ready) => state.context.services.roadmapService as unknown as Internals;
const tick = (state: Ready) => state.context.services.roadmapService.tick();

/** The entry's blocker needs the operator while `blocked` says so (no item-gate cause). */
function blockWhile(state: Ready, entryId: string, blocked: () => boolean) {
  const scheduler = internals(state);
  const real = scheduler.blocker.bind(scheduler);
  return vi.spyOn(scheduler, 'blocker').mockImplementation((...args: unknown[]) =>
    (args[1] as { id: string }).id === entryId && blocked()
      ? {
          reason: 'AQ-01: Plan branch settings changed. Save them again.',
          needsAttention: true,
          kind: 'dependency-blocked',
        }
      : real(...args),
  );
}

/** The roadmap's audit rows of one action, newest last, with their actor. */
function auditRows(state: Ready, action: string) {
  return state.context.storage.audit
    .listWorkspace({ workspaceId: state.workspaceId, limit: 500 })
    .filter((row) => row.action === 'roadmap.updated' && row.metadata.action === action)
    .reverse();
}

/** Stores a hold on an entry as an earlier pass would have. */
function storeHold(state: Ready, entryId: string, attention: ReturnType<typeof roadmapAttention>) {
  const roadmap = storedRoadmap(state);
  state.context.storage.transaction((tx) =>
    tx.roadmaps.save(
      {
        ...roadmap,
        version: roadmap.version + 1,
        entryHolds: {
          ...roadmap.entryHolds,
          [entryId]: { status: 'needs-attention', reason: 'Held.', attention },
        },
      },
      roadmap.version,
    ),
  );
}

it('releases a parallel entry’s blocker hold once its blocker clears, as the system, and holds it no more', async () => {
  const { state, input } = await parallelFixture();
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  let blocked = true;
  const spy = blockWhile(state, entryIds[0]!, () => blocked);
  await roadmapControl(state, 'start');
  await waitFor(() => !!storedRoadmap(state).entryHolds?.[entryIds[0]!], 'blocker hold');
  expect(storedRoadmap(state).entryHolds?.[entryIds[0]!]?.attention).toEqual({
    code: 'entry-blocked',
    owner: 'operator',
  });
  state.context.services.roadmapService.syncAttention(true);
  const item = () =>
    state.context.storage.attention
      .recent(state.workspaceId, 100)
      .find((i) => i.subjectKey === `roadmap:${roadmapId}:entry:${entryIds[0]}`);
  expect(item()?.state).toBe('open');
  // Still blocked: the next pass keeps it.
  await tick(state);
  expect(storedRoadmap(state).entryHolds?.[entryIds[0]!]).toBeDefined();
  blocked = false;
  await tick(state);
  expect(storedRoadmap(state).entryHolds?.[entryIds[0]!]).toBeUndefined();
  const [release] = auditRows(state, 'release-hold');
  expect(release).toMatchObject({
    actorKind: 'system',
    metadata: { release: { entryId: entryIds[0], code: 'entry-blocked', fact: 'blocker' } },
  });
  // The same pass went on with the entry, and later passes do not hold it again.
  expect(storedRoadmap(state).attempts.some((a) => a.entryId === entryIds[0])).toBe(true);
  await tick(state);
  expect(storedRoadmap(state).entryHolds?.[entryIds[0]!]).toBeUndefined();
  state.context.services.roadmapService.syncAttention(true);
  expect(item()).toMatchObject({ state: 'resolved', resolvedBy: 'automation' });
  spy.mockRestore();
});

it('keeps the holds that stay the operator’s: one stored before the build, and an item the item gate refuses', async () => {
  const { state, input } = await parallelFixture();
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  // LIVE-06's shape: a round's capacity hold naming its own entry, not the owner it asked.
  storeHold(state, entryIds[0]!, roadmapAttention('entry-blocked', { entryId: entryIds[0] }));
  storeHold(state, entryIds[1]!, roadmapAttention('entry-blocked', { cause: 'item-unavailable' }));
  await tick(state);
  await tick(state);
  expect(Object.keys(storedRoadmap(state).entryHolds ?? {}).toSorted()).toEqual(
    [entryIds[0], entryIds[1]].toSorted(),
  );
  expect(auditRows(state, 'release-hold')).toEqual([]);
});

it('asks a round’s hold of its owner as a round, and keeps it while the capacity is circular', async () => {
  // The source entry depends on nothing, so the pass reaches its hold.
  const { state, input } = await parallelFixture({ independentThird: true });
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  // A round's capacity hold on its source entry names the owner whose blocker refused it.
  const [source, owner] = [input.entries[2]!.id, entryIds[0]!];
  storeHold(state, source, roadmapAttention('entry-blocked', { entryId: owner }));
  let circular = true;
  const asked: unknown[] = [];
  const scheduler = internals(state);
  const real = scheduler.blocker.bind(scheduler);
  const spy = vi.spyOn(scheduler, 'blocker').mockImplementation((...args: unknown[]) => {
    if ((args[1] as { id: string }).id !== owner) return real(...args);
    asked.push(args[4]);
    return circular
      ? {
          reason: 'All slots are held by work that waits on this slice.',
          needsAttention: false,
          kind: 'capacity-blocked',
          circular: true,
        }
      : undefined;
  });
  await tick(state);
  expect(storedRoadmap(state).entryHolds?.[source]).toBeDefined();
  expect(asked).toContain(true);
  circular = false;
  await tick(state);
  expect(storedRoadmap(state).entryHolds?.[source]).toBeUndefined();
  expect(auditRows(state, 'release-hold').at(-1)?.metadata.release).toEqual({
    entryId: source,
    code: 'entry-blocked',
    gatedEntryId: owner,
    fact: 'blocker',
  });
  spy.mockRestore();
});

it('releases a stored hold for a predecessor’s missing merge once no merge is missing', async () => {
  // The third entry depends on nothing, so the pass evaluates it rather than deferring it.
  const { state, input } = await parallelFixture({ independentThird: true });
  expect((await saveRoadmapRequest(state, input)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).attempts.length > 0, 'the first attempt');
  const third = input.entries[2]!.id;
  storeHold(
    state,
    third,
    roadmapAttention('entry-preparation-failed', { cause: 'predecessor-merge-missing' }),
  );
  await tick(state);
  expect(storedRoadmap(state).entryHolds?.[third]).toBeUndefined();
  expect(auditRows(state, 'release-hold').at(-1)?.metadata.release).toEqual({
    entryId: third,
    code: 'entry-preparation-failed',
    cause: 'predecessor-merge-missing',
    fact: 'predecessor-merge',
  });
});

it('waits on a predecessor’s merge missing at the roadmap’s own merge instead of holding, and merges once it is in', async () => {
  const fixture = await roadmapFixture();
  const { state } = fixture;
  // An integration branch: a merge into main is always the operator's final promotion.
  await useIntegration(fixture);
  expect(
    (
      await saveRoadmapRequest(state, {
        ...roadmapInput(state),
        automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
      })
    ).statusCode,
  ).toBe(200);
  // The predecessor's merge is in the branch when the attempt starts, and missing at its merge.
  let mergeMissing = true;
  const branches = internals(state).execution.branches;
  const real = branches.missingPredecessorMerge.bind(branches);
  const spy = vi
    .spyOn(branches, 'missingPredecessorMerge')
    .mockImplementation(async (...args: unknown[]) =>
      mergeMissing && storedRoadmap(state).attempts.length > 0
        ? "Required predecessor AQ-00's merge is absent from the integration branch"
        : real(...args),
    );
  const merge = vi.spyOn(state.context.services.executionService, 'mergeWorktree');
  await roadmapControl(state, 'start');
  await waitFor(
    () => storedRoadmap(state).entryWaits?.[entryIds[0]!]?.code === 'predecessor-merge-missing',
    'the merge waits on the predecessor',
  );
  // A wait with its item, not a hold or a stop, and no merge was tried.
  expect(storedRoadmap(state)).toMatchObject({ status: 'running' });
  expect(storedRoadmap(state).entryHolds ?? {}).toEqual({});
  expect(storedRoadmap(state).reason).toContain("AQ-00's merge is absent");
  expect(merge).not.toHaveBeenCalled();
  mergeMissing = false;
  await waitFor(
    () => storedRoadmap(state).attempts[0]?.status === 'completed',
    'the merge once the predecessor is in',
  );
  spy.mockRestore();
  merge.mockRestore();
});

it('resumes a sequential roadmap stopped on its entry’s blocker once it clears, keeping its delegator', async () => {
  const { state } = await roadmapFixture();
  await saveRoadmapRequest(state);
  let blocked = true;
  const spy = blockWhile(state, entryIds[0]!, () => blocked);
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'the blocker stop');
  const stopped = storedRoadmap(state);
  expect(stopped.attention).toEqual({
    code: 'entry-blocked',
    owner: 'operator',
    refs: { entryId: entryIds[0] },
  });
  await tick(state);
  expect(storedRoadmap(state).status).toBe('needs-attention');
  blocked = false;
  await tick(state);
  expect(storedRoadmap(state)).toMatchObject({
    status: 'running',
    delegatedByUserId: stopped.delegatedByUserId,
    reason: 'Scheduling enabled. Integration follows each item’s delegated merge policy.',
  });
  expect(storedRoadmap(state).attention).toBeUndefined();
  expect(auditRows(state, 'resume-cleared').at(-1)).toMatchObject({
    actorKind: 'system',
    metadata: { release: { entryId: entryIds[0], code: 'entry-blocked', fact: 'blocker' } },
  });
  // The next pass starts the entry and does not stop again.
  await waitFor(() => storedRoadmap(state).attempts.length === 1, 'the entry starts');
  expect(storedRoadmap(state).status).toBe('running');
  spy.mockRestore();
});

it('leaves a sequential stop to the operator while the roadmap is paused or Resume would refuse', async () => {
  const { state } = await roadmapFixture();
  await saveRoadmapRequest(state);
  let blocked = true;
  const spy = blockWhile(state, entryIds[0]!, () => blocked);
  await roadmapControl(state, 'start');
  await waitFor(() => storedRoadmap(state).status === 'needs-attention', 'the blocker stop');
  blocked = false;
  // Resume's own preconditions refuse: the stop stays the operator's.
  const refused = vi.spyOn(internals(state), 'assertRunnable').mockImplementation(() => {
    throw new Error('Resume refuses.');
  });
  await tick(state);
  expect(storedRoadmap(state).status).toBe('needs-attention');
  refused.mockRestore();
  // The delegating user lost their authority: the stop stays the operator's.
  const authority = vi.spyOn(internals(state), 'authority').mockImplementation(() => {
    throw new Error('The initiating user no longer has permission to run this roadmap.');
  });
  await tick(state);
  expect(storedRoadmap(state).status).toBe('needs-attention');
  authority.mockRestore();
  // A pause carries no code: the operator resumes what they paused.
  await roadmapControl(state, 'pause');
  await tick(state);
  expect(storedRoadmap(state).status).toBe('paused');
  expect(auditRows(state, 'resume-cleared')).toEqual([]);
  spy.mockRestore();
});

it('resumes a stored cycle-needs-attention stop once its cycle is at its merge again', async () => {
  const { state } = await roadmapFixture();
  await saveRoadmapRequest(state);
  await roadmapControl(state, 'start');
  const first = await awaitRoadmapMerge(state, 0);
  // A stop written before decision 1, for a cycle that has since moved on to its merge.
  const running = storedRoadmap(state);
  state.context.storage.transaction((tx) =>
    tx.roadmaps.save(
      {
        ...running,
        version: running.version + 1,
        status: 'needs-attention',
        reason: 'AQ-01: Paused. Inspect its cycle before resuming the roadmap.',
        attention: roadmapAttention('cycle-needs-attention', {
          cycleId: first.cycleId,
          entryId: first.entryId,
        }),
      },
      running.version,
    ),
  );
  await tick(state);
  expect(storedRoadmap(state).status).toBe('running');
  expect(auditRows(state, 'resume-cleared').at(-1)?.metadata.release).toEqual({
    entryId: first.entryId,
    code: 'cycle-needs-attention',
    fact: 'cycle',
  });
});

itNeedsCargo(
  'releases a stored phase-gate hold once its phase gate names nothing that stops',
  async () => {
    const f = await supervisedMapFixture(false, 'automatic');
    const { state } = f;
    f.service.save(f.auth, state.workspaceId, f.input);
    await adoptSupervisedMap(f);
    // Start drops needs-attention holds, so the hold is stored on the running roadmap: on a
    // slice verification, whose verify gate waits only on its slice's merge.
    await roadmapControl(state, 'start');
    const verification = storedRoadmap(state).definition.entries.find(
      (e) => e.executionScope?.kind === 'slice-verification',
    )!;
    storeHold(
      state,
      verification.id,
      roadmapAttention('entry-preparation-failed', {
        cause: 'phase-gate',
        blockers: ['binding-changed'],
      }),
    );
    await waitFor(
      () => !storedRoadmap(state).entryHolds?.[verification.id],
      'the phase gate hold released',
    );
    expect(auditRows(state, 'release-hold').at(-1)?.metadata.release).toMatchObject({
      entryId: verification.id,
      cause: 'phase-gate',
      fact: 'phase-gate',
    });
  },
);
