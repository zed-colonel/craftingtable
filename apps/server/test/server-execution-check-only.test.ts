import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentLaunchRequest, CheckOnlyManifest } from '@craftingtable/agents';
import type { AgentRunId, WorktreeId } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { DeclaredChecksMissingError } from '../src/services/errors.js';
import {
  admit,
  CycleBackend,
  cleanupExecutionFixtures,
  controlCycle,
  currentCycle,
  commitFile,
  declareFixtureChecks,
  designDone,
  directories,
  fixtureRepository,
  git,
  implementationDone,
  merge,
  mergeGate,
  mutationHeaders,
  ready,
  registerAndWorktree,
  reviewText,
  roadmapControl,
  roadmapFixture,
  runLauncher,
  runToFinish,
  saveRoadmapRequest,
  slicedFixture,
  scopeReport,
  scopeTree,
  startCycle,
  storedRoadmap,
  waitFor,
  withoutDaemonChecks,
} from './execution-test-support.js';

const SCRIPT = '#!/bin/sh\ngit diff --check HEAD\n';

/**
 * R-G13 increment 4 (operator decisions 2026-10-06): a run with no pinned dependency
 * environment, in a repository with adopted checks, is held to them through a check-only
 * manifest, and the daemon runs them before a review starts. A roadmap's cycle in a repository
 * without an adoption stops as `repository-checks-undeclared`; other runs there keep today's
 * rule.
 */

afterEach(cleanupExecutionFixtures);

type State = Awaited<ReturnType<typeof ready>>;

/** What a check-only run's review was held to and given, as stored and as launched. */
function checkOnlyRun(state: State, runId: AgentRunId, request?: AgentLaunchRequest) {
  const storage = state.context.storage;
  const environment = storage.runtimeEvidence.run(state.workspaceId, runId);
  const run = storage.execution.runs.find(state.workspaceId, runId)!;
  const receipts = storage.runtimeEvidence
    .checkReceipts(state.workspaceId, runId)
    .map((r) => ({ ...JSON.parse(r.receipt), recordedAt: r.recordedAt }));
  const bin = request?.buildEnvironment?.binDirectory;
  return {
    environment,
    run,
    receipts,
    manifest: bin
      ? (JSON.parse(readFileSync(join(bin, '..', 'manifest.json'), 'utf8')) as CheckOnlyManifest)
      : undefined,
    launchers: bin ? readdirSync(bin) : undefined,
  };
}

/** Each part of a check-only review that the design requires (R-G13 increment 4). */
function expectCheckOnlyReview(state: State, runId: AgentRunId, request: AgentLaunchRequest) {
  const held = checkOnlyRun(state, runId, request);
  const declaration = state.context.storage.runtimeEvidence.checkDeclarations(
    state.workspaceId,
    held.run.repositoryId,
  )[0]!;
  // Held to the current adoption, by the daemon, with no runtime.
  expect(held.environment).toMatchObject({
    receiptAuthority: 'daemon',
    checkDeclarationId: declaration.id,
  });
  expect(held.environment?.runtimeId).toBeUndefined();
  expect(held.manifest).toMatchObject({
    kind: 'checks',
    runId,
    declaredChecks: { declarationId: declaration.id },
  });
  expect(held.launchers).toEqual(['ct-check']);
  // The daemon ran the adopted check on the reviewed head before the reviewer started.
  expect(held.receipts).toEqual([
    expect.objectContaining({
      origin: 'daemon',
      success: true,
      clean: true,
      headSha: held.run.reviewBranchContext?.headSha,
      declaredCheck: expect.objectContaining({ id: 'fixture', declarationId: declaration.id }),
    }),
  ]);
  expect(held.receipts[0]).not.toHaveProperty('runtimeId');
  expect(held.receipts[0].recordedAt <= held.run.startedAt!).toBe(true);
  // Its brief names the adopted checks, and nothing of Cargo.
  expect(held.run.brief).toContain('this run has no pinned dependency environment');
  expect(held.run.brief).toContain(
    `${request.buildEnvironment!.binDirectory}/ct-check --declared fixture`,
  );
  expect(held.run.brief).not.toContain('Cargo launcher');
  expect(request.prompt).toContain('- fixture: exited 0.');
  return held;
}

