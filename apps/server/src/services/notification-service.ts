import { randomUUID } from 'node:crypto';
import type { NotificationStatus, SaveNotificationsRequest } from '@craftingtable/contracts';
import {
  asEventId,
  DEFAULT_NOTIFICATION_PREFERENCES,
  designHasNoOpenQuestions,
  nextReminderAt,
  notificationText,
  type WorkspaceId,
} from '@craftingtable/domain';
import type {
  CraftingTableStorage,
  NotificationRecord,
  StorageRepositories,
  StoredNotificationSettings,
} from '@craftingtable/storage';
import type { AuthContext } from './auth-service.js';
import { ExecutionRequestError } from './errors.js';
import type { DeliveryResult, NotificationTransport } from './notification-transport.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

type Attention = Pick<NotificationRecord, 'sourceKey' | 'kind' | 'title' | 'message' | 'path'>;
export class NotificationService {
  private readonly abort = new AbortController();
  private worker: Promise<void> | undefined;
  private ticking: Promise<void> | undefined;
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly transport: NotificationTransport,
    private readonly publicOrigin: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get(context: AuthContext, workspaceId: WorkspaceId): NotificationStatus {
    this.workspaces.requireRole(context, workspaceId, ['owner']);
    const settings = this.storage.notifications.settings(workspaceId);
    return {
      preferences: settings?.preferences ?? DEFAULT_NOTIFICATION_PREFERENCES,
      version: settings?.version ?? 0,
      credentialsConfigured: Boolean(settings?.applicationToken && settings.userKey),
      blockedReason: settings?.blockedReason ?? null,
      retryAt: settings?.retryAt ?? null,
      records: this.storage.notifications
        .records(workspaceId)
        .slice(0, 50)
        .map((record) => ({
          id: record.id,
          kind: record.kind,
          title: record.title,
          message: record.message,
          path: record.path,
          state: record.state,
          createdAt: record.createdAt,
          lastSentAt: record.lastSentAt,
          nextAttemptAt: record.nextAttemptAt,
          deliveredCount: record.deliveredCount,
          lastError: record.lastError,
        })),
    };
  }
  save(
    context: AuthContext,
    workspaceId: WorkspaceId,
    input: SaveNotificationsRequest,
  ): NotificationStatus {
    this.workspaces.requireRole(context, workspaceId, ['owner']);
    this.storage.transaction((tx) => {
      const previous = tx.notifications.settings(workspaceId);
      if ((previous?.version ?? 0) !== input.expectedVersion)
        throw new ExecutionRequestError(
          'conflict',
          'Notification settings changed. Reload settings before saving.',
        );
      const applicationToken = input.clearCredentials
        ? null
        : (input.applicationToken ?? previous?.applicationToken ?? null);
      const userKey = input.clearCredentials ? null : (input.userKey ?? previous?.userKey ?? null);
      if (input.preferences.enabled && !(applicationToken && userKey))
        throw new ExecutionRequestError(
          'invalid-request',
          'Configure both Pushover credentials before enabling notifications.',
        );
      const settings: StoredNotificationSettings = {
        workspaceId,
        ownerUserId: context.user.id,
        preferences: input.preferences,
        applicationToken,
        userKey,
        version: input.expectedVersion + 1,
        blockedReason: null,
        retryAt: null,
      };
      tx.notifications.saveSettings(settings);
      // Changing local reminder time takes effect for the daily phase immediately.
      for (const record of tx.notifications.records(workspaceId, true)) {
        if (record.failures > 0) {
          tx.notifications.saveRecord({ ...record, nextAttemptAt: this.now().toISOString() });
        } else if (record.firstSentAt !== null && record.kind !== 'test') {
          tx.notifications.saveRecord({
            ...record,
            nextAttemptAt: nextReminderAt(
              record.firstSentAt,
              record.lastSentAt ?? record.firstSentAt,
              settings.preferences,
            ),
          });
        }
      }
      this.journal(tx, workspaceId, 'settings', context);
    });
    this.notifier.notify();
    return this.get(context, workspaceId);
  }
  test(context: AuthContext, workspaceId: WorkspaceId): NotificationStatus {
    this.workspaces.requireRole(context, workspaceId, ['owner']);
    this.storage.transaction((tx) => {
      const settings = tx.notifications.settings(workspaceId);
      if (!settings?.applicationToken || !settings.userKey)
        throw new ExecutionRequestError('invalid-request', 'Save your Pushover credentials first.');
      if (
        tx.notifications
          .records(workspaceId)
          .some(
            (record) =>
              record.kind === 'test' &&
              (record.state === 'active' ||
                Date.parse(record.createdAt) > this.now().getTime() - 60_000),
          )
      )
        throw new ExecutionRequestError(
          'conflict',
          'A test is pending or was requested within the last minute.',
        );
      tx.notifications.saveSettings({
        ...settings,
        ownerUserId: context.user.id,
        blockedReason: null,
        retryAt: null,
        version: settings.version + 1,
      });
      tx.notifications.saveRecord(
        this.record(workspaceId, {
          sourceKey: `test:${randomUUID()}`,
          kind: 'test',
          title: 'CraftingTable notification test',
          message:
            'Pushover is connected. Open CraftingTable to review work that needs your attention.',
          path: `/workspaces/${encodeURIComponent(workspaceId)}/settings`,
        }),
      );
      this.journal(tx, workspaceId, 'test', context);
    });
    this.notifier.notify();
    return this.get(context, workspaceId);
  }
  startWorker(): void {
    if (this.worker !== undefined || this.abort.signal.aborted) return;
    this.worker = this.loop();
  }
  async shutdown(): Promise<void> {
    this.abort.abort();
    await this.worker;
    await this.ticking;
  }
  tick(): Promise<void> {
    if (this.ticking !== undefined) return this.ticking;
    this.ticking = this.deliverDue().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }
  private async loop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      const generation = this.notifier.generation;
      try {
        await this.tick();
      } catch {
        /* Durable leases remain recoverable after a storage failure. */
      }
      await this.notifier.waitForChangeOrTimeout({
        generation,
        timeoutMs: 5000,
        signal: this.abort.signal,
      });
    }
  }
  private authorized(tx: StorageRepositories, settings: StoredNotificationSettings): boolean {
    const access = tx.workspaces.findAuthorized(settings.ownerUserId, settings.workspaceId);
    return (
      access?.membership.role === 'owner' &&
      access.workspace.status === 'active' &&
      tx.users.findById(settings.ownerUserId)?.status === 'active'
    );
  }
  private attention(tx: StorageRepositories, settings: StoredNotificationSettings): Attention[] {
    const workspaceId = settings.workspaceId;
    const cycles = tx.execution.cycles.list(workspaceId);
    const result: Attention[] = [];
    for (const tree of tx.execution.worktrees.listActive(workspaceId)) {
      const item = tx.planning.workItems.find(workspaceId, tree.workItemId);
      if (item === undefined || item.status === 'completed') continue;
      const project = tx.planning.projects.find(workspaceId, tree.projectId);
      const cycle = cycles.find((candidate) => candidate.worktreeId === tree.id);
      const run = tx.execution.runs.listForWorktree(workspaceId, tree.id)[0];
      let kind: 'merge' | 'attention';
      let reason: string;
      let sourceKey: string;
      if (cycle !== undefined && !['stopped', 'completed'].includes(cycle.status)) {
        if (cycle.status !== 'awaiting-merge' && cycle.status !== 'needs-attention') continue;
        kind = cycle.status === 'awaiting-merge' ? 'merge' : 'attention';
        reason = `${cycle.step}: ${cycle.reason}`;
        sourceKey = `cycle:${cycle.id}:${cycle.version}`;
      } else {
        if (run === undefined || cycle?.currentRunId === run.id) continue;
        const turn = tx.execution.runEvents.latestOfKind(workspaceId, run.id, 'turn-completed');
        const payload = turn?.kind === 'turn-completed' ? turn.payload : undefined;
        sourceKey = `run:${run.id}:${turn?.sequence ?? 0}`;
        if (run.status === 'failed' || run.status === 'interrupted') {
          kind = 'attention';
          reason = `${run.role} run ${run.status}. Open the run to inspect and continue.`;
          sourceKey += `:${run.status}`;
        } else if (
          (run.status === 'waiting' || run.status === 'finished') &&
          payload !== undefined
        ) {
          if (run.role === 'review') {
            kind =
              run.verdict === 'mergeable' && payload.outcome === 'success' ? 'merge' : 'attention';
            if (kind === 'merge' && run.reviewBranchContext?.worktreeVersion !== tree.version)
              continue;
            const report = payload.reviewReport;
            const counts = { blocking: 0, major: 0, minor: 0, nit: 0 };
            if (report?.status === 'complete')
              for (const finding of report.report.findings)
                if (finding.status === 'open') counts[finding.severity] += 1;
            reason =
              kind === 'merge'
                ? `Review reports mergeable. ${report?.status === 'complete' ? `Open findings: ${counts.blocking} blocking, ${counts.major} major, ${counts.minor} minor, ${counts.nit} nits.` : 'Structured finding counts are unavailable.'} Inspect the review and approve the merge.`
                : 'Review needs attention. Inspect findings and continue remediation.';
          } else if (
            run.role === 'design' &&
            (payload.outcome !== 'success' ||
              !designHasNoOpenQuestions(payload.resultText, payload.truncated))
          ) {
            kind = 'attention';
            reason =
              'Design needs your input: open questions are unresolved or the conclusion is incomplete.';
          } else continue;
        } else continue;
      }
      if (
        kind === 'merge' ? !settings.preferences.mergeReady : !settings.preferences.needsAttention
      )
        continue;
      result.push({
        sourceKey,
        kind,
        title: notificationText(
          `${project?.name ?? 'CraftingTable'} · ${item.sourceId} · ${kind === 'merge' ? 'Ready for merge' : 'Needs attention'}`,
          250,
        ),
        message: notificationText(
          `${item.title}\n${reason}\nBranch: ${tree.branchName} → ${tree.integrationBranch ?? tree.baseBranch}`,
          1024,
        ),
        path: `/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.id)}`,
      });
    }
    return result;
  }
  private record(workspaceId: WorkspaceId, source: Attention): NotificationRecord {
    return {
      ...source,
      workspaceId,
      id: randomUUID(),
      state: 'active',
      createdAt: this.now().toISOString(),
      firstSentAt: null,
      lastSentAt: null,
      nextAttemptAt: this.now().toISOString(),
      deliveredCount: 0,
      failures: 0,
      lastError: null,
      leaseToken: null,
      leaseUntil: null,
    };
  }
  private reconcile(tx: StorageRepositories, settings: StoredNotificationSettings): void {
    const desired = this.attention(tx, settings);
    const records = tx.notifications.records(settings.workspaceId);
    let changed = false;
    for (const record of records) {
      if (
        record.state === 'active' &&
        record.kind !== 'test' &&
        !desired.some((source) => source.sourceKey === record.sourceKey)
      ) {
        tx.notifications.saveRecord({
          ...record,
          state: 'resolved',
          leaseToken: null,
          leaseUntil: null,
        });
        changed = true;
      }
    }
    for (const source of desired) {
      const existing = records.find((record) => record.sourceKey === source.sourceKey);
      if (existing === undefined) {
        tx.notifications.saveRecord(this.record(settings.workspaceId, source));
        changed = true;
      } else if (existing.state === 'resolved') {
        tx.notifications.saveRecord({
          ...this.record(settings.workspaceId, source),
          id: existing.id,
        });
        changed = true;
      }
    }
    if (changed) this.journal(tx, settings.workspaceId, 'attention');
  }
  private async deliverDue(): Promise<void> {
    for (const initial of this.storage.notifications.listSettings()) {
      if (this.abort.signal.aborted) return;
      this.storage.transaction((tx) =>
        this.reconcile(tx, tx.notifications.settings(initial.workspaceId) ?? initial),
      );
      for (let count = 0; count < 20 && !this.abort.signal.aborted; count += 1) {
        const claim = this.storage.transaction((tx) => {
          const settings = tx.notifications.settings(initial.workspaceId);
          if (
            !settings ||
            !this.authorized(tx, settings) ||
            !settings.applicationToken ||
            !settings.userKey ||
            settings.blockedReason ||
            (settings.retryAt !== null && settings.retryAt > this.now().toISOString())
          )
            return undefined;
          this.reconcile(tx, settings);
          const now = this.now().toISOString();
          const record = tx.notifications
            .records(settings.workspaceId, true)
            .filter(
              (row) =>
                (settings.preferences.enabled || row.kind === 'test') &&
                row.nextAttemptAt <= now &&
                (row.leaseUntil === null || row.leaseUntil <= now),
            )
            .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))[0];
          if (record === undefined) return undefined;
          const claimed = {
            ...record,
            leaseToken: randomUUID(),
            leaseUntil: new Date(this.now().getTime() + 60_000).toISOString(),
          };
          tx.notifications.saveRecord(claimed);
          return { settings, record: claimed };
        });
        if (claim === undefined) break;
        const { settings, record } = claim;
        let delivery: DeliveryResult;
        try {
          delivery = await this.transport.send(
            {
              applicationToken: settings.applicationToken as string,
              userKey: settings.userKey as string,
              device: settings.preferences.device,
              title: record.title,
              message: `${record.deliveredCount > 0 ? 'Reminder: ' : ''}${record.message}`,
              url: new URL(record.path, this.publicOrigin).href,
            },
            this.abort.signal,
          );
        } catch {
          delivery = {
            status: 'retry',
            reason: 'Notification delivery could not be confirmed; it will retry.',
          };
        }
        if (this.abort.signal.aborted) return; // Leave the claim durable; acceptance might be ambiguous.
        this.storage.transaction((tx) => {
          const currentSettings = tx.notifications.settings(settings.workspaceId);
          if (currentSettings === undefined) return;
          this.reconcile(tx, currentSettings);
          const current = tx.notifications.find(settings.workspaceId, record.id);
          const now = this.now().toISOString();
          const seconds = [30, 60, 300, 900, 3600][Math.min(record.failures, 4)] ?? 3600;
          const retryAt =
            delivery.status === 'retry' && delivery.retryAt !== undefined
              ? delivery.retryAt
              : new Date(this.now().getTime() + seconds * 1000).toISOString();
          // A provider cooldown belongs to the recipient configuration, even if
          // the incident resolved while the request was in flight. An old response
          // must never block credentials saved during that request.
          if (currentSettings.version === settings.version) {
            tx.notifications.saveSettings({
              ...currentSettings,
              retryAt: delivery.status === 'accepted' ? null : retryAt,
              blockedReason: delivery.status === 'blocked' ? delivery.reason : null,
            });
          }
          if (
            current !== undefined &&
            (current.leaseToken === record.leaseToken || current.state === 'resolved')
          ) {
            const released = { ...current, leaseToken: null, leaseUntil: null };
            if (delivery.status === 'accepted') {
              const firstSentAt = current.firstSentAt ?? now;
              tx.notifications.saveRecord({
                ...released,
                firstSentAt,
                lastSentAt: now,
                deliveredCount: current.deliveredCount + 1,
                failures: 0,
                lastError: null,
                state: record.kind === 'test' ? 'resolved' : current.state,
                nextAttemptAt: nextReminderAt(firstSentAt, now, currentSettings.preferences),
              });
            } else {
              tx.notifications.saveRecord({
                ...released,
                failures: current.failures + 1,
                nextAttemptAt: retryAt,
                lastError: delivery.reason,
                state:
                  delivery.status === 'blocked' && record.kind === 'test'
                    ? 'resolved'
                    : current.state,
              });
            }
          }
          this.journal(tx, settings.workspaceId, 'delivery');
        });
        this.notifier.notify();
      }
    }
  }
  private journal(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    action: 'settings' | 'attention' | 'delivery' | 'test',
    context?: AuthContext,
  ): void {
    const occurredAt = this.now().toISOString();
    tx.audit.append({
      id: randomUUID(),
      occurredAt,
      workspaceId,
      actorKind: context === undefined ? 'system' : 'user',
      ...(context === undefined
        ? {}
        : { actorUserId: context.user.id, sessionId: context.session.id }),
      action: 'notifications.updated',
      targetType: 'workspace',
      targetId: workspaceId,
      outcome: 'succeeded',
      metadata: { action },
    });
    tx.workspaceEvents.appendEvent({
      id: asEventId(randomUUID()),
      workspaceId,
      occurredAt,
      ...(context === undefined ? {} : { actorUserId: context.user.id }),
      kind: 'notifications-changed',
      payload: { action },
    });
  }
}
