import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/**
 * Each of the thirteen `during` sites names the operation that runs there (increment 11c review,
 * LOW-1): the table is the review's, by file and the member the site is in.
 */
it('names, at each site, the operation that holds the worktree there', () => {
  const services = join(import.meta.dirname, '../src/services');
  const expected: Record<string, readonly (readonly [string, WorktreeOperation])[]> = {
    'run/launch.ts': [['launchWithin', 'run-launch']],
    'execution-service.ts': [
      ['recordScopeReceipt', 'scope-receipt'],
      ['removeWorktree', 'removal'],
      ['releaseDecisionWorktree', 'decision-release'],
      ['mergeWorktree', 'merge'],
    ],
    'branch-service.ts': [['changeWorktree', 'update']],
    'storage-service.ts': [
      ['cleanCaches', 'cache-cleaning'],
      ['removeWorktreeCache', 'cache-cleaning'],
    ],
    'cycle/commands/recovery.ts': [['prepareBaseline', 'baseline-preparation']],
    'cycle/commands/control.ts': [
      ['reviewScopeAgain', 'review-again'],
      ['repeatScopeReview', 'scope-review-repeat'],
    ],
    'cycle/effects/remediation.ts': [['finalizeImplementation', 'implementation-checkpoint']],
    'cycle/effects/integration.ts': [['resolutionMutation', 'integration-resolution']],
  };
  const found: Record<string, [string, string][]> = {};
  for (const file of Object.keys(expected)) {
    let member = '';
    for (const line of readFileSync(join(services, file), 'utf8').split('\n')) {
      const declared = /^ {2}(?:private |protected )?(?:async )?(\w+)(?:<[^>]*>)?\(/.exec(line);
      if (declared) member = declared[1]!;
      const site = /\.during\([^,]+,\s*'([a-z-]+)'/.exec(line);
      if (site) found[file] = [...(found[file] ?? []), [member, site[1]!]];
    }
  }
  expect(found).toEqual(expected);
  expect(Object.values(found).flat()).toHaveLength(13);
});
