import type {
  AgentRunId,
  StoragePolicy,
  UserId,
  WorkspaceId,
  WorktreeId,
} from '@craftingtable/domain';
export interface StorageRootIdentity {
  readonly path: string;
  readonly device: number;
}
export interface StoredStorageSettings {
  readonly version: number;
  readonly policy: StoragePolicy;
  readonly mergeRoot: StorageRootIdentity;
  readonly roots: Readonly<Record<'worktreeRoot' | 'runsRoot' | 'backupRoot', StorageRootIdentity>>;
}
export interface RunDirectory {
  readonly runId: AgentRunId;
  readonly workspaceId: WorkspaceId;
  readonly path: string;
  readonly device: number;
  readonly eligible: boolean;
  readonly buildEligible: boolean;
  readonly worktreeId: WorktreeId;
  readonly retainedSince: string;
}
export interface StorageBackup {
  readonly path: string;
  readonly createdAt: string;
  readonly bytes: number;
}
/** Written by a controlled drain; its presence at the next start means the stop was clean. */
export interface DaemonCleanStop {
  readonly stoppedAt: string;
  readonly interruptedRunCount: number;
}
export interface StorageMaintenanceRepository {
  settings(): StoredStorageSettings | undefined;
  saveSettings(value: StoredStorageSettings): void;
  ownsInstallation(userId: UserId): boolean;
  registerRunDirectory(runId: AgentRunId, path: string, device: number): void;
  unregisteredRuns(): readonly { readonly id: AgentRunId }[];
  directory(runId: AgentRunId): { path: string; device: number } | undefined;
  directories(): readonly RunDirectory[];
  protectedPaths(): readonly string[];
  activeWorktreePaths(): readonly string[];
  backups(): readonly StorageBackup[];
  saveBackup(backup: StorageBackup): void;
  forgetBackup(path: string): void;
  recordCleanStop(stop: DaemonCleanStop): void;
  /** Returns and removes the clean-stop record, so each start consumes it once. */
  takeCleanStop(): DaemonCleanStop | undefined;
}
