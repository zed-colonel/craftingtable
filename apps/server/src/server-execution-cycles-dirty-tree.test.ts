import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGitOperations } from '@craftingtable/git';
import { afterEach, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  admit,
  CycleBackend,
  cleanupExecutionFixtures,
  controlCycle,
  currentCycle,
  cycleFixture,
  designDone,
  fixtureRepository,
  git,
  implementationDone,
  ready,
  registerAndWorktree,
  reviewText,
  startCycle,
  structuredFinding,
  waitFor,
} from './execution-test-support.js';

afterEach(cleanupExecutionFixtures);

it('finalizes an implementer’s tracked edits and staged new source before the first review', async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  backend.onLaunch = (request) => {
    expect(request.temporaryDirectory).toBeTruthy();
    expect(request.temporaryDirectory?.startsWith(worktree.path)).toBe(false);
    expect(request.prompt).toContain('Do not redirect temporary files to the worktree root');
    writeFileSync(join(request.temporaryDirectory ?? '', 'generated-test.wal'), 'temporary');
    if (request.model === 'implement-model') {
      writeFileSync(join(worktree.path, 'README.md'), 'implementation edit');
      writeFileSync(join(worktree.path, 'added.ts'), 'intended new source');
      git(['add', '--', 'added.ts'], worktree.path);
    }
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(
    () => currentCycle(state, cycle).status === 'awaiting-merge',
    'checkpoint then review',
  );
  const settled = currentCycle(state, cycle);
  expect(backend.launches.map((r) => r.model)).toEqual([
    'design-model',
    'implement-model',
    'review-model',
  ]);
  expect(settled.checkpoint?.paths).toEqual(['README.md', 'added.ts']);
  expect(settled.checkpoint?.commitSha).toBe(settled.reviewHeadSha);
  expect(git(['status', '--porcelain'], worktree.path)).toBe('');
  expect(git(['log', '-1', '--format=%s'], worktree.path)).toContain('CraftingTable: finalize run');
});

it('hands dirty negative review findings directly to remediation', async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([structuredFinding]) },
    implementationDone,
    {
      resultText: reviewText([
        { ...structuredFinding, status: 'resolved', disposition: 'Verified fix.' },
      ]),
    },
  ]);
  backend.onLaunch = (request) => {
    if (request.model === 'review-model' && backend.launches.length === 2)
      writeFileSync(join(worktree.path, 'review-test.wal'), 'review-generated');
    if (request.model === 'remediate-model') {
      expect(request.prompt).toContain('F-001');
      expect(request.prompt).toContain('Never blindly commit untracked files');
      rmSync(join(worktree.path, 'review-test.wal'));
      writeFileSync(join(worktree.path, 'README.md'), 'remediated source');
    }
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(
    () => currentCycle(state, cycle).status === 'awaiting-merge',
    'dirty review remediation',
  );
  expect(backend.launches.map((r) => r.model)).toEqual([
    'design-model',
    'implement-model',
    'review-model',
    'remediate-model',
    'review-model',
  ]);
  expect(currentCycle(state, cycle).remediationRounds).toBe(1);
  expect(git(['ls-files'], worktree.path)).not.toContain('.wal');
});

it('routes unclassified new files through bounded remediation without checkpointing them blindly', async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      writeFileSync(join(worktree.path, 'unknown.wal'), 'test artifact');
    if (request.model === 'remediate-model') {
      expect(git(['ls-files'], worktree.path)).not.toContain('unknown.wal');
      rmSync(join(worktree.path, 'unknown.wal'));
    }
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'classified files');
  expect(backend.launches.map((r) => r.model)).toEqual([
    'design-model',
    'implement-model',
    'remediate-model',
    'review-model',
  ]);
});

