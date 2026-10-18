import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { cycleAttention, DEFAULT_COMPLETION_POLICY } from '@craftingtable/domain';
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
  mutationHeaders,
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

// R-B4 increment 4 re-check (W21): a review whose findings need remediation, finished while its
// worktree left the managed branch, stops on the worktree's state, not as controller-error.
it('stops on the worktree’s state when a review with findings ends off its branch', async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([structuredFinding]) },
  ]);
  backend.onLaunch = (request) => {
    if (request.model === 'review-model') git(['checkout', '-b', 'elsewhere'], worktree.path);
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'off-branch stop');
  expect(currentCycle(state, cycle)).toMatchObject({
    step: 'review',
    attention: { code: 'worktree-state' },
    reason: expect.stringContaining('Remediation requires the managed branch'),
  });
  expect(backend.launches.map((r) => r.model)).not.toContain('remediate-model');
});

// R-B4 increment 4 re-check (W6): a passing review that leaves its worktree off the managed
// branch stops on the worktree's state at approval, not as controller-error. (Approval's own
// check comes before the clean-head read, which is reached only if the tree changes between.)
it('stops on the worktree’s state when a passing review leaves its worktree off its branch', async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  backend.onLaunch = (request) => {
    if (request.model === 'review-model') git(['checkout', '-b', 'elsewhere'], worktree.path);
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status !== 'running', 'approval stop');
  expect(currentCycle(state, cycle)).toMatchObject({
    status: 'needs-attention',
    step: 'review',
    attention: { code: 'worktree-state' },
    reason: 'Review approval requires the managed branch without unresolved Git operations.',
  });
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

// R-B4, decision 4: housekeeping's limit stop at an implement step is answered as every limit
// stop is, with Authorize more remediation, which relaunches the housekeeping remediation.
it('relaunches the housekeeping remediation when more is authorized at its limit stop', async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      writeFileSync(join(worktree.path, 'unknown.wal'), 'test artifact');
    if (request.model === 'remediate-model') rmSync(join(worktree.path, 'unknown.wal'));
  };
  const cycle = await startCycle(state, worktree.id, {
    policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
  });
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'limit stop');
  const stopped = currentCycle(state, cycle);
  expect(stopped).toMatchObject({
    step: 'implement',
    attention: { code: 'remediation-exhausted' },
  });
  // Reviews that stalled before the stop (R-B4 increment 4 re-check).
  state.context.storage.execution.cycles.replace(
    { ...stopped, stalledReviews: 2, version: stopped.version + 1 },
    stopped.version,
  );
  const grant = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
    headers: mutationHeaders(state),
    payload: {
      action: 'authorize-remediation',
      expectedVersion: stopped.version + 1,
      additionalRounds: 1,
      instructions: 'Remove the generated artifact.',
    },
  });
  expect(grant.statusCode, grant.body).toBe(200);
  // The grant opens a new progress window, as at a review's limit, and says what it authorized.
  expect(grant.json().cycle).toMatchObject({
    step: 'remediate',
    stalledReviews: 0,
    reason: 'Authorized 1 additional remediation attempt(s); starting remediation.',
  });
  // The grant's own write, by its action.
  expect(
    state.context.storage.audit
      .listWorkspace({ workspaceId: state.workspaceId, limit: 200 })
      .filter((event) => event.targetId === cycle.id)
      .map((event) => (event.metadata as { action?: string } | undefined)?.action),
  ).toContain('authorize-remediation');
  await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'remediated');
  expect(backend.launches.map((r) => r.model)).toEqual([
    'design-model',
    'implement-model',
    'remediate-model',
    'review-model',
  ]);
  const remediation = backend.launches[2]!.prompt;
  expect(remediation).toContain('Files remain after implementation finalization.');
  expect(remediation).toContain('Remove the generated artifact.');
  expect(currentCycle(state, cycle)).toMatchObject({
    remediationRounds: 1,
    additionalRemediationRounds: 1,
  });
});