/** A manual worktree, committed work and, unless `adopt` is false, adopted checks. */
async function manualFixture(adopt = true) {
  const backend = new CycleBackend([]);
  const state = await ready({ backend });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  if (adopt) declareFixtureChecks(state);
  commitFile(worktree.path, 'feature.txt', 'feature\n');
  return { state, backend, worktree };
}

const lastLaunch = (backend: CycleBackend, cwd: string) =>
  backend.launches.filter((request) => request.cwd === cwd).at(-1)!;

it('a manual review in a repository with adopted checks gets a check-only manifest, and the daemon runs them first (R-G13 increment 4, D3)', async () => {
  const { state, backend, worktree } = await manualFixture();
  const review = await runToFinish(state, worktree.id, {
    role: 'review',
    instructions: 'VERDICT-MERGEABLE',
  });
  expectCheckOnlyReview(state, review, lastLaunch(backend, worktree.path));
  // An implementing run is held to them too, and told to run them early.
  const implement = await runToFinish(state, worktree.id, { role: 'implement' });
  const held = checkOnlyRun(state, implement, lastLaunch(backend, worktree.path));
  expect(held.environment?.checkDeclarationId).toBeDefined();
  expect(held.run.brief).toContain('After committing, run them to check your work early');
});

it('a manual run in a repository without adopted checks keeps the earlier rule: no manifest (R-G13 increment 4, D2)', async () => {
  const { state, backend, worktree } = await manualFixture(false);
  const review = await runToFinish(state, worktree.id, {
    role: 'review',
    instructions: 'VERDICT-MERGEABLE',
  });
  expect(state.context.storage.runtimeEvidence.run(state.workspaceId, review)).toBeUndefined();
  expect(lastLaunch(backend, worktree.path).buildEnvironment).toBeUndefined();
});

it("a whole-item roadmap cycle's review gets a check-only manifest, and the daemon runs the adopted checks first (R-G13 increment 4)", async () => {
  const { state, backend } = await roadmapFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  declareFixtureChecks(state);
  expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(() => {
    const attempt = storedRoadmap(state).attempts[0];
    const cycle =
      attempt && state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId);
    if (cycle?.status === 'needs-attention')
      throw new Error(`${cycle.attention?.code}: ${cycle.reason}`);
    return cycle?.status === 'awaiting-merge';
  }, 'the roadmap cycle awaits its merge');
  const attempt = storedRoadmap(state).attempts[0]!;
  const cycle = state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId)!;
  const tree = state.context.storage.execution.worktrees.find(
    state.workspaceId,
    attempt.worktreeId,
  )!;
  expect(tree.executionScope).toBeUndefined();
  expectCheckOnlyReview(state, cycle.currentRunId, lastLaunch(backend, tree.path));
});

it('a roadmap cycle in a repository without adopted checks stops as repository-checks-undeclared before any launch (R-G13 increment 4, D2)', async () => {
  const { state, backend, repository } = await roadmapFixture(undefined, { undeclared: true });
  expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(() => {
    const attempt = storedRoadmap(state).attempts[0];
    const cycle =
      attempt && state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId);
    return cycle?.status === 'needs-attention';
  }, 'the roadmap cycle stops');
  const attempt = storedRoadmap(state).attempts[0]!;
  const cycle = state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId)!;
  expect(cycle.attention).toMatchObject({
    code: 'repository-checks-undeclared',
    refs: { repositoryId: repository.id },
  });
  expect(backend.launches).toHaveLength(0);
});

it('a slice of a map without a runtime gets a check-only manifest, and the daemon runs the adopted checks first (R-G13 increment 4)', async () => {
  const f = await slicedFixture((source) => ({
    ...source,
    slices: source.slices.map((s) => ({ ...s, mode: 'implementation' })),
  }));
  declareFixtureChecks(f.state);
  const tree = await scopeTree(f, f.scopes[0]!);
  expect(
    f.state.context.storage.runtimeEvidence.generations(
      f.state.workspaceId,
      f.scopes[0]!.definitionId,
      1,
    ),
  ).toEqual([]);
  commitFile(tree.path, 'slice.txt', 'slice\n');
  const backend = f.backend as CycleBackend;
  backend.replyForRequest = () => ({ resultText: reviewText([]) });
  const review = await runToFinish(f.state, tree.id, { role: 'review' });
  expectCheckOnlyReview(f.state, review, lastLaunch(backend, tree.path));
});

