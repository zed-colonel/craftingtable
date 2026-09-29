import { realpathSync } from 'node:fs';
import type { GitOperations } from '@craftingtable/git';

/** A protected branch that moved during a run by something other than the daemon. */
export interface UnexplainedMove {
  readonly branch: string;
  readonly before: string | null;
  readonly after: string | null;
}

/** Git operations that can move a branch: the daemon records what each one left behind. */
const MOVING_OPERATIONS = new Set<keyof GitOperations>([
  'mergeBranch',
  'prepareIntegrationResolution',
  'finishIntegrationResolution',
  'abortIntegrationResolution',
  'checkpointWorktree',
  'createBranch',
  'deleteBranch',
  'updateWorktree',
  'createWorktree',
  'removeWorktree',
]);

interface Observation {
  readonly at: number;
  readonly heads: Readonly<Record<string, string>>;
}

const canonical = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Protected-ref snapshots (R-G5, SEC-02d). Before a run the daemon records a repository's
 * branch heads; when the run ends it compares. A branch no managed worktree owns (main, an
 * integration branch, the operator's own) that moved is flagged unless the daemon's own Git left
 * it at that commit during the run: every daemon operation that can move a branch records the
 * heads it left behind. Kept in memory: a restart ends the runs it watched.
 */
export class RefWatch {
  private readonly snapshots = new Map<
    string,
    { readonly repository: string; readonly at: number; readonly heads: Record<string, string> }
  >();
  private readonly observations = new Map<string, Observation[]>();
  private sequence = 0;

  /** The daemon's Git, recording the branch heads each moving operation leaves behind. */
  wrap(git: GitOperations): GitOperations {
    return new Proxy(git, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function' || !MOVING_OPERATIONS.has(property as keyof GitOperations))
          return value;
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          const input = args[0];
          const path =
            typeof input === 'string'
              ? input
              : typeof input === 'object' && input !== null
                ? ((input as { repositoryPath?: string }).repositoryPath ??
                  (input as { worktreePath?: string }).worktreePath)
                : undefined;
          if (path && this.snapshots.size > 0) await this.observe(target, path);
          return result;
        };
      },
    });
  }

  /** Records the repository's branch heads as the run starts. */
  async snapshot(runId: string, git: GitOperations, repositoryPath: string): Promise<void> {
    const heads = await git.branchHeads(repositoryPath);
    if (!heads.ok) return;
    this.snapshots.set(runId, {
      repository: canonical(repositoryPath),
      at: this.tick(),
      heads: heads.value,
    });
  }

  /**
   * The protected branches that moved since the run's snapshot and that no daemon operation
   * explains. `ownedBranches` are the managed worktrees' branches, which their runs move.
   */
  async unexplainedMoves(
    runId: string,
    git: GitOperations,
    ownedBranches: readonly string[],
  ): Promise<UnexplainedMove[]> {
    const snapshot = this.snapshots.get(runId);
    if (!snapshot) return [];
    const now = await git.branchHeads(snapshot.repository);
    const seen = (this.observations.get(snapshot.repository) ?? []).filter(
      (o) => o.at > snapshot.at,
    );
    this.snapshots.delete(runId);
    this.prune();
    if (!now.ok) return [];
    const owned = new Set(ownedBranches);
    const branches = [...new Set([...Object.keys(snapshot.heads), ...Object.keys(now.value)])]
      .filter((branch) => !owned.has(branch))
      .sort();
    return branches.flatMap((branch) => {
      const before = snapshot.heads[branch] ?? null;
      const after = now.value[branch] ?? null;
      if (before === after) return [];
      if (seen.some((o) => (o.heads[branch] ?? null) === after)) return [];
      return [{ branch, before, after }];
    });
  }

  private async observe(git: GitOperations, path: string): Promise<void> {
    const heads = await git.branchHeads(path);
    if (!heads.ok) return;
    const repository = canonical(path);
    const list = this.observations.get(repository) ?? [];
    list.push({ at: this.tick(), heads: heads.value });
    this.observations.set(repository, list);
  }

  /** Drops observations no live snapshot can need. */
  private prune(): void {
    const oldest = Math.min(...[...this.snapshots.values()].map((s) => s.at));
    for (const [repository, list] of this.observations) {
      const kept = list.filter((o) => o.at > oldest);
      if (kept.length) this.observations.set(repository, kept);
      else this.observations.delete(repository);
    }
  }

  private tick(): number {
    this.sequence += 1;
    return this.sequence;
  }
}
