import type { GitOperations } from '@craftingtable/git';

/** A protected ref that moved during a run by something other than the daemon. */
export interface UnexplainedMove {
  /** A branch by its short name; a tag as `refs/tags/<name>`. */
  readonly branch: string;
  readonly before: string | null;
  readonly after: string | null;
}

/** Git operations that can move a ref: the daemon records what each one changed. */
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
  'ensureBaselineTag',
]);

/** A ref one daemon operation moved, and where it left it. */
interface Change {
  readonly at: number;
  readonly ref: string;
  readonly value: string | null;
}

/** Snapshots older than this belong to runs that never ended in this daemon. */
const SNAPSHOT_LIFETIME_MS = 48 * 60 * 60 * 1000;

const display = (ref: string) =>
  ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;

/**
 * Protected-ref snapshots (R-G5, SEC-02d). Before a run the daemon records its repository's
 * branches and tags; when the run ends it compares. A ref no managed worktree owns (main, an
 * integration branch, a tag, the operator's own branches) that moved is flagged unless one of
 * the daemon's own Git operations moved that ref to that commit during the run: each operation
 * that can move a ref records the refs that changed across it, keyed by the repository's common
 * git directory. Kept in memory: a restart ends the runs it watched.
 */
export class RefWatch {
  private readonly snapshots = new Map<
    string,
    {
      readonly repository: string;
      readonly at: number;
      readonly takenAt: number;
      readonly heads: Readonly<Record<string, string>>;
    }
  >();
  private readonly changes = new Map<string, Change[]>();
  private sequence = 0;

  constructor(private readonly clock: () => number = Date.now) {}

  /** The daemon's Git, recording the refs each moving operation changes. */
  wrap(git: GitOperations): GitOperations {
    return new Proxy(git, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function' || !MOVING_OPERATIONS.has(property as keyof GitOperations))
          return value;
        return async (...args: unknown[]) => {
          const input = args[0];
          const path =
            typeof input === 'string'
              ? input
              : typeof input === 'object' && input !== null
                ? ((input as { repositoryPath?: string }).repositoryPath ??
                  (input as { worktreePath?: string }).worktreePath)
                : undefined;
          const watching = path !== undefined && this.snapshots.size > 0;
          const before = watching ? await target.branchHeads(path) : undefined;
          const result = await value.apply(target, args);
          if (watching && before?.ok) {
            const after = await target.branchHeads(path);
            if (after.ok)
              this.record(after.value.repository, before.value.heads, after.value.heads);
          }
          return result;
        };
      },
    });
  }

  /** Records the repository's refs as the run starts. */
  async snapshot(runId: string, git: GitOperations, repositoryPath: string): Promise<void> {
    this.expire();
    const heads = await git.branchHeads(repositoryPath);
    if (!heads.ok) return;
    this.snapshots.set(runId, {
      repository: heads.value.repository,
      at: this.tick(),
      takenAt: this.clock(),
      heads: heads.value.heads,
    });
  }

  /**
   * The protected refs that moved since the run's snapshot and that no daemon operation
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
    const changes = (this.changes.get(snapshot.repository) ?? []).filter((c) => c.at > snapshot.at);
    this.snapshots.delete(runId);
    this.prune();
    if (!now.ok) return [];
    const owned = new Set(ownedBranches.map((branch) => `refs/heads/${branch}`));
    const refs = [...new Set([...Object.keys(snapshot.heads), ...Object.keys(now.value.heads)])]
      .filter((ref) => !owned.has(ref))
      .sort();
    return refs.flatMap((ref) => {
      const before = snapshot.heads[ref] ?? null;
      const after = now.value.heads[ref] ?? null;
      if (before === after) return [];
      if (changes.some((c) => c.ref === ref && c.value === after)) return [];
      return [{ branch: display(ref), before, after }];
    });
  }

  private record(
    repository: string,
    before: Readonly<Record<string, string>>,
    after: Readonly<Record<string, string>>,
  ): void {
    const at = this.tick();
    const list = this.changes.get(repository) ?? [];
    for (const ref of new Set([...Object.keys(before), ...Object.keys(after)]))
      if ((before[ref] ?? null) !== (after[ref] ?? null))
        list.push({ at, ref, value: after[ref] ?? null });
    if (list.length) this.changes.set(repository, list);
  }

  /** Drops changes no live snapshot can need. */
  private prune(): void {
    const oldest = Math.min(...[...this.snapshots.values()].map((s) => s.at));
    for (const [repository, list] of this.changes) {
      const kept = list.filter((c) => c.at > oldest);
      if (kept.length) this.changes.set(repository, kept);
      else this.changes.delete(repository);
    }
  }

  /** Forgets snapshots of runs that never ended here, so their changes are not kept forever. */
  private expire(): void {
    const cutoff = this.clock() - SNAPSHOT_LIFETIME_MS;
    for (const [runId, snapshot] of this.snapshots)
      if (snapshot.takenAt < cutoff) this.snapshots.delete(runId);
    this.prune();
  }

  private tick(): number {
    this.sequence += 1;
    return this.sequence;
  }
}

type Move = Pick<UnexplainedMove, 'branch' | 'before' | 'after'>;

/**
 * The moves not already waiting in an unacknowledged record (R-G5 review): runs that overlap on
 * one repository each see the same outside move, which the operator needs to see once.
 */
export function unrecordedMoves(
  recorded: readonly { readonly moves: readonly Move[] }[],
  moves: readonly Move[],
): Move[] {
  const key = (m: Move) => `${m.branch}\u0000${m.before ?? ''}\u0000${m.after ?? ''}`;
  const seen = new Set(recorded.flatMap((r) => r.moves.map(key)));
  return moves.filter((m) => !seen.has(key(m)));
}

/** Most moves one record holds; a larger set (a fetch of many tags) takes several. */
const MOVES_PER_RECORD = 1000;

export function moveRecords(moves: readonly Move[]): Move[][] {
  const records: Move[][] = [];
  for (let at = 0; at < moves.length; at += MOVES_PER_RECORD)
    records.push(moves.slice(at, at + MOVES_PER_RECORD));
  return records;
}
