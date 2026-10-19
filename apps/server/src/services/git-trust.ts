import { dirname } from 'node:path';
import { checkoutGitDirectories, type GitTrust } from '@craftingtable/git';
import type { CraftingTableStorage } from '@craftingtable/storage';
import type { ExecutionConfig } from '../config.js';
import type { StorageService } from './storage-service.js';

/**
 * What the daemon's Git trusts (R-G14 review MEDIUM-1): the common directories the registered
 * repositories' primary checkouts name (no agent writes a primary checkout), and the roots its
 * managed worktrees live under, the configured one, the stored one and each active worktree's.
 * Computed again only after a write it reads (`trustWrites`, R-B5 decision 13). `complete` is
 * false when a registered repository's checkout could not be read: such a trust is not kept, and
 * is computed again at the next command, as every command did before (increment 6 review LOW-1).
 */
export function daemonGitTrust(
  storage: CraftingTableStorage,
  execution: Pick<ExecutionConfig, 'worktreeRoot'>,
  storageService?: StorageService,
): { readonly trust: GitTrust; readonly complete: boolean } {
  let complete = true;
  const commonDirectories = storage.execution.sourceRepositories.listAll().flatMap((repository) => {
    const named = checkoutGitDirectories(repository.rootPath);
    if (named === undefined) complete = false;
    return named === undefined ? [] : [named.commonDirectory];
  });
  // Where the stored root is, whatever room it has left: the trust needs to know where worktrees
  // are, not whether a new one fits (increment 6 review LOW-1).
  const stored = storageService?.storedWorktreeRoot;
  const worktreeRoots = [
    execution.worktreeRoot,
    ...(stored === undefined ? [] : [stored]),
    ...storage.execution.worktrees.listActive().map((worktree) => dirname(worktree.path)),
  ];
  return {
    trust: {
      commonDirectories: [...new Set(commonDirectories)],
      worktreeRoots: [...new Set(worktreeRoots)],
    },
    complete,
  };
}

/**
 * When the daemon's Git trust must be read again (R-B5, decision 13): what `daemonGitTrust` reads
 * from the database changes only with a write of a worktree or of the storage settings (its
 * worktree root), or of a repository, which the record guard does not report: a committed
 * transaction that changed more rows than it reported guarded writes counts too. `bump` is called for
 * each, and the trust is computed again at the next command, not at every command.
 *
 * The count assumes each guarded write changes a row. A guarded compare-and-set that matches
 * none still counts, so one beside a repository's row in the same transaction would hide it; no
 * transaction pairs them (increment 6 review LOW-3, pinned through storage in
 * `git-trust-generation.test.ts`). A worktree or settings write inside a transaction bumps again
 * at its commit, so a trust read between the write and the commit is not kept (LOW-4).
 */
export function trustWrites(
  bump: () => void,
  inTransaction: () => boolean,
): import('@craftingtable/storage').WriteObserver {
  let wrote = 0;
  let bumped = false;
  return {
    written(kind) {
      const reads = kind === 'worktree' || kind === 'storage-settings';
      if (reads) bump();
      if (inTransaction()) {
        wrote += 1;
        if (reads) bumped = true;
      }
    },
    beforeCommit() {
      // Nothing: a bump already made errs only towards reading the trust again.
    },
    ended(committed, changed) {
      // More rows changed than guarded writes reported: a table the guard does not see, such as
      // a repository's registration beside its audit row.
      if (committed && (bumped || changed > wrote)) bump();
      wrote = 0;
      bumped = false;
    },
  };
}

/** The trust, computed once per generation (decision 13); an incomplete one is not kept. */
export function trustByGeneration(
  compute: () => { readonly trust: GitTrust; readonly complete: boolean },
): {
  readonly read: () => GitTrust;
  readonly bump: () => void;
} {
  let generation = 0;
  let held: { readonly generation: number; readonly value: GitTrust } | undefined;
  return {
    read: () => {
      if (held?.generation === generation) return held.value;
      const { trust, complete } = compute();
      held = complete ? { generation, value: trust } : undefined;
      return trust;
    },
    bump: () => {
      generation += 1;
    },
  };
}
