import type { WorktreeId } from '@craftingtable/domain';
import { expect, it } from 'vitest';
import {
  WORKTREE_HELD_BY,
  type WorktreeOperation,
  WorktreeMutationBusyError,
  WorktreeMutationGuard,
} from '../src/services/worktree-mutation-guard.js';

/**
 * R-B7 decision 3 (AGT-12): the worktree guard's refusal names what holds the worktree, with one
 * error class and status for every holder, so a retry and the cycle's contention rule read the
 * class, never the text.
 */

const OPERATIONS = Object.keys(WORKTREE_HELD_BY) as WorktreeOperation[];
const tree = 'worktree-1' as WorktreeId;

it('names twelve operations, each with its own text', () => {
  expect(OPERATIONS).toHaveLength(12);
  expect(new Set(Object.values(WORKTREE_HELD_BY)).size).toBe(12);
});

it.each(OPERATIONS)(
  'refuses another operation while %s holds the worktree, naming it',
  async (holder) => {
    const guard = new WorktreeMutationGuard();
    let release!: () => void;
    const held = guard.during(
      tree,
      holder,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    let refused: unknown;
    try {
      await guard.during(tree, 'merge', async () => undefined);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(WorktreeMutationBusyError);
    expect(refused).toMatchObject({ code: 'conflict', message: WORKTREE_HELD_BY[holder] });
    expect(() => guard.requireAvailable(tree)).toThrow(WORKTREE_HELD_BY[holder]);
    release();
    await held;
    // Released: the next operation runs.
    await expect(guard.during(tree, 'merge', async () => 'merged')).resolves.toBe('merged');
  },
);

it('keeps the held and terminating texts', async () => {
  const guard = new WorktreeMutationGuard();
  let release!: () => void;
  guard.hold(tree, new Promise<void>((resolve) => (release = resolve)));
  expect(() => guard.requireAvailable(tree)).toThrow(
    'A review is starting in this worktree; its adopted checks are running. Wait for the review to start.',
  );
  release();
  await Promise.resolve();
  await Promise.resolve();
  let exit!: () => void;
  const exiting = guard.untilExited(tree, new Promise<void>((resolve) => (exit = resolve)));
  expect(() => guard.requireAvailable(tree)).toThrow(
    'An agent that lost supervision is still being terminated in this worktree; wait for its process to exit',
  );
  exit();
  await exiting;
  expect(() => guard.requireAvailable(tree)).not.toThrow();
});
