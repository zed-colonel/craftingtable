import type { WorkCycle } from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import { describe, expect, it } from 'vitest';
import { refreshOwner, requireReady } from '../../src/services/cycle-facts.js';
import {
  ConcurrentModificationError,
  ExecutionRequestError,
  TypedRefusalError,
} from '../../src/services/errors.js';
import { finalizationForCycle } from '../../src/services/finalization-policy.js';
import { reviewCapture } from '../../src/services/review-capture.js';

/**
 * The stop each typed throw site names (R-B4, decision 3; increment 4 review, MEDIUM-1): the
 * mechanism that turns a typed refusal into its stop has its own rows (`cycle-effects.test.ts`),
 * so these pin the code at the sites themselves.
 */

/** The stop a call refuses with, or `undefined` when it does not refuse with a typed one. */
async function stopOf(call: () => unknown): Promise<string | undefined> {
  try {
    await call();
  } catch (error) {
    if (error instanceof TypedRefusalError) return error.stop;
    throw error;
  }
  return undefined;
}

describe('the item gate (requireReady)', () => {
  const tx = (item: unknown, pending = false) =>
    ({
      planning: {
        workItems: { find: () => item },
        dependencies: {
          listPredecessors: () =>
            pending
              ? [{ workItemId: 'item-0', sourceId: 'AQ-00', status: 'admitted', kind: 'required' }]
              : [],
        },
      },
    }) as unknown as StorageRepositories;
  const ready =
    (item: unknown, pending = false) =>
    () =>
      requireReady(tx(item, pending), 'ws' as never, 'item-1' as never);
  it.each([
    ['a missing item', undefined, false, 'item-unavailable'],
    ['a proposed item', { status: 'proposed', planVersionId: 'p' }, false, 'item-not-admitted'],
    [
      'an item marked complete',
      { status: 'completed', planVersionId: 'p' },
      false,
      'item-completed-unmerged',
    ],
    [
      'a required predecessor still open',
      { status: 'admitted', planVersionId: 'p' },
      true,
      'predecessors-incomplete',
    ],
    ['an admitted item', { status: 'admitted', planVersionId: 'p' }, false, undefined],
  ])('%s', async (_name, item, pending, stop) =>
    expect(await stopOf(ready(item, pending))).toBe(stop),
  );
});

describe('the finalization and its authority', () => {
  const cycle = {
    id: 'cycle-1',
    workspaceId: 'ws',
    worktreeId: 'tree-1',
    finalizationId: 'fin-1',
    createdByUserId: 'user-1',
  } as unknown as WorkCycle;
  const storage = (finalization: unknown, user: unknown = { id: 'user-1', status: 'active' }) =>
    ({
      execution: { finalizations: { find: () => finalization } },
      users: { findById: () => user },
      workspaces: { findAuthorized: () => ({ membership: { role: 'owner' } }) },
    }) as unknown as CraftingTableStorage;
  const active = { status: 'active', cycleId: 'cycle-1', worktreeId: 'tree-1', workspaceId: 'ws' };
  it('stops a cycle whose finalization is no longer active', async () => {
    expect(await stopOf(() => finalizationForCycle(storage(undefined), cycle))).toBe(
      'finalization-inactive',
    );
    expect(
      await stopOf(() => finalizationForCycle(storage({ ...active, status: 'stopped' }), cycle)),
    ).toBe('finalization-inactive');
  });
  it('stops a finalization whose authority was revoked', async () =>
    expect(
      await stopOf(() =>
        refreshOwner(storage(active, { id: 'user-1', status: 'disabled' }), cycle),
      ),
    ).toBe('authority-lost'));
});

describe('a review continuation’s capture (reviewCapture)', () => {
  it.each([
    [
      'a plain refusal is the continuation’s',
      new ExecutionRequestError('conflict', 'Branch moved.'),
      'review-capture-failed',
    ],
    [
      'a typed refusal keeps its stop',
      new TypedRefusalError('predecessor-merge-missing', 'Merge absent.'),
      'predecessor-merge-missing',
    ],
  ])('%s', async (_name, error, stop) =>
    expect(
      await stopOf(() =>
        reviewCapture(async () => {
          throw error;
        }),
      ),
    ).toBe(stop),
  );
  it('passes contention and the unexpected on', async () => {
    const contention = new ConcurrentModificationError('Another write won.');
    await expect(
      reviewCapture(async () => {
        throw contention;
      }),
    ).rejects.toBe(contention);
    const unexpected = new TypeError('x is undefined');
    await expect(
      reviewCapture(async () => {
        throw unexpected;
      }),
    ).rejects.toBe(unexpected);
  });
});

it('reads a typed refusal as the refusal it was, by name too (logs, the scheduler’s records)', () => {
  const error = new TypedRefusalError('worktree-state', 'Off its branch.');
  expect(error).toBeInstanceOf(ExecutionRequestError);
  expect(error.name).toBe('ExecutionRequestError');
  expect(error.code).toBe('conflict');
});
