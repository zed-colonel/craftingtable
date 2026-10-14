import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  FixtureWheels,
  OPT_PYTHON,
  OPT_UV,
  writePythonProject,
} from '../../../packages/agents/test/python-fixture.js';
import {
  admit,
  CycleBackend,
  cleanupExecutionFixtures,
  currentCycle,
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
  runToFinish,
  startCycle,
  waitFor,
} from './execution-test-support.js';

/**
 * R-G17 increment 3, through the daemon: a review of a Python project runs its adopted check
 * first, in a fresh venv built offline from verified wheels; the brief tells agents to `uv sync`
 * and that checks run offline; the merge goes through on that receipt; an unadopted change to
 * the lock stops as `check-definition-changed`.
 */

afterEach(cleanupExecutionFixtures);

const optToolchain = existsSync(OPT_PYTHON) && existsSync(OPT_UV);
const itPython = it.skipIf(!optToolchain);
const UNITTEST = ['python', '-m', 'unittest', 'discover', '-s', 'tests', '-v'];

/** Settings naming the operator's toolchain and, unless told not to, the pypi source. */
function pythonSettings(pypi = true): Record<string, string> {
  const configDir = mkdtempSync(join(tmpdir(), 'craftingtable-python-settings-'));
  directories.push(configDir);
  writeFileSync(
    join(configDir, 'toolchains.json'),
    JSON.stringify({
      version: 1,
      python: { interpreter: OPT_PYTHON, version: '3.12' },
      uv: { path: OPT_UV, version: '0.12' },
    }),
  );
  writeFileSync(
    join(configDir, 'outside-sources.json'),
    JSON.stringify({
      version: 1,
      sources: [{ kind: 'cargo' }, ...(pypi ? [{ kind: 'pypi' }] : [])],
    }),
  );
  return { CRAFTINGTABLE_CONFIG_DIR: configDir };
}

/** A Python project repository with its checks file, adopted as the operator adopts it. */
async function pythonRepository(backend: CycleBackend, options: { pypi?: boolean } = {}) {
  const root = fixtureRepository();
  const wheels = mkdtempSync(join(tmpdir(), 'craftingtable-python-wheels-'));
  directories.push(wheels);
  const wheel = writePythonProject(root, wheels);
  mkdirSync(join(root, '.craftingtable'));
  writeFileSync(
    join(root, '.craftingtable', 'checks.json'),
    `${JSON.stringify({
      version: 1,
      checks: [{ id: 'tests', argv: UNITTEST, definitionPaths: ['pyproject.toml', 'uv.lock'] }],
    })}\n`,
  );
  git(['add', '--all'], root);
  git(['commit', '--no-gpg-sign', '-m', 'a Python project'], root);
  const state = await ready({
    backend,
    env: pythonSettings(options.pypi ?? true),
    pythonWheels: new FixtureWheels([wheel]),
  });
  const { repository, worktree } = await registerAndWorktree(state, root);
  const auth = state.context.services.authService.authenticate(state.cookie.split('=')[1]!);
  const checks = state.context.services.repositoryChecksService;
  const preview = await checks.preview(auth, state.workspaceId, repository.id, 'main');
  expect(preview.issues).toEqual([]);
  await checks.adopt(auth, state.workspaceId, repository.id, {
    ref: 'main',
    expectedCommit: preview.commitSha,
    rationale: 'The Python fixture checks.',
  });
  return { state, repository, worktree, root };
}

itPython(
  "runs a review's adopted Python check first, offline from verified wheels, and merges on its receipt",
  async () => {
    const backend = new CycleBackend([]);
    const { state, worktree } = await pythonRepository(backend);
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'feature'], worktree.path);
    backend.replyForRequest = () => ({ resultText: reviewText([]) });
    const review = await runToFinish(state, worktree.id, { role: 'review' });
    const receipts = state.context.storage.runtimeEvidence
      .checkReceipts(state.workspaceId, review)
      .map((r) => JSON.parse(r.receipt));
    expect(receipts).toEqual([
      expect.objectContaining({
        origin: 'daemon',
        success: true,
        clean: true,
        declaredCheck: expect.objectContaining({ id: 'tests' }),
      }),
    ]);
    // It names the interpreter, uv and the lock.
    expect(receipts[0].python.tools.map((tool: { path: string }) => tool.path)).toEqual([
      OPT_PYTHON,
      OPT_UV,
    ]);
    expect(receipts[0].python.lockDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(receipts[0].python.wheelSetDigest).toMatch(/^[0-9a-f]{64}$/);
    // The brief says to sync first, and that checks run offline.
    const run = state.context.storage.execution.runs.find(state.workspaceId, review)!;
    expect(run.brief).toContain('uv sync');
    expect(run.brief).toContain('offline');
    expect(await mergeGate(state, worktree.id)).toMatchObject({ mergeable: true, reason: 'ready' });
    const merged = await merge(state, worktree.id);
    expect(merged.statusCode, merged.body).toBe(200);
  },
);

