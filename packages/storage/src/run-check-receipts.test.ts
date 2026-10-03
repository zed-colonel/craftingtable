import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { type TemporaryStorage, temporaryStorage } from './test-support.js';

const fixtures: TemporaryStorage[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

describe('daemon check receipts (schema 33, R-G4)', () => {
  it('refuses to update or delete a stored receipt, on any connection (TS-M5)', () => {
    const fixture = temporaryStorage();
    fixtures.push(fixture);
    const database = openDatabase(fixture.databasePath);
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
      // The triggers are what is under test, not the receipt's parents (a run environment, its
      // agent run, worktree and runtime generation), so the row is stored without them.
      database.pragma('foreign_keys = OFF');
      database
        .prepare('INSERT INTO run_check_receipts VALUES (?, ?, ?, ?)')
        .run('run-1', 1, 'workspace-1', receipt(1));
      database.pragma('foreign_keys = ON');
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
      database.pragma('foreign_keys = OFF');
      database
        .prepare('INSERT INTO run_check_receipts VALUES (?, ?, ?, ?)')
        .run('run-1', 2, 'workspace-1', receipt(2));
      expect(rows()).toHaveLength(2);
    } finally {
      database.close();
    }
  });
});
