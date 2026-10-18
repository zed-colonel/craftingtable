import type { StorageRepositories } from '@craftingtable/storage';
import { describe, expect, it } from 'vitest';
import { activeEditor, activeUser } from '../../src/services/authority-policy.js';
import {
  EXTRA_ROUNDS_LIMIT,
  INSTRUCTION_LIMIT,
  validExtraRounds,
  withinInstructionLimit,
} from '../../src/services/command-bounds.js';
import { policyMismatch } from '../../src/services/repository-policy.js';

/**
 * The cycle half's shared validators, one copy each (R-B7 increment 3, CTRL-14). The sites that
 * ask them, each with its own refusal, have their rows in `validator-sites.test.ts` and the
 * decision tables.
 */

describe("the delegated user's authority", () => {
  const tx = (user: unknown, role?: string) =>
    ({
      users: { findById: (id: string) => (user && id === 'user-1' ? user : undefined) },
      workspaces: {
        findAuthorized: (id: string, workspaceId: string) =>
          role && id === 'user-1' && workspaceId === 'ws' ? { membership: { role } } : undefined,
      },
    }) as unknown as StorageRepositories;
  const active = { id: 'user-1', status: 'active' };
  it.each([
    ['an active owner', active, 'owner', true],
    ['an active editor', active, 'editor', true],
    ['an active viewer', active, 'viewer', false],
    ['an active non-member', active, undefined, false],
    ['an inactive owner', { id: 'user-1', status: 'disabled' }, 'owner', false],
    ['no such user', undefined, 'owner', false],
  ])('%s', (_name, user, role, editor) => {
    expect(activeEditor(tx(user, role), 'user-1' as never, 'ws' as never)).toBe(
      editor ? user : undefined,
    );
    expect(activeUser(tx(user, role), 'user-1' as never)).toBe(
      (user as { status?: string } | undefined)?.status === 'active' ? user : undefined,
    );
  });
  it('answers nothing for no user id, and for another workspace', () => {
    expect(activeEditor(tx(active, 'owner'), undefined, 'ws' as never)).toBeUndefined();
    expect(activeEditor(tx(active, 'owner'), null, 'ws' as never)).toBeUndefined();
    expect(activeUser(tx(active, 'owner'), undefined)).toBeUndefined();
    expect(activeEditor(tx(active, 'owner'), 'user-1' as never, 'other' as never)).toBeUndefined();
  });
});

describe('the bounds on what the daemon composes', () => {
  it('passes 16,000 characters of instructions, and refuses one more', () => {
    expect(INSTRUCTION_LIMIT).toBe(16_000);
    expect(withinInstructionLimit('x'.repeat(16_000))).toBe(true);
    expect(withinInstructionLimit('x'.repeat(16_001))).toBe(false);
    expect(withinInstructionLimit('')).toBe(true);
  });
  it.each([
    [1, 1, 0, true],
    [20, 1, 0, true],
    [21, 1, 0, false],
    [0, 1, 0, false],
    [0, 0, 0, true],
    [-1, 0, 0, false],
    [1.5, 1, 0, false],
    [Number.NaN, 0, 0, false],
    [20, 1, Number.MAX_SAFE_INTEGER - 40, true],
    [20, 1, Number.MAX_SAFE_INTEGER - 39, false],
  ])('%s extra rounds from at least %s, %s already granted: %s', (rounds, min, base, valid) => {
    expect(EXTRA_ROUNDS_LIMIT).toBe(20);
    expect(validExtraRounds(rounds, { min: min as 0 | 1, base })).toBe(valid);
  });
});

describe('the repository policy match', () => {
  const policy = { repositoryId: 'repo-1', integrationBranch: 'revision' } as never;
  const item = { repositoryId: 'repo-1', integrationBranch: 'revision' } as never;
  it.each([
    ['no adopted policy', undefined, item, false],
    ['the same repository and integration branch', policy, item, false],
    ['another repository', policy, { ...(item as object), repositoryId: 'repo-2' }, true],
    [
      'another integration branch',
      policy,
      { ...(item as object), integrationBranch: 'main' },
      true,
    ],
    [
      "a plan finalization's worktree on another branch",
      policy,
      { ...(item as object), integrationBranch: 'main', planVersionId: 'plan-1' },
      false,
    ],
    [
      "a plan finalization's worktree in another repository",
      policy,
      { ...(item as object), repositoryId: 'repo-2', planVersionId: 'plan-1' },
      true,
    ],
  ])('%s', (_name, adopted, worktree, mismatched) =>
    expect(policyMismatch(adopted, worktree as never)).toBe(mismatched),
  );
});
