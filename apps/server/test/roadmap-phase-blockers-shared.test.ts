import { roadmapPageSchema } from '@craftingtable/contracts';
import { phaseBlockerCode, type ExecutionScope } from '@craftingtable/domain';
import type { StorageRepositories } from '@craftingtable/storage';
import { afterEach, expect, it, vi } from 'vitest';
import { scopePhaseBlockers } from '../src/services/execution-scope.js';
import { mapReadSnapshot } from '../src/services/map-read-snapshot.js';
import {
  adoptSupervisedMap,
  cleanupExecutionFixtures,
  roadmapId,
  scopeTree,
  supervisedMapFixture,
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