it('resumes an older dirty negative review directly into remediation', async () => {
  const real = createGitOperations({ gitExecutable: 'git' });
  let rejectOnce = true;
  const backend = new CycleBackend([
    designDone,
    implementationDone,
    { resultText: reviewText([structuredFinding]) },
    implementationDone,
    {
      resultText: reviewText([
        { ...structuredFinding, status: 'resolved', disposition: 'Verified after remediation.' },
      ]),
    },
  ]);
  const state = await ready({
    backend,
    gitOperations: {
      ...real,
      inspectWorktreeChanges: async (path) => {
        const result = await real.inspectWorktreeChanges(path);
        if (
          rejectOnce &&
          backend.launches.at(-1)?.model === 'review-model' &&
          result.ok &&
          result.value.untracked.length
        ) {
          rejectOnce = false;
          return {
            ok: false,
            failure: { kind: 'git-failed', message: 'Simulated pre-fix dirty review stop' },
          };
        }
        return result;
      },
    },
  });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  await admit(state);
  backend.onLaunch = (request) => {
    if (request.model === 'review-model' && backend.launches.length === 2)
      writeFileSync(join(worktree.path, 'review.wal'), 'generated');
    if (request.model === 'remediate-model') {
      expect(request.prompt).toContain('F-001');
      expect(request.prompt).toContain('Remove only confirmed generated test artifacts');
      rmSync(join(worktree.path, 'review.wal'));
    }
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'old review stop');
  expect(currentCycle(state, cycle).step).toBe('review');
  await controlCycle(state, currentCycle(state, cycle), 'resume');
  await waitFor(
    () => currentCycle(state, cycle).status === 'awaiting-merge',
    'resumed remediation',
  );
  expect(backend.launches.map((request) => request.model)).toEqual([
    'design-model',
    'implement-model',
    'review-model',
    'remediate-model',
    'review-model',
  ]);
});

it('a stop during an automatic checkpoint cannot launch a late review', async () => {
  const real = createGitOperations({ gitExecutable: 'git' });
  let entered: (() => void) | undefined;
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const backend = new CycleBackend([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  const state = await ready({
    workers: true,
    backend,
    gitOperations: {
      ...real,
      checkpointWorktree: async (input) => {
        const result = await real.checkpointWorktree(input);
        entered?.();
        await barrier;
        return result;
      },
    },
  });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  await admit(state);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      writeFileSync(join(worktree.path, 'README.md'), 'source change');
  };
  const cycle = await startCycle(state, worktree.id);
  try {
    await waiting;
    expect(currentCycle(state, cycle).checkpoint?.commitSha).toBeUndefined();
    expect(currentCycle(state, cycle).checkpoint?.paths).toEqual(['README.md']);
    await controlCycle(state, currentCycle(state, cycle), 'stop');
  } finally {
    release?.();
  }
  await state.context.services.workCycleService.shutdown();
  expect(currentCycle(state, cycle).status).toBe('stopped');
  expect(backend.launches.map((request) => request.model)).toEqual([
    'design-model',
    'implement-model',
  ]);
  expect(git(['log', '-1', '--format=%s'], worktree.path)).toContain('CraftingTable: finalize run');
});

it.each(['untracked artifact', 'index-only change'])(
  'requires cleanup and a fresh review after a positive review leaves an %s',
  async (kind) => {
    const { state, backend, worktree } = await cycleFixture([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const original = readFileSync(join(worktree.path, 'README.md'), 'utf8');
    backend.onLaunch = (request) => {
      if (request.model === 'review-model' && backend.launches.length === 2) {
        if (kind === 'untracked artifact')
          writeFileSync(join(worktree.path, 'review.wal'), 'temporary');
        else {
          writeFileSync(join(worktree.path, 'README.md'), 'staged change');
          git(['add', 'README.md'], worktree.path);
          writeFileSync(join(worktree.path, 'README.md'), original);
        }
      }
      if (request.model === 'remediate-model') {
        expect(request.prompt).toContain('The prior approval is invalid');
        if (kind === 'untracked artifact') rmSync(join(worktree.path, 'review.wal'));
        else git(['add', 'README.md'], worktree.path);
      }
    };
    const cycle = await startCycle(state, worktree.id);
    await waitFor(
      () => currentCycle(state, cycle).status === 'awaiting-merge',
      'fresh clean review',
    );
    expect(backend.launches.map((request) => request.model)).toEqual([
      'design-model',
      'implement-model',
      'review-model',
      'remediate-model',
      'review-model',
    ]);
    expect(currentCycle(state, cycle).remediationRounds).toBe(1);
    expect(git(['status', '--porcelain'], worktree.path)).toBe('');
  },
);
