import type { NotificationPreferences, UserId, WorkspaceId } from '@craftingtable/domain';
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
