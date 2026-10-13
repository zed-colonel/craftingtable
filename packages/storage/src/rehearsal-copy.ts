import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './database.js';

/**
 * A database copy for a rehearsal (R-B11): the live file is opened only with `?immutable=1`, so
 * neither it, its write-ahead log nor its locks are touched (a transaction still in the log is not
 * in the copy), and `VACUUM INTO` writes a new file. The copy's repositories and worktrees are then
 * moved to copied checkouts, and any repository not copied is pointed at a path that does not
 * exist, so nothing run on the copy can reach a live checkout.
 */
export function copyDatabaseImmutably(source: string, destination: string): void {
  if (existsSync(destination)) throw new Error(`${destination} already exists`);
  if (/[?#]/.test(source)) throw new Error('The database path cannot carry a query or fragment');
  const live = new DatabaseSync(`file:${encodeURI(source)}?immutable=1`, { readOnly: true });
  try {
    live.prepare('VACUUM INTO ?').run(destination);
  } finally {
    live.close();
  }
  // An immutable read while the daemon checkpoints can be torn: the copy must be whole.
  const copy = new DatabaseSync(destination, { readOnly: true });
  try {
    const checked = copy.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    if (checked.length !== 1 || checked[0]?.integrity_check !== 'ok')
      throw new Error(
        `The copy of ${source} is not whole (${checked.map((r) => r.integrity_check).join('; ')}); copy it again`,
      );
  } finally {
    copy.close();
  }
}

interface RehearsalMoves {
  /** Each copied repository's new checkout. */
  readonly repositories: readonly { readonly id: string; readonly rootPath: string }[];
  /** Each copied worktree's new directory. */
  readonly worktrees: readonly { readonly id: string; readonly path: string }[];
  /** Where every repository and worktree not copied points instead: a path that does not exist. */
  readonly absentRoot: string;
}

/** Moves a rehearsal copy's repositories and worktrees; refuses a database with a live log. */
export function relocateRehearsalCopy(copy: string, moves: RehearsalMoves): void {
  if (existsSync(`${copy}-wal`))
    throw new Error('Relocate only a closed copy, never a live database');
  const database = openDatabase(copy);
  try {
    database.transaction(() => {
      const copied = new Set(moves.repositories.map((r) => r.id));
      for (const r of moves.repositories)
        database
          .prepare('UPDATE source_repositories SET root_path=? WHERE id=?')
          .run(r.rootPath, r.id);
      for (const row of database.prepare('SELECT id FROM source_repositories').all() as {
        id: string;
      }[])
        if (!copied.has(row.id))
          database
            .prepare('UPDATE source_repositories SET root_path=? WHERE id=?')
            .run(`${moves.absentRoot}/${row.id}`, row.id);
      const moved = new Map(moves.worktrees.map((w) => [w.id, w.path]));
      for (const row of database.prepare('SELECT id FROM worktrees').all() as { id: string }[])
        database
          .prepare('UPDATE worktrees SET path=? WHERE id=?')
          .run(moved.get(row.id) ?? `${moves.absentRoot}/worktrees/${row.id}`, row.id);
    })();
  } finally {
    database.close();
  }
}
