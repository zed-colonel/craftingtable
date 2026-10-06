import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { attentionFeedSchema, notificationStatusSchema } from '@craftingtable/contracts';
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
  type Finalization,
  type Roadmap,
  type RoadmapDefinition,
  roadmapAttention,
  type WorkCycle,
} from '@craftingtable/domain';
import { openDatabase } from '@craftingtable/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDaemonStorage } from '../src/persisted-records.js';
import { CredentialFile } from '../src/security/credential-file.js';
import { ControllerPasses, OperatorPresence } from '../src/services/attention-gates.js';
import {
  NOTIFICATION_SETTLE_MS,
  NotificationService,
  type NotificationServiceOptions,
  PRESENCE_GRACE_MS,
} from '../src/services/notification-service.js';
import type {
  DeliveryResult,
  NotificationMessage,
} from '../src/services/notification-transport.js';
import { STORAGE_ALERT_CLEAR_HOLD_MS, StorageAlertGate } from '../src/services/storage-alerts.js';
import { GiB } from '../src/services/storage-files.js';
import { WorkspaceEventNotifier } from '../src/services/workspace-event-notifier.js';
import { WorkspaceService } from '../src/services/workspace-service.js';
import { createTestContext, type TestContext } from './test-support.js';

const contexts: TestContext[] = [];
afterEach(async () => {
  for (const context of contexts.splice(0)) await context.cleanup();
});
const token = 'a'.repeat(30);
const key = 'u'.repeat(30);
const preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, enabled: true };
// Most scenarios exercise scheduling and leases; they opt out of the settle delay and the
// presence grace, which have their own tests below. No controller worker runs, so the
// quiescence gate is open unless a test registers one.
const scheduling: NotificationServiceOptions = {
  settleMs: 0,
  presenceGraceMs: 0,
  presenceWindowMs: 0,
};
async function fixture(
  cycleTransitioning: (id: string) => boolean = () => false,
  options: NotificationServiceOptions = scheduling,
) {
  let time = Date.parse('2026-09-10T15:00:00Z');
  const now = () => new Date(time);
  const context = await createTestContext({ now, workers: false });
  contexts.push(context);
  await context.bootstrap();
  const login = await context.login();
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
    context.services.attention,
    context.services.controllerPasses,
    context.services.operatorPresence,
    now,
    cycleTransitioning,
    // The test daemon's own credentials file, which its routes read too (R-G9).
    { credentials: new CredentialFile(context.config.configDir), ...options },
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
    /** Every attention occurrence, newest activity first. */
    items: () => {
      context.services.attention.flush();
      return context.storage.attention.recent(workspaceId, 1000);
    },
    /** One scheduler pass's derived attention (holds, checkpoints, verification setup). */
    schedulerPass: () => {
      context.services.attention.flush();
      context.services.roadmapService.syncAttention(true);
    },
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
type Fixture = Awaited<ReturnType<typeof fixture>>;
const cycleItems = (f: Fixture) =>
  f.items().filter((item) => item.subjectKey === `cycle:${f.cycle().id}`);
const openItems = (f: Fixture) => f.items().filter((item) => item.state === 'open');
/** A service over another handle on the same database, as after a daemon restart. */
function restartedService(
  storage: ReturnType<typeof openDaemonStorage>,
  f: Fixture,
  options: NotificationServiceOptions = scheduling,
) {
  return new NotificationService(
    storage,
    new WorkspaceService(storage),
    new WorkspaceEventNotifier(),
    { send: f.send },
    'https://craft.example',
    { flush: () => undefined, openedPass: () => 0 },
    new ControllerPasses(),
    new OperatorPresence(),
    f.now,
    undefined,
    { credentials: new CredentialFile(f.context.config.configDir), ...options },
  );
}
function roadmapFixture(f: Fixture, changes: Partial<Roadmap> = {}): Roadmap {
  const id = randomUUID();
  return {
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
    ...changes,
  };
}
describe('persistent notifications', () => {
  it('holds sends during recovery preparation without resetting reminders after a failed command', async () => {
    let transitioning = false;
    const f = await fixture(() => transitioning);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    const [first] = cycleItems(f);
    const generation = f.context.services.workspaceEventNotifier.workflowGeneration;
    transitioning = true;
    f.advance(30);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(cycleItems(f)[0]).toMatchObject({
      id: first?.id,
      state: 'open',
      delivery: { firstSentAt: first?.delivery.firstSentAt, deliveredCount: 1 },
    });
    transitioning = false; // Preparation failed; the original incident is still actionable.
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0].message).toMatch(/^Reminder:/);
    expect(f.context.services.workspaceEventNotifier.workflowGeneration).toBe(generation);
    f.setCycle('running');
    await f.service.tick();
    expect(cycleItems(f)[0]?.state).toBe('resolved');
  });
  it('lists a stop already being recovered, but pushes it only once the recovery fails', async () => {
    let transitioning = true;
    const f = await fixture(() => transitioning);
    f.setCycle('needs-attention');
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    expect(openItems(f)).toHaveLength(1);
    transitioning = false;
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('sends the agreed schedule once per phase with project, branches, reason, and private HTTPS link', async () => {
    const f = await fixture();
    await f.service.tick();
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    // The push opens the item in the inbox, which hosts the work item's own controls (R-A5).
    expect(f.send.mock.calls[0]?.[0]).toMatchObject({
      title: 'ActionQueue · AQ-05 · Ready for merge',
      url: `https://craft.example/workspaces/${f.workspaceId}/inbox/${cycleItems(f)[0]?.id}`,
    });
    expect(cycleItems(f)[0]?.path).toBe(`/workspaces/${f.workspaceId}/work-items/item-1`);
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
    const [item] = cycleItems(f);
    if (!item) throw new Error('Missing item');
    f.context.storage.attention.update({
      ...item,
      delivery: {
        ...item.delivery,
        leaseToken: 'interrupted-claim',
        leaseUntil: new Date(f.now().getTime() + 4 * 3_600_000).toISOString(),
      },
    });
    f.advance(200);
    const reopened = openDaemonStorage(f.context.storage.databasePath);
    const restarted = restartedService(reopened, f);
    try {
      await restarted.tick();
      expect(f.send).toHaveBeenCalledTimes(1);
      f.advance(50);
      await restarted.tick();
      await restarted.tick();
      expect(f.send).toHaveBeenCalledTimes(2);
      expect(reopened.attention.find(f.workspaceId, item.id)?.delivery.nextAttemptAt).toBe(
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
  it('serializes concurrent ticks and keeps the push of an item that resolved in flight', async () => {
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
    const [item] = cycleItems(f);
    expect(item?.state).toBe('resolved');
    // The resolved item is history; the delivery log still records that it was pushed.
    expect(f.context.storage.attention.deliveries(f.workspaceId, 10)).toMatchObject([
      { itemIds: [item?.id], result: 'accepted' },
    ]);
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
    expect(openItems(f)).toMatchObject([
      { subjectKey: `run:${runId}`, code: 'manual-design-questions' },
    ]);
    f.context.storage.execution.runs.transition({
      workspaceId: f.workspaceId,
      runId,
      expectedStatuses: ['waiting'],
      toStatus: 'finished',
      occurredAt: f.now().toISOString(),
    });
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    // A follow-up turn that answers the questions clears the item by itself.
    turn('## Open questions\nnone');
    f.advance(30);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(openItems(f)).toHaveLength(0);
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
    expect(openItems(f)).toMatchObject([
      { subjectKey: `run:${reviewId}`, code: 'manual-review-mergeable', kind: 'merge' },
    ]);
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
  f.context.services.attention.flush();
  const reopened = openDaemonStorage(f.context.storage.databasePath);
  const resumed = restartedService(reopened, f);
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
  const [item] = cycleItems(f);
  expect(item?.delivery.leaseToken).not.toBeNull();
  expect(item?.delivery.deliveredCount).toBe(0);
  const resumed = restartedService(f.context.storage, f);
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
  it('moves credentials stored in the database into the credentials file at start (R-G9)', async () => {
    const f = await fixture();
    const file = new CredentialFile(f.context.config.configDir);
    const stored = f.context.storage.notifications.settings(f.workspaceId)!;
    file.setPushover(f.workspaceId, undefined);
    // As a daemon before R-G9 kept them.
    f.context.storage.transaction((tx) =>
      tx.notifications.saveSettings({ ...stored, applicationToken: token, userKey: key }),
    );
    expect(f.service.adoptStoredCredentials()).toBe(1);
    expect(file.pushover(f.workspaceId)).toEqual({ applicationToken: token, userKey: key });
    expect(f.context.storage.notifications.settings(f.workspaceId)).toEqual(stored);
    expect(f.status().credentialsConfigured).toBe(true);
    // Nothing left to move; a file entry already there wins over the database's.
    expect(f.service.adoptStoredCredentials()).toBe(0);
    f.context.storage.transaction((tx) =>
      tx.notifications.saveSettings({ ...stored, applicationToken: 'old', userKey: 'old' }),
    );
    f.service.adoptStoredCredentials();
    expect(file.pushover(f.workspaceId)?.applicationToken).toBe(token);
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
    // The credentials are kept in the credentials file, never in the database (R-G9).
    expect(f.context.storage.notifications.settings(f.workspaceId)).toMatchObject({
      applicationToken: null,
      userKey: null,
    });
    expect(new CredentialFile(f.context.config.configDir).pushover(f.workspaceId)).toEqual({
      applicationToken: token,
      userKey: key,
    });
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
    expect(JSON.stringify(f.context.storage.attention.deliveries(f.workspaceId, 10))).not.toContain(
      token,
    );
    // A save refused for clearing the credentials of enabled notifications leaves them be.
    expect(() =>
      f.service.save(f.auth, f.workspaceId, {
        preferences: { ...preferences, enabled: true },
        expectedVersion: f.status().version,
        clearCredentials: true,
      }),
    ).toThrow(/credentials/);
    expect(f.status().credentialsConfigured).toBe(true);
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
  f.setCycle('paused');
  const roadmap = roadmapFixture(f);
  f.context.storage.roadmaps.save(roadmap, 0);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]?.[0]).toMatchObject({
    title: 'AQ sequence · Roadmap needs attention',
    url: expect.stringMatching(`^https://craft.example/workspaces/${f.workspaceId}/inbox/`),
  });
  f.advance(30);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(2);
  f.context.storage.roadmaps.save({ ...roadmap, status: 'paused', version: 2 }, 1);
  f.advance(60);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(
    f
      .items()
      .filter((item) => item.subjectKey.startsWith('roadmap:'))
      .every((item) => item.state === 'resolved'),
  ).toBe(true);
});

it('retains parallel item reminder timing while siblings progress and resolves an item hold on pause', async () => {
  const f = await fixture();
  f.setCycle('paused');
  const entryId = randomUUID();
  const cycle = f.context.storage.execution.cycles.listForWorkspace(f.workspaceId)[0];
  if (!cycle) throw new Error('Missing fixture cycle');
  const base = roadmapFixture(f);
  const roadmap: Roadmap = {
    ...base,
    status: 'running',
    attention: undefined,
    reason: 'Parallel scheduling enabled.',
    entryHolds: {
      [entryId]: {
        status: 'needs-attention',
        reason: 'Cannot prepare worktree.',
        attention: roadmapAttention('entry-preparation-failed', { entryId }),
      },
    },
    definition: {
      ...base.definition,
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
    },
  };
  const { attention: _none, ...running } = roadmap;
  f.context.storage.roadmaps.save(running, 0);
  f.schedulerPass();
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.send.mock.calls[0]?.[0].title).toContain('AQ-05');
  f.context.storage.roadmaps.save(
    { ...running, version: 2, reason: 'A sibling is now running.' },
    1,
  );
  f.schedulerPass();
  f.advance(29);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(1);
  f.advance(1);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(2);
  f.context.storage.roadmaps.save(
    {
      ...running,
      version: 3,
      entryHolds: { [entryId]: { status: 'paused', reason: 'Operator paused this item.' } },
    },
    2,
  );
  f.schedulerPass();
  f.advance(60);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(2);
  const roadmapItems = () => f.items().filter((item) => item.subjectKey.startsWith('roadmap:'));
  expect(roadmapItems().every((item) => item.state === 'resolved')).toBe(true);
  // A resumed manual cycle supersedes this old preparation alert while work is in flight.
  f.setCycle('running');
  f.context.storage.roadmaps.save(
    {
      ...running,
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
  f.schedulerPass();
  f.advance(60);
  await f.service.tick();
  expect(f.send).toHaveBeenCalledTimes(2);
  expect(roadmapItems().every((item) => item.state === 'resolved')).toBe(true);
});

describe('notification noise controls (R-A1, R-A2)', () => {
  const pages = (send: ReturnType<typeof vi.fn>) =>
    send.mock.calls.filter(
      (call) => !(call[0] as NotificationMessage).message.startsWith('Reminder:'),
    );
  const settling: NotificationServiceOptions = { presenceGraceMs: 0, presenceWindowMs: 0 };
  it('never sends attention that automation takes over inside the settle window', async () => {
    const f = await fixture(undefined, settling);
    f.setCycle('running');
    f.setCycle('needs-attention', { reason: 'Open questions need a reassessment.' });
    await f.service.tick();
    expect(openItems(f)).toHaveLength(1);
    f.advance(NOTIFICATION_SETTLE_MS / 60_000 / 2);
    await f.service.tick();
    f.setCycle('running'); // The controller's own reassessment starts.
    await f.service.tick();
    f.advance(60);
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    expect(openItems(f)).toHaveLength(0);
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
    const f = await fixture(undefined, settling);
    const recovery = cycleAttention('scope-review-recovery');
    f.setCycle('needs-attention', {
      reason: 'Scope review requires recovery: 1 major.',
      attention: recovery,
    });
    await f.service.tick();
    f.advance(1);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      f.advance(1);
      f.setCycle('needs-attention', {
        reason: `Scope review requires recovery (round ${i}).`,
        attention: recovery,
      });
      await f.service.tick();
    }
    expect(f.send).toHaveBeenCalledTimes(1);
    const occurrences = cycleItems(f).filter((item) => item.code === 'scope-review-recovery');
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]?.message).toContain('round 4');
    // Reminders stay anchored to the first push (at +1 min) and carry the current wording.
    f.advance(24.5);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(0.5);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0].message).toMatch(/^Reminder:.*round 4/s);
  });
  it('continues a flapping occurrence without a new page or a restarted reminder schedule', async () => {
    const f = await fixture(undefined, settling);
    f.setCycle('needs-attention');
    await f.service.tick();
    f.advance(1);
    await f.service.tick();
    const [first] = cycleItems(f).filter((item) => item.state === 'open');
    expect(f.send).toHaveBeenCalledTimes(1);
    f.setCycle('running');
    await f.service.tick();
    f.advance(5);
    f.setCycle('needs-attention');
    await f.service.tick();
    f.advance(5);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    // History is kept: the first occurrence stays resolved, and a new one continues it.
    const reopened = cycleItems(f).find((item) => item.state === 'open');
    expect(reopened).toMatchObject({
      continues: first?.id,
      delivery: {
        firstSentAt: first?.delivery.firstSentAt,
        nextAttemptAt: first?.delivery.nextAttemptAt,
      },
    });
    expect(reopened?.id).not.toBe(first?.id);
    expect(f.context.storage.attention.find(f.workspaceId, first!.id)?.state).toBe('resolved');
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
    const f = await fixture(undefined, settling);
    const monitor = () =>
      f.context.services.storageService.syncAttention(
        gate.evaluate(
          [
            { label: 'Future run files', path: '/runs', freeBytes: free[0] ?? null },
            { label: 'Future worktrees', path: '/trees', freeBytes: free[1] ?? null },
          ],
          reserve,
          f.now().getTime(),
        ),
      );
    f.setCycle('running');
    const storage = () => f.items().filter((item) => item.subjectKey.startsWith('storage:'));
    // 45 minutes of oscillation every 15 s, including brief recoveries well above the margin.
    for (let i = 0; i < 180; i++) {
      free = [i % 2 ? 4.9 * GiB : i % 3 ? 5.1 * GiB : 12 * GiB, 20 * GiB];
      monitor();
      await f.service.tick();
      f.advance(0.25);
    }
    expect(pages(f.send)).toHaveLength(1);
    expect(storage()).toHaveLength(1);
    expect(storage()[0]).toMatchObject({ state: 'open', code: 'storage-pressure' });
    // A second volume joining is new work: the coalesced alert pages once more.
    free = [4 * GiB, 4 * GiB];
    monitor();
    await f.service.tick();
    f.advance(1);
    await f.service.tick();
    expect(pages(f.send)).toHaveLength(2);
    expect(f.send.mock.lastCall?.[0].message).toContain('Future worktrees');
    expect(storage()).toHaveLength(1);
    // Clearing needs the free space to stay above the margin for the whole hold period.
    free = [20 * GiB, 20 * GiB];
    monitor();
    await f.service.tick();
    f.advance(STORAGE_ALERT_CLEAR_HOLD_MS / 60_000 - 1);
    monitor();
    await f.service.tick();
    expect(storage()[0]?.state).toBe('open');
    f.advance(1);
    monitor();
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
        .filter((event) => ['notifications-changed', 'attention-changed'].includes(event.kind));
    await f.service.tick(); // The item is already open; this is its first push.
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
    // Each accepted push stays attributable in the audit log, and every attempt in the log.
    const [item] = cycleItems(f);
    const deliveries = f.context.storage.audit
      .listWorkspace({ workspaceId: f.workspaceId, limit: 100 })
      .filter((row) => row.action === 'notifications.updated')
      .map((row) => row.metadata)
      .filter((metadata) => metadata.action === 'delivery');
    expect(deliveries).toHaveLength(3);
    expect(deliveries.every((m) => m.items === item?.id)).toBe(true);
    expect(f.context.storage.attention.deliveries(f.workspaceId, 10).map((d) => d.result)).toEqual([
      'accepted',
      'retry',
      'accepted',
      'accepted',
    ]);
    // Resolution changes the attention set, so it is journaled, with the open count.
    f.setCycle('running');
    await f.service.tick();
    expect(events()).toHaveLength(before + 1);
    expect(events().at(-1)).toMatchObject({ kind: 'attention-changed', payload: { open: 0 } });
  });
  it('backs off a transport error per item without holding other alerts', async () => {
    const f = await fixture();
    f.send.mockResolvedValueOnce({ status: 'retry', reason: 'Network error' });
    await f.service.tick();
    expect(f.status().retryAt).toBeNull();
    f.context.storage.roadmaps.save(
      roadmapFixture(f, { reason: 'Worktree preparation failed.' }),
      0,
    );
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0].title).toBe('AQ sequence · Roadmap needs attention');
  });
  it('honours a delegation grant that makes integration merge manual', async () => {
    const f = await fixture();
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
    expect(openItems(f)).toHaveLength(0);
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
  it('coalesces restart-stopped work into one message', async () => {
    const f = await fixture();
    const roadmap = roadmapFixture(f, {
      attention: roadmapAttention('restart-resume'),
      reason: 'Daemon restarted.',
    });
    f.context.storage.roadmaps.save(roadmap, 0);
    f.setCycle('needs-attention', { reason: 'Daemon restarted.' });
    await f.service.tick();
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]?.[0]).toMatchObject({
      title: 'CraftingTable · 2 items need you',
      url: `https://craft.example/workspaces/${f.workspaceId}/inbox`,
    });
    expect(f.send.mock.calls[0]?.[0].message).toContain('AQ sequence · Roadmap needs attention');
    expect(f.send.mock.calls[0]?.[0].message).toContain('ActionQueue · AQ-05 · Needs attention');
    // Resuming each resolves its own item without another push.
    f.context.storage.roadmaps.save({ ...roadmap, status: 'running', version: 2 }, 1);
    await f.service.tick();
    f.setCycle('running');
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(openItems(f)).toHaveLength(0);
    // A later stop is a genuine, individual alert again.
    f.setCycle('needs-attention', { reason: 'Review found blocking issues.' });
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0].title).toBe('ActionQueue · AQ-05 · Needs attention');
  });
});

