import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { copyMigratedTemplate, testDataRoot } from './test-support.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('daemon check receipts (schema 33, R-G4)', () => {
  it('refuses to update or delete a stored receipt, even on a raw connection (TS-M5)', () => {
    const directory = mkdtempSync(join(testDataRoot(), 'craftingtable-check-receipts-'));
    directories.push(directory);
    const databasePath = join(directory, 'state', 'craftingtable.sqlite');
    copyMigratedTemplate(databasePath);
    const database = openDatabase(databasePath);
    try {
      const receipt = (sequence: number) =>
        JSON.stringify({
          runId: 'run-1',
          workspaceId: 'workspace-1',
          sequence,
          receipt: '{"kind":"scoped-check","exitCode":0}',
          recordedAt: '2026-10-02T00:00:00.000Z',
        });
      const rows = () =>
        database
          .prepare('SELECT run_id, sequence, record_json FROM run_check_receipts ORDER BY sequence')
          .all();
      insertWithoutParents(database, 1, receipt(1));
      const stored = rows();
      expect(stored).toHaveLength(1);

      for (const [sql, ...parameters] of [
        ['UPDATE run_check_receipts SET record_json = ? WHERE run_id = ?', receipt(2), 'run-1'],
        ['UPDATE run_check_receipts SET sequence = 2'],
        ['DELETE FROM run_check_receipts WHERE run_id = ?', 'run-1'],
        ['DELETE FROM run_check_receipts'],
      ] as const)
        expect(() => database.prepare(sql).run(...parameters), sql).toThrow(
          'Check receipts are immutable',
        );
      expect(rows()).toEqual(stored);

      // The table stays append-only rather than frozen: the run's next receipt is stored.
      insertWithoutParents(database, 2, receipt(2));
      expect(rows()).toHaveLength(2);
    } finally {
      database.close();
    }
  });
});

/**
 * Stores a receipt of run `run-1` without its parents (a run environment, its agent run,
 * worktree and runtime generation): the triggers are what is under test, not the parents.
 */
function insertWithoutParents(database: Database.Database, sequence: number, record: string) {
  database.pragma('foreign_keys = OFF');
  try {
    database
      .prepare('INSERT INTO run_check_receipts VALUES (?, ?, ?, ?)')
      .run('run-1', sequence, 'workspace-1', record);
  } finally {
    database.pragma('foreign_keys = ON');
  }
}
