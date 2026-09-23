import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { storageStatusSchema } from '@craftingtable/contracts';
import {
  asAgentRunId,
  asAgentRunEventId,
  asPlanBundleId,
  asPlanVersionId,
  asProjectId,
  asSourceRepositoryId,
  asUserId,
  asWorkItemId,
  asWorkspaceId,
  asWorkspaceMembershipId,
  asWorktreeId,
  DEFAULT_NOTIFICATION_PREFERENCES,
} from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, expect, it, vi } from 'vitest';
import { NotificationService } from './services/notification-service.js';
import {
  STORAGE_ALERT_CLEAR_HOLD_MS,
  STORAGE_UNAVAILABLE_GRACE_MS,
} from './services/storage-alerts.js';
import { cargoCaches, cleanupCandidates, requireFree } from './services/storage-files.js';
import { StorageService } from './services/storage-service.js';
import { createTestContext, type TestContext } from './test-support.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.cleanup();
});
async function fixture() {
  const context = await createTestContext();
  contexts.push(context);
  await context.bootstrap();
  const login = await context.login();
  await context.services.storageService.shutdown();
  await context.services.notificationService.shutdown();
  const auth = context.services.authService.authenticate(
    login.cookie.split('=').slice(1).join('='),
  );
  const workspaceId = context.storage.workspaces.listAuthorized(auth.user.id)[0]?.workspace.id;
  if (!workspaceId) throw new Error('Missing workspace');
  const headers = {
    cookie: login.cookie,
    origin: context.config.publicOrigin,
    'x-craftingtable-csrf': login.csrfToken,
  };
  const url = `/api/workspaces/${workspaceId}/storage`;
  const service = context.services.storageService;
  service.startWorker();
  return { context, auth, workspaceId, headers, url, service };
}
async function runFixture() {
  const state = await fixture();
  const { context, auth, workspaceId, service } = state;
  const projectId = asProjectId('project'),
    bundleId = asPlanBundleId('bundle'),
    planVersionId = asPlanVersionId('plan'),
    workItemId = asWorkItemId('item'),
    repositoryId = asSourceRepositoryId('repo'),
    worktreeId = asWorktreeId('tree'),
    runId = asAgentRunId(randomUUID());
  const now = new Date().toISOString();
  const treePath = join(context.config.execution.worktreeRoot, 'fixture');
  mkdirSync(treePath);
  context.storage.transaction((tx) => {
    tx.planning.projects.insert({
      id: projectId,
      workspaceId,
      name: 'Fixture',
      slug: 'fixture',
      createdAt: now,
      createdByUserId: auth.user.id,
    });
    tx.planning.bundles.insert({
      id: bundleId,
      workspaceId,
      projectId,
      logicalName: 'fixture',
      createdAt: now,
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
      createdAt: now,
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
      registeredAt: now,
      registeredByUserId: auth.user.id,
    });
    tx.execution.worktrees.insert({
      id: worktreeId,
      workspaceId,
      repositoryId,
      projectId,
      workItemId,
      branchName: 'ct/fixture',
      baseSha: 'a'.repeat(40),
      baseBranch: 'main',
      path: treePath,
      createdAt: now,
      createdByUserId: auth.user.id,
    });
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
      brief: 'Review with retained evidence',
      createdAt: now,
      createdByUserId: auth.user.id,
    });
    tx.execution.runs.transition({
      workspaceId,
      runId,
      expectedStatuses: ['starting'],
      toStatus: 'finished',
      occurredAt: now,
      finishedAt: now,
    });
    tx.execution.runEvents.append({
      id: asAgentRunEventId(randomUUID()),
      workspaceId,
      runId,
      occurredAt: now,
      kind: 'run-finished',
      payload: { status: 'finished', exitCode: 0 },
    });
  });
  const runPath = join(service.executionConfig.runsRoot, runId);
  mkdirSync(join(runPath, 'scratch'), { recursive: true });
  writeFileSync(join(runPath, 'brief.md'), 'Retained brief');
  writeFileSync(join(runPath, 'scratch', 'verification.log'), 'checks pass');
  service.registerRun(runId, runPath);
  const cache = makeCargo(join(runPath, 'scratch', 'target'));
  const merge = () => {
    context.storage.execution.worktrees.markMerged({
      workspaceId,
      worktreeId,
      mergeSha: 'b'.repeat(40),
      occurredAt: now,
    });
    context.storage.execution.worktrees.markRemoved({ workspaceId, worktreeId, occurredAt: now });
  };
  return { ...state, runId, runPath, cache, worktreeId, treePath, merge };
}
function makeCargo(path: string) {
  mkdirSync(join(path, 'debug', '.fingerprint'), { recursive: true });
  writeFileSync(
    join(path, 'CACHEDIR.TAG'),
    'Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by cargo.\n',
  );
  writeFileSync(join(path, '.rustc_info.json'), '{}');
  writeFileSync(join(path, 'debug', 'binary'), Buffer.alloc(4096));
  return path;
}
it('requires authentication, CSRF, and ownership of every workspace; rejects arbitrary cleanup paths', async () => {
  const s = await fixture();
  expect((await s.context.app.inject({ method: 'GET', url: s.url })).statusCode).toBe(401);
  expect(
    (
      await s.context.app.inject({
        method: 'POST',
        url: `${s.url}/backup`,
        headers: { cookie: s.headers.cookie },
        payload: {},
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await s.context.app.inject({
        method: 'POST',
        url: `${s.url}/clean`,
        headers: s.headers,
        payload: { path: '/tmp' },
      })
    ).statusCode,
  ).toBe(400);
  const other = asUserId('other'),
    otherWorkspace = asWorkspaceId('other-space'),
    now = new Date().toISOString();
  s.context.storage.users.insert({
    id: other,
    username: 'other',
    usernameNormalized: 'other',
    passwordHash: '$argon2id$test$hash',
    occurredAt: now,
  });
  s.context.storage.workspaces.insert({
    id: otherWorkspace,
    name: 'Other',
    slug: 'other',
    createdByUserId: other,
    occurredAt: now,
  });
  s.context.storage.workspaces.insertMembership({
    id: asWorkspaceMembershipId('other-membership'),
    workspaceId: otherWorkspace,
    userId: other,
    role: 'owner',
    occurredAt: now,
  });
  expect(
    (await s.context.app.inject({ method: 'GET', url: s.url, headers: s.headers })).statusCode,
  ).toBe(403);
});
it('changes future placement durably while old run paths and merge scratch stay fixed', async () => {
  const s = await runFixture();
  const old = s.service.get(s.auth, s.workspaceId);
  const originalMerge = s.service.executionConfig.mergeRoot;
  const policy = {
    ...old.policy,
    worktreeRoot: join(s.context.directory, 'new-trees'),
    runsRoot: join(s.context.directory, 'new-runs'),
  };
  const result = s.service.save(s.auth, s.workspaceId, { expectedVersion: old.version, policy });
  expect(result.version).toBe(2);
  expect(s.service.executionConfig.worktreeRoot).toBe(policy.worktreeRoot);
  expect(s.context.storage.maintenance.directories()[0]?.path).toBe(s.runPath);
  const reopened = new StorageService(
    s.context.storage,
    {
      ...s.context.config,
      execution: {
        ...s.context.config.execution,
        worktreeRoot: join(s.context.directory, 'changed-env-trees'),
      },
    },
    s.context.services.workspaceService,
  );
  expect(reopened.executionConfig.runsRoot).toBe(policy.runsRoot);
  expect(reopened.executionConfig.mergeRoot).toBe(originalMerge);
  expect(() => s.service.save(s.auth, s.workspaceId, { expectedVersion: 1, policy })).toThrow(
    /Reload/,
  );
  expect(() =>
    s.service.save(s.auth, s.workspaceId, {
      expectedVersion: 2,
      policy: { ...policy, runsRoot: join(s.runPath, 'scratch') },
    }),
  ).toThrow(/retained run/);
  const invalid = { ...policy, backupRoot: join(s.context.directory, 'source', '.git', 'backup') };
  mkdirSync(join(s.context.directory, 'source', '.git'), { recursive: true });
  expect(() =>
    s.service.save(s.auth, s.workspaceId, { expectedVersion: 2, policy: invalid }),
  ).toThrow(/must not contain/);
  expect(existsSync(invalid.backupRoot)).toBe(false);
});
it('cleans ended-run caches before merge, retaining run history and unknown scratch', async () => {
  const s = await runFixture();
  const scan = await s.service.scan(s.auth, s.workspaceId);
  expect(scan.scan?.cacheCount).toBe(1);
  expect(scan.scan?.reclaimableBytes).toBeGreaterThan(4096);
  await s.service.clean(s.auth, s.workspaceId, scan.scan?.id ?? '');
  expect(existsSync(s.cache)).toBe(false);
  expect(readFileSync(join(s.runPath, 'scratch', 'verification.log'), 'utf8')).toBe('checks pass');
  expect(readFileSync(join(s.runPath, 'brief.md'), 'utf8')).toBe('Retained brief');
  expect(s.context.storage.execution.runs.find(s.workspaceId, s.runId)?.brief).toContain(
    'retained evidence',
  );
  await expect(s.service.clean(s.auth, s.workspaceId, scan.scan?.id ?? '')).rejects.toThrow(
    /Scan storage/,
  );
});
it('revalidates eligibility and directory identity after preview; cannot follow replaced scratch links', async () => {
  const s = await runFixture();
  s.merge();
  const scan = await s.service.scan(s.auth, s.workspaceId);
  const scratch = join(s.runPath, 'scratch');
  renameSync(scratch, `${scratch}-preserved`);
  symlinkSync(`${scratch}-preserved`, scratch);
  await s.service.clean(s.auth, s.workspaceId, scan.scan?.id ?? '');
  expect(existsSync(join(`${scratch}-preserved`, 'target', 'debug', 'binary'))).toBe(true);
  rmSync(scratch);
  renameSync(`${scratch}-preserved`, scratch);
  const next = await s.service.scan(s.auth, s.workspaceId);
  const db = openDatabase(s.context.config.databasePath);
  db.prepare("UPDATE agent_runs SET status='running', finished_at=NULL WHERE id=?").run(s.runId);
  db.close();
  await s.service.clean(s.auth, s.workspaceId, next.scan?.id ?? '');
  expect(existsSync(s.cache)).toBe(true);
});
it('refuses forged cache tags, symlinked markers, and cache paths on a changed volume', async () => {
  const s = await runFixture();
  const run = { path: s.runPath, runId: s.runId, device: statSync(s.runPath).dev };
  writeFileSync(join(s.cache, 'CACHEDIR.TAG'), 'not a Cargo cache');
  expect(await cargoCaches(run)).toEqual([]);
  rmSync(join(s.cache, 'CACHEDIR.TAG'));
  symlinkSync(join(s.runPath, 'brief.md'), join(s.cache, 'CACHEDIR.TAG'));
  expect(await cargoCaches(run)).toEqual([]);
  await expect(cargoCaches({ ...run, device: run.device + 1 })).rejects.toThrow(/volume changed/);
});
it('expires other scratch after 30 days and protects recent edits and interrupted unmerged work', async () => {
  const s = await runFixture();
  rmSync(s.cache, { recursive: true });
  const old = new Date(Date.now() - 40 * 86_400_000);
  const scratch = join(s.runPath, 'scratch');
  utimesSync(join(scratch, 'verification.log'), old, old);
  utimesSync(scratch, old, old);
  const run = {
    path: s.runPath,
    runId: s.runId,
    device: statSync(s.runPath).dev,
    retainedSince: old.toISOString(),
  };
  expect((await cleanupCandidates(run, 30, new Date()))[0]?.kind).toBe('scratch');
  expect(await cleanupCandidates(run, 0, new Date())).toEqual([]);
  expect(
    await cleanupCandidates({ ...run, retainedSince: new Date().toISOString() }, 30, new Date()),
  ).toEqual([]);
  expect((await s.service.scan(s.auth, s.workspaceId)).scan?.expiredScratchCount).toBe(0);
  writeFileSync(join(scratch, 'verification.log'), 'recently inspected');
  expect(await cleanupCandidates(run, 30, new Date())).toEqual([]);
});
it('automatic cleanup resumes after restart and daily backups are consistent, private and bounded', async () => {
  const s = await runFixture();
  s.merge();
  let instant = Date.now();
  const now = () => new Date(instant);
  const settings = s.service.get(s.auth, s.workspaceId);
  s.service.save(s.auth, s.workspaceId, {
    expectedVersion: settings.version,
    policy: { ...settings.policy, backupsToKeep: 1 },
  });
  const restarted = new StorageService(
    s.context.storage,
    s.context.config,
    s.context.services.workspaceService,
    now,
  );
  await restarted.tick();
  expect(existsSync(s.cache)).toBe(false);
  let backups = s.context.storage.maintenance.backups();
  expect(backups).toHaveLength(1);
  const initial = backups[0];
  if (!initial) throw new Error('Missing backup');
  const db = openDatabase(initial.path);
  expect(db.pragma('integrity_check')).toEqual([{ integrity_check: 'ok' }]);
  expect(db.prepare('SELECT brief FROM agent_runs WHERE id=?').get(s.runId)).toEqual({
    brief: 'Review with retained evidence',
  });
  db.close();
  expect(statSync(initial.path).mode & 0o777).toBe(0o600);
  await restarted.tick();
  expect(s.context.storage.maintenance.backups()).toHaveLength(1);
  instant += 86_400_001;
  await restarted.tick();
  backups = s.context.storage.maintenance.backups();
  expect(backups).toHaveLength(1);
  expect(backups[0]?.path).not.toBe(initial.path);
  expect(existsSync(initial.path)).toBe(false);
});
it('refuses new writes after a configured volume disappears and raises a stable attention source', async () => {
  const s = await fixture();
  const before = s.service.get(s.auth, s.workspaceId);
  const root = before.policy.runsRoot;
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    renameSync(root, `${root}-offline`);
    expect(() => s.service.executionConfig.runsRoot).toThrow(/unavailable/);
    expect(existsSync(root)).toBe(false);
    expect(() =>
      requireFree(
        { path: s.context.directory, device: statSync(s.context.directory).dev },
        Number.MAX_SAFE_INTEGER,
      ),
    ).toThrow(/less than/);
    // A brief remount stays quiet; a mount that stays away raises one coalesced alert.
    expect(s.service.alerts()).toHaveLength(0);
    vi.setSystemTime(Date.now() + STORAGE_UNAVAILABLE_GRACE_MS);
    const alerts = s.service.alerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.key).toBe('storage:volumes');
    const notifications = new NotificationService(
      s.context.storage,
      s.context.services.workspaceService,
      s.context.services.workspaceEventNotifier,
      { send: async () => ({ status: 'accepted' }) },
      s.context.config.publicOrigin,
      () => new Date(),
      () => s.service.alerts(),
      undefined,
      { settleMs: 0 },
    );
    notifications.save(s.auth, s.workspaceId, {
      expectedVersion: 0,
      preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true },
      applicationToken: 'a'.repeat(30),
      userKey: 'u'.repeat(30),
      clearCredentials: false,
    });
    await notifications.tick();
    expect(
      s.context.storage.notifications
        .records(s.workspaceId)
        .some((record) => record.sourceKey === alerts[0]?.key && record.state === 'active'),
    ).toBe(true);
    renameSync(`${root}-offline`, root);
    await notifications.tick();
    expect(
      s.context.storage.notifications
        .records(s.workspaceId)
        .some((record) => record.state === 'active'),
    ).toBe(true);
    vi.setSystemTime(Date.now() + STORAGE_ALERT_CLEAR_HOLD_MS);
    await notifications.tick();
    expect(
      s.context.storage.notifications
        .records(s.workspaceId)
        .every((record) => record.state === 'resolved'),
    ).toBe(true);
    await notifications.shutdown();
  } finally {
    vi.useRealTimers();
  }
});
it('serves validated storage status and a usable cleanup preview through the authenticated API', async () => {
  const s = await fixture();
  const response = await s.context.app.inject({
    method: 'POST',
    url: `${s.url}/scan`,
    headers: s.headers,
    payload: {},
  });
  expect(response.statusCode, response.body).toBe(200);
  expect(storageStatusSchema.parse(response.json()).scan?.cacheCount).toBe(0);
});

