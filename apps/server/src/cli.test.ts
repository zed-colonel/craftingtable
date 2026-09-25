import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverMigrations,
  inspectMigrationStatus,
  openDatabase,
  runMigrations,
} from '@craftingtable/storage';
import { describe, expect, it } from 'vitest';
import {
  parseCliArguments,
  runDatabaseCommand,
  runJournalCompaction,
  SCHEMA_VALIDATION_EXIT_CODE,
} from './cli.js';

describe('CLI argument parsing', () => {
  it('accepts bootstrap and database commands', () => {
    expect(parseCliArguments(['admin', 'bootstrap', '--username', 'keith'])).toEqual({
      command: 'bootstrap',
      username: 'keith',
    });
    expect(parseCliArguments(['db', 'migrate'])).toEqual({ command: 'db-migrate' });
    expect(parseCliArguments(['db', 'status'])).toEqual({ command: 'db-status' });
  });

  it('parses journal compaction as a dry run unless applied (R-H2)', () => {
    expect(parseCliArguments(['db', 'compact-journal'])).toEqual({
      command: 'compact-journal',
      apply: false,
      vacuum: false,
    });
    expect(
      parseCliArguments(['db', 'compact-journal', '--apply', '--vacuum', '--bodies', '/copy/runs']),
    ).toEqual({ command: 'compact-journal', apply: true, vacuum: true, bodies: '/copy/runs' });
    for (const args of [['--vacuum'], ['--bodies', 'relative'], ['--bodies'], ['--force']])
      expect(() => parseCliArguments(['db', 'compact-journal', ...args])).toThrow(/Usage/);
  });

  it('refuses to compact, even as a dry run, a database with pending migrations (R-H2)', () => {
    const directory = mkdtempSync(join(tmpdir(), 'craftingtable-cli-compact-test-'));
    const databasePath = join(directory, 'craftingtable.sqlite');
    try {
      const database = openDatabase(databasePath);
      runMigrations(database, discoverMigrations().slice(0, -1));
      database.close();
      const before = inspectMigrationStatus(databasePath);
      let output = '';
      const code = runJournalCompaction(
        databasePath,
        { apply: false, vacuum: false },
        {
          write(message: string) {
            output += message;
          },
        },
      );
      expect(code).toBe(2);
      expect(output).toMatch(/nothing was changed/);
      // Opening storage would have migrated it and left a pre-migration snapshot.
      expect(inspectMigrationStatus(databasePath)).toEqual(before);
      expect(
        readdirSync(directory).filter((name) => !name.startsWith('craftingtable.sqlite')),
      ).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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
      const migrationStatus = runMigrations(future);
      future
        .prepare(
          `INSERT INTO schema_migrations (version, name, checksum, applied_at)
           VALUES (?, 'future', ?, ?)`,
        )
        .run(migrationStatus.supportedVersion + 1, 'f'.repeat(64), '2026-07-24T00:00:00.000Z');
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

it('parses local recovery and rejects passwords or extra options in argv', () => {
  expect(parseCliArguments(['admin', 'reset-password', '--username', 'keith'])).toEqual({
    command: 'reset-password',
    username: 'keith',
  });
  for (const args of [
    ['admin', 'reset-password'],
    ['admin', 'reset-password', '--username', 'keith', '--password', 'secret'],
    ['admin', 'reset-password', '--username', 'keith', '--password=secret'],
    ['admin', 'reset-password', '--username', 'keith', 'unexpected'],
  ])
    expect(() => parseCliArguments(args)).toThrow();
});