it('works on a host without Cargo: the manifest names none, and the adopted check runs (R-G13 increment 4)', async () => {
  const { state, backend, worktree } = await manualFixture();
  // A PATH with Git and the shell tools, and a HOME without Cargo's directory.
  const bin = mkdtempSync(join(tmpdir(), 'ct-no-cargo-'));
  directories.push(bin);
  for (const directory of ['/usr/local/bin', '/usr/bin', '/bin'])
    for (const name of (() => {
      try {
        return readdirSync(directory);
      } catch {
        return [];
      }
    })())
      if (!/^(cargo|rustup|rustc)/.test(name))
        try {
          symlinkSync(join(directory, name), join(bin, name));
        } catch {
          /* already linked from an earlier directory */
        }
  const home = join(bin, 'home');
  mkdirSync(home);
  vi.stubEnv('PATH', bin);
  vi.stubEnv('HOME', home);
  try {
    const review = await runToFinish(state, worktree.id, {
      role: 'review',
      instructions: 'VERDICT-MERGEABLE',
    });
    const held = expectCheckOnlyReview(state, review, lastLaunch(backend, worktree.path));
    expect(held.manifest).not.toHaveProperty('cargoExecutable');
  } finally {
    vi.unstubAllEnvs();
  }
});

/** The reviewer runs a command it chooses and claims success; the daemon's own runs are off. */
function reviewerRunsItsOwnCheck(state: State, backend: CycleBackend) {
  withoutDaemonChecks(state);
  backend.replyForRequest = async (request) => {
    if (request.prompt.includes('Adopted repository checks')) {
      await runLauncher(request, 'ct-check', ['--', 'true']);
    }
    return { resultText: reviewText([]) };
  };
}

it("refuses the operator's merge of a check-only review without a daemon receipt of each adopted check on the reviewed head; ct-check -- true does not count (R-G13 increment 4)", async () => {
  const { state, backend, worktree } = await manualFixture();
  reviewerRunsItsOwnCheck(state, backend);
  const review = await runToFinish(state, worktree.id, { role: 'review' });
  const receipts = checkOnlyRun(state, review).receipts;
  // The agent's own check ran and was recorded: successful, clean, on the head, and no run of
  // an adopted check.
  expect(receipts).toEqual([
    expect.objectContaining({ origin: 'agent', success: true, clean: true, command: 'true' }),
  ]);
  expect(await mergeGate(state, worktree.id)).toMatchObject({
    mergeable: false,
    reason: 'scope-blocked',
  });
  const refused = await merge(state, worktree.id);
  expect(refused.statusCode).toBe(409);
  expect(refused.body).toContain('ct-check --declared fixture');
  // A review whose adopted check the daemon ran meets the gate, and the merge goes ahead.
  vi.restoreAllMocks();
  backend.replyForRequest = () => ({ resultText: reviewText([]) });
  await runToFinish(state, worktree.id, { role: 'review' });
  expect(await mergeGate(state, worktree.id)).toMatchObject({ mergeable: true, reason: 'ready' });
  const merged = await merge(state, worktree.id);
  expect(merged.statusCode, merged.body).toBe(200);
});

it('refuses a delegated merge of a check-only review without a daemon receipt of each adopted check (R-G13 increment 4)', async () => {
  const { state, backend, worktree } = await manualFixture();
  reviewerRunsItsOwnCheck(state, backend);
  await runToFinish(state, worktree.id, { role: 'review' });
  const auth = state.context.services.authService.authenticate(state.cookie.split('=')[1]!);
  await expect(
    state.context.services.executionService.mergeWorktree(
      auth,
      state.workspaceId,
      worktree.id,
      {},
      undefined,
      { roadmapId: '00000000-0000-4000-8000-000000000001', definitionRevision: 1, check: () => {} },
    ),
  ).rejects.toBeInstanceOf(DeclaredChecksMissingError);
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, worktree.id),
  ).toBeUndefined();
});

