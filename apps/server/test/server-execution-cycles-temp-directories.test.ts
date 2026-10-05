import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AgentLaunchError } from '@craftingtable/agents';
import { afterEach, expect, it } from 'vitest';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

import {
  cleanupExecutionFixtures,
  currentCycle,
  cycleFixture,
  designDone,
  present,
  startCycle,
  waitFor,
} from './execution-test-support.js';
import { AGENTS_ROOT_LOCK_FILE, acquireDaemonLocks } from '../src/instance-lock.js';
import { createTestContext, testDataRoot } from './test-support.js';

afterEach(cleanupExecutionFixtures);

it("gives each run's agent a short private temporary directory and removes it when the run ends (LIVE-31)", async () => {
  const { state, backend, worktree } = await cycleFixture([designDone]);
  const root = state.context.config.execution.agentTemporaryRoot;
  // Observed at launch and asserted after: an assertion failing inside the launch only fails it.
  const seen: { own?: string; mode?: number; tmpdir?: string; scratch?: string }[] = [];
  backend.onLaunch = (request) => {
    const own = request.processTemporaryDirectory;
    seen.push({
      ...(own === undefined ? {} : { own, mode: statSync(own).mode & 0o777 }),
      ...(request.environment?.TMPDIR ? { tmpdir: request.environment.TMPDIR } : {}),
      ...(request.temporaryDirectory ? { scratch: request.temporaryDirectory } : {}),
    });
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => seen.length === 1, 'launched');
  const [launched] = seen;
  const own = present(launched?.own);
  // Its own, beneath the daemon's root, private, outside the worktree and the run's directory.
  expect(dirname(own)).toBe(root);
  expect(basename(own)).toMatch(/^[0-9a-f]{12}$/);
  expect(launched?.mode).toBe(0o700);
  expect(own.startsWith(worktree.path)).toBe(false);
  expect(own.startsWith(state.context.config.execution.runsRoot)).toBe(false);
  // The run's scratch stays the commands' and builds' place.
  expect(launched?.tmpdir).toBe(launched?.scratch);
  await waitFor(() => !existsSync(own), 'directory removed at run end');
  const run = present(
    state.context.storage.execution.runs.find(
      state.workspaceId,
      currentCycle(state, cycle).currentRunId,
    ),
  );
  expect(run.status).toBe('finished');
});

it("removes agents' temporary directories a stopped daemon left behind (LIVE-31)", async () => {
  const { state } = await cycleFixture([]);
  const root = state.context.config.execution.agentTemporaryRoot;
  const left = join(root, '0123456789ab');
  mkdirSync(join(left, 'claude-1000'), { recursive: true });
  writeFileSync(join(left, 'claude-1000', 'partial'), 'x');
  state.context.services.agentRunService.recoverInterrupted();
  await waitFor(() => !existsSync(left), 'leftover removed in the background');
  expect(existsSync(root)).toBe(true);
});

