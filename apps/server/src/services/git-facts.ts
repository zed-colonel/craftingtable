import type { GitOperations } from '@craftingtable/git';

/** A full object name: SHA-1 or SHA-256. Abbreviations can become ambiguous, so they are not kept. */
const OBJECT_NAME = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Git facts that resolved commits pin, asked of Git once (R-D5, PERF-09).
 *
 * Read paths ask whether recorded merges are in the integration branch's head, and whether a
 * worktree contains its target, on every refresh: one `git merge-base --is-ancestor` each, per
 * completed item and per worktree. Once one commit is an ancestor of another it stays one, so
 * the answer is kept by the repository and the two object names. A `false` is not kept: a merge
 * absent from integration may arrive, and a shallow history may deepen. Refs are resolved on
 * every read, so each read still sees the branch where it is now; only what follows from the
 * commits it resolved to is remembered. The newest `limit` facts are kept.
 */
export class GitFacts {
  private readonly ancestry = new Map<string, true>();

  constructor(private readonly limit = 4096) {}

  wrap(git: GitOperations): GitOperations {
    return new Proxy(git, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (property !== 'isAncestor' || typeof value !== 'function') return value;
        const isAncestor: GitOperations['isAncestor'] = async (
          repository,
          ancestor,
          descendant,
        ) => {
          const pinned = OBJECT_NAME.test(ancestor) && OBJECT_NAME.test(descendant);
          const key = `${repository}\0${ancestor}\0${descendant}`;
          if (pinned && this.ancestry.has(key)) {
            this.ancestry.delete(key);
            this.ancestry.set(key, true);
            return { ok: true, value: true };
          }
          const result = await (value as GitOperations['isAncestor']).call(
            target,
            repository,
            ancestor,
            descendant,
          );
          if (pinned && result.ok && result.value) this.remember(key);
          return result;
        };
        return isAncestor;
      },
    });
  }

  private remember(key: string): void {
    this.ancestry.set(key, true);
    for (const oldest of this.ancestry.keys()) {
      if (this.ancestry.size <= this.limit) break;
      this.ancestry.delete(oldest);
    }
  }
}
