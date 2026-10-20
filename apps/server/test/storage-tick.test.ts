import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  type Stats,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type AgentRunId,
  asAgentRunEventId,
  asAgentRunId,
  asPlanBundleId,
  asPlanVersionId,
  asProjectId,
  asSourceRepositoryId,
  asWorkItemId,
  asWorktreeId,
  type WorkspaceId,
  type WorktreeId,
} from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, expect, it, vi } from 'vitest';
import { directoryBytes, WalkPacer } from '../src/services/storage-files.js';
import {
  STORAGE_TICK_PACING,
  StorageService,
  type StorageTickPacing,
} from '../src/services/storage-service.js';
import { createTestContext, type TestContext } from './test-support.js';

/**
 * R-H8: what the storage service's minute's maintenance (`tick`) finds in each kind of run
 * directory, and what it removes or refuses, pinned before its walk changes. Every expectation
 * here is the tick's decision as the code stood at d77cb20; a change to how the tick reads the
 * directories keeps every one of them.
 */

/** Paths whose entries report another device: a volume mounted inside a run's scratch. */
const otherVolume = vi.hoisted(() => ({ prefixes: [] as string[] }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const lstat = (async (path: string, ...rest: unknown[]) => {
    const entry = (await (actual.lstat as (...args: unknown[]) => Promise<Stats>)(
      path,
      ...rest,
    )) as Stats;
    if (otherVolume.prefixes.some((prefix) => String(path).startsWith(prefix)))
      entry.dev = entry.dev + 1;
    return entry;
  }) as typeof actual.lstat;
  return { ...actual, lstat, default: { ...actual, lstat } };
});

const DAY = 86_400_000;
const contexts: TestContext[] = [];
afterEach(async () => {
  otherVolume.prefixes = [];
  for (const context of contexts.splice(0)) await context.cleanup();
});

function makeCargo(path: string, profile: 'debug' | 'release' = 'debug') {
  mkdirSync(join(path, profile, '.fingerprint'), { recursive: true });
  writeFileSync(
    join(path, 'CACHEDIR.TAG'),
    'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n',
  );
  writeFileSync(join(path, '.rustc_info.json'), '{}');
  writeFileSync(join(path, profile, 'binary'), Buffer.alloc(4096));
  return path;
}

/** Sets a file's or directory's modification (and access) time. */
function age(path: string, at: number) {
  const time = new Date(at);
  utimesSync(path, time, time);
}

type Status = 'finished' | 'failed' | 'interrupted';
type Tree = 'active' | 'merged' | 'removed-unmerged';

/**
 * A daemon's storage, its own clock, and run directories of every kind the tick meets. The
 * tick's walking budget is unbounded and its walks unpaused unless a test sets them (R-H8
 * decision 5), so what one tick reads never depends on the machine's speed.
 */