it('keeps reclaiming caches when backup storage is unavailable and retries backup after recovery', async () => {
  const s = await runFixture();
  s.merge();
  const root = s.service.get(s.auth, s.workspaceId).policy.backupRoot;
  renameSync(root, `${root}-offline`);
  await expect(s.service.tick()).rejects.toThrow(/unavailable/);
  expect(existsSync(s.cache)).toBe(false);
  expect(s.context.storage.maintenance.backups()).toHaveLength(0);
  renameSync(`${root}-offline`, root);
  await s.service.tick();
  expect(s.context.storage.maintenance.backups()).toHaveLength(1);
  expect(s.service.get(s.auth, s.workspaceId).lastError).toBeNull();
});

it.each(['finished', 'failed', 'cancelled'] as const)(
  'cleans caches after a %s run without waiting for merge',
  async (status) => {
    const s = await runFixture();
    const db = openDatabase(s.context.config.databasePath);
    db.prepare('UPDATE agent_runs SET status=? WHERE id=?').run(status, s.runId);
    db.close();
    const nested = makeCargo(join(s.runPath, 'scratch', 'repro', 'target'));
    renameSync(join(nested, 'debug'), join(nested, 'release'));
    await s.service.cleanupAfterRun(s.worktreeId);
    expect(existsSync(s.cache)).toBe(false);
    expect(existsSync(nested)).toBe(false);
    expect(existsSync(join(s.runPath, 'scratch', 'verification.log'))).toBe(true);
    expect(
      s.context.storage.execution.worktrees.find(s.workspaceId, s.worktreeId)?.mergedAt,
    ).toBeUndefined();
  },
);
it.each(['running', 'waiting', 'interrupted'] as const)(
  'retains build caches for a %s run',
  async (status) => {
    const s = await runFixture();
    const db = openDatabase(s.context.config.databasePath);
    db.prepare('UPDATE agent_runs SET status=?, finished_at=? WHERE id=?').run(
      status,
      status === 'interrupted' ? new Date().toISOString() : null,
      s.runId,
    );
    db.close();
    await s.service.cleanupAfterRun(s.worktreeId);
    expect(existsSync(s.cache)).toBe(true);
  },
);
it('honors disabled automatic cache cleanup while manual preview remains available', async () => {
  const s = await runFixture();
  const status = s.service.get(s.auth, s.workspaceId);
  s.service.save(s.auth, s.workspaceId, {
    expectedVersion: status.version,
    policy: { ...status.policy, autoCleanBuildCaches: false },
  });
  await s.service.cleanupAfterRun(s.worktreeId);
  expect(existsSync(s.cache)).toBe(true);
  expect((await s.service.scan(s.auth, s.workspaceId)).scan?.cacheCount).toBe(1);
});

