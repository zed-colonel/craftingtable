/** Installation-wide storage placement and retention; no filesystem authority here. */
export interface StoragePolicy {
  readonly worktreeRoot: string;
  readonly runsRoot: string;
  readonly backupRoot: string;
  readonly autoCleanBuildCaches: boolean;
  readonly scratchRetentionDays: 0 | 30;
  readonly minimumFreeGiB: number;
  readonly dailyBackups: boolean;
  readonly backupsToKeep: number;
}