/** Both merges of a worktree's review: the delegated one, then the operator's. */
async function expectBothMergesRefused(state: State, worktreeId: WorktreeId) {
  const auth = state.context.services.authService.authenticate(state.cookie.split('=')[1]!);
  await expect(
    state.context.services.executionService.mergeWorktree(
      auth,
      state.workspaceId,
      worktreeId,
      {},
      undefined,
      { roadmapId: '00000000-0000-4000-8000-000000000001', definitionRevision: 1, check: () => {} },
    ),
  ).rejects.toBeInstanceOf(DeclaredChecksMissingError);
  expect(await mergeGate(state, worktreeId)).toMatchObject({
    mergeable: false,
    reason: 'scope-blocked',
  });
  const refused = await merge(state, worktreeId);
  expect(refused.statusCode).toBe(409);
  expect(refused.body).toContain('ct-check --declared fixture');
  expect(
    state.context.storage.execution.merges.latest(state.workspaceId, worktreeId),
  ).toBeUndefined();
}

it('refuses both merges of a review prepared before its repository adopted checks; with no adoption it keeps the earlier rule (R-G13 increment 4, operator decision 2026-10-07)', async () => {
  const { state, backend, worktree } = await manualFixture(false);
  backend.replyForRequest = () => ({ resultText: reviewText([]) });
  const review = await runToFinish(state, worktree.id, { role: 'review' });
  expect(state.context.storage.runtimeEvidence.run(state.workspaceId, review)).toBeUndefined();
  // No adoption: the earlier rule, under which the review alone gates the merge.
  expect(await mergeGate(state, worktree.id)).toMatchObject({ mergeable: true, reason: 'ready' });
  // Adopted after the review was prepared: the review ran none of the checks, so it is refused.
  declareFixtureChecks(state);
  await expectBothMergesRefused(state, worktree.id);
  // No cycle owns the worktree: its exit is a fresh review.
  expect((await merge(state, worktree.id)).body).toContain('Run a fresh review');
  // A fresh review, held to the adoption, merges.
  await runToFinish(state, worktree.id, { role: 'review' });
  const merged = await merge(state, worktree.id);
  expect(merged.statusCode, merged.body).toBe(200);
});

it('merges a review in a repository without adopted checks under the earlier rule (R-G13 increment 4, operator decision 2026-10-07)', async () => {
  const { state, backend, worktree } = await manualFixture(false);
  backend.replyForRequest = () => ({ resultText: reviewText([]) });
  await runToFinish(state, worktree.id, { role: 'review' });
  const merged = await merge(state, worktree.id);
  expect(merged.statusCode, merged.body).toBe(200);
});

it.each([
  ['the adopted check failed on the reviewed head', 'failed'],
  ['the only passing run of it was on another commit', 'other-commit'],
  ['the run of it was not clean', 'unclean'],
] as const)(
  'refuses both merges of a check-only review when %s (R-G13 increment 4, review M1)',
  async (_label, condition) => {
    const { state, backend, worktree } = await manualFixture(condition !== 'failed');
    if (condition === 'failed') {
      // The daemon's own run of the adopted check, before the reviewer: it fails.
      declareFixtureChecks(state, [
        {
          id: 'fixture',
          argv: ['git', 'rev-parse', '--verify', 'refs/heads/no-such-branch'],
          definitionPaths: [],
        },
      ]);
      backend.replyForRequest = () => ({ resultText: reviewText([]) });
    } else {
      withoutDaemonChecks(state);
      backend.replyForRequest = async (request) => {
        if (!request.prompt.includes('Adopted repository checks'))
          return { resultText: reviewText([]) };
        if (condition === 'other-commit') {
          // Commit Y, run the adopted check on it, and go back to the reviewed head H.
          const reviewed = git(['rev-parse', 'HEAD'], request.cwd).trim();
          commitFile(request.cwd, 'other.txt', 'other\n');
          await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
          git(['reset', '--hard', reviewed], request.cwd);
        } else {
          // An untracked file while the check runs.
          writeFileSync(join(request.cwd, 'untracked.txt'), 'x\n');
          await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
          rmSync(join(request.cwd, 'untracked.txt'));
        }
        return { resultText: reviewText([]) };
      };
    }
    const review = await runToFinish(state, worktree.id, { role: 'review' });
    const [receipt] = checkOnlyRun(state, review).receipts;
    // The one receipt of the adopted check fails exactly the condition under test.
    expect(receipt).toMatchObject({ declaredCheck: expect.objectContaining({ id: 'fixture' }) });
    const head = state.context.storage.execution.runs.find(state.workspaceId, review)!
      .reviewBranchContext!.headSha;
    expect([receipt.success, receipt.headSha === head, receipt.clean]).toEqual([
      condition !== 'failed',
      condition !== 'other-commit',
      condition !== 'unclean',
    ]);
    await expectBothMergesRefused(state, worktree.id);
  },
);

