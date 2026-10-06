import { randomUUID } from 'node:crypto';
import type { NotificationStatus, SaveNotificationsRequest } from '@craftingtable/contracts';
import {
  type AttentionItem,
  asEventId,
  DEFAULT_NOTIFICATION_PREFERENCES,
  INSTALLATION_ATTENTION_CODES,
  type NotificationDelivery,
  nextReminderAt,
  notificationText,
  truncateUtf16,
  type WorkspaceId,
} from '@craftingtable/domain';
import type {
  NotificationRecord,
  StorageRepositories,
  StoredNotificationSettings,
} from '@craftingtable/storage';
import {
  MemoryCredentials,
  type PushoverCredentialStore,
  type PushoverCredentials,
} from '../security/credential-file.js';
import type { ControllerPasses, OperatorPresence } from './attention-gates.js';
import { inboxPath } from './attention-service.js';
import type { AuthContext } from './auth-service.js';
import { ExecutionRequestError } from './errors.js';
import type { DeliveryResult, NotificationTransport } from './notification-transport.js';
import type { WorkspaceEventNotifier } from './workspace-event-notifier.js';
import type { WorkspaceService } from './workspace-service.js';

/**
 * A new item waits this long before its first push; one the daemon resolves inside the
 * window is never sent (NOTIF-01).
 */
export const NOTIFICATION_SETTLE_MS = 30_000;
/**
 * The longest a first push waits for the controllers to go quiet. A controller pass that
 * hangs must not silence every alert.
 */
export const QUIESCENCE_LIMIT_MS = 2 * 60_000;
/** While the operator is watching, a new item waits this long before it is pushed (NOTIF-04). */
export const PRESENCE_GRACE_MS = 5 * 60_000;
/** A command this recent means the operator is at the controls: reminders wait. */
export const PRESENCE_WINDOW_MS = 5 * 60_000;
/** Pre-schema-32 outbox rows no item took over by then are resolved. */
export const LEGACY_SWEEP_AFTER_MS = 10 * 60_000;

/**
 * Everything the notification service may read or write. It has no access to cycles,
 * roadmaps, maps or the filesystem: attention arrives as items, projected where the state
 * that causes them is written (R-A4, ADR-070), so a delivery tick is a few indexed reads.
 */
type NotificationRepositories = Pick<
  StorageRepositories,
  | 'notifications'
  | 'attention'
  | 'audit'
  | 'workspaceEvents'
  | 'workspaces'
  | 'users'
  | 'maintenance'
>;
export interface NotificationStorage extends NotificationRepositories {
  transaction<T>(operation: (tx: NotificationRepositories) => T): T;
}

/** The projection this service reads through; see `AttentionProjector`. */
export interface AttentionSource {
  /** Catches up on writes made outside a transaction. */
  flush(): void;
  /** The controller pass sequence the item opened at. */
  openedPass(itemId: string): number;
}

export interface NotificationServiceOptions {
  /** Where the Pushover credentials are kept (R-G9): the daemon's credentials file. */
  readonly credentials?: PushoverCredentialStore;
  readonly settleMs?: number;
  readonly presenceGraceMs?: number;
  readonly presenceWindowMs?: number;
}

type Claim =
  | { readonly kind: 'items'; readonly items: readonly AttentionItem[] }
  | { readonly kind: 'test'; readonly record: NotificationRecord };

export class NotificationService {
  private readonly abort = new AbortController();
  private worker: Promise<void> | undefined;
  private ticking: Promise<void> | undefined;
  private readonly credentials: PushoverCredentialStore;
  private readonly settleMs: number;
  private readonly presenceGraceMs: number;
  private readonly presenceWindowMs: number;
  private legacySwept = false;
  private readonly bootedAt: number;
  constructor(
    private readonly storage: NotificationStorage,
    private readonly workspaces: WorkspaceService,
    private readonly notifier: WorkspaceEventNotifier,
    private readonly transport: NotificationTransport,
    private readonly publicOrigin: string,
    private readonly attention: AttentionSource,
    private readonly passes: ControllerPasses,
    private readonly presence: OperatorPresence,
    private readonly now: () => Date = () => new Date(),
    /** A cycle whose item waits: a transition is being prepared, or an investigation runs. */
    private readonly cycleTransitioning: (id: string, workspaceId: WorkspaceId) => boolean = () =>
      false,
    options: NotificationServiceOptions = {},
  ) {
    this.credentials = options.credentials ?? new MemoryCredentials();
    this.settleMs = options.settleMs ?? NOTIFICATION_SETTLE_MS;
    this.bootedAt = now().getTime();
    this.presenceGraceMs = options.presenceGraceMs ?? PRESENCE_GRACE_MS;
    this.presenceWindowMs = options.presenceWindowMs ?? PRESENCE_WINDOW_MS;
  }