// Operator decision 2026-10-16 (R-B4, decision 4 at every step): housekeeping's limit stop after
// a passing review, whose approval found the worktree changed, takes the grant too, and the grant
// relaunches that housekeeping rather than leaving Stop as the only control.
it('relaunches the approval’s housekeeping when more is authorized at its limit stop at a review step', async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  let reviews = 0;
  backend.onLaunch = (request) => {
    if (request.model === 'review-model' && ++reviews === 1)
      writeFileSync(join(worktree.path, 'review.wal'), 'left by the review');
    if (request.model === 'remediate-model') rmSync(join(worktree.path, 'review.wal'));
  };
  const cycle = await startCycle(state, worktree.id, {
    policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
  });
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'limit stop');
  const limit = currentCycle(state, cycle);
  expect(limit).toMatchObject({
    step: 'review',
    attention: { code: 'remediation-exhausted' },
    reason: expect.stringContaining('Verification changed the worktree.'),
  });
  const grant = () =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: {
        action: 'authorize-remediation',
        expectedVersion: currentCycle(state, cycle).version,
        additionalRounds: 1,
        instructions: 'Remove what the review left behind.',
      },
    });
  // Only the limit stop: the same passing review at another stop asks for no remediation.
  const replace = (fields: Record<string, unknown>) => {
    const current = currentCycle(state, cycle);
    state.context.storage.execution.cycles.replace(
      { ...current, ...fields, version: current.version + 1 },
      current.version,
    );
  };
  replace({ attention: cycleAttention('restart-resume') });
  const elsewhere = await grant();
  expect(elsewhere.statusCode).toBe(409);
  expect(elsewhere.body).toContain('A valid review requiring remediation is needed');
  replace({ attention: limit.attention });
  const granted = await grant();
  expect(granted.statusCode, granted.body).toBe(200);
  await waitFor(() => currentCycle(state, cycle).status === 'awaiting-merge', 'remediated');
  expect(backend.launches.map((r) => r.model)).toEqual([
    'design-model',
    'implement-model',
    'review-model',
    'remediate-model',
    'review-model',
  ]);
  const remediation = backend.launches[3]!.prompt;
  expect(remediation).toContain('Verification changed the worktree.');
  expect(remediation).toContain('Remove what the review left behind.');
});

// R-B4 increment 4 review: the grant at housekeeping's limit is refused where it would not help.
it('refuses the housekeeping grant at another stop, too few rounds, or an unsettled worktree', async () => {
  const { state, backend, worktree } = await cycleFixture([
    designDone,
    implementationDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model')
      writeFileSync(join(worktree.path, 'unknown.wal'), 'test artifact');
  };
  const cycle = await startCycle(state, worktree.id, {
    policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
  });
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'limit stop');
  const grant = (additionalRounds = 1) =>
    state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: {
        action: 'authorize-remediation',
        expectedVersion: currentCycle(state, cycle).version,
        additionalRounds,
        instructions: 'Remove the generated artifact.',
      },
    });
  const rewrite = (fields: Record<string, unknown>) => {
    const current = currentCycle(state, cycle);
    state.context.storage.execution.cycles.replace(
      { ...current, ...fields, version: current.version + 1 },
      current.version,
    );
  };
  const limit = currentCycle(state, cycle);
  // Off its managed branch, the remediation would run on the wrong branch.
  git(['checkout', '-b', 'elsewhere'], worktree.path);
  const offBranch = await grant();
  expect(offBranch.statusCode).toBe(409);
  expect(offBranch.body).toContain('Remediation requires the managed branch');
  git(['checkout', worktree.branchName], worktree.path);
  // So would a pending merge (R-B4 increment 4 re-check).
  const mergeHead = resolve(
    worktree.path,
    git(['rev-parse', '--git-path', 'MERGE_HEAD'], worktree.path).trim(),
  );
  writeFileSync(mergeHead, `${git(['rev-parse', 'HEAD'], worktree.path).trim()}\n`);
  const pending = await grant();
  expect(pending.statusCode).toBe(409);
  expect(pending.body).toContain('without unresolved Git operations');
  rmSync(mergeHead);
  // Rounds already spent beyond the allowance need a grant that covers them.
  rewrite({ remediationRounds: 2 });
  const tooFew = await grant(1);
  expect(tooFew.statusCode).toBe(409);
  expect(tooFew.body).toContain('Authorize at least 3 more');
  // Another stop at the step is not the limit's.
  rewrite({ remediationRounds: 0, attention: cycleAttention('step-incomplete') });
  expect((await grant()).statusCode).toBe(409);
  // A worktree that is no longer active takes no remediation (R-B4 increment 4 re-check).
  rewrite({ attention: cycleAttention('remediation-exhausted') });
  state.context.storage.execution.worktrees.markRemoved({
    workspaceId: state.workspaceId,
    worktreeId: worktree.id,
    occurredAt: new Date().toISOString(),
  });
  const inactive = await grant();
  expect(inactive.statusCode).toBe(409);
  expect(inactive.body).toContain('The managed worktree must be active');
  expect(backend.launches.map((r) => r.model)).toEqual(['design-model', 'implement-model']);
  expect(limit.step).toBe('implement');
});

