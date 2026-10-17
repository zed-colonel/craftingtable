import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentLaunchRequest, executeCheck } from '@craftingtable/agents';
import { asDeclaredCheckId } from '@craftingtable/domain';
import { afterEach, expect, it, vi } from 'vitest';
import {
  admit,
  CycleBackend,
  cleanupExecutionFixtures,
  commitFile,
  configureLocalRuntime,
  currentCycle,
  declareFixtureChecks,
  designDone,
  fixtureRepository,
  itNeedsCargo,
  openQuestions,
  ready,
  registerAndWorktree,
  reviewText,
  runLauncher,
  runToFinish,
  scopeTree,
  slicedFixture,
  startCycle,
  waitFor,
} from './execution-test-support.js';

/**
 * R-C17 part 1: a declared check's own time limit ends at its step's deadline at the latest. The
 * daemon gives each check it runs the deadline of the cycle step that owns the run, and none for
 * a run no cycle owns; a run's launchers wait past the longest limit any of its checks has.
 */

const executions = vi.hoisted(() => [] as Parameters<typeof executeCheck>[0][]);
vi.mock('@craftingtable/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@craftingtable/agents')>();
  return {
    ...actual,
    executeCheck: (execution: Parameters<typeof executeCheck>[0]) => {
      executions.push(execution);
      return actual.executeCheck(execution);
    },
  };
});

afterEach(async () => {
  executions.splice(0);
  await cleanupExecutionFixtures();
});

const LIMITED = [
  {
    id: asDeclaredCheckId('fixture'),
    argv: ['git', 'diff', '--check', 'HEAD'],
    definitionPaths: [],
    timeoutMinutes: 45,
  },
];

/** What the run's `ct-check` launcher waits for the daemon's answer, in milliseconds. */
const launcherLimit = (request: AgentLaunchRequest) =>
  Number(
    /process\.argv\.slice\(2\),(\d+)\)/.exec(
      readFileSync(join(request.buildEnvironment!.binDirectory, 'ct-check'), 'utf8'),
    )?.[1],
  );

it("a cycle step's checks end at its deadline; its launchers wait past the longest limit (R-C17 part 1)", async () => {
  const backend = new CycleBackend([]);
  const state = await ready({ backend });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  declareFixtureChecks(state, LIMITED);
  commitFile(worktree.path, 'feature.txt', 'feature\n');
  await admit(state);
  let deadline: string | undefined;
  let launched: AgentLaunchRequest | undefined;
  backend.replyForRequest = async (request) => {
    launched ??= request;
    deadline ??= currentCycle(state, cycle).runDeadlineAt;
    await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
    return designDone;
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => executions.length > 0 && deadline !== undefined, 'the design step’s check');
  expect(executions[0]!.args).toEqual(['--declared', 'fixture']);
  expect(executions[0]!.stepDeadline).toBe(Date.parse(deadline!));
  // The check may run 45 minutes, past today's 30-minute cap: its launcher waits for it.
  expect(launcherLimit(launched!)).toBe(50 * 60_000);
});

it('a run no cycle owns gives its checks no step deadline (R-C17 part 1)', async () => {
  const backend = new CycleBackend([]);
  const state = await ready({ backend });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  declareFixtureChecks(state, LIMITED);
  commitFile(worktree.path, 'feature.txt', 'feature\n');
  backend.replyForRequest = async (request) => {
    await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
    return { resultText: reviewText([]) };
  };
  await runToFinish(state, worktree.id, { role: 'review' });
  expect(executions.length).toBeGreaterThan(0);
  for (const execution of executions) expect(execution.stepDeadline).toBeUndefined();
});

it("a manual run beside a stopped cycle in its worktree is not that cycle's step: no step deadline (R-C17 part 1)", async () => {
  const backend = new CycleBackend([openQuestions]);
  const state = await ready({ backend });
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  declareFixtureChecks(state, LIMITED);
  commitFile(worktree.path, 'feature.txt', 'feature\n');
  await admit(state);
  const cycle = await startCycle(state, worktree.id);
  await waitFor(
    () => currentCycle(state, cycle).status === 'needs-attention',
    'the design stops on its open questions',
  );
  backend.replyForRequest = async (request) => {
    await runLauncher(request, 'ct-check', ['--declared', 'fixture']);
    return { resultText: reviewText([]) };
  };
  const manual = await runToFinish(state, worktree.id, { role: 'review' });
  expect(currentCycle(state, cycle).currentRunId).not.toBe(manual);
  expect(executions.length).toBeGreaterThan(0);
  for (const execution of executions) expect(execution.stepDeadline).toBeUndefined();
});

itNeedsCargo(
  "a pinned run's launchers wait past its longest declared limit too (R-C17 part 1)",
  async () => {
    const f = await slicedFixture();
    declareFixtureChecks(f.state, LIMITED);
    await configureLocalRuntime(f.auth, f.state, f.parentScope.definitionId);
    const tree = await scopeTree(f, f.scopes[0]!);
    commitFile(tree.path, 'a.txt', 'A');
    let launched: AgentLaunchRequest | undefined;
    f.backend.replyForRequest = async (request) => {
      launched = request;
      return { resultText: reviewText([]) };
    };
    await runToFinish(f.state, tree.id, { role: 'review' });
    const manifest = JSON.parse(
      readFileSync(join(launched!.buildEnvironment!.binDirectory, '..', 'manifest.json'), 'utf8'),
    );
    // A pinned manifest (it names a runtime), not a check-only one.
    expect(manifest.kind).toBeUndefined();
    expect(manifest.runtimeId).toBeDefined();
    expect(launcherLimit(launched!)).toBe(50 * 60_000);
  },
);
