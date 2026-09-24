import { randomUUID } from 'node:crypto';
import type { NotificationStatus, SaveNotificationsRequest } from '@craftingtable/contracts';
import {
  asEventId,
  DEFAULT_NOTIFICATION_PREFERENCES,
  designHasNoOpenQuestions,
  effectiveCycleAttention,
  effectiveRoadmapAttention,
  nextReminderAt,
  notificationText,
  type WorkspaceId,
  type Roadmap,
  type RoadmapEntry,
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
import type { StorageAlert } from './storage-alerts.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

/**
 * A new occurrence waits this long before its first push. The claim re-derives attention,
 * so a state the controller leaves on its own within the window is never sent (NOTIF-01).
 */
export const NOTIFICATION_SETTLE_MS = 30_000;
/** An occurrence that reopens this soon after resolving is the same occurrence (NOTIF-03). */
export const NOTIFICATION_FLAP_WINDOW_MS = 10 * 60_000;
/**
 * A roadmap-level wait for the operator. The scheduler that owns the policy derives these
 * (`RoadmapService.attentionAlerts`); this service only formats and delivers them (R-A3).
 */
export type RoadmapAlert =
  | {
      readonly kind: 'verification-setup' | 'checkpoint-evidence';
      readonly roadmap: Roadmap;
      readonly members: readonly string[];
      readonly lines: readonly string[];
    }
  | {
      readonly kind: 'entry-hold';
      readonly roadmap: Roadmap;
      readonly entry: RoadmapEntry;
      readonly reason: string;
      readonly cycleId?: string;
    };

export interface NotificationServiceOptions {
  readonly settleMs?: number;
  readonly roadmapAlerts?: (
    storage: StorageRepositories,
    workspaceId: WorkspaceId,
  ) => readonly RoadmapAlert[];
  /** Cycles and roadmaps this boot's restart recovery stopped; they share one message. */
  readonly restartedAtBoot?: {
    readonly cycleIds: readonly string[];
    readonly roadmapIds: readonly string[];
  };
}
type Attention = Pick<NotificationRecord, 'sourceKey' | 'kind' | 'title' | 'message' | 'path'> & {
  readonly members?: readonly string[];
};
export class NotificationService {
  private readonly abort = new AbortController();
  private worker: Promise<void> | undefined;
  private ticking: Promise<void> | undefined;
  private readonly settleMs: number;
  private readonly bootId = randomUUID();
  private readonly roadmapAlerts: NotificationServiceOptions['roadmapAlerts'];
  /** `cycle:<id>` / `roadmap:<id>` still in the state this boot's restart left them in. */
  private readonly restartHeld: Set<string>;
  constructor(
    private readonly storage: CraftingTableStorage,
    private readonly workspaces: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly transport: NotificationTransport,
    private readonly publicOrigin: string,
    private readonly now: () => Date = () => new Date(),
    private readonly storageAttention?: () => readonly StorageAlert[],
    private readonly cycleTransitioning: (id: string) => boolean = () => false,
    options: NotificationServiceOptions = {},
  ) {
    this.settleMs = options.settleMs ?? NOTIFICATION_SETTLE_MS;
    this.roadmapAlerts = options.roadmapAlerts;
    this.restartHeld = new Set([
      ...(options.restartedAtBoot?.cycleIds ?? []).map((id) => `cycle:${id}`),
      ...(options.restartedAtBoot?.roadmapIds ?? []).map((id) => `roadmap:${id}`),
    ]);
  }

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
    this.notifier.notify('activity');
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
    this.notifier.notify('activity');
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
      const generation = this.notifier.workflowGeneration;
      try {
        await this.tick();
      } catch {
        /* Durable leases remain recoverable after a storage failure. */
      }
      await this.notifier.waitForChangeOrTimeout({
        channel: 'workflow',
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
    const roadmaps = tx.roadmaps.list(workspaceId);
    const result: Attention[] = [];
    // Restart-stopped work is held in one per-boot message until it is seen leaving that state.
    for (const cycle of cycles)
      if (cycle.status !== 'needs-attention') this.restartHeld.delete(`cycle:${cycle.id}`);
    for (const roadmap of roadmaps)
      if (roadmap.status !== 'needs-attention') this.restartHeld.delete(`roadmap:${roadmap.id}`);
    const restarted: { id: string; label: string; roadmap: boolean }[] = [];
    if (
      settings.preferences.needsAttention &&
      tx.maintenance.ownsInstallation(settings.ownerUserId)
    ) {
      for (const alert of this.storageAttention?.() ?? [])
        result.push({
          sourceKey: alert.key,
          kind: 'attention',
          title: 'CraftingTable · Storage needs attention',
          message: notificationText(alert.message, 1024),
          path: `/workspaces/${encodeURIComponent(workspaceId)}/settings`,
          ...(alert.members ? { members: alert.members } : {}),
        });
    }
    for (const tree of tx.execution.worktrees.listActive(workspaceId)) {
      const item = tree.workItemId
        ? tx.planning.workItems.find(workspaceId, tree.workItemId)
        : {
            id: '',
            status: 'admitted',
            sourceId: 'Finalization',
            title: 'Plan conformance, simplification and polish',
          };
      if (item === undefined || item.status === 'completed') continue;
      const project = tx.planning.projects.find(workspaceId, tree.projectId);
      const cycle = cycles.find((candidate) => candidate.worktreeId === tree.id);
      if (cycle && this.cycleTransitioning(cycle.id)) continue;
      const run = tx.execution.runs.listForWorktree(workspaceId, tree.id)[0];
      let kind: 'merge' | 'attention';
      let reason: string;
      let sourceKey: string;
      if (cycle !== undefined && !['stopped', 'completed'].includes(cycle.status)) {
        if (cycle.status !== 'awaiting-merge' && cycle.status !== 'needs-attention') continue;
        if (this.restartHeld.has(`cycle:${cycle.id}`)) {
          restarted.push({
            id: cycle.id,
            label: `${item.sourceId}: ${item.title}`,
            roadmap: false,
          });
          continue;
        }
        // The controller declares each stop and whether automation claims it (R-A3); only
        // operator-owned stops are sent.
        const attention = effectiveCycleAttention(cycle);
        if (attention?.owner !== 'operator') continue;
        const requirements = attention.code === 'merge-requirements';
        kind =
          cycle.status === 'awaiting-merge' &&
          !requirements &&
          (!tree.executionScope || tree.executionScope.kind === 'slice')
            ? 'merge'
            : 'attention';
        reason =
          requirements && attention.detail ? attention.detail : `${cycle.step}: ${cycle.reason}`;
        // Keyed by condition, not row version: bumps that keep the blocker do not re-page.
        sourceKey = `cycle:${cycle.id}:${cycle.status}${requirements ? ':merge-requirements' : ''}`;
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
        path: tree.planVersionId
          ? `/workspaces/${encodeURIComponent(workspaceId)}/projects/${encodeURIComponent(tree.projectId)}/plans/${encodeURIComponent(tree.planVersionId)}`
          : `/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.id)}`,
      });
    }
    if (settings.preferences.needsAttention) {
      const cycleAlert = (id: string) =>
        result.some((source) => source.sourceKey.startsWith(`cycle:${id}:`));
      const roadmapsPath = `/workspaces/${encodeURIComponent(workspaceId)}/roadmaps`;
      for (const alert of this.roadmapAlerts?.(tx, workspaceId) ?? []) {
        if (alert.kind === 'entry-hold') {
          if (alert.cycleId && cycleAlert(alert.cycleId)) continue;
          result.push({
            sourceKey: `roadmap:${alert.roadmap.id}:entry:${alert.entry.id}`,
            kind: 'attention',
            title: notificationText(`${alert.entry.sourceId} · Roadmap item needs attention`, 250),
            message: notificationText(`${alert.entry.title}\n${alert.reason}`, 1024),
            path: roadmapsPath,
          });
        } else if (alert.kind === 'verification-setup')
          result.push({
            sourceKey: `roadmap:${alert.roadmap.id}:environments`,
            members: alert.members,
            kind: 'attention',
            title: notificationText(
              `${alert.roadmap.definition.name} · Verification setup needed`,
              250,
            ),
            message: notificationText(alert.lines.join('\n'), 1024),
            path: roadmapsPath,
          });
        else
          result.push({
            sourceKey: `roadmap:${alert.roadmap.id}:checkpoints`,
            members: alert.members,
            kind: 'attention',
            title: notificationText(
              `${alert.roadmap.definition.name} · Checkpoint evidence needed`,
              250,
            ),
            message: notificationText(
              `These checkpoints are eligible for independent evidence review: ${alert.lines.join(', ')}. Expected dependency waits do not need action.`,
              1024,
            ),
            path: roadmapsPath,
          });
      }
      for (const roadmap of roadmaps) {
        if (effectiveRoadmapAttention(roadmap)?.owner !== 'operator') continue;
        if (this.restartHeld.has(`roadmap:${roadmap.id}`)) {
          restarted.push({ id: roadmap.id, label: roadmap.definition.name, roadmap: true });
          continue;
        }
        const active = roadmap.attempts.find((attempt) => attempt.status !== 'completed');
        const cycle = active && cycles.find((candidate) => candidate.id === active.cycleId);
        // The item alert already carries findings and branch details for this checkpoint.
        if (cycle && cycleAlert(cycle.id)) continue;
        result.push({
          sourceKey: `roadmap:${roadmap.id}:needs-attention`,
          kind: 'attention',
          title: notificationText(`${roadmap.definition.name} · Roadmap needs attention`, 250),
          message: notificationText(roadmap.reason, 1024),
          path: `/workspaces/${encodeURIComponent(workspaceId)}/roadmaps`,
        });
      }
      // NOTIF-06: a restart stops every running roadmap and cycle; say so once per boot.
      if (restarted.length) {
        const count = (roadmap: boolean, noun: string) => {
          const n = restarted.filter((r) => r.roadmap === roadmap).length;
          return n ? [`${n} ${noun}${n === 1 ? '' : 's'}`] : [];
        };
        const anyRoadmap = restarted.some((r) => r.roadmap);
        result.push({
          sourceKey: `restart:${this.bootId}`,
          members: restarted.map((r) => r.id).sort(),
          kind: 'attention',
          title: 'CraftingTable · Resume after restart',
          message: notificationText(
            `The daemon restarted and stopped ${[...count(true, 'roadmap'), ...count(false, 'work cycle')].join(' and ')}. Each waits for an explicit Resume:\n${restarted.map((r) => r.label).join('\n')}`,
            1024,
          ),
          path: `/workspaces/${encodeURIComponent(workspaceId)}${anyRoadmap ? '/roadmaps' : ''}`,
        });
      }
    }
    return result;
  }
  private record(workspaceId: WorkspaceId, source: Attention): NotificationRecord {
    const now = this.now();
    return {
      ...source,
      workspaceId,
      id: randomUUID(),
      state: 'active',
      createdAt: now.toISOString(),
      firstSentAt: null,
      lastSentAt: null,
      // An explicit test is the operator's own request; everything else settles first.
      nextAttemptAt:
        source.kind === 'test' ? now.toISOString() : this.settled(now.getTime()).toISOString(),
      deliveredCount: 0,
      failures: 0,
      lastError: null,
      leaseToken: null,
      leaseUntil: null,
    };
  }
  private settled(from: number): Date {
    return new Date(from + this.settleMs);
  }
  /** Reopen a recently resolved occurrence without a new page or a restarted reminder schedule. */
  private reopen(
    existing: NotificationRecord,
    source: Attention,
    settings: StoredNotificationSettings,
  ): NotificationRecord {
    const settle = this.settled(this.now().getTime()).toISOString();
    const reminder =
      existing.firstSentAt === null
        ? settle
        : nextReminderAt(
            existing.firstSentAt,
            existing.lastSentAt ?? existing.firstSentAt,
            settings.preferences,
          );
    return {
      ...existing,
      ...source,
      state: 'active',
      resolvedAt: undefined,
      failures: 0,
      lastError: null,
      leaseToken: null,
      leaseUntil: null,
      nextAttemptAt: reminder > settle ? reminder : settle,
    };
  }
  private transitioningRecord(tx: StorageRepositories, record: NotificationRecord): boolean {
    const parts = record.sourceKey.split(':');
    if (parts[0] === 'cycle') return this.cycleTransitioning(parts[1]!);
    if (parts[0] === 'roadmap' && parts[2] === 'entry') {
      const roadmap = tx.roadmaps.find(record.workspaceId, parts[1]!);
      return !!roadmap?.attempts.some(
        (a) => a.entryId === parts[3] && this.cycleTransitioning(a.cycleId),
      );
    }
    return false;
  }
  /** Returns whether the set of active attention occurrences changed. */
  private reconcile(tx: StorageRepositories, settings: StoredNotificationSettings): boolean {
    const desired = this.attention(tx, settings);
    const records = tx.notifications.records(settings.workspaceId);
    const now = this.now();
    let changed = false;
    for (const record of records) {
      if (
        record.state === 'active' &&
        record.kind !== 'test' &&
        !this.transitioningRecord(tx, record) &&
        !desired.some((source) => source.sourceKey === record.sourceKey)
      ) {
        tx.notifications.saveRecord({
          ...record,
          state: 'resolved',
          resolvedAt: now.toISOString(),
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
        const flapped =
          existing.resolvedAt !== undefined &&
          now.getTime() - Date.parse(existing.resolvedAt) < NOTIFICATION_FLAP_WINDOW_MS;
        tx.notifications.saveRecord(
          flapped
            ? this.reopen(existing, source, settings)
            : { ...this.record(settings.workspaceId, source), id: existing.id },
        );
        changed = true;
      } else if (
        existing.firstSentAt !== null &&
        source.members?.some((member) => !existing.members?.includes(member))
      ) {
        // A set-valued alert gained a member: that is new work, so page again.
        tx.notifications.saveRecord({
          ...this.record(settings.workspaceId, source),
          id: existing.id,
        });
        changed = true;
      } else if (
        existing.title !== source.title ||
        existing.message !== source.message ||
        existing.path !== source.path ||
        existing.kind !== source.kind ||
        JSON.stringify(existing.members) !== JSON.stringify(source.members)
      ) {
        // Wording, a shrinking set, or a version bump: refresh the text silently.
        tx.notifications.saveRecord({
          ...existing,
          title: source.title,
          message: source.message,
          path: source.path,
          kind: source.kind,
          members: source.members,
        });
      }
    }
    if (changed) this.journal(tx, settings.workspaceId, 'attention');
    return changed;
  }
  private async deliverDue(): Promise<void> {
    for (const initial of this.storage.notifications.listSettings()) {
      if (this.abort.signal.aborted) return;
      for (let count = 0; count < 20 && !this.abort.signal.aborted; count += 1) {
        let changed = false;
        const claim = this.storage.transaction((tx) => {
          const settings = tx.notifications.settings(initial.workspaceId);
          if (settings) changed = this.reconcile(tx, settings);
          if (
            !settings ||
            !this.authorized(tx, settings) ||
            !settings.applicationToken ||
            !settings.userKey ||
            settings.blockedReason ||
            (settings.retryAt !== null && settings.retryAt > this.now().toISOString())
          )
            return undefined;
          const now = this.now().toISOString();
          const record = tx.notifications
            .records(settings.workspaceId, true)
            .filter(
              (row) =>
                (settings.preferences.enabled || row.kind === 'test') &&
                !this.transitioningRecord(tx, row) &&
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
        if (changed) this.notifier.notify('activity');
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
        changed = false;
        this.storage.transaction((tx) => {
          const currentSettings = tx.notifications.settings(settings.workspaceId);
          if (currentSettings === undefined) return;
          changed = this.reconcile(tx, currentSettings);
          const current = tx.notifications.find(settings.workspaceId, record.id);
          const now = this.now().toISOString();
          const seconds = [30, 60, 300, 900, 3600][Math.min(record.failures, 4)] ?? 3600;
          // Only the provider's own cooldown (rate limit) holds every alert. A transport
          // error or provider outage backs off this record alone (NOTIF-16).
          const cooldown =
            delivery.status === 'retry' && delivery.retryAt !== undefined ? delivery.retryAt : null;
          const retryAt = cooldown ?? new Date(this.now().getTime() + seconds * 1000).toISOString();
          // A provider cooldown belongs to the recipient configuration, even if
          // the incident resolved while the request was in flight. An old response
          // must never block credentials saved during that request.
          const blockedReason = delivery.status === 'blocked' ? delivery.reason : null;
          if (
            currentSettings.version === settings.version &&
            (currentSettings.retryAt !== cooldown ||
              currentSettings.blockedReason !== blockedReason)
          ) {
            tx.notifications.saveSettings({ ...currentSettings, retryAt: cooldown, blockedReason });
            // A rejection or provider cooldown changes what Settings shows; it is rare.
            this.journal(tx, settings.workspaceId, 'settings');
            changed = true;
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
              // One audit row per accepted push keeps pages attributable; retries,
              // failures and leases stay in the outbox row only (R-A2).
              this.journal(tx, settings.workspaceId, 'delivery', undefined, {
                notificationId: current.id,
                sourceKey: current.sourceKey,
                reminder: current.deliveredCount > 0,
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
            // The operator asked for this test and is watching Settings for its outcome.
            if (record.kind === 'test' && delivery.status !== 'retry') {
              this.journal(tx, settings.workspaceId, 'test');
              changed = true;
            }
          }
        });
        if (changed) this.notifier.notify('activity');
      }
    }
  }
  private journal(
    tx: StorageRepositories,
    workspaceId: WorkspaceId,
    action: 'settings' | 'attention' | 'delivery' | 'test',
    context?: AuthContext,
    detail: Record<string, string | boolean> = {},
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
      metadata: { action, ...detail },
    });
    // Delivery bookkeeping never invalidates browsers; only the attention set and
    // settings do (R-A2, NOTIF-10).
    if (action === 'delivery') return;
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