describe('durable attention items (R-A4)', () => {
  it('opens and resolves an item in the transaction that changes its subject', async () => {
    const f = await fixture();
    const [item] = f.context.storage.attention.open(f.workspaceId);
    expect(item).toMatchObject({
      subjectKey: `cycle:${f.cycle().id}`,
      code: 'merge-approval',
      kind: 'merge',
      refs: { cycleId: f.cycle().id, worktreeId: f.worktreeId, workItemId: f.workItemId },
    });
    const running = (cycle: WorkCycle): WorkCycle => {
      const { attention: _stop, ...rest } = cycle;
      return { ...rest, status: 'running', version: cycle.version + 1 };
    };
    // A write that rolls back leaves the item as it was.
    expect(() =>
      f.context.storage.transaction((tx) => {
        tx.execution.cycles.replace(running(f.cycle()), f.cycle().version);
        throw new Error('abandoned');
      }),
    ).toThrow('abandoned');
    expect(f.context.storage.attention.find(f.workspaceId, item!.id)?.state).toBe('open');
    // A committed write resolves it in the same transaction: nothing else runs in between.
    f.context.storage.transaction((tx) => {
      tx.execution.cycles.replace(running(f.cycle()), f.cycle().version);
    });
    expect(f.context.storage.attention.find(f.workspaceId, item!.id)).toMatchObject({
      state: 'resolved',
    });
  });
  it('lists a stopped cycle even when its work item already completed (WI-02/domain, 2026-09-25)', async () => {
    const f = await fixture();
    f.context.storage.planning.workItems.complete({
      workItemId: f.workItemId,
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      completedAt: f.now().toISOString(),
      completedByUserId: f.auth.user.id,
      mergeSha: 'c'.repeat(40),
    });
    // A re-run of an accepted item's slice stops on a provider failure.
    f.setCycle('needs-attention', { attention: cycleAttention('service-failure-not-retryable') });
    await f.service.tick();
    expect(openItems(f)).toMatchObject([
      { subjectKey: `cycle:${f.cycle().id}`, code: 'service-failure-not-retryable' },
    ]);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  /** A roadmap decision preparation for AQ-ADR-003 whose design run left open questions. */
  async function preparationWithQuestions() {
    const f = await fixture();
    f.setCycle('stopped');
    const treeId = asWorktreeId('decision-tree');
    const runId = asAgentRunId('decision-run');
    f.context.storage.execution.worktrees.insert({
      id: treeId,
      workspaceId: f.workspaceId,
      repositoryId: f.repositoryId,
      projectId: f.projectId,
      planVersionId: asPlanVersionId('plan-1'),
      branchName: 'ct/decision-1',
      baseSha: 'a'.repeat(40),
      baseBranch: 'main',
      path: '/tmp/aq-decision-tree',
      createdAt: f.now().toISOString(),
      createdByUserId: f.auth.user.id,
    });
    const roadmap = roadmapFixture(f, { status: 'running', attention: undefined });
    const { attention: _none, ...running } = roadmap;
    f.context.storage.roadmaps.save(
      {
        ...running,
        decisionPreparations: [
          {
            id: randomUUID(),
            definitionId: randomUUID(),
            bindingRevision: 1,
            bindingDigest: 'd'.repeat(64),
            checkpointId: 'AQ-ADR-003',
            workspaceId: f.workspaceId,
            repositoryId: f.repositoryId,
            projectId: f.projectId,
            planVersionId: asPlanVersionId('plan-1'),
            integrationBranch: 'aq-cont-1',
            integrationSha: 'a'.repeat(40),
            worktreeId: treeId,
            runId,
            profile: { backend: 'claude-code' },
            deadlineAt: f.now().toISOString(),
            instructions: '',
            createdAt: f.now().toISOString(),
            createdByUserId: f.auth.user.id,
          },
        ],
      },
      0,
    );
    f.context.storage.execution.runs.insert({
      id: runId,
      workspaceId: f.workspaceId,
      worktreeId: treeId,
      repositoryId: f.repositoryId,
      projectId: f.projectId,
      planVersionId: asPlanVersionId('plan-1'),
      backend: 'claude-code',
      role: 'design',
      permissionMode: 'auto',
      brief: 'Prepare the decision',
      createdAt: f.now().toISOString(),
      createdByUserId: f.auth.user.id,
    });
    f.context.storage.execution.runs.transition({
      workspaceId: f.workspaceId,
      runId,
      expectedStatuses: ['starting'],
      toStatus: 'finished',
      occurredAt: f.now().toISOString(),
    });
    f.context.storage.execution.runEvents.append({
      id: asAgentRunEventId(randomUUID()),
      workspaceId: f.workspaceId,
      runId,
      occurredAt: f.now().toISOString(),
      kind: 'turn-completed',
      payload: {
        outcome: 'success',
        resultText: '## Open questions\nWhich storage engine?',
        turns: 1,
        durationMs: 1,
      },
    });
    const preparation = f.context.storage.roadmaps.find(f.workspaceId, roadmap.id)!
      .decisionPreparations![0]!;
    return { f, roadmap, runId, preparation };
  }
  /**
   * Records an evidence decision on a checkpoint submission for the preparation's definition (or
   * `definitionId`) and projects it. The projector reads through the transaction's repositories,
   * so the repository type is stubbed.
   */
  function decide(
    f: Awaited<ReturnType<typeof fixture>>,
    preparation: { readonly definitionId: string },
    shape: {
      readonly sourceId?: string;
      readonly bindingRevision?: number;
      readonly coverage?: string;
      readonly outcome?: string;
      readonly definitionId?: string;
      readonly subjectKind?: string;
    } = {},
  ) {
    const submission = {
      id: randomUUID(),
      subject: {
        kind: shape.subjectKind ?? 'checkpoint',
        sourceId: shape.sourceId ?? 'AQ-ADR-003',
      },
      bindingRevision: shape.bindingRevision ?? 1,
      architectureDecision: { coverage: shape.coverage ?? 'full' },
    };
    const decision = {
      id: randomUUID(),
      workspaceId: f.workspaceId,
      submissionId: submission.id,
      outcome: shape.outcome ?? 'accepted',
    };
    const evidence = Object.getPrototypeOf(f.context.storage.runtimeEvidence) as Pick<
      typeof f.context.storage.runtimeEvidence,
      'submissions' | 'decisions'
    >;
    const owner = shape.definitionId ?? preparation.definitionId;
    const submissions = vi
      .spyOn(evidence, 'submissions')
      .mockImplementation(
        (_ws, definitionId) => (definitionId === owner ? [submission] : []) as never,
      );
    const decisions = vi.spyOn(evidence, 'decisions').mockReturnValue([decision] as never);
    try {
      f.context.storage.transaction(() =>
        f.context.services.attention.written('evidence-decision', decision as never),
      );
    } finally {
      // The stubs are on the shared repository prototype.
      submissions.mockRestore();
      decisions.mockRestore();
    }
  }
  it('names a roadmap decision preparation and links it to the roadmap', async () => {
    const { f, roadmap, runId, preparation } = await preparationWithQuestions();
    expect(openItems(f)).toMatchObject([
      {
        subjectKey: `run:${runId}`,
        code: 'decision-preparation-questions',
        title: 'ActionQueue · AQ-ADR-003 · Needs attention',
        // The roadmap's setup page, at its preparation section (R-E2).
        path: `/workspaces/${f.workspaceId}/roadmaps/${roadmap.id}/setup#decision-preparation-${roadmap.id}`,
        refs: { roadmapId: roadmap.id, runId },
      },
    ]);
    // Once the decision is accepted in full, its preparation's questions need nobody
    // (LIVE-09). Accepting it is an evidence decision, which re-derives the preparation.
    decide(f, preparation);
    expect(openItems(f)).toEqual([]);
    expect(f.items().find((item) => item.subjectKey === `run:${runId}`)?.state).toBe('resolved');
  });
  // Only an accepted, full-coverage decision for the preparation's own checkpoint, definition and
  // binding answers its questions (LIVE-09; R-C14 review gap).
  it.each([
    ['a partial decision', { coverage: 'partial' }],
    ['a decision on another binding revision', { bindingRevision: 2 }],
    ['a rejected decision', { outcome: 'rejected' }],
    ["another checkpoint's decision", { sourceId: 'AQ-ADR-004' }],
    ["another definition's decision", { definitionId: randomUUID() }],
    ['a decision on a slice of the same name', { subjectKind: 'slice' }],
  ])("keeps a preparation's questions open after %s", async (_name, shape) => {
    const { f, runId, preparation } = await preparationWithQuestions();
    decide(f, preparation, shape);
    expect(openItems(f).map((item) => item.subjectKey)).toEqual([`run:${runId}`]);
  });
  it('lists an interrupted merge, a failed merge cleanup and a blocked finalization cleanup', async () => {
    const f = await fixture();
    f.setCycle('stopped');
    const codes = () => openItems(f).map((item) => item.code);
    const operation = {
      id: randomUUID(),
      workspaceId: f.workspaceId,
      worktreeId: f.worktreeId,
      status: 'reserved' as const,
      sourceSha: 'a'.repeat(40),
      targetSha: 'b'.repeat(40),
      targetBranch: 'aq-cont-1',
      reviewRunId: asAgentRunId('cycle-run'),
      createdAt: f.now().toISOString(),
      authorizedByUserId: f.auth.user.id,
    };
    f.context.storage.transaction((tx) => tx.execution.merges.save(operation));
    expect(codes()).toEqual(['merge-recovery-required']);
    f.context.storage.transaction((tx) =>
      tx.execution.merges.save({
        ...operation,
        status: 'merged',
        mergeSha: 'c'.repeat(40),
        cleanupError: 'The worktree is still in use.',
      }),
    );
    expect(codes()).toEqual(['merge-cleanup-failed']);
    f.context.storage.transaction((tx) =>
      tx.execution.merges.save({ ...operation, status: 'cleaned', mergeSha: 'c'.repeat(40) }),
    );
    expect(codes()).toEqual([]);
    // A finalization whose integration branch could not be removed.
    const recorded = JSON.parse(
      readFileSync(
        new URL('../../../fixtures/records/legacy-finalization-2026-09-13.json', import.meta.url),
        'utf8',
      ),
    ) as { finalization: Finalization };
    const finalization: Finalization = {
      ...recorded.finalization,
      id: randomUUID(),
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      planVersionId: asPlanVersionId('plan-1'),
      repositoryId: f.repositoryId,
      worktreeId: f.worktreeId,
      integrationCleanup: {
        status: 'blocked',
        requestedAt: f.now().toISOString(),
        requestedByUserId: f.auth.user.id,
        error: 'The branch has commits that are not on the target.',
      },
    };
    f.context.storage.transaction((tx) => tx.execution.finalizations.save(finalization, 0));
    expect(openItems(f)).toMatchObject([
      {
        code: 'finalization-cleanup-blocked',
        refs: { finalizationId: finalization.id },
        message: `${finalization.integrationBranch}: The branch has commits that are not on the target.`,
      },
    ]);
  });
  it('serves the inbox feed to members, most blocking first, without the host alerts for others', async () => {
    const f = await fixture();
    f.context.storage.roadmaps.save(roadmapFixture(f), 0);
    f.context.services.storageService.syncAttention([
      { key: 'storage:volumes', message: 'Future run files: below reserve.', members: ['/runs'] },
    ]);
    const feed = async (cookie = f.headers.cookie) => {
      const response = await f.context.app.inject({
        method: 'GET',
        url: `/api/workspaces/${f.workspaceId}/attention`,
        headers: { cookie },
      });
      expect(response.statusCode, response.body).toBe(200);
      return attentionFeedSchema.parse(response.json()).items;
    };
    const items = await feed();
    expect(items.map((item) => item.code).sort()).toEqual([
      'merge-approval',
      'scheduler-error',
      'storage-pressure',
    ]);
    for (const item of items)
      expect(item.inboxPath).toBe(`/workspaces/${f.workspaceId}/inbox/${item.id}`);
    // Sorted by work waiting on the item: a successor of AQ-05 now waits on its merge.
    f.context.storage.transaction((tx) => {
      tx.planning.workItems.insertMany([
        {
          id: asWorkItemId('item-2'),
          workspaceId: f.workspaceId,
          projectId: f.projectId,
          planVersionId: asPlanVersionId('plan-1'),
          sourceId: 'AQ-06',
          ordinal: 1,
          title: 'After the queue improvement',
          risk: 'low',
          primaryAreas: [],
          exitGate: 'Checks pass',
          sourceFields: {},
        },
      ]);
      tx.planning.dependencies.insertMany([
        {
          id: 'dependency-1' as never,
          workspaceId: f.workspaceId,
          planVersionId: asPlanVersionId('plan-1'),
          predecessorWorkItemId: f.workItemId,
          successorWorkItemId: asWorkItemId('item-2'),
          kind: 'required',
          ordinal: 0,
        },
      ]);
    });
    // A recommended successor does not wait, so it does not count.
    f.context.storage.transaction((tx) => {
      tx.planning.workItems.insertMany([
        {
          id: asWorkItemId('item-3'),
          workspaceId: f.workspaceId,
          projectId: f.projectId,
          planVersionId: asPlanVersionId('plan-1'),
          sourceId: 'AQ-07',
          ordinal: 2,
          title: 'Nice to have after it',
          risk: 'low',
          primaryAreas: [],
          exitGate: 'Checks pass',
          sourceFields: {},
        },
      ]);
      tx.planning.dependencies.insertMany([
        {
          id: 'dependency-2' as never,
          workspaceId: f.workspaceId,
          planVersionId: asPlanVersionId('plan-1'),
          predecessorWorkItemId: f.workItemId,
          successorWorkItemId: asWorkItemId('item-3'),
          kind: 'recommended',
          ordinal: 1,
        },
      ]);
    });
    const sorted = await feed();
    expect(sorted[0]).toMatchObject({ code: 'merge-approval', blocks: 1 });
    // A viewer sees the work items but not the host's storage alert.
    const viewer = asUserId('viewer');
    f.context.storage.users.insert({
      id: viewer,
      username: 'viewer',
      usernameNormalized: 'viewer',
      passwordHash: '$argon2id$unused',
      occurredAt: f.now().toISOString(),
    });
    f.context.storage.workspaces.insertMembership({
      id: asWorkspaceMembershipId('viewer-membership'),
      workspaceId: f.workspaceId,
      userId: viewer,
      role: 'viewer',
      occurredAt: f.now().toISOString(),
    });
    const auth = { ...f.auth, user: { ...f.auth.user, id: viewer } };
    expect(
      f.context.services.attentionService
        .feed(auth, f.workspaceId)
        .items.map((item) => item.code)
        .sort(),
    ).toEqual(['merge-approval', 'scheduler-error']);
    expect(
      (
        await f.context.app.inject({
          method: 'GET',
          url: `/api/workspaces/${f.workspaceId}/attention`,
        })
      ).statusCode,
    ).toBe(401);
  });
  it('lists every stop kind of 2026-09-25 in the inbox feed with the refs its controls need', async () => {
    const f = await fixture();
    const owner = {
      roadmapId: randomUUID(),
      attemptId: randomUUID(),
      entryId: randomUUID(),
      definitionRevision: 1,
    };
    for (const code of [
      'shared-decision-required',
      'service-failure-not-retryable',
      'service-retries-exhausted',
      'work-item-questions',
      'scope-review-open-questions',
      'scope-review-recovery',
      'upstream-transition-undeclared',
    ] as const) {
      f.setCycle('needs-attention', { attention: cycleAttention(code), owner });
      const [item] = f.context.services.attentionService.feed(f.auth, f.workspaceId).items;
      expect(item, code).toMatchObject({
        code,
        refs: {
          cycleId: f.cycle().id,
          workItemId: f.workItemId,
          roadmapId: owner.roadmapId,
          entryId: owner.entryId,
        },
        inboxPath: `/workspaces/${f.workspaceId}/inbox/${item?.id}`,
      });
    }
  });
  it('hands a split set\u2019s push schedule to its members, and announces in-place changes', async () => {
    const f = await fixture();
    f.setCycle('running');
    const roadmap = roadmapFixture(f, { status: 'running', attention: undefined });
    const { attention: _none, ...running } = roadmap;
    f.context.storage.roadmaps.save(running, 0);
    const scope = `roadmap-pass:${roadmap.id}`;
    const projector = f.context.services.attention;
    const checkpoint = (id: string, blocks: number) => ({
      subjectKey: `roadmap:${roadmap.id}:checkpoint:${id}`,
      code: 'architecture-decision' as const,
      kind: 'attention' as const,
      title: `AQ sequence · ${id} · Decision to accept`,
      message: 'Ready.',
      path: '/workspaces/ws/roadmaps',
      refs: { roadmapId: roadmap.id },
      blocks,
    });
    // The pre-split set, already pushed.
    f.context.storage.transaction((tx) =>
      projector.sync(tx, f.workspaceId, scope, [
        {
          subjectKey: `roadmap:${roadmap.id}:checkpoints`,
          code: 'checkpoint-evidence',
          kind: 'attention',
          title: 'AQ sequence · Checkpoint evidence needed',
          message: 'AQ-ADR-001',
          path: '/workspaces/ws/roadmaps',
          refs: { roadmapId: roadmap.id },
          members: ['AQ-ADR-001'],
        },
      ]),
    );
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(1);
    const set = `roadmap:${roadmap.id}:checkpoints`;
    f.context.storage.transaction((tx) =>
      projector.sync(tx, f.workspaceId, scope, [checkpoint('AQ-ADR-001', 0)], {
        superseded: new Set([set]),
        carryFrom: set,
      }),
    );
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1); // Not paged again, and not a false alarm.
    expect(f.items().find((item) => item.subjectKey === set)?.resolvedBy).toBe('superseded');
    const [member] = openItems(f);
    expect(member?.delivery).toMatchObject({ deliveredCount: 1 });
    expect(member?.blocks).toBe(0);
    // A checkpoint that blocks nothing says so, rather than counting the roadmap's entries.
    expect(f.context.services.attentionService.feed(f.auth, f.workspaceId).items[0]).toMatchObject({
      blocks: 0,
    });
    // A change in place (here, what waits on it) is announced to browsers.
    const events = () =>
      f.context.storage.workspaceEvents
        .listAfter({ workspaceId: f.workspaceId, after: 0, limit: 1000 })
        .filter((event) => event.kind === 'attention-changed').length;
    const before = events();
    f.context.storage.transaction((tx) =>
      projector.sync(tx, f.workspaceId, scope, [checkpoint('AQ-ADR-001', 3)]),
    );
    expect(events()).toBe(before + 1);
  });
  it('keeps history: a resolved item and the delivery log cannot be changed or deleted', async () => {
    const f = await fixture();
    await f.service.tick();
    f.setCycle('running');
    const [item] = cycleItems(f);
    expect(item?.state).toBe('resolved');
    expect(() => f.context.storage.attention.update({ ...item!, message: 'rewritten' })).toThrow(
      /history/,
    );
    const database = openDatabase(f.context.storage.databasePath);
    try {
      expect(() => database.prepare('DELETE FROM attention_items').run()).toThrow(/history/);
      expect(() =>
        database.prepare("UPDATE notification_deliveries SET result = 'retry'").run(),
      ).toThrow(/append-only/);
      expect(() => database.prepare('DELETE FROM notification_deliveries').run()).toThrow(
        /append-only/,
      );
    } finally {
      database.close();
    }
  });
  it('counts a pushed item the daemon resolved by itself as a false alarm, and one the operator resolved as not', async () => {
    const f = await fixture();
    f.advance(1);
    f.setCycle('needs-attention', { attention: cycleAttention('review-open-questions') });
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(1);
    f.setCycle('running'); // Automation moved on; nobody acted.
    f.context.services.attention.flush();
    const [falseAlarm] = f.context.storage.attention.falseAlarms(f.workspaceId);
    expect(falseAlarm).toMatchObject({ code: 'review-open-questions', resolvedBy: 'automation' });
    // The operator answers the next stop: a command recorded after the item opened.
    f.setCycle('needs-attention', { attention: cycleAttention('implementation-open-questions') });
    await f.service.tick();
    f.advance(1);
    f.service.save(f.auth, f.workspaceId, { preferences, expectedVersion: f.status().version });
    f.setCycle('running');
    f.context.services.attention.flush();
    expect(f.context.storage.attention.falseAlarms(f.workspaceId)).toHaveLength(1);
    expect(
      f.items().find((item) => item.code === 'implementation-open-questions')?.resolvedBy,
    ).toBe('operator');
    // A stop replaced by another stop on the same subject is superseded.
    f.setCycle('needs-attention', { attention: cycleAttention('remediation-exhausted') });
    f.context.services.attention.flush();
    f.setCycle('needs-attention', { attention: cycleAttention('remediation-stalled') });
    f.context.services.attention.flush();
    expect(f.items().find((item) => item.code === 'remediation-exhausted')?.resolvedBy).toBe(
      'superseded',
    );
  });
  it('replays the recorded false-alarm sequences without a false alarm', async () => {
    // Default gates: 30 s settle, 5 min presence, and both controllers running.
    const f = await fixture(undefined, {});
    const passes = f.context.services.controllerPasses;
    passes.register('cycles');
    passes.register('roadmaps');
    const pass = (worker: 'cycles' | 'roadmaps') => passes.completed(worker, passes.started());
    const seconds = (value: number) => f.advance(value / 60);
    // The controller writes each stop in a transaction, which projects it at once.
    const write = (...change: Parameters<typeof f.setCycle>) => {
      f.setCycle(...change);
      f.context.services.attention.flush();
    };
    f.advance(30); // The operator's settings save is no longer recent.
    pass('cycles');
    pass('roadmaps');
    // NOTIF-01, EXO-02 (cycle 188747f3): a stop raised when automatic scope evidence lifted a
    // wait; 0.5 s later the old worker pushed it; 1.6 s later the roadmap ran Review again.
    write('needs-attention', {
      reason: 'wi integration changed. Preview dependency refresh.',
      attention: cycleAttention('review-baseline-changed'),
    });
    seconds(0.5);
    await f.service.tick();
    pass('cycles');
    seconds(1.1);
    write('running'); // The roadmap's own pass (actor: system) starts the review.
    pass('roadmaps');
    await f.service.tick();
    // NOTIF-01, near miss (cycle 10dbc912): a scope review stops; 0.9 s later the roadmap
    // reserves scope recovery, which claims the stop.
    write('needs-attention', {
      reason: 'Scope review requires recovery: 1 major.',
      attention: cycleAttention('scope-review-recovery'),
    });
    seconds(0.2);
    await f.service.tick();
    seconds(0.7);
    write('needs-attention', {
      reason: 'Scope review requires recovery: 1 major.',
      attention: cycleAttention('scope-review-recovery', undefined, { claim: 'scope-recovery' }),
    });
    pass('roadmaps');
    pass('cycles');
    seconds(40);
    await f.service.tick();
    write('running');
    // The same shape where the takeover comes only in the roadmap's next pass, after the
    // settle window: the quiescence gate holds the push until that pass has run.
    write('needs-attention', { attention: cycleAttention('scope-review-open-questions') });
    pass('cycles');
    seconds(45);
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    write('running');
    pass('roadmaps');
    seconds(60);
    await f.service.tick();
    // NOTIF-03 (cycle ac9b0f0f): the operator's own baseline preparation bumped the stopped
    // cycle twice within a second; they started design recovery 6 s later.
    f.service.save(f.auth, f.workspaceId, { preferences, expectedVersion: f.status().version });
    write('needs-attention', { attention: cycleAttention('design-open-questions') });
    seconds(0.8);
    write('needs-attention', { attention: cycleAttention('design-open-questions') });
    pass('cycles');
    pass('roadmaps');
    await f.service.tick();
    seconds(6);
    write('running');
    await f.service.tick();
    f.advance(60);
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    f.context.services.attention.flush();
    expect(f.context.storage.attention.falseAlarms(f.workspaceId)).toEqual([]);
    const resolved = f.items().filter((item) => item.state === 'resolved');
    expect(resolved.filter((item) => item.resolvedBy === 'automation').length).toBeGreaterThan(2);
    // A genuine stop is still sent once the controllers are quiet and it has settled.
    write('needs-attention', { attention: cycleAttention('review-open-questions') });
    pass('cycles');
    pass('roadmaps');
    seconds(31);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('waits for every running controller to complete a pass that began after the item opened', async () => {
    const f = await fixture(undefined, { settleMs: 0, presenceGraceMs: 0, presenceWindowMs: 0 });
    const passes = f.context.services.controllerPasses;
    passes.register('cycles');
    passes.register('roadmaps');
    const inFlight = passes.started(); // A roadmap pass already running when the stop opens.
    f.setCycle('needs-attention', { attention: cycleAttention('review-open-questions') });
    f.context.services.attention.flush();
    passes.completed('cycles', passes.started());
    passes.completed('roadmaps', inFlight);
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    passes.completed('roadmaps', passes.started());
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    // A controller that hangs does not silence alerts for good.
    f.setCycle('needs-attention', { attention: cycleAttention('review-open-questions-at-limit') });
    f.context.services.attention.flush();
    passes.started();
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(2);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('holds a first push while the operator watches, and reminders while they issue commands', async () => {
    const f = await fixture(undefined, { settleMs: 0 });
    f.advance(10); // The settings save is no longer a recent command.
    const presence = f.context.services.operatorPresence;
    presence.opened(f.workspaceId, f.auth.user.id);
    f.setCycle('needs-attention', { attention: cycleAttention('review-open-questions') });
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    f.advance(PRESENCE_GRACE_MS / 60_000);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    presence.closed(f.workspaceId, f.auth.user.id);
    // Reminder due at +30 min, but the operator is issuing commands.
    f.advance(30);
    f.service.save(f.auth, f.workspaceId, { preferences, expectedVersion: f.status().version });
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(5);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0].message).toMatch(/^Reminder:/);
  });
  it('sends one digest per wake with new items and due reminders, rendered from current state', async () => {
    const f = await fixture();
    await f.service.tick(); // The merge approval is pushed at 15:00.
    f.advance(30);
    f.context.storage.roadmaps.save(roadmapFixture(f), 0);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls[1]?.[0]).toMatchObject({
      title: 'CraftingTable · 2 items need you',
      message:
        'AQ sequence · Roadmap needs attention\nReminder: ActionQueue · AQ-05 · Ready for merge',
    });
    const [delivery] = f.context.storage.attention.deliveries(f.workspaceId, 1);
    expect(delivery?.itemIds).toHaveLength(2);
    expect(delivery?.reminderItemIds).toEqual([cycleItems(f)[0]?.id]);
  });
  it('delivers from items alone: a tick reads no cycle, roadmap, map or run state', async () => {
    const f = await fixture();
    const allowed = new Set([
      'notifications',
      'attention',
      'audit',
      'workspaceEvents',
      'workspaces',
      'users',
      'maintenance',
    ]);
    const narrow = <T extends object>(repositories: T): T =>
      new Proxy(repositories, {
        get(target, key, receiver) {
          if (typeof key === 'string' && !allowed.has(key) && key !== 'transaction')
            throw new Error(`Notification delivery read ${key}`);
          return Reflect.get(target, key, receiver);
        },
      });
    const storage = f.context.storage;
    f.context.services.attention.flush();
    const service = new NotificationService(
      narrow({
        ...storage,
        transaction: <T>(operation: (tx: never) => T) =>
          storage.transaction((tx) => operation(narrow(tx) as never)),
      }) as never,
      f.context.services.workspaceService,
      f.context.services.workspaceEventNotifier,
      { send: f.send },
      'https://craft.example',
      { flush: () => undefined, openedPass: () => 0 },
      new ControllerPasses(),
      new OperatorPresence(),
      f.now,
      undefined,
      { credentials: new CredentialFile(f.context.config.configDir), ...scheduling },
    );
    try {
      await service.tick();
      expect(f.send).toHaveBeenCalledTimes(1);
    } finally {
      await service.shutdown();
    }
  });
  it('folds a pre-R-A4 outbox row into its item without paging again', async () => {
    const f = await fixture();
    // The stop's item opens after the upgrade, as at the first boot on schema 32.
    f.setCycle('running');
    f.context.services.attention.flush();
    f.advance(11);
    const sentAt = new Date(f.now().getTime() - 10 * 60_000).toISOString();
    f.context.storage.notifications.saveRecord({
      id: randomUUID(),
      workspaceId: f.workspaceId,
      sourceKey: `cycle:${f.cycle().id}:awaiting-merge`,
      kind: 'merge',
      title: 'ActionQueue · AQ-05 · Ready for merge',
      message: 'Legacy text',
      path: '/workspaces/x',
      state: 'active',
      createdAt: sentAt,
      firstSentAt: sentAt,
      lastSentAt: sentAt,
      nextAttemptAt: new Date(f.now().getTime() + 20 * 60_000).toISOString(),
      deliveredCount: 1,
      failures: 0,
      lastError: null,
      leaseToken: null,
      leaseUntil: null,
    });
    f.setCycle('awaiting-merge', { attention: cycleAttention('merge-approval') });
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    expect(cycleItems(f).find((item) => item.state === 'open')?.delivery).toMatchObject({
      firstSentAt: sentAt,
      deliveredCount: 1,
    });
    expect(f.context.storage.notifications.records(f.workspaceId, true)).toHaveLength(0);
    f.advance(20);
    await f.service.tick();
    expect(f.send.mock.calls[0]?.[0].message).toMatch(/^Reminder:/);
  });
});

describe('attention items: review fixes (R-A4)', () => {
  const emoji = '😀'.repeat(30);
  it('bounds item text in the units the contract counts, so a long emoji reason never fails a write', async () => {
    const f = await fixture();
    const reason = `${emoji}${'a'.repeat(3900)}`; // Valid on the cycle; over 4000 UTF-16 units as an item.
    f.setCycle('needs-attention', { reason, attention: cycleAttention('review-open-questions') });
    // The next unrelated write commits, and the item is stored within its bound.
    f.context.storage.transaction((tx) =>
      tx.workspaces.rename({
        workspaceId: f.workspaceId,
        name: 'Renamed',
        occurredAt: f.now().toISOString(),
      }),
    );
    const [item] = openItems(f);
    expect(item?.code).toBe('review-open-questions');
    expect(item?.message.length).toBeLessThanOrEqual(4000);
    // A long push is logged within its bound too, so it is not re-sent after its lease.
    f.setCycle('needs-attention', {
      reason: `${emoji}${'b'.repeat(1100)}`,
      attention: cycleAttention('implementation-open-questions'),
    });
    await f.service.tick();
    f.advance(2);
    await f.service.tick();
    f.advance(2);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.context.storage.attention.deliveries(f.workspaceId, 10)).toHaveLength(1);
  });
  it('never fails the writer when an item cannot be projected, and retries it', async () => {
    const f = await fixture();
    f.context.services.attention.flush();
    const insert = vi
      .spyOn(f.context.storage.attention.constructor.prototype, 'insert')
      .mockImplementationOnce(() => {
        throw new Error('projection defect');
      });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const { attention: _stop, ...rest } = f.cycle();
      const stopped: WorkCycle = {
        ...rest,
        status: 'needs-attention',
        version: f.cycle().version + 1,
        reason: 'Review needs your input.',
        attention: cycleAttention('review-open-questions'),
      };
      f.context.storage.transaction((tx) => {
        tx.execution.cycles.replace(stopped, f.cycle().version);
      });
      // The cycle write committed; its item failed and is retried by the next write.
      expect(f.context.storage.execution.cycles.find(f.workspaceId, f.cycle().id)?.status).toBe(
        'needs-attention',
      );
      expect(errors).toHaveBeenCalledTimes(1);
      f.context.storage.transaction(() => undefined);
      expect(openItems(f).map((item) => item.code)).toEqual(['review-open-questions']);
    } finally {
      insert.mockRestore();
      errors.mockRestore();
    }
  });
  it('continues an item that resolved while its push was in flight, without paging it again', async () => {
    const f = await fixture();
    let accept: ((value: DeliveryResult) => void) | undefined;
    f.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          accept = resolve;
        }),
    );
    const tick = f.service.tick();
    // The controller resolves the item in its own transaction while the push is in flight.
    f.setCycle('running');
    f.context.services.attention.flush();
    accept?.({ status: 'accepted' });
    await tick;
    const [first] = cycleItems(f);
    expect(first).toMatchObject({ state: 'resolved', delivery: { firstSentAt: null } });
    f.advance(2);
    f.setCycle('awaiting-merge', { attention: cycleAttention('merge-approval') });
    await f.service.tick();
    f.advance(1);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    const reopened = cycleItems(f).find((item) => item.state === 'open');
    expect(reopened).toMatchObject({ continues: first?.id, delivery: { deliveredCount: 1 } });
  });
  it('pages a grown set through the presence and quiescence gates again', async () => {
    const f = await fixture(undefined, { settleMs: 0 });
    f.setCycle('running');
    f.advance(10);
    const alert = (members: string[]) =>
      f.context.services.storageService.syncAttention([
        { key: 'storage:volumes', message: 'Below reserve.', members },
      ]);
    alert(['/runs']);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(30);
    f.context.services.operatorPresence.opened(f.workspaceId, f.auth.user.id);
    alert(['/runs', '/trees']);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(1); // The operator is watching: the grace applies.
    f.advance(5);
    await f.service.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('folds a sent outbox row into an item that opens after the first delivery tick', async () => {
    const f = await fixture();
    f.setCycle('running');
    await f.service.tick();
    const sentAt = new Date(f.now().getTime() - 5 * 60_000).toISOString();
    f.context.storage.notifications.saveRecord({
      id: randomUUID(),
      workspaceId: f.workspaceId,
      sourceKey: 'storage:volumes',
      kind: 'attention',
      title: 'CraftingTable · Storage needs attention',
      message: 'Legacy text',
      path: '/workspaces/x',
      state: 'active',
      createdAt: sentAt,
      firstSentAt: sentAt,
      lastSentAt: sentAt,
      nextAttemptAt: new Date(f.now().getTime() + 25 * 60_000).toISOString(),
      deliveredCount: 1,
      failures: 0,
      lastError: null,
      leaseToken: null,
      leaseUntil: null,
    });
    // The storage monitor's first reading comes after the first delivery tick.
    f.context.services.storageService.syncAttention([
      { key: 'storage:volumes', message: 'Below reserve.', members: ['/runs'] },
    ]);
    await f.service.tick();
    expect(f.send).not.toHaveBeenCalled();
    expect(openItems(f)[0]?.delivery).toMatchObject({ firstSentAt: sentAt, deliveredCount: 1 });
  });
  it('keeps an item’s quiescence mark when the projection that resolved it rolls back', async () => {
    const f = await fixture();
    f.context.services.controllerPasses.started();
    f.setCycle('needs-attention', { attention: cycleAttention('review-open-questions') });
    f.context.services.attention.flush();
    const [item] = openItems(f);
    const mark = f.context.services.attention.openedPass(item!.id);
    expect(mark).toBeGreaterThan(0);
    // The next stop supersedes the item, but opening its successor fails: the unit rolls back.
    const insert = vi
      .spyOn(f.context.storage.attention.constructor.prototype, 'insert')
      .mockImplementationOnce(() => {
        throw new Error('projection defect');
      });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      f.setCycle('needs-attention', { attention: cycleAttention('remediation-exhausted') });
      f.context.storage.transaction(() => undefined);
    } finally {
      insert.mockRestore();
      errors.mockRestore();
    }
    expect(f.context.storage.attention.find(f.workspaceId, item!.id)?.state).toBe('open');
    expect(f.context.services.attention.openedPass(item!.id)).toBe(mark);
  });
  it('re-derives a roadmap stop when its cycle item resolves through the worktree, and supersedes item-for-item', async () => {
    const f = await fixture();
    const entryId = randomUUID();
    const base = roadmapFixture(f);
    const roadmap: Roadmap = {
      ...base,
      attempts: [
        {
          id: randomUUID(),
          entryId,
          definitionRevision: 1,
          cycleId: f.cycle().id,
          worktreeId: f.worktreeId,
          status: 'active',
          createdAt: f.now().toISOString(),
        },
      ],
    };
    f.context.storage.roadmaps.save(roadmap, 0);
    f.setCycle('awaiting-merge', {
      attention: cycleAttention('merge-approval'),
      owner: {
        roadmapId: roadmap.id,
        attemptId: roadmap.attempts[0]!.id,
        entryId,
        definitionRevision: 1,
      },
    });
    // The cycle's merge item carries this stop; the roadmap adds none of its own.
    expect(openItems(f).map((item) => item.subjectKey)).toEqual([`cycle:${f.cycle().id}`]);
    f.context.storage.transaction((tx) =>
      tx.execution.worktrees.markRemoved({
        workspaceId: f.workspaceId,
        worktreeId: f.worktreeId,
        occurredAt: f.now().toISOString(),
      }),
    );
    expect(openItems(f).map((item) => item.subjectKey)).toEqual([`roadmap:${roadmap.id}`]);
  });
  it('a review whose automatic recovery stopped converging is one item carrying the rounds (R-C5)', async () => {
    const f = await fixture();
    const entryId = randomUUID();
    const base = roadmapFixture(f);
    const { attention: _none, ...running } = base;
    const roadmap: Roadmap = {
      ...running,
      status: 'running',
      attempts: [
        {
          id: randomUUID(),
          entryId,
          definitionRevision: 1,
          cycleId: f.cycle().id,
          worktreeId: f.worktreeId,
          status: 'active',
          createdAt: f.now().toISOString(),
        },
      ],
      definition: {
        ...base.definition,
        entries: [
          {
            id: entryId,
            workItemId: f.workItemId,
            projectId: f.projectId,
            planVersionId: asPlanVersionId('plan-1'),
            sourceId: 'AQ-05',
            title: 'Parent acceptance',
            repositoryId: f.repositoryId,
            integrationBranch: 'aq-cont-1',
            profiles: f.cycle().profiles,
            policy: f.cycle().policy,
            instructions: '',
          },
        ],
      },
    };
    f.context.storage.roadmaps.save(roadmap, 0);
    f.setCycle('needs-attention', {
      attention: cycleAttention('scope-review-recovery'),
      owner: {
        roadmapId: roadmap.id,
        attemptId: roadmap.attempts[0]!.id,
        entryId,
        definitionRevision: 1,
      },
    });
    const open = () => {
      f.schedulerPass();
      return openItems(f).map((item) => ({ subject: item.subjectKey, code: item.code }));
    };
    expect(open()).toEqual([{ subject: `cycle:${f.cycle().id}`, code: 'scope-review-recovery' }]);
    // Automatic recovery stops: the roadmap holds the review's entry with the rounds' progress.
    const held = f.context.storage.roadmaps.find(f.workspaceId, roadmap.id)!;
    f.context.storage.roadmaps.save(
      {
        ...held,
        version: held.version + 1,
        entryHolds: {
          [entryId]: {
            status: 'needs-attention',
            reason:
              'Automatic recovery stopped: the last rounds ended without progress. Round 1: stalled; still open F003 (major).',
            attention: roadmapAttention('recovery-not-converging', { entryId }),
          },
        },
      },
      held.version,
    );
    // One item: the review's own, with its controls, now saying why recovery stopped.
    expect(open()).toEqual([{ subject: `cycle:${f.cycle().id}`, code: 'recovery-not-converging' }]);
    expect(openItems(f)[0]!.message).toContain('F003 (major)');
    expect(openItems(f)[0]!.refs).toMatchObject({ roadmapId: roadmap.id, entryId });
    // Answered (the hold goes): the review's own stop again.
    const answered = f.context.storage.roadmaps.find(f.workspaceId, roadmap.id)!;
    const { entryHolds: _held, ...cleared } = answered;
    f.context.storage.roadmaps.save(
      { ...cleared, version: answered.version + 1 },
      answered.version,
    );
    expect(open()).toEqual([{ subject: `cycle:${f.cycle().id}`, code: 'scope-review-recovery' }]);
  });
  it('replaces a roadmap hold with its cycle\u2019s own stop, as superseded', async () => {
    const f = await fixture();
    const entryId = randomUUID();
    const base = roadmapFixture(f);
    const { attention: _none, ...roadmap } = {
      ...base,
      status: 'running' as const,
      attempts: [
        {
          id: randomUUID(),
          entryId,
          definitionRevision: 1,
          cycleId: f.cycle().id,
          worktreeId: f.worktreeId,
          status: 'active' as const,
          createdAt: f.now().toISOString(),
        },
      ],
      entryHolds: {
        [entryId]: {
          status: 'needs-attention' as const,
          reason: 'Held for review.',
          attention: roadmapAttention('entry-blocked', { entryId }),
        },
      },
      definition: {
        ...base.definition,
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
            profiles: f.cycle().profiles,
            policy: f.cycle().policy,
            instructions: '',
          },
        ],
      },
    };
    const owner = {
      roadmapId: roadmap.id,
      attemptId: roadmap.attempts[0]!.id,
      entryId,
      definitionRevision: 1,
    };
    f.setCycle('paused', { owner });
    f.context.storage.roadmaps.save(roadmap, 0);
    f.schedulerPass();
    const hold = `roadmap:${roadmap.id}:entry:${entryId}`;
    expect(openItems(f).map((item) => item.subjectKey)).toEqual([hold]);
    f.setCycle('needs-attention', { attention: cycleAttention('review-open-questions'), owner });
    f.context.services.attention.flush();
    expect(openItems(f).map((item) => item.subjectKey)).toEqual([`cycle:${f.cycle().id}`]);
    expect(f.items().find((item) => item.subjectKey === hold)?.resolvedBy).toBe('superseded');
  });
  it('resolves a storage alert in a workspace that is no longer active', async () => {
    const f = await fixture();
    f.context.services.storageService.syncAttention([
      { key: 'storage:volumes', message: 'Below reserve.', members: ['/runs'] },
    ]);
    const database = openDatabase(f.context.storage.databasePath);
    try {
      database.prepare("UPDATE workspaces SET status = 'archived' WHERE id = ?").run(f.workspaceId);
    } finally {
      database.close();
    }
    f.context.services.storageService.syncAttention([
      { key: 'storage:volumes', message: 'Below reserve.', members: ['/runs'] },
    ]);
    expect(
      f.context.storage.attention
        .recent(f.workspaceId, 10)
        .filter((item) => item.subjectKey === 'storage:volumes')
        .map((item) => item.state),
    ).toEqual(['resolved']);
  });
  it('counts a controller pass that failed as completed', async () => {
    const f = await fixture();
    const passes = f.context.services.controllerPasses;
    const cycles = f.context.services.workCycleService;
    cycles.attachPasses(passes);
    passes.register('cycles');
    const opened = passes.current;
    const pass = vi
      .spyOn(cycles as unknown as { pass(): Promise<void> }, 'pass')
      .mockRejectedValueOnce(new Error('pass failed'));
    await expect(cycles.tick()).rejects.toThrow('pass failed');
    pass.mockRestore();
    expect(passes.quietSince(opened)).toBe(true);
  });
});