it('a manual cycle in a repository without adopted checks keeps the earlier rule (R-G13 increment 4, D2, review L2)', async () => {
  const backend = new CycleBackend([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  const state = await ready({ backend });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  await admit(state);
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model') commitFile(request.cwd, 'feature.txt', 'feature\n');
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => {
    const current = currentCycle(state, cycle);
    if (current.status === 'needs-attention')
      throw new Error(`${current.attention?.code}: ${current.reason}`);
    return current.status === 'awaiting-merge';
  }, 'the manual cycle awaits its merge');
  expect(
    state.context.storage.runtimeEvidence.run(
      state.workspaceId,
      currentCycle(state, cycle).currentRunId,
    ),
  ).toBeUndefined();
  expect(backend.launches.every((request) => request.buildEnvironment === undefined)).toBe(true);
});

it("a run is held to its repository's current adoption, not an earlier one (R-G13 increment 4, review L2)", async () => {
  const { state, backend, worktree } = await manualFixture();
  const storage = state.context.storage;
  const first = storage.runtimeEvidence.checkDeclarations(
    state.workspaceId,
    worktree.repositoryId,
  )[0]!;
  storage.runtimeEvidence.addCheckDeclaration({ ...first, id: randomUUID(), version: 2 });
  const current = storage.runtimeEvidence.checkDeclarations(
    state.workspaceId,
    worktree.repositoryId,
  )[0]!;
  expect(current.version).toBe(2);
  backend.replyForRequest = () => ({ resultText: reviewText([]) });
  const review = await runToFinish(state, worktree.id, { role: 'review' });
  const held = checkOnlyRun(state, review, lastLaunch(backend, worktree.path));
  expect(held.environment?.checkDeclarationId).toBe(current.id);
  expect(held.manifest?.declaredChecks).toMatchObject({ declarationId: current.id, version: 2 });
});

it("a manual run beside a paused roadmap cycle is not that cycle's: in a repository without adopted checks it keeps the earlier rule (R-G13 increment 4, review L4)", async () => {
  const { state, backend } = await roadmapFixture(
    [designDone, implementationDone, { resultText: reviewText([]) }],
    { undeclared: true },
  );
  expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(() => {
    const attempt = storedRoadmap(state).attempts[0];
    const cycle =
      attempt && state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId);
    return cycle?.status === 'needs-attention';
  }, 'the roadmap cycle stops');
  const attempt = storedRoadmap(state).attempts[0]!;
  const tree = state.context.storage.execution.worktrees.find(
    state.workspaceId,
    attempt.worktreeId,
  )!;
  commitFile(tree.path, 'manual.txt', 'manual\n');
  backend.replyForRequest = () => ({ resultText: reviewText([]) });
  // The operator's own run in the stopped cycle's worktree: not the roadmap's.
  const review = await runToFinish(state, tree.id, { role: 'review' });
  expect(state.context.storage.runtimeEvidence.run(state.workspaceId, review)).toBeUndefined();
  expect(lastLaunch(backend, tree.path).buildEnvironment).toBeUndefined();
});