it("sweeps only run directories from the agents' temporary root at a start, and names what it left (TS-H3, R-G5)", async () => {
  // A root as a stopped daemon left it, before the next daemon starts on it.
  const root = mkdtempSync(join(testDataRoot(), 'craftingtable-agent-root-'));
  // A run's own directory.
  const run = join(root, '0123456789ab');
  mkdirSync(join(run, 'claude-1000'), { recursive: true });
  // What a misconfigured root holds besides (the database's directory, a home, /tmp): each
  // must outlive the start, contents included.
  const target = join(root, 'target');
  mkdirSync(target);
  writeFileSync(join(target, 'kept'), 'x');
  const kept = {
    file: join(root, 'craftingtable.sqlite'),
    directory: join(root, 'pre-migration'),
    hexFile: join(root, 'abcdef012345'),
    link: join(root, 'fedcba987654'),
    upper: join(root, '0123456789AB'),
    long: join(root, '0123456789abc'),
    short: join(root, '0123456789a'),
  };
  writeFileSync(kept.file, 'the database');
  mkdirSync(kept.directory);
  writeFileSync(join(kept.directory, 'backup'), 'x');
  writeFileSync(kept.hexFile, 'a file named like a run');
  // A link named like a run, to a directory that is not one: neither it nor its target goes.
  symlinkSync(target, kept.link);
  for (const name of [kept.upper, kept.long, kept.short]) {
    mkdirSync(name);
    writeFileSync(join(name, 'kept'), 'x');
  }
  // More than the warning names: it counts them all and names the first 20.
  const others = Array.from({ length: 15 }, (_, index) => join(root, `other-${index}`));
  for (const other of others) writeFileSync(other, 'x');
  const warnings: { message: string; detail?: Readonly<Record<string, unknown>> }[] = [];
  const context = await createTestContext({
    env: { CRAFTINGTABLE_AGENT_TMP_ROOT: root },
    runLog: {
      warn: (message, detail) => warnings.push({ message, ...(detail ? { detail } : {}) }),
    },
  });
  try {
    // The start swept the root; its removals run in the background.
    await context.services.agentRunService.quiesce();
    expect(existsSync(run)).toBe(false);
    for (const path of Object.values(kept))
      expect(lstatSync(path, { throwIfNoEntry: false }), path).toBeDefined();
    expect(readFileSync(kept.file, 'utf8')).toBe('the database');
    expect(existsSync(join(kept.directory, 'backup'))).toBe(true);
    expect(lstatSync(kept.link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(target, 'kept'))).toBe(true);
    for (const name of [kept.upper, kept.long, kept.short])
      expect(existsSync(join(name, 'kept'))).toBe(true);
    for (const other of others) expect(existsSync(other), other).toBe(true);
    // One warning for everything left, naming it.
    expect(warnings).toEqual([
      {
        message: expect.stringContaining('not run directories'),
        detail: {
          root,
          count: 23,
          entries: ['target', ...Object.values(kept), ...others]
            .map((path) => basename(path))
            .sort()
            .slice(0, 20),
        },
      },
    ]);
  } finally {
    await context.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps the root's own lock socket without naming it in the start's warning (R-G5)", async () => {
  // Where there is no abstract socket namespace, the root's lock is a socket file in the root.
  // A short base: a socket's path holds 107 bytes, more than the run's data root leaves.
  const root = mkdtempSync('/tmp/cta-');
  const lockData = mkdtempSync('/tmp/ctl-');
  const lock = await acquireDaemonLocks(
    { dataDir: lockData, execution: { agentTemporaryRoot: root } },
    'darwin',
  );
  const socket = join(root, AGENTS_ROOT_LOCK_FILE);
  expect(lstatSync(socket).isSocket()).toBe(true);
  const warnings: { message: string; detail?: Readonly<Record<string, unknown>> }[] = [];
  const start = (env: Record<string, string>) =>
    createTestContext({
      env,
      runLog: {
        warn: (message, detail) => warnings.push({ message, ...(detail ? { detail } : {}) }),
      },
    });
  const context = await start({ CRAFTINGTABLE_AGENT_TMP_ROOT: root });
  try {
    await context.services.agentRunService.quiesce();
    expect(lstatSync(socket).isSocket()).toBe(true);
    expect(warnings).toEqual([]);
  } finally {
    await context.cleanup();
    await lock.release();
  }
  // A file of the same name is not the lock: it is named like anything else.
  writeFileSync(socket, 'not a socket');
  const other = await start({ CRAFTINGTABLE_AGENT_TMP_ROOT: root });
  try {
    await other.services.agentRunService.quiesce();
    expect(warnings).toEqual([
      expect.objectContaining({
        detail: expect.objectContaining({ entries: [AGENTS_ROOT_LOCK_FILE] }),
      }),
    ]);
  } finally {
    await other.cleanup();
    rmSync(root, { recursive: true, force: true });
    rmSync(lockData, { recursive: true, force: true });
  }
});

it('ends a run normally when its agent left a read-only directory behind, and removes it (LIVE-31 review)', async () => {
  const { state, backend, worktree } = await cycleFixture([designDone]);
  let own: string | undefined;
  backend.onLaunch = (request) => {
    own = request.processTemporaryDirectory;
    // What any sandboxed command may do: a directory it cannot itself be removed from.
    const locked = join(present(own), 'claude-1000', 'locked');
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, 'file'), 'x');
    chmodSync(locked, 0o500);
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => own !== undefined && !existsSync(own), 'directory removed');
  const run = present(
    state.context.storage.execution.runs.find(
      state.workspaceId,
      currentCycle(state, cycle).currentRunId,
    ),
  );
  expect(run.status).toBe('finished');
});