// R-B4 increment 4 re-check: the grant inspects the worktree before it writes, and a cycle
// changed meanwhile (a pause, another tab's grant), or a merge or launch that took the worktree,
// refuses it, as at a review's limit.
it.each([
  ['the cycle changed', 'Cycle changed; refresh before authorizing more remediation.'],
  ['a launch took the worktree', 'A review is starting in this worktree'],
])(
  'refuses the housekeeping grant when %s during its worktree inspection',
  async (what, refusal) => {
    const real = createGitOperations({ gitExecutable: 'git' });
    let during: (() => void) | undefined;
    const { state, backend, worktree } = await cycleFixture(
      [designDone, implementationDone, implementationDone, { resultText: reviewText([]) }],
      undefined,
      {
        ...real,
        inspectWorktreeChanges: async (path) => {
          const result = await real.inspectWorktreeChanges(path);
          const change = during;
          during = undefined;
          change?.();
          return result;
        },
      },
    );
    backend.onLaunch = (request) => {
      if (request.model === 'implement-model')
        writeFileSync(join(worktree.path, 'unknown.wal'), 'test artifact');
    };
    const cycle = await startCycle(state, worktree.id, {
      policy: { ...DEFAULT_COMPLETION_POLICY, maxRemediationRounds: 0 },
    });
    await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'limit stop');
    const stopped = currentCycle(state, cycle);
    let release = () => {};
    // The cycle's one mutation guard, shared by its modules (R-B7 increment 8: the commands).
    const lane = (
      state.context.services.workCycleService as unknown as {
        controls: { mutations: { hold: (id: string, until: Promise<unknown>) => void } };
      }
    ).controls.mutations;
    during =
      what === 'the cycle changed'
        ? () =>
            state.context.storage.execution.cycles.replace(
              { ...stopped, reason: 'Changed elsewhere.', version: stopped.version + 1 },
              stopped.version,
            )
        : () => lane.hold(worktree.id, new Promise((resolve) => (release = () => resolve(null))));
    const raced = await state.context.app.inject({
      method: 'POST',
      url: `/api/workspaces/${state.workspaceId}/cycles/${cycle.id}/control`,
      headers: mutationHeaders(state),
      payload: {
        action: 'authorize-remediation',
        expectedVersion: stopped.version,
        additionalRounds: 1,
        instructions: 'Remove the generated artifact.',
      },
    });
    release();
    expect(raced.statusCode, raced.body).toBe(409);
    expect(raced.body).toContain(refusal);
    expect(currentCycle(state, cycle)).toMatchObject({ remediationRounds: 0, step: 'implement' });
    expect(backend.launches.map((r) => r.model)).toEqual(['design-model', 'implement-model']);
  },
);