it('a check-only review whose work changed an adopted definition stops as check-definition-changed; its merge does not adopt it (R-G13 increment 4)', async () => {
  const backend = new CycleBackend([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  const state = await ready({ backend });
  const root = fixtureRepository();
  mkdirSync(join(root, '.craftingtable'));
  writeFileSync(
    join(root, '.craftingtable', 'checks.json'),
    `${JSON.stringify({ version: 1, checks: [{ id: 'fixture', argv: ['scripts/check.sh'] }] })}\n`,
  );
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'check.sh'), SCRIPT, { mode: 0o755 });
  git(['add', '--all'], root);
  git(['commit', '--no-gpg-sign', '-m', 'checks'], root);
  const { repository, worktree } = await registerAndWorktree(state, root);
  await admit(state);
  // Adopted as the operator adopts, so a merge could propose a new version of it.
  const auth = state.context.services.authService.authenticate(state.cookie.split('=')[1]!);
  const checks = state.context.services.repositoryChecksService;
  const preview = await checks.preview(auth, state.workspaceId, repository.id, 'main');
  expect(preview.issues).toEqual([]);
  await checks.adopt(auth, state.workspaceId, repository.id, {
    ref: 'main',
    expectedCommit: preview.commitSha,
    rationale: 'The fixture checks.',
  });
  backend.onLaunch = (request) => {
    if (request.model === 'implement-model') {
      writeFileSync(join(request.cwd, 'scripts', 'check.sh'), `${SCRIPT}echo changed\n`);
      git(['add', '--all'], request.cwd);
      git(['commit', '--no-gpg-sign', '-m', 'change the check'], request.cwd);
    }
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => {
    const current = currentCycle(state, cycle);
    return current.status === 'needs-attention' || current.status === 'awaiting-merge';
  }, 'the review is decided');
  // Adoption at merge is a scoped slice's (increment 5); the exit here is adopting on the
  // Repositories page.
  expect(currentCycle(state, cycle)).toMatchObject({
    status: 'needs-attention',
    attention: { code: 'check-definition-changed', refs: { repositoryId: repository.id } },
  });
});

it("refuses to start a check-only run when the daemon's check service cannot run its checks (R-G13 increment 4)", async () => {
  const { state, worktree } = await manualFixture();
  // A daemon whose check service is not attached: nothing would run or record the checks.
  (state.context.services.agentRunService as unknown as { checks: undefined }).checks = undefined;
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id, role: 'review' },
  });
  expect(started.statusCode).not.toBe(200);
  expect(started.body).toContain('check service is not running');
  expect(
    state.context.storage.execution.runs.listForWorktree(state.workspaceId, worktree.id),
  ).toEqual([]);
});

it('a check-only slice whose work changed an adopted definition cannot adopt it at merge (R-G13 increment 4)', async () => {
  const f = await slicedFixture((source) => ({
    ...source,
    slices: source.slices.map((s) => ({ ...s, mode: 'implementation' })),
  }));
  const { state } = f;
  const root = f.repository.rootPath;
  mkdirSync(join(root, '.craftingtable'));
  writeFileSync(
    join(root, '.craftingtable', 'checks.json'),
    `${JSON.stringify({ version: 1, checks: [{ id: 'fixture', argv: ['scripts/check.sh'] }] })}\n`,
  );
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'check.sh'), SCRIPT, { mode: 0o755 });
  git(['add', '--all'], root);
  git(['commit', '--no-gpg-sign', '-m', 'checks'], root);
  const checks = state.context.services.repositoryChecksService;
  const preview = await checks.preview(f.auth, state.workspaceId, f.repository.id, 'main');
  await checks.adopt(f.auth, state.workspaceId, f.repository.id, {
    ref: 'main',
    expectedCommit: preview.commitSha,
    rationale: 'The fixture checks.',
  });
  const tree = await scopeTree(f, f.scopes[0]!);
  writeFileSync(join(tree.path, 'scripts', 'check.sh'), `${SCRIPT}echo changed\n`);
  git(['add', '--all'], tree.path);
  git(['commit', '--no-gpg-sign', '-m', 'change the check'], tree.path);
  (f.backend as CycleBackend).replyForRequest = () => ({
    resultText: scopeReport(state, tree.executionScope!),
  });
  await runToFinish(state, tree.id, { role: 'review' });
  const diagnosis = await checks.definitionsOf(f.auth, state.workspaceId, tree.id);
  expect(diagnosis?.merge?.proposalDigest).toBeDefined();
  const declarationId = state.context.storage.runtimeEvidence.checkDeclarations(
    state.workspaceId,
    f.repository.id,
  )[0]!.id;
  const adopting = await merge(state, tree.id, {
    adoptChecks: {
      proposalDigest: diagnosis!.merge!.proposalDigest,
      rationale: 'Adopt at merge.',
      declarationId,
    },
  });
  expect(adopting.statusCode).toBe(409);
  expect(adopting.body).toContain('nothing to adopt');
  // Without an adoption, the gate refuses the changed definition.
  const plain = await merge(state, tree.id);
  expect(plain.statusCode).toBe(409);
  expect(plain.body).toContain('differ from the adopted ones');
  expect(
    state.context.storage.runtimeEvidence.checkDeclarations(state.workspaceId, f.repository.id),
  ).toHaveLength(1);
});