async function tickFixture(pacing: Partial<StorageTickPacing> = {}) {
  let instant = Date.now();
  const context = await createTestContext();
  contexts.push(context);
  await context.bootstrap();
  const login = await context.login();
  await context.services.storageService.shutdown();
  await context.services.notificationService.shutdown();
  const auth = context.services.authService.authenticate(
    login.cookie.split('=').slice(1).join('='),
  );
  const workspaceId = context.storage.workspaces.listAuthorized(auth.user.id)[0]?.workspace
    .id as WorkspaceId;
  const service = new StorageService(
    context.storage,
    context.config,
    context.services.workspaceService,
    () => new Date(instant),
    undefined,
    { ...STORAGE_TICK_PACING, walkBudgetMs: Infinity, walkSliceMs: Infinity, ...pacing },
  );
  const projectId = asProjectId('project'),
    bundleId = asPlanBundleId('bundle'),
    planVersionId = asPlanVersionId('plan'),
    workItemId = asWorkItemId('item'),
    repositoryId = asSourceRepositoryId('repo');
  const created = new Date(instant).toISOString();
  context.storage.transaction((tx) => {
    tx.planning.projects.insert({
      id: projectId,
      workspaceId,
      name: 'Fixture',
      slug: 'fixture',
      createdAt: created,
      createdByUserId: auth.user.id,
    });
    tx.planning.bundles.insert({
      id: bundleId,
      workspaceId,
      projectId,
      logicalName: 'fixture',
      createdAt: created,
    });
    tx.planning.versions.insert({
      id: planVersionId,
      workspaceId,
      projectId,
      bundleId,
      versionNumber: 1,
      contentDigest: 'a'.repeat(64),
      digestAlgorithm: 'sha-256',
      digestFormatVersion: 1,
      sourceProfile: 'exo-work-breakdown-v1',
      document: 'plan.md',
      normalizedSource: {},
      itemCount: 1,
      requiredDependencyCount: 0,
      createdAt: created,
      createdByUserId: auth.user.id,
    });
    tx.planning.workItems.insertMany([
      {
        id: workItemId,
        workspaceId,
        projectId,
        planVersionId,
        sourceId: 'ITEM-1',
        ordinal: 0,
        title: 'Fixture',
        risk: 'low',
        primaryAreas: [],
        exitGate: 'Verified',
        sourceFields: {},
      },
    ]);
    tx.execution.sourceRepositories.insert({
      id: repositoryId,
      workspaceId,
      displayName: 'Fixture',
      rootPath: join(context.directory, 'source'),
      defaultBranch: 'main',
      registeredHeadSha: 'a'.repeat(40),
      registeredAt: created,
      registeredByUserId: auth.user.id,
    });
  });
  const runsRoot = service.executionConfig.runsRoot;
  const outside = join(context.directory, 'outside');
  mkdirSync(outside);

  /**
   * A run in its worktree. `retained` is how many days ago its retention began (the later of
   * its end and its worktree's removal, as `retainedSince` reads them); `exited` whether its
   * process was seen to exit (a `run-finished` event with an exit code).
   */
  const addRun = (input: {
    readonly status: Status;
    readonly tree: Tree;
    readonly exited: boolean;
    readonly retained: number;
    readonly worktreeId?: WorktreeId;
  }) => {
    const worktreeId = input.worktreeId ?? asWorktreeId(randomUUID());
    const runId = asAgentRunId(randomUUID());
    const now = new Date(instant).toISOString();
    context.storage.transaction((tx) => {
      if (!input.worktreeId) {
        const treePath = join(context.config.execution.worktreeRoot, worktreeId);
        mkdirSync(treePath);
        tx.execution.worktrees.insert({
          id: worktreeId,
          workspaceId,
          repositoryId,
          projectId,
          workItemId,
          branchName: `ct/${worktreeId}`,
          baseSha: 'a'.repeat(40),
          baseBranch: 'main',
          path: treePath,
          createdAt: now,
          createdByUserId: auth.user.id,
        });
      }
      tx.execution.runs.insert({
        id: runId,
        workspaceId,
        repositoryId,
        projectId,
        workItemId,
        worktreeId,
        backend: 'codex',
        role: 'review',
        permissionMode: 'auto',
        brief: 'Fixture run',
        createdAt: now,
        createdByUserId: auth.user.id,
      });
      if (input.exited)
        tx.execution.runEvents.append({
          id: asAgentRunEventId(randomUUID()),
          workspaceId,
          runId,
          occurredAt: now,
          kind: 'run-finished',
          payload: { status: input.status, exitCode: 0 },
        });
    });
    const since = new Date(instant - input.retained * DAY).toISOString();
    const db = openDatabase(context.config.databasePath);
    db.prepare(
      'UPDATE agent_runs SET status = ?, finished_at = ?, created_at = ? WHERE id = ?',
    ).run(input.status, since, since, runId);
    if (!input.worktreeId) {
      db.prepare('UPDATE worktrees SET created_at = ? WHERE id = ?').run(since, worktreeId);
      if (input.tree !== 'active')
        db.prepare(
          "UPDATE worktrees SET status = 'removed', removed_at = ?, merged_at = ?, merge_sha = ? WHERE id = ?",
        ).run(
          since,
          input.tree === 'merged' ? since : null,
          input.tree === 'merged' ? 'b'.repeat(40) : null,
          worktreeId,
        );
    }
    db.close();
    const path = join(runsRoot, runId);
    mkdirSync(path);
    writeFileSync(join(path, 'brief.md'), 'Retained brief');
    service.registerRun(runId, path);
    return { runId, worktreeId, path, scratch: join(path, 'scratch') };
  };
  /** A scratch file last changed `days` ago, with the scratch itself as old. */
  const scratchFile = (run: { scratch: string }, days: number, name = 'notes.log') => {
    mkdirSync(run.scratch, { recursive: true });
    writeFileSync(join(run.scratch, name), 'scratch');
    age(join(run.scratch, name), instant - days * DAY);
    age(run.scratch, instant - days * DAY);
  };
  /** Tool-result bodies last changed `days` ago (R-H2). */
  const bodies = (run: { path: string }, days: number) => {
    const directory = join(run.path, 'tool-results');
    mkdirSync(directory);
    writeFileSync(join(directory, `${'a'.repeat(64)}.txt.gz`), 'body');
    age(join(directory, `${'a'.repeat(64)}.txt.gz`), instant - days * DAY);
    age(directory, instant - days * DAY);
    return directory;
  };
  /** A Cargo cache in the scratch, aged with it so it never makes the scratch look recent. */
  const cargo = (run: { scratch: string }, relative: string, days: number) => {
    const path = makeCargo(join(run.scratch, relative));
    for (const entry of [
      'CACHEDIR.TAG',
      '.rustc_info.json',
      'debug/binary',
      'debug/.fingerprint',
      'debug',
      '',
    ])
      age(join(path, entry), instant - days * DAY);
    let parent = path;
    while (parent !== run.scratch) {
      parent = join(parent, '..');
      age(parent, instant - days * DAY);
    }
    return path;
  };
  return {
    context,
    auth,
    workspaceId,
    service,
    outside,
    addRun,
    scratchFile,
    bodies,
    cargo,
    advance: (days: number) => {
      instant += days * DAY;
    },
    instant: () => instant,
  };
}

