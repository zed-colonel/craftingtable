import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { startAgentRunResponseSchema } from '@craftingtable/contracts';
import {
  type AgentRunId,
  InvariantError,
  type WorkspaceId,
  type WorktreeId,
} from '@craftingtable/domain';
import { openDatabase, type RunLaunchReservation } from '@craftingtable/storage';
import { afterEach, expect, it, vi } from 'vitest';
import {
  cleanupExecutionFixtures,
  fixtureRepository,
  mutationHeaders,
  ready,
  registerAndWorktree,
  waitFor,
} from './execution-test-support.js';
import { removeReservation } from '../src/services/run/reservation.js';
import { testDataRoot } from './test-support.js';

/**
 * R-B7 decision 1 (AGT-12): a launch's reservation, its durable record before its first file.
 * The characterization (`launch-characterization.test.ts`) pins that a refused launch leaves
 * nothing and that a relaunch of the same run starts in an empty directory; these rows pin the
 * reservation's own rules: its invariant, the leftover it clears, the registration failure that
 * keeps it, and what a start does with reservations and with the run directories no run owns.
 */

/** The fixture trees, made writable again after each row: one a failing row left in place would
 * otherwise keep the test data root's cleanup from removing it. */
const trees: string[] = [];
function writable(path: string) {
  if (!existsSync(path) || !statSync(path).isDirectory()) return;
  chmodSync(path, 0o700);
  for (const entry of readdirSync(path)) writable(join(path, entry));
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const tree of trees.splice(0)) writable(tree);
  await cleanupExecutionFixtures();
});

type Launcher = {
  reserve(
    workspaceId: WorkspaceId,
    worktreeId: WorktreeId,
    runId: AgentRunId,
  ): Promise<RunLaunchReservation>;
};

async function fixture() {
  const state = await ready();
  const { worktree } = await registerAndWorktree(state, fixtureRepository());
  const { runsRoot, checkLogRoot } = state.context.config.execution;
  const launcher = (state.context.services.agentRunService as unknown as { launcher: Launcher })
    .launcher;
  const reservations = () => state.context.storage.maintenance.launchReservations();
  return { state, worktree, runsRoot, checkLogRoot, launcher, reservations };
}

/** A directory tree as a refused launch leaves one: read-only manifests and launchers in it. */
function launchTree(path: string) {
  trees.push(path);
  mkdirSync(join(path, 'checks', 'bin'), { recursive: true, mode: 0o700 });
  writeFileSync(join(path, 'checks', 'manifest.json'), '{}', { mode: 0o400 });
  writeFileSync(join(path, 'checks', 'bin', 'ct-check'), '#!/bin/sh\n', { mode: 0o500 });
  chmodSync(join(path, 'checks', 'bin'), 0o500);
}

const reservation = (
  state: Awaited<ReturnType<typeof fixture>>['state'],
  worktreeId: WorktreeId,
  runsRoot: string,
  checkLogRoot: string,
  runId = randomUUID() as AgentRunId,
): RunLaunchReservation => ({
  runId,
  workspaceId: state.workspaceId,
  worktreeId,
  runDirectory: join(runsRoot, runId),
  runDevice: 0,
  replyDirectory: join(checkLogRoot, runId, 'replies'),
  replyDevice: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
});

it('reserves a run with no row, clearing what a refused launch left first, and retries a held reservation', async () => {
  const { state, worktree, runsRoot, checkLogRoot, launcher, reservations } = await fixture();
  // A refused launch's leftovers from before this release: its run directory and its replies.
  const runId = randomUUID() as AgentRunId;
  launchTree(join(runsRoot, runId));
  mkdirSync(join(checkLogRoot, runId, 'replies'), { recursive: true });
  writeFileSync(join(checkLogRoot, runId, 'replies', 'reply.json'), '{}');
  const reserved = await launcher.reserve(state.workspaceId, worktree.id, runId);
  expect(existsSync(join(runsRoot, runId))).toBe(false);
  expect(existsSync(join(checkLogRoot, runId, 'replies'))).toBe(false);
  expect(reservations()).toEqual([reserved]);
  expect(reserved).toMatchObject({
    runId,
    workspaceId: state.workspaceId,
    worktreeId: worktree.id,
    runDirectory: join(runsRoot, runId),
    replyDirectory: join(checkLogRoot, runId, 'replies'),
  });
  // A reservation still held (a refused launch's whose directories could not be removed then) is
  // tried again (increment 11b review, LOW-3): here nothing is left, so the run is reserved anew.
  await expect(launcher.reserve(state.workspaceId, worktree.id, runId)).resolves.toMatchObject({
    runId,
  });
  expect(reservations().map((r) => r.runId)).toEqual([runId]);
  // One that still cannot be cleared refuses the launch, and stays for the next start.
  writeFileSync(join(runsRoot, runId), 'not a directory');
  await expect(launcher.reserve(state.workspaceId, worktree.id, runId)).rejects.toThrow(
    'could not be removed',
  );
  expect(reservations().map((r) => r.runId)).toEqual([runId]);
  // A run id that is not one path component is refused before anything is touched (LOW-2).
  writeFileSync(join(runsRoot, 'keep'), 'keep');
  for (const bad of ['..', '', 'a/b'])
    await expect(
      launcher.reserve(state.workspaceId, worktree.id, bad as AgentRunId),
    ).rejects.toThrow(InvariantError);
  expect(existsSync(join(runsRoot, 'keep'))).toBe(true);
  // A run row of the id is a broken invariant.
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id },
  });
  const { run } = startAgentRunResponseSchema.parse(started.json());
  await expect(launcher.reserve(state.workspaceId, worktree.id, run.id)).rejects.toThrow(
    InvariantError,
  );
  // The launch's own reservation went once its directory was registered.
  expect(reservations().map((r) => r.runId)).toEqual([runId]);
});

