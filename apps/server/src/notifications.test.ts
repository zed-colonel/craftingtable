import { randomUUID } from 'node:crypto';
import { notificationStatusSchema } from '@craftingtable/contracts';
import {
  asAgentRunEventId,
  asAgentRunId,
  asPlanBundleId,
  asPlanVersionId,
  asProjectId,
  asSourceRepositoryId,
  asUserId,
  asWorkItemId,
  asWorkspaceId,
  asWorkspaceMembershipId,
  asWorktreeId,
  cycleAttention,
  DEFAULT_COMPLETION_POLICY,
  DEFAULT_NOTIFICATION_PREFERENCES,
  effectiveCycleAttention,
  type Roadmap,
  type RoadmapDefinition,
  roadmapAttention,
  type WorkCycle,
} from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDaemonStorage } from './persisted-records.js';
import {
  NOTIFICATION_SETTLE_MS,
  NotificationService,
  type NotificationServiceOptions,
} from './services/notification-service.js';
import type { DeliveryResult, NotificationMessage } from './services/notification-transport.js';
import {
  STORAGE_ALERT_CLEAR_HOLD_MS,
  type StorageAlert,
  StorageAlertGate,
} from './services/storage-alerts.js';
import { GiB } from './services/storage-files.js';
import { WorkspaceEventNotifier } from './services/workspace-event-notifier.js';
import { WorkspaceService } from './services/workspace-service.js';
import { createTestContext, type TestContext } from './test-support.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.cleanup();
});
const token = 'a'.repeat(30);
const key = 'u'.repeat(30);
const preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true };
// Most scenarios exercise scheduling and leases; they opt out of the settle delay, which
// has its own tests below.
async function fixture(
  cycleTransitioning: (id: string) => boolean = () => false,
  options: NotificationServiceOptions = { settleMs: 0 },
  storageAttention?: () => readonly StorageAlert[],
) {
  let time = Date.parse('2026-09-10T15:00:00Z');
  const now = () => new Date(time);
  const context = await createTestContext({ now });
  contexts.push(context);
  await context.bootstrap();
  const login = await context.login();
  await context.services.notificationService.shutdown();
  await context.services.workCycleService.shutdown();
  const user = context.storage.users.findByNormalizedUsername('test-user');
  if (!user) throw new Error('Missing user');
  const workspaceId = context.storage.workspaces.listAuthorized(user.id)[0]?.workspace.id;
  if (!workspaceId) throw new Error('Missing workspace');
  const auth = context.services.authService.authenticate(
    login.cookie.slice(login.cookie.indexOf('=') + 1),
  );
  const projectId = asProjectId('project-1');
  const workItemId = asWorkItemId('item-1');
  const repositoryId = asSourceRepositoryId('repo-1');
  const worktreeId = asWorktreeId('tree-1');
  const planVersionId = asPlanVersionId('plan-1');
  const bundleId = asPlanBundleId('bundle-1');
  context.storage.transaction((tx) => {
    tx.planning.projects.insert({
      id: projectId,
      workspaceId,
      name: 'ActionQueue',
      slug: 'aq',
      createdAt: now().toISOString(),
      createdByUserId: user.id,
    });
    tx.planning.bundles.insert({
      id: bundleId,
      workspaceId,
      projectId,
      logicalName: 'aq',
      createdAt: now().toISOString(),
    });
    tx.planning.versions.insert({
      id: planVersionId,
      workspaceId,
      projectId,
      bundleId,
      versionNumber: 1,
      contentDigest: 'e'.repeat(64),
      digestAlgorithm: 'sha-256',
      digestFormatVersion: 1,
      sourceProfile: 'exo-work-breakdown-v1',
      document: 'plan.md',
      normalizedSource: {},
      itemCount: 1,
      requiredDependencyCount: 0,
      createdAt: now().toISOString(),
      createdByUserId: user.id,
    });
    tx.planning.workItems.insertMany([
      {
        id: workItemId,
        workspaceId,
        projectId,
        planVersionId,
        sourceId: 'AQ-05',
        ordinal: 0,
        title: 'Next queue improvement',
        risk: 'low',
        primaryAreas: [],
        exitGate: 'Checks pass',
        sourceFields: {},
      },
    ]);
    tx.execution.sourceRepositories.insert({
      id: repositoryId,
      workspaceId,
      displayName: 'AQ',
      rootPath: '/tmp/aq-notification-fixture',
      defaultBranch: 'main',
      registeredHeadSha: 'a'.repeat(40),
      registeredAt: now().toISOString(),
      registeredByUserId: user.id,
    });
    tx.execution.worktrees.insert({
      id: worktreeId,
      workspaceId,
      repositoryId,
      projectId,
      workItemId,
      branchName: 'ct/aq-05',
      baseSha: 'a'.repeat(40),
      baseBranch: 'main',
      integrationBranch: 'aq-cont-1',
      path: '/tmp/aq-notification-tree',
      createdAt: now().toISOString(),
      createdByUserId: user.id,
    });
  });
  const profile = { backend: 'claude-code' as const, permissionMode: 'auto' as const };
  let cycle: WorkCycle = {
    id: randomUUID(),
    workspaceId,
    projectId,
    workItemId,
    worktreeId,
    workItemSourceId: 'AQ-05',
    workItemTitle: 'Next queue improvement',
    createdByUserId: user.id,
    createdAt: now().toISOString(),
    updatedAt: now().toISOString(),
    version: 1,
    status: 'awaiting-merge',
    step: 'review',
    policy: DEFAULT_COMPLETION_POLICY,
    profiles: { design: profile, implement: profile, review: profile, remediate: profile },
    instructions: '',
    currentRunId: asAgentRunId('cycle-run'),
    runDeadlineAt: now().toISOString(),
    remediationRounds: 0,
    stalledReviews: 0,
    reason: 'Review meets policy. Operator merge approval required.',
    attention: cycleAttention('merge-approval'),
  };
  context.storage.execution.cycles.insert(cycle);
  const send = vi
    .fn<(message: NotificationMessage, signal: AbortSignal) => Promise<DeliveryResult>>()
    .mockResolvedValue({ status: 'accepted' });
  const service = new NotificationService(
    context.storage,
    context.services.workspaceService,
    context.services.workspaceEventNotifier,
    { send },
    'https://craft.example',
    now,
    storageAttention,
    cycleTransitioning,
    {
      roadmapAlerts: (tx, ws) => context.services.roadmapService.attentionAlerts(tx, ws),
      ...options,
    },
  );
  service.save(auth, workspaceId, {
    preferences,
    expectedVersion: 0,
    applicationToken: token,
    userKey: key,
  });
  const headers = {
    cookie: login.cookie,
    origin: context.config.publicOrigin,
    'x-craftingtable-csrf': login.csrfToken,
  };
  return {
    context,
    service,
    send,
    auth,
    workspaceId,
    worktreeId,
    workItemId,
    projectId,
    repositoryId,
    now,
    headers,
    advance: (minutes: number) => {
      time += minutes * 60_000;
    },
    status: () => service.get(auth, workspaceId),
    cycle: () => cycle,
    setCycle: (status: WorkCycle['status'], changes: Partial<WorkCycle> = {}) => {
      // Written like the controller writes it: a stop carries its typed attention (R-A3).
      const { attention: _previous, ...rest } = cycle;
      const merged: WorkCycle = {
        ...rest,
        ...changes,
        status,
        version: cycle.version + 1,
        updatedAt: now().toISOString(),
      };
      const attention = changes.attention ?? effectiveCycleAttention(merged);
      const next: WorkCycle = attention ? { ...merged, attention } : merged;
      context.storage.execution.cycles.replace(next, cycle.version);
      cycle = next;
    },
  };
}
describe('persistent notifications', () => {
  it('holds sends during recovery preparation without resetting reminders after a failed command', async () => {
    let transitioning = false;
    const f = await fixture(() => transitioning);
    await f.service.tick();
    const first = f.context.storage.notifications.records(f.workspaceId)[0]!;
    const generation = f.context.services.workspaceEventNotifier.workflowGeneration;
    transitioning = true;
    f.advance(30);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.context.storage.notifications.records(f.workspaceId)[0]).toMatchObject({
      state: 'active',
      firstSentAt: first.firstSentAt,
      deliveredCount: 1,
    });
    transitioning = false; // Preparation failed; the original incident is still actionable.
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0].message).toMatch(/^Reminder:/);
    expect(f.context.services.workspaceEventNotifier.workflowGeneration).toBe(generation);
    f.setCycle('running');
    await f.service.tick();
    expect(f.context.storage.notifications.records(f.workspaceId)[0]?.state).toBe('resolved');
  });
  it('does not create attention for a stop already being recovered, but reports a failed recovery immediately', async () => {
    let transitioning = true;
    const f = await fixture(() => transitioning);
    f.setCycle('needs-attention');
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.context.storage.notifications.records(f.workspaceId)).toHaveLength(0);
    transitioning = false;
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('sends the agreed schedule once per phase with project, branches, reason, and private HTTPS link', async () => {
    const f = await fixture();
    await f.service.tick();
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0]).toMatchObject({
      title: 'ActionQueue · AQ-05 · Ready for merge',
      url: `https://craft.example/workspaces/${f.workspaceId}/work-items/item-1`,
    });
    expect(f.send.mock.calls[0]?.[0].message).toContain('ct/aq-05 → aq-cont-1');
    f.advance(29);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(1);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    f.advance(30);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 5; i++) {
      f.advance(60);
      await f.service.tick();
    }
    expect(f.send).toHaveBeenCalledTimes(8);
    expect(f.status().records[0]?.nextAttemptAt).toBe('2026-09-11T04:00:00.000Z');
    f.advance(7 * 60);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(9);
    expect(f.status().records[0]?.nextAttemptAt).toBe('2026-09-12T04:00:00.000Z');
  });
  it.each(['running', 'paused', 'stopped', 'completed'] as const)(
    'clears reminders when the cycle becomes %s and resets on a new attention occurrence',
    async (status) => {
      const f = await fixture();
      await f.service.tick();
      f.setCycle(status);
      f.advance(31);
      await f.service.tick();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.status().records[0]?.state).toBe('resolved');
      f.setCycle('needs-attention');
      await f.service.tick();
      expect(f.send).toHaveBeenCalledTimes(2);
      expect(f.send.mock.calls[1]?.[0].title).toContain('Needs attention');
    },
  );
  it('resolves a removed or merged worktree even if the cycle still says awaiting merge', async () => {
    const f = await fixture();
    await f.service.tick();
    f.context.storage.execution.worktrees.markRemoved({
      workspaceId: f.workspaceId,
      worktreeId: f.worktreeId,
      occurredAt: f.now().toISOString(),
    });
    f.advance(30);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.status().records[0]?.state).toBe('resolved');
  });
  it('persists retry state, recovers a lease after a reopen, and sends only one overdue reminder', async () => {
    const f = await fixture();
    await f.service.tick();
    const record = f.context.storage.notifications.records(f.workspaceId)[0];
    if (!record) throw new Error('Missing record');
    f.context.storage.notifications.saveRecord({
      ...record,
      leaseToken: 'interrupted-claim',
      leaseUntil: new Date(f.now().getTime() + 4 * 3_600_000).toISOString(),
    });
    f.advance(200);
    const reopened = openDaemonStorage(f.context.storage.databasePath);
    const notifier = new WorkspaceEventNotifier();
    const restarted = new NotificationService(
      reopened,
      new WorkspaceService(reopened),
      notifier,
      { send: f.send },
      'https://craft.example',
      f.now,
    );
    try {
      await restarted.tick();
      expect(f.send).toHaveBeenCalledTimes(1);
      f.advance(50);
      await restarted.tick();
      await restarted.tick();
      expect(f.send).toHaveBeenCalledTimes(2);
      expect(reopened.notifications.records(f.workspaceId)[0]?.nextAttemptAt).toBe(
        '2026-09-10T20:00:00.000Z',
      );
    } finally {
      await restarted.shutdown();
      reopened.close();
    }
  });
  it('retries failures durably without consuming reminder stages or repeating every scan', async () => {
    const f = await fixture();
    f.send.mockResolvedValueOnce({ status: 'retry', reason: 'Temporary failure' });
    await f.service.tick();
    expect(f.status().records[0]?.deliveredCount).toBe(0);
    f.advance(0.4);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(0.1);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.status().records[0]?.nextAttemptAt).toBe('2026-09-10T15:30:30.000Z');
    f.advance(30);
    f.send.mockResolvedValueOnce({ status: 'retry', reason: 'Again' });
    await f.service.tick();
    f.setCycle('running');
    f.advance(1);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(3);
    expect(f.status().records[0]?.state).toBe('resolved');
  });
  it('blocks permanent rejections until settings or a test explicitly retries', async () => {
    const f = await fixture();
    f.send.mockResolvedValue({ status: 'blocked', reason: 'Credentials rejected' });
    await f.service.tick();
    f.advance(1440);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.service.save(f.auth, f.workspaceId, {
      preferences,
      expectedVersion: f.status().version,
      applicationToken: 'b'.repeat(30),
    });
    f.send.mockResolvedValue({ status: 'accepted' });
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.status().blockedReason).toBeNull();
  });
  it('shares provider cooldowns across attention occurrences', async () => {
    const f = await fixture();
    const retryAt = new Date(f.now().getTime() + 3600_000).toISOString();
    f.send.mockResolvedValueOnce({ status: 'retry', reason: 'Quota', retryAt });
    await f.service.tick();
    f.setCycle('needs-attention');
    f.advance(30);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(30);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('serializes concurrent ticks and does not persist stale attention after an in-flight delivery', async () => {
    const f = await fixture();
    let accept: ((value: DeliveryResult) => void) | undefined;
    f.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const one = f.service.tick();
    const two = f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.setCycle('running');
    accept?.({ status: 'accepted' });
    await Promise.all([one, two]);
    expect(f.status().records[0]?.state).toBe('resolved');
  });
  it('disabling prevents attention sends, while an explicit test works and has no reminders', async () => {
    const f = await fixture();
    f.service.save(f.auth, f.workspaceId, {
      preferences: { ...preferences, enabled: false },
      expectedVersion: f.status().version,
    });
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    f.service.test(f.auth, f.workspaceId);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.status().records.find((record) => record.kind === 'test')).toMatchObject({
      state: 'resolved',
      deliveredCount: 1,
    });
    expect(() => f.service.test(f.auth, f.workspaceId)).toThrow(/last minute/);
    f.advance(1440);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.service.save(f.auth, f.workspaceId, { preferences, expectedVersion: f.status().version });
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('checks owner authority again before background delivery', async () => {
    const f = await fixture();
    const database = openDatabase(f.context.storage.databasePath);
    try {
      database
        .prepare(
          "UPDATE workspace_memberships SET role = 'viewer' WHERE workspace_id = ? AND user_id = ?",
        )
        .run(f.workspaceId, f.auth.user.id);
    } finally {
      database.close();
    }
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('suppresses opted-out sources and resumes with one current alert when enabled', async () => {
    const f = await fixture();
    f.service.save(f.auth, f.workspaceId, {
      preferences: { ...preferences, mergeReady: false },
      expectedVersion: f.status().version,
    });
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    f.service.save(f.auth, f.workspaceId, { preferences, expectedVersion: f.status().version });
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.service.save(f.auth, f.workspaceId, {
      preferences: { ...preferences, mergeReady: false },
      expectedVersion: f.status().version,
    });
    f.advance(30);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('supports manual design questions, review readiness, and follow-up turns', async () => {
    const f = await fixture();
    f.setCycle('stopped');
    const runId = asAgentRunId('manual-run');
    f.context.storage.execution.runs.insert({
      id: runId,
      workspaceId: f.workspaceId,
      worktreeId: f.worktreeId,
      repositoryId: f.repositoryId,
      projectId: f.projectId,
      workItemId: f.workItemId,
      backend: 'claude-code',
      role: 'design',
      permissionMode: 'auto',
      brief: 'Fixture brief',
      createdAt: f.now().toISOString(),
      createdByUserId: f.auth.user.id,
    });
    f.context.storage.execution.runs.transition({
      workspaceId: f.workspaceId,
      runId,
      expectedStatuses: ['starting'],
      toStatus: 'waiting',
      occurredAt: f.now().toISOString(),
    });
    const turn = (resultText: string) =>
      f.context.storage.execution.runEvents.append({
        id: asAgentRunEventId(randomUUID()),
        workspaceId: f.workspaceId,
        runId,
        occurredAt: f.now().toISOString(),
        kind: 'turn-completed',
        payload: { outcome: 'success', resultText, turns: 1, durationMs: 1 },
      });
    turn('## Open questions\nWhich approach?');
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.context.storage.execution.runs.transition({
      workspaceId: f.workspaceId,
      runId,
      expectedStatuses: ['waiting'],
      toStatus: 'finished',
      occurredAt: f.now().toISOString(),
    });
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    turn('## Open questions\nnone');
    f.advance(30);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    const reviewId = asAgentRunId('review-run');
    f.context.storage.execution.runs.insert({
      id: reviewId,
      workspaceId: f.workspaceId,
      worktreeId: f.worktreeId,
      repositoryId: f.repositoryId,
      projectId: f.projectId,
      workItemId: f.workItemId,
      backend: 'claude-code',
      role: 'review',
      permissionMode: 'auto',
      brief: 'Fixture brief',
      reviewBranchContext: {
        headSha: 'a'.repeat(40),
        targetSha: 'b'.repeat(40),
        targetBranch: 'aq-cont-1',
        worktreeVersion: 1,
      },
      createdAt: f.now().toISOString(),
      createdByUserId: f.auth.user.id,
    });
    f.context.storage.execution.runEvents.append({
      id: asAgentRunEventId(randomUUID()),
      workspaceId: f.workspaceId,
      runId: reviewId,
      occurredAt: f.now().toISOString(),
      kind: 'turn-completed',
      payload: { outcome: 'success', resultText: 'VERDICT: mergeable', turns: 1, durationMs: 1 },
    });
    f.context.storage.execution.runs.transition({
      workspaceId: f.workspaceId,
      runId: reviewId,
      expectedStatuses: ['starting'],
      toStatus: 'finished',
      verdict: 'mergeable',
      occurredAt: f.now().toISOString(),
    });
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0].title).toContain('Ready for merge');
  });
});
it('preserves a provider cooldown after resolution during delivery and across database reopen', async () => {
  const f = await fixture();
  let finish: ((result: DeliveryResult) => void) | undefined;
  f.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const attempt = f.service.tick();
  f.setCycle('running');
  finish?.({ status: 'retry', reason: 'Quota reached', retryAt: '2026-09-10T16:00:00.000Z' });
  await attempt;
  expect(f.status().retryAt).toBe('2026-09-10T16:00:00.000Z');
  f.setCycle('needs-attention');
  const reopened = openDaemonStorage(f.context.storage.databasePath);
  const resumed = new NotificationService(
    reopened,
    new WorkspaceService(reopened),
    new WorkspaceEventNotifier(),
    { send: f.send },
    'https://craft.example',
    f.now,
  );
  try {
    f.advance(59);
    await resumed.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(1);
    await resumed.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
  } finally {
    await resumed.shutdown();
    reopened.close();
  }
});
it('aborts an in-flight delivery on shutdown and leaves the lease available for recovery', async () => {
  const f = await fixture();
  f.send.mockImplementationOnce(
    (_message, signal) =>
      new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ status: 'retry', reason: 'Aborted' }), {
          once: true,
        });
      }),
  );
  const attempt = f.service.tick();
  await f.service.shutdown();
  await attempt;
  const record = f.context.storage.notifications.records(f.workspaceId)[0];
  expect(record?.leaseToken).not.toBeNull();
  expect(record?.deliveredCount).toBe(0);
  const resumed = new NotificationService(
    f.context.storage,
    f.context.services.workspaceService,
    new WorkspaceEventNotifier(),
    { send: f.send },
    'https://craft.example',
    f.now,
  );
  try {
    await resumed.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(1);
    await resumed.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
  } finally {
    await resumed.shutdown();
  }
});
it('an old credential rejection cannot block newly saved credentials', async () => {
  const f = await fixture();
  let finish: ((result: DeliveryResult) => void) | undefined;
  f.send.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const attempt = f.service.tick();
  f.service.save(f.auth, f.workspaceId, {
    preferences,
    expectedVersion: f.status().version,
    applicationToken: 'b'.repeat(30),
  });
  finish?.({ status: 'blocked', reason: 'Old credentials rejected' });
  await attempt;
  expect(f.status().blockedReason).toBeNull();
  f.advance(1);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(f.send.mock.calls[1]?.[0].applicationToken).toBe('b'.repeat(30));
});

