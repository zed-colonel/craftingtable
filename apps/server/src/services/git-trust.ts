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

/**
 * When the daemon's Git trust must be read again (R-B5, decision 13): what `daemonGitTrust` reads
 * from the database changes only with a write of a worktree or of the storage settings (its
 * worktree root), or of a repository, which the record guard does not report: a committed
 * transaction that changed more rows than it reported guarded writes counts too. `bump` is called for
 * each, and the trust is computed again at the next command, not at every command.
 */
export function trustWrites(
  bump: () => void,
  inTransaction: () => boolean,
): import('@craftingtable/storage').WriteObserver {
  let wrote = 0;
  return {
    written(kind) {
      if (kind === 'worktree' || kind === 'storage-settings') bump();
      if (inTransaction()) wrote += 1;
    },
    beforeCommit() {
      // Nothing: a bump already made errs only towards reading the trust again.
    },
    ended(committed, changed) {
      // More rows changed than guarded writes reported: a table the guard does not see, such as
      // a repository's registration beside its audit row.
      if (committed && changed > wrote) bump();
      wrote = 0;
    },
  };
}

/** The trust, computed once per generation (decision 13). */
export function trustByGeneration(compute: () => GitTrust): {
  readonly read: () => GitTrust;
  readonly bump: () => void;
} {
  let generation = 0;
  let held: { readonly generation: number; readonly value: GitTrust } | undefined;
  return {
    read: () => {
      if (held?.generation !== generation) held = { generation, value: compute() };
      return held.value;
    },
    bump: () => {
      generation += 1;
    },
  };
}