itPython(
  'stops a cycle whose work changed the adopted uv.lock as check-definition-changed',
  async () => {
    const backend = new CycleBackend([
      designDone,
      implementationDone,
      { resultText: reviewText([]) },
    ]);
    const { state, repository, worktree } = await pythonRepository(backend);
    await admit(state);
    backend.onLaunch = (request) => {
      if (request.model === 'implement-model') {
        writeFileSync(
          join(request.cwd, 'uv.lock'),
          `# an unadopted change\n${readFileSync(join(request.cwd, 'uv.lock'), 'utf8')}`,
        );
        git(['add', '--all'], request.cwd);
        git(['commit', '--no-gpg-sign', '-m', 'change the lock'], request.cwd);
      }
    };
    const cycle = await startCycle(state, worktree.id);
    await waitFor(() => {
      const current = currentCycle(state, cycle);
      return current.status === 'needs-attention' || current.status === 'awaiting-merge';
    }, 'the review is decided');
    expect(currentCycle(state, cycle)).toMatchObject({
      status: 'needs-attention',
      attention: { code: 'check-definition-changed', refs: { repositoryId: repository.id } },
    });
  },
);

itPython(
  'tells agents to `uv sync` only when the pypi source lets their commands reach PyPI, and says nothing of Python for a tree without a root uv.lock (increment 3 review N2, B1)',
  async () => {
    const backend = new CycleBackend([]);
    const { state, worktree } = await pythonRepository(backend, { pypi: false });
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'feature'], worktree.path);
    backend.replyForRequest = () => ({ resultText: reviewText([]) });
    const review = await runToFinish(state, worktree.id, { role: 'review' });
    const brief = state.context.storage.execution.runs.find(state.workspaceId, review)!.brief;
    expect(brief).toContain('offline');
    expect(brief).not.toContain('uv sync');
    expect(brief).toContain('no PyPI');
    // Without a root uv.lock, the tree is no Python project to the checks, and the brief says so
    // by saying nothing of Python.
    git(['rm', '--quiet', 'uv.lock'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'no lock'], worktree.path);
    const second = await runToFinish(state, worktree.id, { role: 'review' });
    expect(
      state.context.storage.execution.runs.find(state.workspaceId, second)!.brief,
    ).not.toContain('Python:');
  },
);

/** The real-PyPI fixture: markupsafe's compiled wheel and pytest, from PyPI itself. */
const PYPI_FIXTURE = new URL('../../../packages/agents/test/fixtures/python-pypi/', import.meta.url)
  .pathname;

it.skipIf(!optToolchain || process.env.CRAFTINGTABLE_REAL_PYPI !== '1')(
  "runs a review's adopted pytest check on wheels the daemon fetched and verified from the real PyPI; pytest collecting nothing fails it (CRAFTINGTABLE_REAL_PYPI=1)",
  async () => {
    const backend = new CycleBackend([]);
    const root = fixtureRepository();
    cpSync(PYPI_FIXTURE, root, { recursive: true });
    mkdirSync(join(root, '.craftingtable'));
    writeFileSync(
      join(root, '.craftingtable', 'checks.json'),
      `${JSON.stringify({
        version: 1,
        checks: [
          {
            id: 'pytest',
            argv: ['python', '-m', 'pytest', '-q', 'tests'],
            definitionPaths: ['pyproject.toml', 'uv.lock'],
          },
          {
            id: 'nothing',
            argv: ['python', '-m', 'pytest', '-q', 'tests', '-k', 'no_such_test'],
            definitionPaths: ['pyproject.toml', 'uv.lock'],
          },
        ],
      })}\n`,
    );
    git(['add', '--all'], root);
    git(['commit', '--no-gpg-sign', '-m', 'a Python project on PyPI'], root);
    // The daemon's own store, fetching from PyPI.
    const state = await ready({ backend, env: pythonSettings() });
    const { repository, worktree } = await registerAndWorktree(state, root);
    const auth = state.context.services.authService.authenticate(state.cookie.split('=')[1]!);
    const checks = state.context.services.repositoryChecksService;
    const preview = await checks.preview(auth, state.workspaceId, repository.id, 'main');
    expect(preview.issues).toEqual([]);
    await checks.adopt(auth, state.workspaceId, repository.id, {
      ref: 'main',
      expectedCommit: preview.commitSha,
      rationale: 'The real-PyPI fixture.',
    });
    writeFileSync(join(worktree.path, 'feature.txt'), 'feature\n');
    git(['add', '--all'], worktree.path);
    git(['commit', '--no-gpg-sign', '-m', 'feature'], worktree.path);
    backend.replyForRequest = () => ({ resultText: reviewText([]) });
    const review = await runToFinish(state, worktree.id, { role: 'review' });
    const receipts = state.context.storage.runtimeEvidence
      .checkReceipts(state.workspaceId, review)
      .map((r) => JSON.parse(r.receipt));
    const byId = Object.fromEntries(receipts.map((r) => [r.declaredCheck.id, r]));
    expect(byId.pytest).toMatchObject({ success: true, clean: true });
    // pytest exits 5 when it collects no test: the check fails, and the merge is refused.
    expect(byId.nothing).toMatchObject({ success: false, exitCode: 5 });
    expect(await mergeGate(state, worktree.id)).toMatchObject({ mergeable: false });
  },
  300_000,
);