  /**
   * Moves Pushover credentials still in the database into the credentials file, at start
   * (R-G9). One the file already holds for that workspace is kept; the database's are cleared
   * either way. The settings' version is unchanged: what they say has not.
   */
  adoptStoredCredentials(): number {
    let moved = 0;
    this.storage.transaction((tx) => {
      for (const settings of tx.notifications.listSettings()) {
        if (settings.applicationToken === null && settings.userKey === null) continue;
        if (
          settings.applicationToken &&
          settings.userKey &&
          this.credentials.pushover(settings.workspaceId) === undefined
        )
          this.credentials.setPushover(settings.workspaceId, {
            applicationToken: settings.applicationToken,
            userKey: settings.userKey,
          });
        tx.notifications.saveSettings({ ...settings, applicationToken: null, userKey: null });
        moved += 1;
      }
    });
    return moved;
  }

  /**
   * A workspace's credentials, or why the credentials file cannot be read (R-G9 review): the
   * page says so, and delivery waits for it, rather than every workspace's delivery failing.
   */
  private readCredentials(workspaceId: WorkspaceId): {
    readonly held?: PushoverCredentials;
    readonly unreadable?: string;
  } {
    try {
      const held = this.credentials.pushover(workspaceId);
      return held === undefined ? {} : { held };
    } catch (error) {
      return { unreadable: error instanceof Error ? error.message : String(error) };
    }
  }