it('lists a slice whose review has no record as scope-blocked once its repository adopts checks (R-G13 increment 4, re-check R2)', async () => {
  const f = await slicedFixture((source) => ({
    ...source,
    slices: source.slices.map((s) => ({ ...s, mode: 'implementation' })),
  }));
  const tree = await scopeTree(f, f.scopes[0]!);
  commitFile(tree.path, 'slice.txt', 'slice\n');
  (f.backend as CycleBackend).replyForRequest = () => ({
    resultText: scopeReport(f.state, tree.executionScope!),
  });
  // Reviewed while the repository had no adoption: no record, the earlier rule.
  const review = await runToFinish(f.state, tree.id, { role: 'review' });
  expect(f.state.context.storage.runtimeEvidence.run(f.state.workspaceId, review)).toBeUndefined();
  expect(await mergeGate(f.state, tree.id)).toMatchObject({ mergeable: true, reason: 'ready' });
  declareFixtureChecks(f.state);
  expect(await mergeGate(f.state, tree.id)).toMatchObject({
    mergeable: false,
    reason: 'scope-blocked',
  });
});

it("a roadmap cycle awaiting the operator's merge with a review prepared before its checks were adopted recovers by Pause, then Resume (R-G13 increment 4, re-check R1)", async () => {
  const { state, backend } = await roadmapFixture([
    designDone,
    implementationDone,
    { resultText: reviewText([]) },
  ]);
  expect((await saveRoadmapRequest(state)).statusCode).toBe(200);
  await roadmapControl(state, 'start');
  await waitFor(() => {
    const attempt = storedRoadmap(state).attempts[0];
    const cycle =
      attempt && state.context.storage.execution.cycles.find(state.workspaceId, attempt.cycleId);
    return cycle?.status === 'awaiting-merge';
  }, 'the roadmap cycle awaits its merge');
  const attempt = storedRoadmap(state).attempts[0]!;
  const storage = state.context.storage;
  const first = storage.execution.cycles.find(state.workspaceId, attempt.cycleId)!;
  // A review prepared before the deploy, or before the adoption: it has no record.
  const recorded = storage.runtimeEvidence.run.bind(storage.runtimeEvidence);
  const hidden = vi
    .spyOn(storage.runtimeEvidence, 'run')
    .mockImplementation((ws, id) => (id === first.currentRunId ? undefined : recorded(ws, id)));
  try {
    const refused = await merge(state, attempt.worktreeId);
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain('prepared without the repository');
    // The refusal names the cycle's own exit.
    expect(refused.body).toContain('Pause its cycle, then resume it');
    backend.replyForRequest = () => ({ resultText: reviewText([]) });
    const paused = await controlCycle(state, first, 'pause');
    await controlCycle(state, paused, 'resume');
    await waitFor(() => {
      const cycle = storage.execution.cycles.find(state.workspaceId, first.id)!;
      if (cycle.status === 'needs-attention')
        throw new Error(`${cycle.attention?.code}: ${cycle.reason}`);
      return cycle.status === 'awaiting-merge' && cycle.currentRunId !== first.currentRunId;
    }, 'a fresh review awaits the merge');
    const fresh = storage.execution.cycles.find(state.workspaceId, first.id)!;
    expect(
      storage.runtimeEvidence.run(state.workspaceId, fresh.currentRunId)?.checkDeclarationId,
    ).toBeDefined();
    const merged = await merge(state, attempt.worktreeId);
    expect(merged.statusCode, merged.body).toBe(200);
  } finally {
    hidden.mockRestore();
  }
  // The roadmap kept its cycle throughout.
  expect(storedRoadmap(state).attempts[0]!.cycleId).toBe(first.id);
  expect(storedRoadmap(state).status).not.toBe('needs-attention');
});
