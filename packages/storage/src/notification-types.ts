import type {
  AttentionItem,
  NotificationDelivery,
  NotificationPreferences,
  UserId,
  WorkspaceId,
} from '@craftingtable/domain';
/** Private storage types: credentials never enter wire responses, journals, or agent environments. */
export interface StoredNotificationSettings {
  workspaceId: WorkspaceId;
  ownerUserId: UserId;
  preferences: NotificationPreferences;
  applicationToken: string | null;
  userKey: string | null;
  version: number;
  blockedReason: string | null;
  retryAt: string | null;
}
export interface NotificationRecord {
  id: string;
  workspaceId: WorkspaceId;
  sourceKey: string;
  kind: 'merge' | 'attention' | 'test';
  title: string;
  message: string;
  path: string;
  state: 'active' | 'resolved';
  createdAt: string;
  firstSentAt: string | null;
  lastSentAt: string | null;
  nextAttemptAt: string;
  deliveredCount: number;
  failures: number;
  lastError: string | null;
  leaseToken: string | null;
  leaseUntil: string | null;
  /** When the occurrence last resolved; a quick reopen reactivates it without a new page. */
  resolvedAt?: string;
  /** Members of a set-valued alert; only a newly added member re-pages. */
  members?: readonly string[];
}
export interface NotificationRepository {
  settings(workspaceId: WorkspaceId): StoredNotificationSettings | undefined;
  listSettings(): readonly StoredNotificationSettings[];
  saveSettings(settings: StoredNotificationSettings): void;
  records(workspaceId: WorkspaceId, activeOnly?: boolean): readonly NotificationRecord[];
  find(workspaceId: WorkspaceId, id: string): NotificationRecord | undefined;
  saveRecord(record: NotificationRecord): void;
}

/** Attention occurrences and the push log (R-A4, ADR-070). */
export interface AttentionRepository {
  /** Open items, oldest first; every workspace when none is given. */
  open(workspaceId?: WorkspaceId): readonly AttentionItem[];
  openInScope(workspaceId: WorkspaceId, scopeKey: string): readonly AttentionItem[];
  /** Workspace and scope of every open item, for a full rebuild. */
  openScopes(): readonly { readonly workspaceId: WorkspaceId; readonly scopeKey: string }[];
  find(workspaceId: WorkspaceId, id: string): AttentionItem | undefined;
  /** The latest occurrence of a subject at a code, open or resolved. */
  latest(workspaceId: WorkspaceId, subjectKey: string, code: string): AttentionItem | undefined;
  /** Most recently opened or resolved items, for the settings history. */
  recent(workspaceId: WorkspaceId, limit: number): readonly AttentionItem[];
  insert(item: AttentionItem): void;
  /** Updates an open item; storage refuses to change a resolved one. */
  update(item: AttentionItem): void;
  appendDelivery(delivery: NotificationDelivery): void;
  deliveries(workspaceId: WorkspaceId, limit: number): readonly NotificationDelivery[];
  /** Items the daemon resolved by itself after a push had been accepted for them. */
  falseAlarms(workspaceId: WorkspaceId): readonly AttentionItem[];
}