/** The tick's refusals: one message naming each run it could not inspect, or none. */
async function tick(service: StorageService): Promise<string | undefined> {
  try {
    await service.tick();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The runs a message refuses, named in the order of `runs`. */
function refused(message: string | undefined, runs: Record<string, { runId: AgentRunId }>) {
  return Object.entries(runs)
    .filter(([, run]) => message?.includes(`run ${run.runId}`))
    .map(([name]) => name);
}

it('finds, removes and refuses in each kind of run directory as before (R-H8 characterization)', async () => {
  const f = await tickFixture();
  // Merged 40 days ago; its scratch, bodies and cache all as old: all past retention.
  const expired = f.addRun({ status: 'finished', tree: 'merged', exited: true, retained: 40 });
  f.scratchFile(expired, 40);
  const expiredCache = f.cargo(expired, 'target', 40);
  const expiredBodies = f.bodies(expired, 40);
  // Past retention, but its scratch changed a day ago: only its bodies and its cache go.
  const recentScratch = f.addRun({
    status: 'finished',
    tree: 'merged',
    exited: true,
    retained: 40,
  });
  f.scratchFile(recentScratch, 40);
  const recentScratchCache = f.cargo(recentScratch, 'target', 40);
  f.scratchFile(recentScratch, 1, 'recent.log');
  const recentScratchBodies = f.bodies(recentScratch, 40);
  // Merged 10 days ago: inside retention however old its files; its cache still goes.
  const within = f.addRun({ status: 'finished', tree: 'merged', exited: true, retained: 10 });
  f.scratchFile(within, 40);
  const withinCache = f.cargo(within, 'target', 40);
  const withinBodies = f.bodies(within, 40);
  // Bodies written a day ago into a long-retained run (journal compaction) wait out a window.
  const recentBodies = f.addRun({ status: 'finished', tree: 'merged', exited: true, retained: 40 });
  f.scratchFile(recentBodies, 40);
  const recentBodiesBodies = f.bodies(recentBodies, 1);
  // Ended and exited, its worktree still active: only build caches go, to depth 4 of the scratch.
  const buildOnly = f.addRun({ status: 'finished', tree: 'active', exited: true, retained: 1 });
  f.scratchFile(buildOnly, 1);
  const buildOnlyCache = f.cargo(buildOnly, 'target', 1);
  const buildOnlyRelease = makeCargo(join(buildOnly.scratch, 'repro', 'target'), 'release');
  const buildOnlyDepth4 = f.cargo(buildOnly, 'a/b/c/target', 1);
  const buildOnlyDepth5 = f.cargo(buildOnly, 'a/b/c/d/target', 1);
  // Interrupted and merged 10 days ago: eligible, never build-eligible; its cache stays.
  const interrupted = f.addRun({
    status: 'interrupted',
    tree: 'merged',
    exited: false,
    retained: 10,
  });
  f.scratchFile(interrupted, 40);
  const interruptedCache = f.cargo(interrupted, 'target', 40);
  // Interrupted and merged 40 days ago: its whole scratch expires, cache and all.
  const interruptedExpired = f.addRun({
    status: 'interrupted',
    tree: 'merged',
    exited: false,
    retained: 40,
  });
  f.scratchFile(interruptedExpired, 40);
  f.cargo(interruptedExpired, 'target', 40);
  // Failed without an observed exit: its cache stays.
  const notExited = f.addRun({ status: 'failed', tree: 'active', exited: false, retained: 1 });
  const notExitedCache = f.cargo(notExited, 'target', 1);
  // Ended and exited, but another run on its worktree is live: its cache stays.
  const liveSibling = f.addRun({ status: 'finished', tree: 'active', exited: true, retained: 1 });
  const liveSiblingCache = f.cargo(liveSibling, 'target', 1);
  const live = f.addRun({
    status: 'finished',
    tree: 'active',
    exited: false,
    retained: 0,
    worktreeId: liveSibling.worktreeId,
  });
  const db = openDatabase(f.context.config.databasePath);
  db.prepare("UPDATE agent_runs SET status = 'running', finished_at = NULL WHERE id = ?").run(
    live.runId,
  );
  db.close();
  // Removed 40 days ago without a merge: never eligible, so its scratch stays; its cache goes.
  const unmerged = f.addRun({
    status: 'finished',
    tree: 'removed-unmerged',
    exited: true,
    retained: 40,
  });
  f.scratchFile(unmerged, 40);
  const unmergedCache = f.cargo(unmerged, 'target', 40);
  // Links are never followed: a scratch, a bodies directory or a cache that is one.
  const scratchLink = f.addRun({ status: 'finished', tree: 'merged', exited: true, retained: 40 });
  const linkedScratch = join(f.outside, 'scratch');
  mkdirSync(linkedScratch);
  const linkedScratchCache = makeCargo(join(linkedScratch, 'target'));
  age(linkedScratch, f.instant() - 40 * DAY);
  symlinkSync(linkedScratch, scratchLink.scratch);
  const bodiesLink = f.addRun({ status: 'finished', tree: 'merged', exited: true, retained: 40 });
  const linkedBodies = join(f.outside, 'tool-results');
  mkdirSync(linkedBodies);
  writeFileSync(join(linkedBodies, `${'b'.repeat(64)}.txt.gz`), 'body');
  age(join(linkedBodies, `${'b'.repeat(64)}.txt.gz`), f.instant() - 40 * DAY);
  age(linkedBodies, f.instant() - 40 * DAY);
  symlinkSync(linkedBodies, join(bodiesLink.path, 'tool-results'));
  const cacheLink = f.addRun({ status: 'finished', tree: 'active', exited: true, retained: 1 });
  const linkedCache = makeCargo(join(f.outside, 'target'));
  mkdirSync(cacheLink.scratch);
  symlinkSync(linkedCache, join(cacheLink.scratch, 'target'));
  // A volume mounted inside an expired scratch: the run is refused, its bodies too.
  const mounted = f.addRun({ status: 'finished', tree: 'merged', exited: true, retained: 40 });
  f.scratchFile(mounted, 40);
  mkdirSync(join(mounted.scratch, 'mounted'));
  age(join(mounted.scratch, 'mounted'), f.instant() - 40 * DAY);
  age(mounted.scratch, f.instant() - 40 * DAY);
  const mountedBodies = f.bodies(mounted, 40);
  otherVolume.prefixes.push(join(realpathSync(mounted.scratch), 'mounted'));
  // More than the inventory's 10,000 entries above depth 4: the run is refused, its cache kept.
  const wide = f.addRun({ status: 'finished', tree: 'active', exited: true, retained: 1 });
  const wideCache = f.cargo(wide, 'target', 1);
  for (let index = 0; index <= 10_000; index++)
    mkdirSync(join(wide.scratch, 'wide', String(index)), { recursive: true });
  // Registered, but its directory is gone: nothing to find, nothing refused.
  const missing = f.addRun({ status: 'finished', tree: 'merged', exited: true, retained: 40 });
  rmSync(missing.path, { recursive: true });

  const runs = {
    expired,
    recentScratch,
    within,
    recentBodies,
    buildOnly,
    interrupted,
    interruptedExpired,
    notExited,
    liveSibling,
    live,
    unmerged,
    scratchLink,
    bodiesLink,
    cacheLink,
    mounted,
    wide,
    missing,
  };

  // The operator's scan reads the same candidates, unremoved (its counts pin them).
  const scan = (await f.service.scan(f.auth, f.workspaceId)).scan;
  expect(scan).toMatchObject({
    cacheCount: 7,
    expiredScratchCount: 5,
    warnings: expect.any(Array),
  });
  expect(refused(scan?.warnings.join(' '), runs)).toEqual(['mounted', 'wide']);

  // The tick removes what is due and refuses the two it cannot inspect.
  expect(refused(await tick(f.service), runs)).toEqual(['mounted', 'wide']);
  const gone = (paths: Record<string, string>) =>
    Object.entries(paths)
      .filter(([, path]) => !existsSync(path))
      .map(([name]) => name);
  let before: string[] = [];
  /** What went since the last call, in the order of `watched`. */
  const newlyGone = () => {
    const now = gone(watched);
    const fresh = now.filter((name) => !before.includes(name));
    before = now;
    return fresh;
  };
  const watched = {
    expiredScratch: expired.scratch,
    expiredCache,
    expiredBodies,
    recentScratch: recentScratch.scratch,
    recentScratchCache,
    recentScratchBodies,
    withinScratch: within.scratch,
    withinCache,
    withinBodies,
    recentBodiesScratch: recentBodies.scratch,
    recentBodiesBodies,
    buildOnlyScratch: buildOnly.scratch,
    buildOnlyCache,
    buildOnlyRelease,
    buildOnlyDepth4,
    buildOnlyDepth5,
    interruptedScratch: interrupted.scratch,
    interruptedCache,
    interruptedExpiredScratch: interruptedExpired.scratch,
    notExitedCache,
    liveSiblingCache,
    unmergedScratch: unmerged.scratch,
    unmergedCache,
    linkedScratchCache,
    linkedBodies,
    linkedCache,
    mountedScratch: mounted.scratch,
    mountedBodies,
    wideCache,
  };
  expect(newlyGone()).toEqual([
    'expiredScratch',
    'expiredCache',
    'expiredBodies',
    'recentScratchCache',
    'recentScratchBodies',
    'withinCache',
    'recentBodiesScratch',
    'buildOnlyCache',
    'buildOnlyRelease',
    'buildOnlyDepth4',
    'interruptedExpiredScratch',
    'unmergedCache',
  ]);
  // Each removal is audited, intent first.
  const audited = f.context.storage.audit
    .listWorkspace({ workspaceId: f.workspaceId, limit: 500 })
    .filter((row) => row.action === 'storage.cleaned');
  // Eleven removals: the expired run's cache went with its scratch.
  expect(audited.filter((row) => row.metadata.phase === 'authorized')).toHaveLength(11);
  expect(audited.filter((row) => row.metadata.phase === 'removed')).toHaveLength(11);

  // A minute later nothing more is due; the same two are refused again.
  f.advance(1 / 1440);
  expect(refused(await tick(f.service), runs)).toEqual(['mounted', 'wide']);
  expect(newlyGone()).toEqual([]);

  // 21 days on, the runs merged 10 days ago are past retention: their bodies go, and the
  // interrupted run's whole scratch. The other's scratch stays: removing its cache at the first
  // tick changed the scratch, which starts its quiet period again.
  f.advance(21);
  await tick(f.service);
  expect(newlyGone()).toEqual(['withinBodies', 'interruptedScratch', 'interruptedCache']);
  // The bodies written a day before the first tick expire 30 days after they were written.
  f.advance(8);
  await tick(f.service);
  expect(newlyGone()).toEqual(['recentBodiesBodies']);
  // The scratches whose caches the first tick removed expire 30 days after that removal.
  f.advance(2);
  await tick(f.service);
  expect(newlyGone()).toEqual(['recentScratch', 'withinScratch']);
  // What stays, stays: never eligible, refused, or reached only through a link.
  expect(Object.keys(watched).filter((name) => !gone(watched).includes(name))).toEqual([
    'buildOnlyScratch',
    'buildOnlyDepth5',
    'notExitedCache',
    'liveSiblingCache',
    'unmergedScratch',
    'linkedScratchCache',
    'linkedBodies',
    'linkedCache',
    'mountedScratch',
    'mountedBodies',
    'wideCache',
  ]);
});

it('follows what changes after a tick: a write, an eligibility, the policy (R-H8 characterization)', async () => {
  const f = await tickFixture();
  // Merged 40 days ago, its scratch 40 days old: due now, but written to after the first look.
  const written = f.addRun({ status: 'finished', tree: 'merged', exited: true, retained: 20 });
  f.scratchFile(written, 40);
  // Ended and exited with its worktree active; merged later.
  const merged = f.addRun({ status: 'finished', tree: 'active', exited: true, retained: 40 });
  f.scratchFile(merged, 40);
  // Ended and exited with its worktree active: a cache appears in it after the first tick.
  const rebuilt = f.addRun({ status: 'finished', tree: 'active', exited: true, retained: 1 });
  f.scratchFile(rebuilt, 1);

  expect(await tick(f.service)).toBeUndefined();
  expect([written.scratch, merged.scratch, rebuilt.scratch].every(existsSync)).toBe(true);

  // A file written into a scratch inside retention postpones its expiry by a full window.
  f.advance(5);
  f.scratchFile(written, 0, 'late.log');
  f.advance(10);
  expect(await tick(f.service)).toBeUndefined();
  expect(existsSync(written.scratch)).toBe(true);
  f.advance(26);
  expect(await tick(f.service)).toBeUndefined();
  expect(existsSync(written.scratch)).toBe(false);

  // A worktree merged and removed after a tick: its old scratch goes at the next one.
  f.context.storage.execution.worktrees.markMerged({
    workspaceId: f.workspaceId,
    worktreeId: merged.worktreeId,
    mergeSha: 'b'.repeat(40),
    occurredAt: new Date(f.instant() - 40 * DAY).toISOString(),
  });
  f.advance(1 / 1440);
  expect(await tick(f.service)).toBeUndefined();
  expect(existsSync(merged.scratch)).toBe(false);

  // A cache built into an ended run's scratch after a tick, by nothing the daemon knows of, goes
  // at the re-check, 6 hours after the directory was last read (R-H8 decision 2); until then
  // the tick does not read it. (Before R-H8 it went at the next tick.)
  const cache = makeCargo(join(rebuilt.scratch, 'target'));
  f.advance(1 / 1440);
  expect(await tick(f.service)).toBeUndefined();
  expect(existsSync(cache)).toBe(true);
  f.advance(6 / 24);
  expect(await tick(f.service)).toBeUndefined();
  expect(existsSync(cache)).toBe(false);

  // With automatic cache cleanup off, a cache stays; turned back on, it goes at the next tick.
  const status = f.service.get(f.auth, f.workspaceId);
  f.service.save(f.auth, f.workspaceId, {
    expectedVersion: status.version,
    policy: { ...status.policy, autoCleanBuildCaches: false },
  });
  const kept = makeCargo(join(rebuilt.scratch, 'target'));
  f.advance(1 / 1440);
  expect(await tick(f.service)).toBeUndefined();
  expect(existsSync(kept)).toBe(true);
  const off = f.service.get(f.auth, f.workspaceId);
  f.service.save(f.auth, f.workspaceId, {
    expectedVersion: off.version,
    policy: { ...off.policy, autoCleanBuildCaches: true },
  });
  f.advance(1 / 1440);
  expect(await tick(f.service)).toBeUndefined();
  expect(existsSync(kept)).toBe(false);
});

it("hands cleanup only what it may remove, so the operator's scan and last cleanup stand (R-H8 decision 3)", async () => {
  const f = await tickFixture();
  // An interrupted run, merged inside retention: eligible, never build-eligible; its cache stays.
  const interrupted = f.addRun({
    status: 'interrupted',
    tree: 'merged',
    exited: false,
    retained: 10,
  });
  const cache = f.cargo(interrupted, 'target', 10);
  const scan = (await f.service.scan(f.auth, f.workspaceId)).scan;
  expect(scan?.cacheCount).toBe(1);
  f.advance(1 / 1440);
  expect(await tick(f.service)).toBeUndefined();
  expect(existsSync(cache)).toBe(true);
  // The tick removed nothing and handed nothing on: the scan is still the operator's to use, and
  // no "last cleanup" of nothing replaced the real one.
  const status = f.service.get(f.auth, f.workspaceId);
  expect(status.scan?.id).toBe(scan?.id);
  expect(status.lastCleanup).toBeNull();
  // The operator's Clean of that scan skips the cache as before: the run is not build-eligible.
  await f.service.clean(f.auth, f.workspaceId, scan?.id ?? '');
  expect(existsSync(cache)).toBe(true);
});

it('refuses only the directories it would act on; the scan still warns of the rest (R-H8 decision 4)', async () => {
  const f = await tickFixture();
  // An interrupted run inside retention: the tick acts on nothing in it, so its scratch past the
  // inventory's limit is no refusal of the tick's.
  const interrupted = f.addRun({
    status: 'interrupted',
    tree: 'merged',
    exited: false,
    retained: 10,
  });
  f.cargo(interrupted, 'target', 10);
  for (let index = 0; index <= 10_000; index++)
    mkdirSync(join(interrupted.scratch, 'wide', String(index)), { recursive: true });
  // A build-eligible run with the same scratch is still refused.
  const ended = f.addRun({ status: 'finished', tree: 'active', exited: true, retained: 1 });
  const endedCache = f.cargo(ended, 'target', 1);
  for (let index = 0; index <= 10_000; index++)
    mkdirSync(join(ended.scratch, 'wide', String(index)), { recursive: true });
  expect(refused(await tick(f.service), { interrupted, ended })).toEqual(['ended']);
  expect(existsSync(endedCache)).toBe(true);
  const scan = (await f.service.scan(f.auth, f.workspaceId)).scan;
  expect(refused(scan?.warnings.join(' '), { interrupted, ended })).toEqual([
    'interrupted',
    'ended',
  ]);
  // With automatic cache cleanup off, the tick acts on no cache, so neither is refused.
  const status = f.service.get(f.auth, f.workspaceId);
  f.service.save(f.auth, f.workspaceId, {
    expectedVersion: status.version,
    policy: { ...status.policy, autoCleanBuildCaches: false },
  });
  f.advance(1 / 1440);
  expect(await tick(f.service)).toBeUndefined();
});

it("removes a candidate only as the kind it was found as (R-H8 decision 8, the design review's M-1)", async () => {
  const f = await tickFixture();
  // Merged 40 days ago, interrupted (never build-eligible), its scratch itself a Cargo target
  // and as old: the scan nominates the scratch as expired.
  const run = f.addRun({ status: 'interrupted', tree: 'merged', exited: false, retained: 40 });
  mkdirSync(run.scratch);
  f.cargo(run, '', 40);
  const scan = (await f.service.scan(f.auth, f.workspaceId)).scan;
  expect(scan).toMatchObject({ expiredScratchCount: 1, cacheCount: 0 });
  // Then written to: no longer expired, it is found only as a build cache, which this run may
  // not have removed. The scan's stale nomination must not remove it under the other kind.
  writeFileSync(join(run.scratch, 'recent.log'), 'written after the scan');
  await f.service.clean(f.auth, f.workspaceId, scan?.id ?? '');
  expect(existsSync(join(run.scratch, 'recent.log'))).toBe(true);
});

it("removes an expired run's bodies though its scratch is past the cache inventory, and goes on (R-H8 increment 1 review)", async () => {
  const f = await tickFixture();
  // Interrupted and merged 40 days ago: its bodies expired, its scratch written yesterday and
  // past the cache inventory, which the tick does not search in a run it may not clean.
  const wide = f.addRun({ status: 'interrupted', tree: 'merged', exited: false, retained: 40 });
  const bodies = f.bodies(wide, 40);
  for (let index = 0; index <= 10_000; index++)
    mkdirSync(join(wide.scratch, 'wide', String(index)), { recursive: true });
  f.scratchFile(wide, 1);
  // Another run's cache, handed on after it.
  const ended = f.addRun({ status: 'finished', tree: 'active', exited: true, retained: 1 });
  const cache = f.cargo(ended, 'target', 1);
  expect(await tick(f.service)).toBeUndefined();
  expect(existsSync(bodies)).toBe(false);
  expect(existsSync(wide.scratch)).toBe(true);
  expect(existsSync(cache)).toBe(false);
});

it('expires scratch and bodies with automatic cache cleanup off (R-H8 increment 1 review)', async () => {
  const f = await tickFixture();
  const status = f.service.get(f.auth, f.workspaceId);
  f.service.save(f.auth, f.workspaceId, {
    expectedVersion: status.version,
    policy: { ...status.policy, autoCleanBuildCaches: false },
  });
  const expired = f.addRun({ status: 'finished', tree: 'merged', exited: true, retained: 40 });
  f.scratchFile(expired, 40);
  const bodies = f.bodies(expired, 40);
  const recent = f.addRun({ status: 'finished', tree: 'merged', exited: true, retained: 40 });
  f.scratchFile(recent, 1);
  const cache = f.cargo(recent, 'target', 40);
  expect(await tick(f.service)).toBeUndefined();
  expect([existsSync(expired.scratch), existsSync(bodies)]).toEqual([false, false]);
  expect([existsSync(recent.scratch), existsSync(cache)]).toEqual([true, true]);
});

it('reads a directory again at its due time, not before (R-H8 decision 1)', async () => {
  const f = await tickFixture();
  // Merged 29.9 days ago, its scratch 40 days old: due when its retention runs out, in 2.4 hours
  // (inside the 6-hour re-check).
  const retained = f.addRun({ status: 'finished', tree: 'merged', exited: true, retained: 29.9 });
  f.scratchFile(retained, 40);
  // Merged 40 days ago, its scratch last written 29.97 days ago: due in about 43 minutes.
  const written = f.addRun({ status: 'finished', tree: 'merged', exited: true, retained: 40 });
  f.scratchFile(written, 29.97);
  expect(await tick(f.service)).toBeUndefined();
  // Caches built into both after that read go unseen until each is due.
  const first = f.cargo(retained, 'target', 40);
  const second = f.cargo(written, 'target', 29.97);
  f.advance(0.02);
  expect(await tick(f.service)).toBeUndefined();
  expect([existsSync(first), existsSync(second)]).toEqual([true, true]);
  f.advance(0.02);
  expect(await tick(f.service)).toBeUndefined();
  expect([existsSync(first), existsSync(written.scratch)]).toEqual([true, false]);
  f.advance(0.07);
  expect(await tick(f.service)).toBeUndefined();
  expect(existsSync(retained.scratch)).toBe(false);
});

it('reads a directory again when the daemon touches it, its worktree or the policy it was read under (R-H8)', async () => {
  const f = await tickFixture();
  const run = f.addRun({ status: 'finished', tree: 'active', exited: true, retained: 1 });
  f.scratchFile(run, 1);
  expect(await tick(f.service)).toBeUndefined();
  const planted = () => makeCargo(join(run.scratch, 'target'));
  const minute = async () => {
    f.advance(1 / 1440);
    expect(await tick(f.service)).toBeUndefined();
  };
  // Nothing the daemon knows of: unseen.
  let cache = planted();
  await minute();
  expect(existsSync(cache)).toBe(true);
  // A settings change that changes no result (the backups kept) changes nothing (review L-3).
  const status = f.service.get(f.auth, f.workspaceId);
  f.service.save(f.auth, f.workspaceId, {
    expectedVersion: status.version,
    policy: { ...status.policy, backupsToKeep: status.policy.backupsToKeep + 1 },
  });
  await minute();
  expect(existsSync(cache)).toBe(true);
  // Its worktree touched (a launch, an end-of-run cleanup): read at the next tick.
  f.service.forgetInspections({ worktreeId: run.worktreeId });
  await minute();
  expect(existsSync(cache)).toBe(false);
  // The run itself touched (its checks stopped).
  await minute();
  cache = planted();
  await minute();
  expect(existsSync(cache)).toBe(true);
  f.service.forgetInspections({ runId: run.runId });
  await minute();
  expect(existsSync(cache)).toBe(false);
  // Another run's worktree or run touched: not this one.
  await minute();
  cache = planted();
  f.service.forgetInspections({ worktreeId: asWorktreeId('another-worktree') });
  f.service.forgetInspections({ runId: asAgentRunId(randomUUID()) });
  await minute();
  expect(existsSync(cache)).toBe(true);
  // A clock set back makes what was read "later" due (review L-2).
  f.advance(-1);
  expect(await tick(f.service)).toBeUndefined();
  expect(existsSync(cache)).toBe(false);
});

it('walks about its budget a tick, at least one directory, never-read ones first (R-H8 decision 5)', async () => {
  const f = await tickFixture({ walkBudgetMs: 0 });
  const runs = [1, 2, 3].map(() => {
    const run = f.addRun({ status: 'finished', tree: 'active', exited: true, retained: 1 });
    return f.cargo(run, 'target', 1);
  });
  const left = () => runs.filter(existsSync).length;
  // One directory a tick; one just cleaned is read again at the next (review M-2).
  for (const expected of [2, 2, 1, 1, 0]) {
    expect(await tick(f.service)).toBeUndefined();
    expect(left()).toBe(expected);
    f.advance(1 / 1440);
  }
});

it('reads a standing refusal again every tick, outside the budget (R-H8 decision 6, the operator 2026-10-20)', async () => {
  const f = await tickFixture({ walkBudgetMs: 0 });
  const wide = f.addRun({ status: 'finished', tree: 'active', exited: true, retained: 1 });
  for (let index = 0; index <= 10_000; index++)
    mkdirSync(join(wide.scratch, 'wide', String(index)), { recursive: true });
  const caches = [1, 2].map(() => {
    const run = f.addRun({ status: 'finished', tree: 'active', exited: true, retained: 1 });
    return f.cargo(run, 'target', 1);
  });
  const left = () => caches.filter(existsSync).length;
  // The first tick reads only the first directory, and it is refused.
  expect(refused(await tick(f.service), { wide })).toEqual(['wide']);
  expect(left()).toBe(2);
  // Each later tick reads it again, refused, and one other directory besides (a cleaned one
  // again at the next).
  for (const expected of [1, 1, 0]) {
    f.advance(1 / 1440);
    expect(refused(await tick(f.service), { wide })).toEqual(['wide']);
    expect(left()).toBe(expected);
  }
  // Once the operator fixes it, the next tick clears the refusal.
  rmSync(join(wide.scratch, 'wide'), { recursive: true });
  f.advance(1 / 1440);
  expect(await tick(f.service)).toBeUndefined();
});

it('pauses a long walk after each slice of it (R-H8 decision 5)', async () => {
  const f = await tickFixture();
  const run = f.addRun({ status: 'finished', tree: 'active', exited: true, retained: 1 });
  mkdirSync(run.scratch);
  for (let index = 0; index < 30; index++) writeFileSync(join(run.scratch, String(index)), '');
  const started = performance.now();
  await directoryBytes(run.scratch, undefined, new WalkPacer(0, 20));
  // 31 entries, each after a 20 ms pause: the walk gave the event loop back throughout.
  expect(performance.now() - started).toBeGreaterThanOrEqual(600);
});
