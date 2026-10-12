import { roadmapPageSchema } from '@craftingtable/contracts';
import {
  type AgentRunId,
  asConcurrencyDefinitionId,
  type ExecutionScope,
  phaseBlockerCode,
  type Roadmap,
  type WorkItemId,
  type WorkspaceId,
} from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { afterEach, expect, it, vi } from 'vitest';
import { scopeDecisionsKey } from '../src/services/architecture-decision-policy.js';
import { milestoneMemoKey } from '../src/services/cross-project-service.js';
import { scopePhaseBlockers } from '../src/services/execution-scope.js';
import { mapReadSnapshot } from '../src/services/map-read-snapshot.js';
import { openRecoveries } from '../src/services/roadmap-service.js';
import { receiptCurrencyKey } from '../src/services/runtime-evidence-policy.js';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  launchScoped,
  roadmapId,
  scopeTree,
  supervisedMapFixture,
  waitFor,
} from './execution-test-support.js';

/**
 * R-D8: a scope's phase blockers are computed once per read snapshot and shared by every caller
 * (the map evaluation and the roadmap view ask for the same scopes in one page read). Only the
 * resource check reads the reservation owner, so it stays per caller.
 */

/** A scope as the shared computation keys it: a verification shares its slice's answer. */
const shared = vi.hoisted(
  () => (s: ExecutionScope) =>
    `${s.definitionId}:${s.bindingRevision}:${s.kind === 'slice-verification' ? 'slice' : s.kind}:${s.sourceId}`,
);
const calls = vi.hoisted(() => ({
  // One per computation of a scope's owner-free blockers.
  computed: [] as string[],
  resources: [] as { scope: string; phase: string; ownerId?: string }[],
}));
vi.mock('../src/services/runtime-evidence-policy.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../src/services/runtime-evidence-policy.js')>();
  return {
    ...original,
    runtimeScopeBlockers: (...args: Parameters<typeof original.runtimeScopeBlockers>) => {
      calls.computed.push(shared(args[2]));
      return original.runtimeScopeBlockers(...args);
    },
  };
});
vi.mock('../src/services/phase-resources.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/phase-resources.js')>();
  return {
    ...original,
    resourceBlockers: (...args: Parameters<typeof original.resourceBlockers>) => {
      calls.resources.push({
        scope: shared(args[1].scope),
        phase: args[2],
        ...(args[3] === undefined ? {} : { ownerId: args[3] }),
      });
      return original.resourceBlockers(...args);
    },
  };
});

afterEach(cleanupExecutionFixtures);

async function adoptedMap() {
  const f = await supervisedMapFixture(true);
  f.service.save(f.auth, f.state.workspaceId, f.input);
  await adoptSupervisedMap(f);
  calls.computed.length = 0;
  calls.resources.length = 0;
  return f;
}

