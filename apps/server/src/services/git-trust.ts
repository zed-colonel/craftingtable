import { dirname } from 'node:path';
import { checkoutGitDirectories, type GitTrust } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { ExecutionConfig } from '../config.js';
import type { StorageService } from './storage-service.js';

/**
 * What the daemon's Git trusts (R-G14 review MEDIUM-1): the common directories the registered
 * repositories' primary checkouts name (no agent writes a primary checkout), and the roots its
 * managed worktrees live under, the configured one, the stored one and each active worktree's.
 * Read per command, so a repository registered or a root moved since applies at once.
 */
export function daemonGitTrust(
  storage: CraftingTableStorage,
  execution: Pick<ExecutionConfig, 'worktreeRoot'>,
  storageService?: StorageService,
): GitTrust {
  const commonDirectories = storage.execution.sourceRepositories.listAll().flatMap((repository) => {
    const named = checkoutGitDirectories(repository.rootPath);
    return named === undefined ? [] : [named.commonDirectory];
  });
  let stored: string | undefined;
  try {
    stored = storageService?.executionConfig.worktreeRoot;
  } catch {
    // An unavailable volume: its worktrees are not reachable either.
  }
  const worktreeRoots = [
    execution.worktreeRoot,
    ...(stored === undefined ? [] : [stored]),
    ...storage.execution.worktrees.listActive().map((worktree) => dirname(worktree.path)),
  ];
  return {
    commonDirectories: [...new Set(commonDirectories)],
    worktreeRoots: [...new Set(worktreeRoots)],
  };
}