it('starts after a stop that left an unremovable directory, and removes it (LIVE-31 review)', async () => {
  const { state } = await cycleFixture([]);
  const locked = join(state.context.config.execution.agentTemporaryRoot, '0123456789ab', 'locked');
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, 'file'), 'x');
  chmodSync(locked, 0o500);
  expect(() => state.context.services.agentRunService.recoverInterrupted()).not.toThrow();
  await waitFor(() => !existsSync(dirname(locked)), 'leftover removed in the background');
});

it("removes a run's earlier directory when the run launches again, and when its record fails to end (LIVE-31 verification)", async () => {
  const { state } = await cycleFixture([]);
  // The service's own bookkeeping, as a launch that failed before its record leaves it.
  const service = state.context.services.agentRunService as unknown as {
    processTemporaryDirectory(runId: string): string;
    finalize(workspaceId: string, runId: string, status: 'failed', detail: object): void;
  };
  const first = service.processTemporaryDirectory('run-a');
  const second = service.processTemporaryDirectory('run-a');
  expect(second).not.toBe(first);
  await waitFor(() => !existsSync(first), 'the earlier directory removed');
  expect(existsSync(second)).toBe(true);
  // A run whose record cannot be written still loses its directory.
  const storage = state.context.storage as unknown as { transaction: (work: unknown) => unknown };
  const transaction = storage.transaction;
  storage.transaction = () => {
    throw new Error('storage unavailable');
  };
  try {
    expect(() => service.finalize(state.workspaceId, 'run-a', 'failed', {})).toThrow(
      'storage unavailable',
    );
  } finally {
    storage.transaction = transaction;
  }
  await waitFor(() => !existsSync(second), 'removed although the record failed');
});

it('leaves no run starting when its temporary directory cannot be made (LIVE-31 review)', async () => {
  const { state, backend, worktree } = await cycleFixture([designDone]);
  // A file where the root should be: every directory beneath it fails.
  writeFileSync(state.context.config.execution.agentTemporaryRoot, 'in the way');
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status !== 'running', 'the start failed');
  expect(backend.launches).toHaveLength(0);
  expect(state.context.storage.execution.runs.listLive()).toEqual([]);
});

it("stops a cycle as agent-environment-unavailable when the agent's tools cannot start (LIVE-31)", async () => {
  const { state, backend, worktree } = await cycleFixture([designDone]);
  let own: string | undefined;
  backend.failLaunch = (request) => {
    own = request.processTemporaryDirectory;
    return new AgentLaunchError(
      'environment-unavailable',
      "Claude Code's command sandbox cannot start on this host: socat is not on the agent's PATH.",
    );
  };
  const cycle = await startCycle(state, worktree.id);
  await waitFor(() => currentCycle(state, cycle).status === 'needs-attention', 'typed stop');
  const stopped = currentCycle(state, cycle);
  expect(stopped.attention?.code).toBe('agent-environment-unavailable');
  expect(stopped.reason).toContain("socat is not on the agent's PATH");
  expect(existsSync(present(own))).toBe(false);
  // Not the agent's report: nothing ran, so no questions are asked of the operator.
  expect(
    state.context.storage.attention.open(state.workspaceId).map((item) => item.code),
  ).toContain('agent-environment-unavailable');
});
