import { statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { configureDatabase } from './database.js';
import { temporaryStorage, type TemporaryStorage } from './test-support.js';

const temporaries: TemporaryStorage[] = [];
afterEach(() => {
  for (const temporary of temporaries.splice(0)) {
    temporary.cleanup();
  }
});

describe('SQLite operating mode', () => {
  it('enables and verifies the required pragmas on a real file', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const database = new Database(temporary.databasePath);
    expect(configureDatabase(database)).toEqual({
      journalMode: 'wal',
      foreignKeys: 1,
      synchronous: 2,
      busyTimeout: 5000,
    });
    database.close();
  });

  it('creates owner-only directory and database permissions', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    expect(statSync(temporary.databasePath).mode & 0o777).toBe(0o600);
    expect(statSync(new URL('.', `file://${temporary.databasePath}`)).mode & 0o777).toBe(0o700);
  });

  it('enforces foreign keys', () => {
    const temporary = temporaryStorage();
    temporaries.push(temporary);
    const database = new Database(temporary.databasePath);
    configureDatabase(database);
    expect(() =>
      database
        .prepare(
          `INSERT INTO workspaces (
            id, name, slug, status, created_by_user_id, created_at, updated_at, version
          ) VALUES ('workspace-x', 'X', 'x', 'active', 'missing', ?, ?, 1)`,
        )
        .run(new Date().toISOString(), new Date().toISOString()),
    ).toThrow(/FOREIGN KEY/);
    database.close();
  });
});