it('computes each scope and phase once in a roadmap page read, for the map and the entries together (R-D8)', async () => {
  const f = await adoptedMap();
  const response = await f.state.context.app.inject({
    method: 'GET',
    url: `/api/workspaces/${f.state.workspaceId}/roadmaps/${roadmapId}/view`,
    headers: { cookie: f.state.cookie },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(roadmapPageSchema.parse(response.json()).status.entries.length).toBeGreaterThan(0);
  const asked = new Set(calls.resources.map((r) => `${r.scope} ${r.phase}`));
  // The map and the entries both asked for some scope and phase, and it was computed once.
  expect(calls.resources.length).toBeGreaterThan(asked.size);
  expect(calls.computed).toHaveLength(asked.size);
});

it('keeps the reservation owner exact while sharing the rest within a read snapshot (R-D8)', async () => {
  const f = await adoptedMap();
  const { storage } = f.state.context;
  const ws = f.state.workspaceId;
  const scope = f.scopes[0]!;
  expect(scope.kind).toBe('slice');
  // The slice's start needs the development workstation; its one place is held by run-a.
  const tree = await scopeTree(f, scope);
  storage.phaseScheduling.setCapacity('local-development', 1);
  storage.phaseScheduling.acquire({
    id: 'reservation-a',
    workspaceId: ws,
    worktreeId: tree.id,
    ownerId: 'run-a',
    phase: 'start',
    resourceKey: 'local-development',
    capacity: 1,
    acquiredAt: new Date().toISOString(),
  });
  const ask = (
    tx: StorageRepositories,
    owner?: string,
    phase: 'start' | 'verify' = 'start',
    kind: ExecutionScope['kind'] = 'slice',
  ) =>
    scopePhaseBlockers(tx, ws, f.state.workItemId, { ...scope, kind }, phase, {
      ...(owner ? { ownerId: owner } : {}),
    });
  const busy = (blockers: ReturnType<typeof ask>) =>
    blockers.filter((b) => phaseBlockerCode(b) === 'resource-busy');

  // Unshared, as every caller outside a read snapshot asks: each call computes.
  calls.computed.length = 0;
  const alone = { a: ask(storage, 'run-a'), b: ask(storage, 'run-b'), none: ask(storage) };
  expect(calls.computed).toHaveLength(3);
  expect(busy(alone.a)).toEqual([]);
  expect(busy(alone.b)).toHaveLength(1);
  expect(busy(alone.none)).toHaveLength(1);

  // In one read snapshot: computed once, each owner's answer as when asked alone.
  calls.computed.length = 0;
  calls.resources.length = 0;
  const snapshot = mapReadSnapshot(storage);
  expect(ask(snapshot)).toEqual(alone.none);
  expect(ask(snapshot, 'run-a')).toEqual(alone.a);
  expect(ask(snapshot, 'run-b')).toEqual(alone.b);
  expect(calls.computed).toHaveLength(1);
  expect(calls.resources.map((r) => r.ownerId)).toEqual([undefined, 'run-a', 'run-b']);

  // A slice's verification asks the same of the slice at verify, with its own resource check.
  const verification = {
    slice: ask(storage, 'run-a', 'verify'),
    own: ask(storage, 'run-a', 'verify', 'slice-verification'),
  };
  calls.computed.length = 0;
  calls.resources.length = 0;
  expect(ask(snapshot, 'run-a', 'verify')).toEqual(verification.slice);
  expect(ask(snapshot, 'run-a', 'verify', 'slice-verification')).toEqual(verification.own);
  expect(calls.computed).toHaveLength(1);
  expect(calls.resources).toHaveLength(2);
});

it('shares a verification with its slice away from merge, and computes them apart at merge (R-D8 review L1)', async () => {
  const f = await adoptedMap();
  const { storage } = f.state.context;
  const ws = f.state.workspaceId;
  const slice = f.scopes[0]!;
  const verification: ExecutionScope = { ...slice, kind: 'slice-verification' };
  const snapshot = mapReadSnapshot(storage);
  for (const [phase, computations] of [
    ['start', 1],
    ['verify', 1],
    // At merge an unmerged candidate checkpoint counts for the slice alone (`candidateApplies`).
    ['merge', 2],
  ] as const) {
    calls.computed.length = 0;
    scopePhaseBlockers(snapshot, ws, f.state.workItemId, slice, phase, { resources: false });
    scopePhaseBlockers(snapshot, ws, f.state.workItemId, verification, phase, {
      resources: false,
    });
    expect(calls.computed, phase).toHaveLength(computations);
  }
});

it('keeps a resource blocker where it was, before the checks that follow it (R-D8 review L3)', async () => {
  const f = await adoptedMap();
  const { storage } = f.state.context;
  const ws = f.state.workspaceId;
  // Parent acceptance needs the verification workstation, held by another owner, and its
  // required slices, which have not merged: blockers from both sides of the resource check.
  const tree = await scopeTree(f, f.scopes[0]!);
  storage.phaseScheduling.setCapacity('local-verification', 1);
  storage.phaseScheduling.acquire({
    id: 'reservation-v',
    workspaceId: ws,
    worktreeId: tree.id,
    ownerId: 'run-other',
    phase: 'accept',
    resourceKey: 'local-verification',
    capacity: 1,
    acquiredAt: new Date().toISOString(),
  });
  const codes = scopePhaseBlockers(
    mapReadSnapshot(storage),
    ws,
    f.state.workItemId,
    f.parentScope,
    'accept',
    { ownerId: 'run-mine' },
  ).map((b) => phaseBlockerCode(b));
  const busy = codes.indexOf('resource-busy');
  const unmerged = codes.indexOf('required-slice-unmerged');
  expect(busy).toBeGreaterThanOrEqual(0);
  expect(unmerged).toBeGreaterThan(busy);
});

it('keys each read-snapshot memo by every input its answer reads (R-D8 review L3)', () => {
  const ws = 'ws-1' as WorkspaceId;
  const scope: ExecutionScope = {
    kind: 'slice',
    definitionId: asConcurrencyDefinitionId('map'),
    bindingRevision: 1,
    sourceId: 'a',
  };
  const receipt = { scope, workItemId: 'item' as WorkItemId, reviewRunId: 'run-1' as AgentRunId };
  const receiptKeys = [
    receipt,
    { ...receipt, reviewRunId: 'run-2' as AgentRunId },
    { ...receipt, workItemId: 'item-2' as WorkItemId },
    { ...receipt, scope: { ...scope, sourceId: 'b' } },
    { ...receipt, scope: { ...scope, kind: 'slice-verification' as const } },
    { ...receipt, scope: { ...scope, bindingRevision: 2 } },
  ].map((r) => receiptCurrencyKey(ws, r));
  expect(new Set(receiptKeys).size).toBe(receiptKeys.length);
  const d = { id: asConcurrencyDefinitionId('map'), digest: 'd1' };
  const requirement = { kind: 'slice' as const, id: 'a', state: 'merged' as const };
  const milestoneKeys = [
    milestoneMemoKey(ws, d, 1, requirement),
    milestoneMemoKey(ws, { ...d, digest: 'd2' }, 1, requirement),
    milestoneMemoKey(ws, d, 2, requirement),
    milestoneMemoKey(ws, d, 1, { ...requirement, id: 'b' }),
    milestoneMemoKey(ws, d, 1, { ...requirement, state: 'verified' as const }),
    milestoneMemoKey(ws, d, 1, { ...requirement, kind: 'work_item' as const }),
  ];
  expect(new Set(milestoneKeys).size).toBe(milestoneKeys.length);
  const decisionKeys = [
    scopeDecisionsKey(ws, scope),
    scopeDecisionsKey(ws, { ...scope, sourceId: 'b' }),
    scopeDecisionsKey(ws, { ...scope, bindingRevision: 2 }),
    scopeDecisionsKey(ws, { ...scope, definitionId: asConcurrencyDefinitionId('other') }),
    scopeDecisionsKey(ws, { ...scope, kind: 'parent-acceptance' }),
  ];
  expect(new Set(decisionKeys).size).toBe(decisionKeys.length);
  // Only a parent acceptance is told apart: a slice and its verification ask the same.
  expect(scopeDecisionsKey(ws, { ...scope, kind: 'slice-verification' })).toBe(decisionKeys[0]);
});

it("finds a work item's open recovery round as the roadmap's attempts list them (R-D8 review L3)", () => {
  const entries = [
    { id: 'e1', workItemId: 'w1' },
    { id: 'e2', workItemId: 'w1' },
    { id: 'e3', workItemId: 'w2' },
  ];
  const attempt = (id: string, entryId: string, phase?: string) => ({
    id,
    entryId,
    ...(phase ? { recovery: { phase } } : {}),
  });
  const roadmap = {
    definition: { entries },
    attempts: [
      attempt('plain', 'e1'),
      attempt('done', 'e1', 'completed'),
      attempt('first', 'e2', 'repair'),
      attempt('second', 'e1', 'verification'),
      attempt('other', 'e3', 'repair'),
    ],
  } as unknown as Roadmap;
  const open = openRecoveries(roadmap);
  expect(open.get('w1')?.id).toBe('first');
  expect(open.get('w2')?.id).toBe('other');
  // A new entries list (a new definition) is read again, not taken from the last answer.
  const moved = {
    ...roadmap,
    definition: { entries: [{ id: 'e2', workItemId: 'w3' }, ...entries.slice(0, 1)] },
  } as unknown as Roadmap;
  expect(openRecoveries(moved).get('w3')?.id).toBe('first');
  expect(openRecoveries(moved).get('w1')?.id).toBe('second');
});

it("asks a slice's merge whether that slice started, not another slice of its work item (R-D8 review L3)", async () => {
  const f = await adoptedMap();
  const { storage } = f.state.context;
  const [a, b] = [f.scopes[0]!, f.scopes[1]!];
  expect(a.sourceId).not.toBe(b.sourceId);
  // Slice b starts; slice a has not.
  const started = await launchScoped(f, await scopeTree(f, b));
  expect(started.statusCode, started.body).toBe(200);
  await waitFor(
    () =>
      storage.execution.runs
        .listForWorkItem(f.state.workspaceId, f.state.workItemId)
        .some((r) => !!r.startedAt),
    'slice b started',
  );
  const codes = (scope: ExecutionScope) =>
    scopePhaseBlockers(
      mapReadSnapshot(storage),
      f.state.workspaceId,
      f.state.workItemId,
      scope,
      'merge',
      {
        resources: false,
      },
    ).map((blocker) => phaseBlockerCode(blocker));
  expect(codes(a)).toContain('slice-not-started');
  expect(codes(b)).not.toContain('slice-not-started');
});

it('says a blocker once when two requirements name the same thing (R-D8 review L3)', async () => {
  // Slice b requires slice a merged both to start and to merge: one message, said once.
  const f = await supervisedMapFixture(true, 'automatic', false, false, false, (source) => ({
    ...source,
    slices: source.slices.map((slice, index) =>
      index === 1
        ? {
            ...slice,
            start_requires: [
              { kind: 'slice' as const, id: source.slices[0]!.id, state: 'merged' as const },
            ],
            merge_requires: [
              { kind: 'slice' as const, id: source.slices[0]!.id, state: 'merged' as const },
            ],
          }
        : slice,
    ),
  }));
  f.service.save(f.auth, f.state.workspaceId, f.input);
  await adoptSupervisedMap(f);
  const messages = scopePhaseBlockers(
    mapReadSnapshot(f.state.context.storage),
    f.state.workspaceId,
    f.state.workItemId,
    f.scopes[1]!,
    'merge',
    { resources: false },
  ).map((b) => b.message);
  expect(
    messages.filter((m) => m.startsWith('Slice ') && m.endsWith(' must be merged.')),
  ).toHaveLength(1);
  expect(new Set(messages).size).toBe(messages.length);
});