it('keeps the reservation of a run whose directory could not be registered, and the next start drops it', async () => {
  const { state, worktree, runsRoot, reservations } = await fixture();
  vi.spyOn(state.context.services.storageService, 'registerRun').mockImplementationOnce(() => {
    throw new Error('simulated registration failure');
  });
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id },
  });
  expect(started.statusCode).toBe(500);
  const [kept] = reservations();
  const run = state.context.storage.execution.runs.find(state.workspaceId, kept!.runId);
  expect(run?.status).toBe('failed');
  expect(existsSync(join(runsRoot, kept!.runId))).toBe(true);
  // The run row owns the directory: a start drops the reservation and keeps the directory.
  await state.context.services.agentRunService.recoverInterrupted();
  expect(reservations()).toEqual([]);
  expect(existsSync(join(runsRoot, kept!.runId))).toBe(true);
});

it('a start removes a reservation with no run row with what it made, and keeps one it cannot clear', async () => {
  const { state, worktree, runsRoot, checkLogRoot, reservations } = await fixture();
  const cut = reservation(state, worktree.id, runsRoot, checkLogRoot);
  launchTree(cut.runDirectory);
  mkdirSync(cut.replyDirectory, { recursive: true });
  const stuck = reservation(state, worktree.id, runsRoot, checkLogRoot);
  // Its run directory is a file, not a directory: never removed as one.
  writeFileSync(stuck.runDirectory, 'not a directory');
  const reserved = [
    { ...cut, runDevice: statSync(runsRoot).dev, replyDevice: statSync(checkLogRoot).dev },
    { ...stuck, runDevice: statSync(runsRoot).dev, replyDevice: statSync(checkLogRoot).dev },
  ];
  state.context.storage.transaction((tx) => {
    for (const r of reserved) tx.maintenance.reserveLaunch(r);
  });
  await state.context.services.agentRunService.recoverInterrupted();
  expect(existsSync(cut.runDirectory)).toBe(false);
  expect(existsSync(cut.replyDirectory)).toBe(false);
  // The run's check-log directory goes too, once the replies leave it empty.
  expect(existsSync(join(checkLogRoot, cut.runId))).toBe(false);
  expect(reservations().map((r) => r.runId)).toEqual([stuck.runId]);
  expect(existsSync(stuck.runDirectory)).toBe(true);
  // A directory on another device than the one reserved, or a reservation naming another run's
  // directories, is never removed, and its reservation stays (increment 11b review, LOW-2, LOW-4).
  const moved = reservation(state, worktree.id, runsRoot, checkLogRoot);
  launchTree(moved.runDirectory);
  const other = reservation(state, worktree.id, runsRoot, checkLogRoot);
  launchTree(other.runDirectory);
  state.context.storage.transaction((tx) =>
    tx.maintenance.reserveLaunch({
      ...moved,
      runDevice: statSync(runsRoot).dev + 1,
      replyDevice: statSync(checkLogRoot).dev,
    }),
  );
  await state.context.services.agentRunService.recoverInterrupted();
  expect(existsSync(moved.runDirectory)).toBe(true);
  expect(
    reservations()
      .map((r) => r.runId)
      .sort(),
  ).toEqual([stuck.runId, moved.runId].sort());
  // The table's checks refuse a reservation naming another run's directories, and so does the
  // removal itself.
  const naming = {
    ...reservation(state, worktree.id, runsRoot, checkLogRoot),
    runDirectory: other.runDirectory,
    runDevice: statSync(runsRoot).dev,
    replyDevice: statSync(checkLogRoot).dev,
  };
  expect(() =>
    state.context.storage.transaction((tx) => tx.maintenance.reserveLaunch(naming)),
  ).toThrow();
  expect(await removeReservation(state.context.storage, { warn: () => undefined }, naming)).toBe(
    false,
  );
  expect(existsSync(other.runDirectory)).toBe(true);
});

