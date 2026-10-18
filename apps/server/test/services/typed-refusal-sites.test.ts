import type { WorkCycle } from '@craftingtable/domain';
import type { CraftingTableStorage, StorageRepositories } from '@craftingtable/storage';
import { describe, expect, it } from 'vitest';
import {
  creatorAuthorized,
  refreshOwner,
  requireReady,
} from '../../src/services/cycle/core/facts.js';
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

  // A cycle with no work item (R-B7 increment 12): the sites pass its absent id on as they did
  // with `!`, and it is the same stop as an unknown item, never a lookup.
  it('a cycle with no work item', async () =>
    expect(
      await stopOf(() =>
        requireReady(tx({ status: 'admitted', planVersionId: 'p' }), 'ws' as never, undefined),
      ),
    ).toBe('item-unavailable'));

  it('says how to leave the stop of an item marked complete (increment 5 review)', () =>
    expect(ready({ status: 'completed', planVersionId: 'p' })).toThrow(
      'This work item was marked complete without merging its worktree. Merge the worktree by hand, after stopping its cycle if one runs, or reconcile the queue.',
    ));

  // The item before the scope's phase gate (increment 5 review, LOW-4): a tx without the
  // map's records would fail the scope's read, so the item's refusal must come first.
  it('answers with the item before the scope', async () =>
    expect(
      await stopOf(() =>
        requireReady(
          tx({ status: 'proposed', planVersionId: 'p' }),
          'ws' as never,
          'item-1' as never,
          { kind: 'slice' } as never,
        ),
      ),
    ).toBe('item-not-admitted'));
});

// R-B7 increment 3 (CTRL-14): the guard's fact, the shared rule's answer for the cycle's creator.
describe("the cycle creator's authority (creatorAuthorized)", () => {
  const cycle = { workspaceId: 'ws', createdByUserId: 'user-1' } as unknown as WorkCycle;
  const tx = (user: unknown, access: unknown) =>
    ({
      users: { findById: () => user },
      workspaces: { findAuthorized: () => access },
    }) as unknown as StorageRepositories;
  const active = { id: 'user-1', status: 'active' };
  it.each([
    ['an active owner', active, { membership: { role: 'owner' } }, true],
    ['an active editor', active, { membership: { role: 'editor' } }, true],
    ['an active viewer', active, { membership: { role: 'viewer' } }, false],
    ['an active user who left the workspace', active, undefined, false],
    [
      'an inactive owner',
      { id: 'user-1', status: 'disabled' },
      { membership: { role: 'owner' } },
      false,
    ],
    ['no user', undefined, { membership: { role: 'owner' } }, false],
  ])('%s: %s', (_name, user, access, authorized) =>
    expect(creatorAuthorized(tx(user, access), cycle)).toBe(authorized),
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
  const storage = (
    finalization: unknown,
    user: unknown = { id: 'user-1', status: 'active' },
    access: unknown = { membership: { role: 'owner' } },
  ) =>
    ({
      execution: { finalizations: { find: () => finalization } },
      users: { findById: () => user },
      workspaces: { findAuthorized: () => access },
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
  // R-B7 increment 3 (CTRL-14): the site keeps its refusal for every way the rule fails.
  it.each([
    ['an inactive user', { id: 'user-1', status: 'disabled' }, { membership: { role: 'owner' } }],
    ['a viewer', { id: 'user-1', status: 'active' }, { membership: { role: 'viewer' } }],
    // `null` where the repository answers nothing: `undefined` would take the stub's default.
    ['a user who left the workspace', { id: 'user-1', status: 'active' }, null],
    ['no user', null, { membership: { role: 'owner' } }],
  ])('refuses the finalization of %s with its own text', (_name, user, access) => {
    let refused: unknown;
    try {
      refreshOwner(storage(active, user, access), cycle);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(TypedRefusalError);
    expect({
      stop: (refused as TypedRefusalError).stop,
      message: (refused as Error).message,
    }).toEqual({ stop: 'authority-lost', message: 'Finalization authority was revoked' });
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
