import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { createGitOperations } from '../src/operations.js';
import { GIT_EXECUTABLE } from './test-support.js';

/** `packages/git` split by concern (R-G10 F, GIT-10). */
const source = (name = '') => fileURLToPath(new URL(`../src/${name}`, import.meta.url));

it('keeps operations.ts to the types and the factory, and runner.ts the only process authority', () => {
  expect(readFileSync(source('operations.ts'), 'utf8').split('\n').length).toBeLessThanOrEqual(400);
  const spawning = readdirSync(source())
    .filter((name) => name.endsWith('.ts'))
    .filter((name) => /from 'node:child_process'/.test(readFileSync(source(name), 'utf8')));
  expect(spawning).toEqual(['runner.ts']);
  const scope = readFileSync(
    fileURLToPath(new URL('../../../scripts/check-forbidden-scope.mjs', import.meta.url)),
    'utf8',
  );
  expect(scope).toContain("'packages/git/src/runner.ts'");
  expect(scope).not.toContain("'packages/git/src/operations.ts'");
});

it('composes one plain object with every operation, as test doubles and proxies use it', () => {
  const git = createGitOperations({ gitExecutable: GIT_EXECUTABLE });
  expect(Object.getPrototypeOf(git)).toBe(Object.prototype);
  const copy = { ...git };
  expect(Object.keys(copy).sort()).toEqual(
    [
      'abortIntegrationResolution',
      'branchHeads',
      'checkpointWorktree',
      'commonAncestor',
      'createBranch',
      'createWorktree',
      'deleteBranch',
      'deleteContainedBranch',
      'ensureBaselineTag',
      'exactBranchCommit',
      'exportCommit',
      'finishIntegrationResolution',
      'inspectIntegrationResolution',
      'inspectMergeOperation',
      'inspectRepository',
      'inspectWorktreeChanges',
      'isAncestor',
      'listBaselineTags',
      'listBranches',
      'listCommitPaths',
      'mergeBranch',
      'mergeTree',
      'prepareIntegrationResolution',
      'preserveRef',
      'previewIntegration',
      'readCommitFiles',
      'removeWorktree',
      'resolveBranch',
      'resolveCommit',
      'snapshotWorktree',
      'updateWorktree',
      'worktreeDiff',
      'worktreeHead',
    ].sort(),
  );
  expect(Object.values(copy).every((value) => typeof value === 'function')).toBe(true);
});
