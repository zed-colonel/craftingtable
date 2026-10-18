import type { WorkCycle } from '@craftingtable/domain';
import type { CraftingTableStorage } from '@craftingtable/storage';
import { afterEach, expect, it } from 'vitest';
import { cycleFacts } from '../src/services/cycle/core/facts.js';
import { decide } from '../src/services/cycle/core/machine.js';
import { createCycleFixture } from './cycle-test-support.js';
import { cleanupExecutionFixtures, startCycle } from './execution-test-support.js';

/**
 * The real `CycleFacts` over real storage (R-B4 increment 2 review, LOW-1): every fact is read
 * when a guard asks for it, once, so an idle pass costs only what its deciding guard reads.
 */

afterEach(cleanupExecutionFixtures);

/** The storage, counting each repository method it is asked for by name. */
function counted(storage: CraftingTableStorage) {
  const calls = new Map<string, number>();
  const wrap = (target: object, path: string): unknown =>
    new Proxy(target, {
      get(object, key, receiver) {
        const value = Reflect.get(object, key, receiver);
        const name = `${path}.${String(key)}`;
        if (typeof value === 'function')
          return (...args: unknown[]) => {
            calls.set(name, (calls.get(name) ?? 0) + 1);
            return Reflect.apply(value, object, args);
          };
        return value && typeof value === 'object' ? wrap(value, name) : value;
      },
    });
  return { storage: wrap(storage, 'storage') as CraftingTableStorage, calls };
}

it('reads each fact once, and only the deciding guard’s facts', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  const { storage, calls } = counted(f.context.storage);
  // A scoped stop: its phase gate would read the map, which a stopped cycle never asks.
  const stopped = {
    ...cycle,
    status: 'needs-attention',
    executionScope: { kind: 'slice', definitionId: 'map', bindingRevision: 1, sourceId: 'wi/A' },
  } as unknown as WorkCycle;
  let owners = 0;
  const facts = cycleFacts(storage, stopped, {
    now: new Date(),
    settling: new Set(['roadmap-1']),
    owner: () => {
      owners += 1;
      return undefined;
    },
  });
  // Building the facts reads nothing.
  expect([...calls.keys()]).toEqual([]);
  decide(
    stopped,
    facts,
    { refreshing: () => false, cleaningRun: () => false, draining: () => false },
    new Date(),
  );
  // A cycle waiting for the operator reads its worktree and nothing that evaluates a gate.
  expect(
    [...calls.keys()].filter((name) => /phaseScheduling|imports|planning|runEvents/.test(name)),
  ).toEqual([]);
  // Each fact is remembered: the owner the settle check reads is asked once.
  facts.settling();
  facts.settling();
  expect(owners).toBe(1);
});

it('refuses the readiness of a cycle whose finalization is no longer active', async () => {
  const f = await createCycleFixture();
  const cycle = await startCycle(f, f.worktreeId);
  const facts = cycleFacts(
    f.context.storage,
    { ...cycle, workItemId: undefined, finalizationId: 'fin-gone' } as unknown as WorkCycle,
    { now: new Date(), settling: new Set(), owner: () => undefined },
  );
  expect(facts.readiness()).toMatchObject({ kind: 'refused', code: 'finalization-inactive' });
});