describe('notification routes and credentials', () => {
  it('requires authentication, owner membership, CSRF, and matching origin', async () => {
    const f = await fixture();
    const url = `/api/workspaces/${f.workspaceId}/notifications`;
    expect((await f.context.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(
      (
        await f.context.app.inject({
          method: 'POST',
          url,
          headers: { cookie: f.headers.cookie },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await f.context.app.inject({
          method: 'POST',
          url,
          headers: { ...f.headers, origin: 'https://evil.example' },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    const outsider = asUserId('viewer');
    f.context.storage.users.insert({
      id: outsider,
      username: 'viewer',
      usernameNormalized: 'viewer',
      passwordHash: '$argon2id$unused',
      occurredAt: f.now().toISOString(),
    });
    f.context.storage.workspaces.insertMembership({
      id: asWorkspaceMembershipId('viewer-membership'),
      workspaceId: f.workspaceId,
      userId: outsider,
      role: 'viewer',
      occurredAt: f.now().toISOString(),
    });
    const viewer = { ...f.auth, user: { ...f.auth.user, id: outsider } };
    expect(() => f.service.get(viewer, f.workspaceId)).toThrow();
    expect(() => f.service.test(viewer, f.workspaceId)).toThrow();
    expect(() => f.service.get(viewer, asWorkspaceId('unrelated'))).toThrow();
  });
  it('validates settings, prevents stale writes, preserves write-only keys, and keeps secrets out of journals and responses', async () => {
    const f = await fixture();
    const url = `/api/workspaces/${f.workspaceId}/notifications`;
    const read = await f.context.app.inject({ method: 'GET', url, headers: f.headers });
    expect(read.statusCode).toBe(200);
    expect(notificationStatusSchema.parse(read.json()).credentialsConfigured).toBe(true);
    expect(read.body).not.toContain(token);
    expect(read.body).not.toContain(key);
    const body = { preferences, expectedVersion: f.status().version };
    expect(
      (
        await f.context.app.inject({
          method: 'POST',
          url,
          headers: f.headers,
          payload: { ...body, applicationToken: 'bad' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await f.context.app.inject({
          method: 'POST',
          url,
          headers: f.headers,
          payload: { ...body, preferences: { ...preferences, timeZone: 'bad-zone' } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await f.context.app.inject({ method: 'POST', url, headers: f.headers, payload: body }))
        .statusCode,
    ).toBe(200);
    expect(
      (await f.context.app.inject({ method: 'POST', url, headers: f.headers, payload: body }))
        .statusCode,
    ).toBe(409);
    expect(f.context.storage.notifications.settings(f.workspaceId)?.applicationToken).toBe(token);
    const audit = f.context.storage.audit.listWorkspace({ workspaceId: f.workspaceId, limit: 100 });
    const events = f.context.storage.workspaceEvents.listAfter({
      workspaceId: f.workspaceId,
      after: 0,
      limit: 100,
    });
    expect(events.some((event) => event.kind === 'notifications-changed')).toBe(true);
    expect(JSON.stringify({ audit, events })).not.toContain(token);
    expect(JSON.stringify({ audit, events })).not.toContain(key);
    const test = await f.context.app.inject({
      method: 'POST',
      url: `${url}/test`,
      headers: f.headers,
      payload: {},
    });
    expect(test.statusCode).toBe(200);
    await f.service.tick();
    f.service.save(f.auth, f.workspaceId, {
      preferences: { ...preferences, enabled: false },
      expectedVersion: f.status().version,
      clearCredentials: true,
    });
    expect(f.status().credentialsConfigured).toBe(false);
    expect(f.context.storage.notifications.settings(f.workspaceId)?.userKey).toBeNull();
    expect(() =>
      f.service.save(f.auth, f.workspaceId, { preferences, expectedVersion: f.status().version }),
    ).toThrow(/credentials/);
  });
});

it('repeats roadmap preparation alerts and resolves on pause', async () => {
  const f = await fixture();
  await f.context.services.roadmapService.shutdown();
  f.setCycle('paused');
  const id = randomUUID();
  const roadmap: import('@craftingtable/domain').Roadmap = {
    id,
    workspaceId: f.workspaceId,
    version: 1,
    status: 'needs-attention',
    attention: roadmapAttention('scheduler-error'),
    reason: 'Worktree preparation failed. Inspect the repository.',
    createdAt: f.now().toISOString(),
    updatedAt: f.now().toISOString(),
    createdByUserId: f.auth.user.id,
    delegatedByUserId: f.auth.user.id,
    attempts: [],
    definition: {
      roadmapId: id,
      revision: 1,
      name: 'AQ sequence',
      entries: [],
      createdAt: f.now().toISOString(),
      createdByUserId: f.auth.user.id,
    },
  };
  f.context.storage.roadmaps.save(roadmap, 0);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]?.[0]).toMatchObject({
    title: 'AQ sequence · Roadmap needs attention',
    url: `https://craft.example/workspaces/${f.workspaceId}/roadmaps`,
  });
  f.advance(30);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(2);
  f.context.storage.roadmaps.save({ ...roadmap, status: 'paused', version: 2 }, 1);
  f.advance(60);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(
    f.context.storage.notifications
      .records(f.workspaceId)
      .filter((r) => r.sourceKey.startsWith('roadmap:'))
      .every((r) => r.state === 'resolved'),
  ).toBe(true);
});

it('retains parallel item reminder timing while siblings progress and resolves an item hold on pause', async () => {
  const f = await fixture();
  await f.context.services.roadmapService.shutdown();
  f.setCycle('paused');
  const id = randomUUID();
  const entryId = randomUUID();
  const cycle = f.context.storage.execution.cycles.listForWorkspace(f.workspaceId)[0];
  if (!cycle) throw new Error('Missing fixture cycle');
  const roadmap: import('@craftingtable/domain').Roadmap = {
    id,
    workspaceId: f.workspaceId,
    version: 1,
    status: 'running',
    reason: 'Parallel scheduling enabled.',
    createdAt: f.now().toISOString(),
    updatedAt: f.now().toISOString(),
    createdByUserId: f.auth.user.id,
    delegatedByUserId: f.auth.user.id,
    attempts: [],
    entryHolds: {
      [entryId]: {
        status: 'needs-attention',
        reason: 'Cannot prepare worktree.',
        attention: roadmapAttention('entry-preparation-failed', { entryId }),
      },
    },
    definition: {
      roadmapId: id,
      revision: 1,
      name: 'Parallel queue',
      scheduling: {
        mode: 'parallel',
        maxInFlight: 2,
        maxPerRepository: 2,
        maxIntegrationRefreshes: 3,
      },
      entries: [
        {
          id: entryId,
          workItemId: f.workItemId,
          projectId: f.projectId,
          planVersionId: asPlanVersionId('plan-1'),
          sourceId: 'AQ-05',
          title: 'Next queue improvement',
          repositoryId: f.repositoryId,
          integrationBranch: 'aq-cont-1',
          profiles: cycle.profiles,
          policy: cycle.policy,
          instructions: '',
        },
      ],
      createdAt: f.now().toISOString(),
      createdByUserId: f.auth.user.id,
    },
  };
  f.context.storage.roadmaps.save(roadmap, 0);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]?.[0].title).toContain('AQ-05');
  f.context.storage.roadmaps.save(
    { ...roadmap, version: 2, reason: 'A sibling is now running.' },
    1,
  );
  f.advance(29);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(1);
  f.advance(1);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(2);
  f.context.storage.roadmaps.save(
    {
      ...roadmap,
      version: 3,
      entryHolds: { [entryId]: { status: 'paused', reason: 'Operator paused this item.' } },
    },
    2,
  );
  f.advance(60);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(
    f.context.storage.notifications
      .records(f.workspaceId)
      .filter((r) => r.sourceKey.startsWith('roadmap:'))
      .every((r) => r.state === 'resolved'),
  ).toBe(true);
  // A resumed manual cycle supersedes this old preparation alert while work is in flight.
  f.setCycle('running');
  f.context.storage.roadmaps.save(
    {
      ...roadmap,
      version: 4,
      attempts: [
        {
          id: randomUUID(),
          entryId,
          definitionRevision: 1,
          cycleId: cycle.id,
          worktreeId: f.worktreeId,
          status: 'active',
          createdAt: f.now().toISOString(),
        },
      ],
    },
    3,
  );
  f.advance(60);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(
    f.context.storage.notifications
      .records(f.workspaceId)
      .filter((r) => r.sourceKey.startsWith('roadmap:'))
      .every((r) => r.state === 'resolved'),
  ).toBe(true);
});

describe('notification noise controls (R-A1, R-A2)', () => {
  const pages = (send: ReturnType<typeof vi.fn>) =>
    send.mock.calls.filter(
      (call) => !(call[0] as NotificationMessage).message.startsWith('Reminder:'),
    );
  it('never sends attention that automation takes over inside the settle window', async () => {
    const f = await fixture(undefined, {});
    f.setCycle('running');
    f.setCycle('needs-attention', { reason: 'Open questions need a reassessment.' });
    await f.service.tick();
    expect(f.context.storage.notifications.records(f.workspaceId)).toHaveLength(1);
    f.advance(NOTIFICATION_SETTLE_MS / 60_000 / 2);
    await f.service.tick();
    f.setCycle('running'); // The controller's own reassessment starts.
    await f.service.tick();
    f.advance(60);
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.context.storage.notifications.records(f.workspaceId)[0]).toMatchObject({
      state: 'resolved',
      deliveredCount: 0,
    });
    // A stop that persists through the window is sent exactly once, after it settles.
    f.setCycle('needs-attention', { reason: 'Reassessment still needs the operator.' });
    await f.service.tick();
    f.advance(NOTIFICATION_SETTLE_MS / 60_000 - 1 / 60);
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    f.advance(1 / 60);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('keeps one occurrence and its reminder schedule across version bumps with the same blocker', async () => {
    const f = await fixture(undefined, {});
    f.setCycle('needs-attention', { reason: 'Scope review requires recovery: 1 major.' });
    await f.service.tick();
    f.advance(1);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      f.advance(1);
      f.setCycle('needs-attention', { reason: `Scope review requires recovery (round ${i}).` });
      await f.service.tick();
    }
    expect(f.send).toHaveBeenCalledTimes(1);
    const records = f.context.storage.notifications.records(f.workspaceId);
    expect(records).toHaveLength(1);
    expect(records[0]?.sourceKey).toBe(`cycle:${f.cycle().id}:needs-attention`);
    expect(records[0]?.message).toContain('round 4');
    // Reminders stay anchored to the first push (at +1 min) and carry the current wording.
    f.advance(24.5);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(0.5);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0].message).toMatch(/^Reminder:.*round 4/s);
  });
  it('reopens a flapping occurrence without a new page or a restarted reminder schedule', async () => {
    const f = await fixture(undefined, {});
    f.setCycle('needs-attention');
    await f.service.tick();
    f.advance(1);
    await f.service.tick();
    const first = f.context.storage.notifications.records(f.workspaceId)[0]!;
    expect(f.send).toHaveBeenCalledTimes(1);
    f.setCycle('running');
    await f.service.tick();
    f.advance(5);
    f.setCycle('needs-attention');
    await f.service.tick();
    f.advance(5);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.context.storage.notifications.records(f.workspaceId)[0]).toMatchObject({
      id: first.id,
      state: 'active',
      firstSentAt: first.firstSentAt,
      nextAttemptAt: first.nextAttemptAt,
    });
    // Outside the flap window a reopened stop is a new occurrence and pages again.
    f.setCycle('running');
    await f.service.tick();
    f.advance(15);
    f.setCycle('needs-attention');
    await f.service.tick();
    f.advance(1);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0].message).not.toMatch(/^Reminder:/);
  });
  it('sends at most one storage page while a volume flaps around its reserve', async () => {
    const gate = new StorageAlertGate();
    const reserve = 5 * GiB;
    let free = [4 * GiB, 20 * GiB];
    let clock = () => new Date();
    const f = await fixture(undefined, {}, () =>
      gate.evaluate(
        [
          { label: 'Future run files', path: '/runs', freeBytes: free[0] ?? null },
          { label: 'Future worktrees', path: '/trees', freeBytes: free[1] ?? null },
        ],
        reserve,
        clock().getTime(),
      ),
    );
    clock = f.now;
    f.setCycle('running');
    const storage = () =>
      f.context.storage.notifications
        .records(f.workspaceId)
        .filter((r) => r.sourceKey.startsWith('storage:'));
    // 45 minutes of oscillation every 15 s, including brief recoveries well above the margin.
    for (let i = 0; i < 180; i++) {
      free = [i % 2 ? 4.9 * GiB : i % 3 ? 5.1 * GiB : 12 * GiB, 20 * GiB];
      await f.service.tick();
      f.advance(0.25);
    }
    expect(pages(f.send)).toHaveLength(1);
    expect(storage()).toHaveLength(1);
    expect(storage()[0]?.state).toBe('active');
    // A second volume joining is new work: the coalesced alert pages once more.
    free = [4 * GiB, 4 * GiB];
    await f.service.tick();
    f.advance(1);
    await f.service.tick();
    expect(pages(f.send)).toHaveLength(2);
    expect(f.send.mock.lastCall?.[0].message).toContain('Future worktrees');
    expect(storage()).toHaveLength(1);
    // Clearing needs the free space to stay above the margin for the whole hold period.
    free = [20 * GiB, 20 * GiB];
    await f.service.tick();
    f.advance(STORAGE_ALERT_CLEAR_HOLD_MS / 60_000 - 1);
    await f.service.tick();
    expect(storage()[0]?.state).toBe('active');
    f.advance(1);
    await f.service.tick();
    expect(storage()[0]?.state).toBe('resolved');
    expect(pages(f.send)).toHaveLength(2);
  });
  it('journals no workspace event and wakes no stream for delivery bookkeeping', async () => {
    const f = await fixture();
    const notifier = f.context.services.workspaceEventNotifier;
    const events = () =>
      f.context.storage.workspaceEvents
        .listAfter({ workspaceId: f.workspaceId, after: 0, limit: 1000 })
        .filter((event) => event.kind === 'notifications-changed');
    await f.service.tick(); // The attention occurrence opens: one event, then the first push.
    expect(f.send).toHaveBeenCalledTimes(1);
    const before = events().length;
    const generation = notifier.generation;
    f.advance(30);
    await f.service.tick(); // Reminder.
    f.send.mockResolvedValueOnce({ status: 'retry', reason: 'Network error' });
    f.advance(30);
    await f.service.tick(); // Failed reminder.
    f.advance(5);
    await f.service.tick(); // Retried reminder.
    expect(f.send).toHaveBeenCalledTimes(4);
    expect(events()).toHaveLength(before);
    expect(notifier.generation).toBe(generation);
    // Each accepted push stays attributable in the audit log.
    const deliveries = f.context.storage.audit
      .listWorkspace({ workspaceId: f.workspaceId, limit: 100 })
      .filter((row) => row.action === 'notifications.updated')
      .map((row) => row.metadata)
      .filter((metadata) => metadata.action === 'delivery');
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((m) => m.sourceKey === `cycle:${f.cycle().id}:awaiting-merge`)).toBe(
      true,
    );
    // Resolution changes the attention set, so it is journaled.
    f.setCycle('running');
    await f.service.tick();
    expect(events()).toHaveLength(before + 1);
  });
  it('backs off a transport error per record without holding other alerts', async () => {
    const f = await fixture();
    f.send.mockResolvedValueOnce({ status: 'retry', reason: 'Network error' });
    await f.service.tick();
    expect(f.status().retryAt).toBeNull();
    await f.context.services.roadmapService.shutdown();
    const id = randomUUID();
    f.context.storage.roadmaps.save(
      {
        id,
        workspaceId: f.workspaceId,
        version: 1,
        status: 'needs-attention',
        attention: roadmapAttention('scheduler-error'),
        reason: 'Worktree preparation failed.',
        createdAt: f.now().toISOString(),
        updatedAt: f.now().toISOString(),
        createdByUserId: f.auth.user.id,
        delegatedByUserId: f.auth.user.id,
        attempts: [],
        definition: {
          roadmapId: id,
          revision: 1,
          name: 'AQ sequence',
          entries: [],
          createdAt: f.now().toISOString(),
          createdByUserId: f.auth.user.id,
        },
      },
      0,
    );
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0].title).toBe('AQ sequence · Roadmap needs attention');
  });
  it('honours a delegation grant that makes integration merge manual', async () => {
    const f = await fixture();
    await f.context.services.roadmapService.shutdown();
    const cycle = f.cycle();
    const id = randomUUID();
    const entryId = randomUUID();
    const definition: RoadmapDefinition = {
      roadmapId: id,
      revision: 1,
      name: 'AQ sequence',
      automation: { integrationMerge: 'automatic', integrationConflicts: 'manual' },
      entries: [
        {
          id: entryId,
          workItemId: f.workItemId,
          projectId: f.projectId,
          planVersionId: asPlanVersionId('plan-1'),
          sourceId: 'AQ-05',
          title: 'Next queue improvement',
          repositoryId: f.repositoryId,
          integrationBranch: 'aq-cont-1',
          profiles: cycle.profiles,
          policy: cycle.policy,
          instructions: '',
        },
      ],
      createdAt: f.now().toISOString(),
      createdByUserId: f.auth.user.id,
    };
    const roadmap: Roadmap = {
      id,
      workspaceId: f.workspaceId,
      version: 1,
      status: 'running',
      reason: 'Running.',
      createdAt: f.now().toISOString(),
      updatedAt: f.now().toISOString(),
      createdByUserId: f.auth.user.id,
      delegatedByUserId: f.auth.user.id,
      attempts: [
        {
          id: randomUUID(),
          entryId,
          definitionRevision: 1,
          cycleId: cycle.id,
          worktreeId: f.worktreeId,
          status: 'active',
          createdAt: f.now().toISOString(),
        },
      ],
      definition,
    };
    f.context.storage.roadmaps.save(roadmap, 0);
    f.context.storage.roadmaps.addDefinition(definition);
    // The controller declares who owns the stop; notifications only read it (R-A3).
    const controllerSees = async () => f.context.services.workCycleService.declareAttention();
    await controllerSees();
    expect(
      f.context.storage.execution.cycles.find(f.workspaceId, f.cycle().id)?.attention,
    ).toMatchObject({ code: 'merge-approval', owner: 'controller', claim: 'roadmap-merge' });
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled(); // The roadmap merges this item itself.
    f.context.storage.roadmaps.save(
      {
        ...roadmap,
        version: 2,
        delegationAssignments: [
          {
            id: randomUUID(),
            entryIds: [entryId],
            automation: { integrationMerge: 'manual', integrationConflicts: 'manual' },
            reviewerRoles: [],
            rationale: 'Operator approves this merge.',
            appliedAt: f.now().toISOString(),
            appliedByUserId: f.auth.user.id,
          },
        ],
      },
      1,
    );
    await controllerSees();
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0].title).toBe('ActionQueue · AQ-05 · Ready for merge');
  });
  it('coalesces restart-stopped work into one message per boot', async () => {
    const f = await fixture();
    await f.context.services.roadmapService.shutdown();
    const id = randomUUID();
    const roadmap: Roadmap = {
      id,
      workspaceId: f.workspaceId,
      version: 1,
      status: 'needs-attention',
      attention: roadmapAttention('restart-resume'),
      reason: 'Daemon restarted.',
      createdAt: f.now().toISOString(),
      updatedAt: f.now().toISOString(),
      createdByUserId: f.auth.user.id,
      delegatedByUserId: f.auth.user.id,
      attempts: [],
      definition: {
        roadmapId: id,
        revision: 1,
        name: 'AQ sequence',
        entries: [],
        createdAt: f.now().toISOString(),
        createdByUserId: f.auth.user.id,
      },
    };
    f.context.storage.roadmaps.save(roadmap, 0);
    f.setCycle('needs-attention', { reason: 'Daemon restarted.' });
    const booted = new NotificationService(
      f.context.storage,
      f.context.services.workspaceService,
      f.context.services.workspaceEventNotifier,
      { send: f.send },
      'https://craft.example',
      f.now,
      undefined,
      undefined,
      { settleMs: 0, restartedAtBoot: { cycleIds: [f.cycle().id], roadmapIds: [id] } },
    );
    try {
      await booted.tick();
      await booted.tick();
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(f.send.mock.calls[0]?.[0]).toMatchObject({
        title: 'CraftingTable · Resume after restart',
        url: `https://craft.example/workspaces/${f.workspaceId}/roadmaps`,
      });
      expect(f.send.mock.calls[0]?.[0].message).toContain('1 roadmap and 1 work cycle');
      // Resuming one item shrinks the message silently.
      f.context.storage.roadmaps.save({ ...roadmap, status: 'running', version: 2 }, 1);
      await booted.tick();
      expect(f.send).toHaveBeenCalledTimes(1);
      const digest = () =>
        f.context.storage.notifications
          .records(f.workspaceId)
          .find((r) => r.sourceKey.startsWith('restart:'));
      expect(digest()?.message).not.toContain('AQ sequence');
      f.setCycle('running');
      await booted.tick();
      expect(digest()?.state).toBe('resolved');
      // A later stop is a genuine, individual alert again.
      f.setCycle('needs-attention', { reason: 'Review found blocking issues.' });
      await booted.tick();
      expect(f.send).toHaveBeenCalledTimes(2);
      expect(f.send.mock.calls[1]?.[0].title).toBe('ActionQueue · AQ-05 · Needs attention');
    } finally {
      await booted.shutdown();
    }
  });
});