it('queues end-of-run cleanup behind existing maintenance without losing the request', async () => {
  const s = await runFixture();
  let release = () => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = s.context.storage.backup.bind(s.context.storage);
  const spy = vi.spyOn(s.context.storage, 'backup').mockImplementation(async (path) => {
    await barrier;
    await original(path);
  });
  const backup = s.service.backup(s.auth, s.workspaceId);
  const cleanup = s.service.cleanupAfterRun(s.worktreeId);
  expect(s.service.isCleaningRun(s.worktreeId)).toBe(true);
  expect(existsSync(s.cache)).toBe(true);
  release();
  await Promise.all([backup, cleanup]);
  spy.mockRestore();
  expect(existsSync(s.cache)).toBe(false);
  expect(s.service.isCleaningRun(s.worktreeId)).toBe(false);
});
it('protects prior run caches while another run in that worktree is live', async () => {
  const s = await runFixture();
  const source = s.context.storage.execution.runs.find(s.workspaceId, s.runId);
  if (!source) throw new Error('Missing run');
  s.context.storage.execution.runs.insert({
    ...source,
    id: asAgentRunId(randomUUID()),
    createdAt: new Date().toISOString(),
  });
  await s.service.cleanupAfterRun(s.worktreeId);
  expect(existsSync(s.cache)).toBe(true);
});

it('retains cache data when supervision failed without an observed process exit', async () => {
  const s = await runFixture();
  const source = s.context.storage.execution.runs.find(s.workspaceId, s.runId);
  if (!source) throw new Error('Missing run');
  const run = s.context.storage.execution.runs.insert({
    ...source,
    id: asAgentRunId(randomUUID()),
  });
  s.context.storage.execution.runs.transition({
    workspaceId: s.workspaceId,
    runId: run.id,
    expectedStatuses: ['starting'],
    toStatus: 'failed',
    occurredAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  });
  const directory = join(s.service.executionConfig.runsRoot, run.id);
  const cache = makeCargo(join(directory, 'scratch', 'target'));
  s.service.registerRun(run.id, directory);
  await s.service.cleanupAfterRun(s.worktreeId);
  expect(existsSync(cache)).toBe(true);
});
