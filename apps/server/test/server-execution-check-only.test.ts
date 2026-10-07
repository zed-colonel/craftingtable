import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentLaunchRequest, CheckOnlyManifest } from '@craftingtable/agents';
import type { AgentRunId } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import { DeclaredChecksMissingError } from '../src/services/errors.js';
import {
  admit,
  CycleBackend,
  cleanupExecutionFixtures,
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
  ready,
  registerAndWorktree,
  reviewText,
  roadmapControl,
  roadmapFixture,
  runLauncher,
  runToFinish,
  saveRoadmapRequest,
  slicedFixture,
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

it('a review prepared before its repository adopted checks keeps the earlier rule at merge (R-G13 increment 4)', async () => {
  const { state, backend, worktree } = await manualFixture(false);
  backend.replyForRequest = () => ({ resultText: reviewText([]) });
  await runToFinish(state, worktree.id, { role: 'review' });
  // Adopted after the review was prepared: the review has no record, and is not held to them.
  declareFixtureChecks(state);
  const merged = await merge(state, worktree.id);
  expect(merged.statusCode, merged.body).toBe(200);
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
