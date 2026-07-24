import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, runMigrations } from '@craftingtable/storage';
import { describe, expect, it } from 'vitest';
import { parseCliArguments, runDatabaseCommand, SCHEMA_VALIDATION_EXIT_CODE } from './cli.js';

describe('CLI argument parsing', () => {
  it('accepts bootstrap and database commands', () => {
    expect(parseCliArguments(['admin', 'bootstrap', '--username', 'keith'])).toEqual({
      command: 'bootstrap',
      username: 'keith',
    });
    expect(parseCliArguments(['db', 'migrate'])).toEqual({ command: 'db-migrate' });
    expect(parseCliArguments(['db', 'status'])).toEqual({ command: 'db-status' });
  });

  it('refuses passwords in process arguments', () => {
    expect(() =>
      parseCliArguments(['admin', 'bootstrap', '--username', 'keith', '--password', 'secret']),
    ).toThrow(/never/);
  });

  it('reports unsupported and checksum-mismatched schemas with a dedicated exit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'craftingtable-cli-schema-test-'));
    const databasePath = join(directory, 'craftingtable.sqlite');
    const output = { stdout: '', stderr: '' };
    const streams = {
      stdout: {
        write(message: string) {
          output.stdout += message;
        },
      },
      stderr: {
        write(message: string) {
          output.stderr += message;
        },
      },
    };
    try {
      const database = openDatabase(databasePath);
      runMigrations(database);
      database
        .prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = 1`)
        .run('0'.repeat(64));
      database.close();

      expect(runDatabaseCommand('db-status', databasePath, streams)).toBe(
        SCHEMA_VALIDATION_EXIT_CODE,
      );
      expect(output.stdout).toBe('');
      expect(output.stderr).toMatch(/^schema invalid \(checksum-mismatch\):/);

      output.stderr = '';
      expect(runDatabaseCommand('db-migrate', databasePath, streams)).toBe(
        SCHEMA_VALIDATION_EXIT_CODE,
      );
      expect(output.stderr).toMatch(/^schema invalid \(checksum-mismatch\):/);

      const futurePath = join(directory, 'future.sqlite');
      const future = openDatabase(futurePath);
      runMigrations(future);
      future
        .prepare(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at)
           VALUES (2, 'future', ?, ?)`,
        )
        .run('f'.repeat(64), '2026-07-24T00:00:00.000Z');
      future.close();
      output.stderr = '';
      expect(runDatabaseCommand('db-status', futurePath, streams)).toBe(
        SCHEMA_VALIDATION_EXIT_CODE,
      );
      expect(output.stderr).toMatch(/^schema invalid \(unsupported-version\):/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