it('keeps what a launch made once its record committed, even when the transaction then throws', async () => {
  const { state, worktree, runsRoot, reservations } = await fixture();
  // The record's transaction returns the run row; it throws after its commit (LOW-1).
  const storage = state.context.storage;
  const transaction = storage.transaction.bind(storage);
  vi.spyOn(storage, 'transaction').mockImplementation(((work: never) => {
    const result = transaction(work) as unknown;
    if (result && typeof result === 'object' && 'brief' in result && 'role' in result)
      throw new Error('simulated failure after the commit');
    return result;
  }) as never);
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id },
  });
  expect(started.statusCode).toBe(500);
  vi.restoreAllMocks();
  const [kept] = reservations();
  expect(storage.execution.runs.find(state.workspaceId, kept!.runId)).toBeDefined();
  expect(existsSync(join(runsRoot, kept!.runId))).toBe(true);
});

it('owns a run directory by its run row, its directory row or its reservation', async () => {
  const { state, worktree, runsRoot, checkLogRoot } = await fixture();
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id },
  });
  const { run } = startAgentRunResponseSchema.parse(started.json());
  const maintenance = state.context.storage.maintenance;
  const registered = maintenance.directory(run.id)!.path;
  const reserved = reservation(state, worktree.id, runsRoot, checkLogRoot);
  state.context.storage.transaction((tx) => tx.maintenance.reserveLaunch(reserved));
  expect(maintenance.ownsRunDirectory(run.id, '/nowhere')).toBe(true);
  expect(maintenance.ownsRunDirectory('nobody', registered)).toBe(true);
  expect(maintenance.ownsRunDirectory(reserved.runId, '/nowhere')).toBe(true);
  expect(maintenance.ownsRunDirectory('nobody', reserved.runDirectory)).toBe(true);
  expect(maintenance.ownsRunDirectory('nobody', '/nowhere')).toBe(false);
});

it('the first start after migration 0046 removes the run directories no run owns, once', async () => {
  const { state, worktree, runsRoot } = await fixture();
  const started = await state.context.app.inject({
    method: 'POST',
    url: `/api/workspaces/${state.workspaceId}/work-items/${state.workItemId}/runs`,
    headers: mutationHeaders(state),
    payload: { worktreeId: worktree.id },
  });
  const { run } = startAgentRunResponseSchema.parse(started.json());
  await waitFor(
    () =>
      state.context.storage.execution.runs.find(state.workspaceId, run.id)?.status !== 'starting',
    'the run started',
  );
  const orphan = randomUUID();
  launchTree(join(runsRoot, orphan));
  const notARun = join(runsRoot, 'operator-notes');
  mkdirSync(notARun);
  // A link named as a run is never followed: what it points to stays.
  const outside = mkdtempSync(join(testDataRoot(), 'craftingtable-outside-'));
  writeFileSync(join(outside, 'keep'), 'keep');
  const linked = randomUUID();
  symlinkSync(outside, join(runsRoot, linked));
  // The fixture's own start consumed the task; this is the first start after the migration.
  const database = openDatabase(state.context.storage.databasePath);
  try {
    database
      .prepare("INSERT INTO startup_tasks (task) VALUES ('remove-orphan-run-directories')")
      .run();
  } finally {
    database.close();
  }
  const service = state.context.services.agentRunService;
  await service.recoverInterrupted();
  expect(existsSync(join(runsRoot, orphan))).toBe(false);
  expect(existsSync(join(runsRoot, run.id))).toBe(true);
  expect(existsSync(notARun)).toBe(true);
  expect(existsSync(join(outside, 'keep'))).toBe(true);
  expect(lstatSync(join(runsRoot, linked)).isSymbolicLink()).toBe(true);
  expect(
    state.context.storage.maintenance.startupTaskPending('remove-orphan-run-directories'),
  ).toBe(false);
  // Once: a later orphan stays.
  const later = randomUUID();
  mkdirSync(join(runsRoot, later));
  await service.recoverInterrupted();
  expect(existsSync(join(runsRoot, later))).toBe(true);
});