  get(context: AuthContext, workspaceId: WorkspaceId): NotificationStatus {
    this.workspaces.requireRole(context, workspaceId, ['owner']);
    const settings = this.storage.notifications.settings(workspaceId);
    const credentials = this.readCredentials(workspaceId);
    const installation = this.storage.maintenance.ownsInstallation(context.user.id);
    const items = this.storage.attention
      .recent(workspaceId, 50)
      .filter((item) => installation || !INSTALLATION_ATTENTION_CODES.has(item.code))
      .map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        message: item.message,
        // An open item is decided in the inbox; a resolved one is history of its subject.
        path: item.state === 'open' ? inboxPath(workspaceId, item.id) : item.path,
        state: item.state === 'open' ? ('active' as const) : ('resolved' as const),
        createdAt: item.openedAt,
        lastSentAt: item.delivery.lastSentAt,
        nextAttemptAt: item.delivery.nextAttemptAt,
        deliveredCount: item.delivery.deliveredCount,
        lastError: item.delivery.lastError,
        activity: item.resolvedAt ?? item.openedAt,
      }));
    const tests = this.storage.notifications
      .records(workspaceId)
      .filter((record) => record.kind === 'test')
      .slice(0, 10)
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
        activity: record.lastSentAt ?? record.createdAt,
      }));
    return {
      preferences: settings?.preferences ?? DEFAULT_NOTIFICATION_PREFERENCES,
      version: settings?.version ?? 0,
      credentialsConfigured: credentials.held !== undefined,
      blockedReason: settings?.blockedReason ?? credentials.unreadable ?? null,
      retryAt: settings?.retryAt ?? null,
      // Open items first, then by last activity, so a current alert is never pushed off (NOTIF-07).
      records: [...items, ...tests]
        .sort(
          (a, b) =>
            Number(b.state === 'active') - Number(a.state === 'active') ||
            b.activity.localeCompare(a.activity),
        )
        .slice(0, 50)
        .map(({ activity: _activity, ...record }) => record),
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
      const held = this.credentials.pushover(workspaceId);
      const applicationToken = input.clearCredentials
        ? null
        : (input.applicationToken ?? held?.applicationToken ?? null);
      const userKey = input.clearCredentials ? null : (input.userKey ?? held?.userKey ?? null);
      if (input.preferences.enabled && !(applicationToken && userKey))
        throw new ExecutionRequestError(
          'invalid-request',
          'Configure both Pushover credentials before enabling notifications.',
        );
      const settings: StoredNotificationSettings = {
        workspaceId,
        ownerUserId: context.user.id,
        preferences: input.preferences,
        // The credentials are kept in the credentials file, never the database (R-G9).
        applicationToken: null,
        userKey: null,
        version: input.expectedVersion + 1,
        blockedReason: null,
        retryAt: null,
      };
      tx.notifications.saveSettings(settings);
      // Changing local reminder time takes effect for the daily phase immediately.
      const now = this.now().toISOString();
      for (const item of tx.attention.open(workspaceId)) {
        const { delivery } = item;
        if (delivery.failures > 0)
          tx.attention.update({ ...item, delivery: { ...delivery, nextAttemptAt: now } });
        else if (delivery.firstSentAt !== null)
          tx.attention.update({
            ...item,
            delivery: {
              ...delivery,
              nextAttemptAt: nextReminderAt(
                delivery.firstSentAt,
                delivery.lastSentAt ?? delivery.firstSentAt,
                settings.preferences,
              ),
            },
          });
      }
      for (const record of tx.notifications.records(workspaceId, true))
        if (record.failures > 0) tx.notifications.saveRecord({ ...record, nextAttemptAt: now });
      this.journal(tx, workspaceId, 'settings', context);
      // Last, so a save the database refuses changes no credentials; a file that cannot be
      // written fails the save.
      this.credentials.setPushover(
        workspaceId,
        applicationToken && userKey ? { applicationToken, userKey } : undefined,
      );
    });
    this.notifier.notify('activity');
    return this.get(context, workspaceId);
  }
  test(context: AuthContext, workspaceId: WorkspaceId): NotificationStatus {
    this.workspaces.requireRole(context, workspaceId, ['owner']);
    this.storage.transaction((tx) => {
      const settings = tx.notifications.settings(workspaceId);
      if (!settings || this.credentials.pushover(workspaceId) === undefined)
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
      const now = this.now().toISOString();
      tx.notifications.saveRecord({
        id: randomUUID(),
        workspaceId,
        sourceKey: `test:${randomUUID()}`,
        kind: 'test',
        title: 'CraftingTable notification test',
        message:
          'Pushover is connected. Open CraftingTable to review work that needs your attention.',
        path: `/workspaces/${encodeURIComponent(workspaceId)}/settings`,
        state: 'active',
        createdAt: now,
        firstSentAt: null,
        lastSentAt: null,
        // An explicit test is the operator's own request: it does not settle.
        nextAttemptAt: now,
        deliveredCount: 0,
        failures: 0,
        lastError: null,
        leaseToken: null,
        leaseUntil: null,
      });
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
  private authorized(tx: NotificationRepositories, settings: StoredNotificationSettings): boolean {
    const access = tx.workspaces.findAuthorized(settings.ownerUserId, settings.workspaceId);
    return (
      access?.membership.role === 'owner' &&
      access.workspace.status === 'active' &&
      tx.users.findById(settings.ownerUserId)?.status === 'active'
    );
  }
  /**
   * Whether an open item may be pushed now: operator-owned (every item is), wanted by the
   * preferences, due, settled, not in a command's hands, and, for a first push, after the
   * controllers went quiet and outside the grace a watching operator gets. Reminders wait
   * while the operator is issuing commands.
   */
  private eligible(
    tx: NotificationRepositories,
    settings: StoredNotificationSettings,
    item: AttentionItem,
    now: number,
    present: { readonly watching: boolean; readonly commanding: boolean },
  ): boolean {
    const { preferences } = settings;
    const { delivery } = item;
    if (!(item.kind === 'merge' ? preferences.mergeReady : preferences.needsAttention))
      return false;
    if (
      INSTALLATION_ATTENTION_CODES.has(item.code) &&
      !tx.maintenance.ownsInstallation(settings.ownerUserId)
    )
      return false;
    if (delivery.leaseUntil !== null && Date.parse(delivery.leaseUntil) > now) return false;
    if (item.refs.cycleId && this.cycleTransitioning(item.refs.cycleId, item.workspaceId))
      return false;
    const first = delivery.firstSentAt === null;
    // A set that gained a member pages from then on, through the same gates (R-A4 review).
    const since = Date.parse(delivery.since ?? item.openedAt);
    const due =
      first && delivery.failures === 0
        ? Math.max(Date.parse(delivery.nextAttemptAt), since) + this.settleMs
        : Date.parse(delivery.nextAttemptAt);
    if (due > now) return false;
    if (!first) return !present.commanding;
    const age = now - since;
    if (age < QUIESCENCE_LIMIT_MS && !this.passes.quietSince(this.attention.openedPass(item.id)))
      return false;
    return !((present.watching || present.commanding) && age < this.presenceGraceMs);
  }
  /**
   * Resolves pre-schema-32 outbox rows that no item took over. The projector folds each
   * row into the first item for its subject; rows still active well after boot describe a
   * state that no longer exists.
   */
  private sweepLegacy(): void {
    if (this.legacySwept || this.now().getTime() - this.bootedAt < LEGACY_SWEEP_AFTER_MS) return;
    this.storage.transaction((tx) => {
      for (const settings of tx.notifications.listSettings())
        for (const record of tx.notifications.records(settings.workspaceId, true))
          if (record.kind !== 'test')
            tx.notifications.saveRecord({
              ...record,
              state: 'resolved',
              resolvedAt: this.now().toISOString(),
              leaseToken: null,
              leaseUntil: null,
            });
    });
    this.legacySwept = true;
  }
  private claim(workspaceId: WorkspaceId): Claim | undefined {
    return this.storage.transaction((tx) => {
      const settings = tx.notifications.settings(workspaceId);
      if (
        !settings ||
        !this.authorized(tx, settings) ||
        this.readCredentials(workspaceId).held === undefined ||
        settings.blockedReason ||
        (settings.retryAt !== null && settings.retryAt > this.now().toISOString())
      )
        return undefined;
      const now = this.now();
      const at = now.toISOString();
      const lease = () => ({
        leaseToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + 60_000).toISOString(),
      });
      // An explicit test goes first and alone.
      const test = tx.notifications
        .records(workspaceId, true)
        .filter(
          (row) =>
            row.kind === 'test' &&
            row.nextAttemptAt <= at &&
            (row.leaseUntil === null || row.leaseUntil <= at),
        )
        .sort((a, b) => a.nextAttemptAt.localeCompare(b.nextAttemptAt))[0];
      if (test) {
        const record = { ...test, ...lease() };
        tx.notifications.saveRecord(record);
        return { kind: 'test', record };
      }
      if (!settings.preferences.enabled) return undefined;
      const lastCommand = tx.audit.lastUserAction(workspaceId, settings.ownerUserId);
      const present = {
        watching: this.presence.watching(workspaceId, settings.ownerUserId),
        commanding:
          lastCommand !== undefined &&
          now.getTime() - Date.parse(lastCommand) < this.presenceWindowMs,
      };
      const due = tx.attention
        .open(workspaceId)
        .filter((item) => this.eligible(tx, settings, item, now.getTime(), present));
      if (!due.length) return undefined;
      // One digest per workspace per wake: every newly eligible item and due reminder.
      const token = lease();
      const items = due.map((item) => ({ ...item, delivery: { ...item.delivery, ...token } }));
      for (const item of items) tx.attention.update(item);
      return { kind: 'items', items };
    });
  }
  private async deliverDue(): Promise<void> {
    this.attention.flush();
    this.sweepLegacy();
    for (const initial of this.storage.notifications.listSettings()) {
      if (this.abort.signal.aborted) return;
      for (let count = 0; count < 20 && !this.abort.signal.aborted; count += 1) {
        const claim = this.claim(initial.workspaceId);
        if (claim === undefined) break;
        const settings = this.storage.notifications.settings(initial.workspaceId)!;
        const credentials = this.readCredentials(settings.workspaceId).held;
        const message = this.message(settings.workspaceId, claim);
        let delivery: DeliveryResult;
        try {
          if (credentials === undefined) throw new Error('The Pushover credentials were removed.');
          delivery = await this.transport.send(
            {
              applicationToken: credentials.applicationToken,
              userKey: credentials.userKey,
              device: settings.preferences.device,
              ...message,
              url: new URL(message.path, this.publicOrigin).href,
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
        let changed = false;
        this.storage.transaction((tx) => {
          const currentSettings = tx.notifications.settings(settings.workspaceId);
          if (currentSettings === undefined) return;
          const now = this.now().toISOString();
          const failures =
            claim.kind === 'test'
              ? claim.record.failures
              : Math.max(...claim.items.map((item) => item.delivery.failures));
          const seconds = [30, 60, 300, 900, 3600][Math.min(failures, 4)] ?? 3600;
          // Only the provider's own cooldown (rate limit) holds every alert. A transport
          // error or provider outage backs off this delivery's items alone (NOTIF-16).
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
          const record: NotificationDelivery = {
            id: randomUUID(),
            workspaceId: settings.workspaceId,
            attemptedAt: now,
            itemIds: claim.kind === 'items' ? claim.items.map((item) => item.id) : [],
            reminderItemIds:
              claim.kind === 'items'
                ? claim.items
                    .filter((item) => item.delivery.firstSentAt !== null)
                    .map((item) => item.id)
                : [],
            ...(claim.kind === 'test' ? { testId: claim.record.id } : {}),
            title: message.title,
            message: message.message,
            result: delivery.status,
            ...(delivery.status === 'accepted' ? {} : { error: delivery.reason }),
          };
          // Every attempt is kept, including for items that resolved while it was in flight.
          // The push has happened: failing to log it must not keep the lease and resend.
          try {
            this.storage.transaction((inner) => inner.attention.appendDelivery(record));
          } catch {
            /* The items below still record the send. */
          }
          if (claim.kind === 'test') {
            const current = tx.notifications.find(settings.workspaceId, claim.record.id);
            if (current?.leaseToken === claim.record.leaseToken) {
              const released = { ...current, leaseToken: null, leaseUntil: null };
              tx.notifications.saveRecord(
                delivery.status === 'accepted'
                  ? {
                      ...released,
                      firstSentAt: current.firstSentAt ?? now,
                      lastSentAt: now,
                      deliveredCount: current.deliveredCount + 1,
                      failures: 0,
                      lastError: null,
                      state: 'resolved',
                    }
                  : {
                      ...released,
                      failures: current.failures + 1,
                      nextAttemptAt: retryAt,
                      lastError: delivery.reason,
                      state: delivery.status === 'blocked' ? 'resolved' : current.state,
                    },
              );
            }
            // The operator asked for this test and is watching Settings for its outcome.
            if (delivery.status !== 'retry') {
              this.journal(tx, settings.workspaceId, 'test');
              changed = true;
            }
          } else {
            for (const claimed of claim.items) {
              const current = tx.attention.find(settings.workspaceId, claimed.id);
              // A resolved item is history; the delivery row above records the push.
              if (
                current?.state !== 'open' ||
                current.delivery.leaseToken !== claimed.delivery.leaseToken
              )
                continue;
              const released = { ...current.delivery, leaseToken: null, leaseUntil: null };
              if (delivery.status === 'accepted') {
                const firstSentAt = released.firstSentAt ?? now;
                tx.attention.update({
                  ...current,
                  delivery: {
                    ...released,
                    firstSentAt,
                    lastSentAt: now,
                    deliveredCount: released.deliveredCount + 1,
                    failures: 0,
                    lastError: null,
                    nextAttemptAt: nextReminderAt(firstSentAt, now, currentSettings.preferences),
                  },
                });
              } else
                tx.attention.update({
                  ...current,
                  delivery: {
                    ...released,
                    failures: released.failures + 1,
                    nextAttemptAt: retryAt,
                    lastError: delivery.reason,
                  },
                });
            }
          }
          // One audit row per accepted push keeps pages attributable; retries,
          // failures and leases stay in the delivery log (R-A2).
          if (delivery.status === 'accepted')
            this.journal(tx, settings.workspaceId, 'delivery', undefined, {
              deliveryId: record.id,
              items: record.itemIds.join(','),
              reminder: record.reminderItemIds.length > 0,
            });
        });
        if (changed) this.notifier.notify('activity');
      }
    }
  }
  /** The push text, rendered from the items' current state at send time (NOTIF-12). */
  private message(
    workspaceId: WorkspaceId,
    claim: Claim,
  ): { readonly title: string; readonly message: string; readonly path: string } {
    const text = this.text(workspaceId, claim);
    // Stored bounds count UTF-16 units; `notificationText` counts code points.
    return {
      ...text,
      title: truncateUtf16(text.title, 250),
      message: truncateUtf16(text.message, 1024),
    };
  }
  private text(
    workspaceId: WorkspaceId,
    claim: Claim,
  ): { readonly title: string; readonly message: string; readonly path: string } {
    if (claim.kind === 'test') return claim.record;
    const reminder = (item: AttentionItem) => item.delivery.deliveredCount > 0;
    const [only] = claim.items;
    if (claim.items.length === 1 && only)
      return {
        title: notificationText(only.title, 250),
        message: notificationText(`${reminder(only) ? 'Reminder: ' : ''}${only.message}`, 1024),
        // Every push opens the inbox: the item itself, or the list for a digest (R-A5).
        path: inboxPath(workspaceId, only.id),
      };
    const fresh = claim.items.filter((item) => !reminder(item));
    const lines = [...fresh, ...claim.items.filter(reminder)].map(
      (item) => `${reminder(item) ? 'Reminder: ' : ''}${item.title}`,
    );
    return {
      title: notificationText(`CraftingTable · ${claim.items.length} items need you`, 250),
      message: notificationText(lines.join('\n'), 1024),
      path: inboxPath(workspaceId),
    };
  }
  private journal(
    tx: NotificationRepositories,
    workspaceId: WorkspaceId,
    action: 'settings' | 'delivery' | 'test',
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
