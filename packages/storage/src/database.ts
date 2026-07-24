import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';

export interface DatabasePragmas {
  readonly journalMode: string;
  readonly foreignKeys: number;
  readonly synchronous: number;
  readonly busyTimeout: number;
}

export function configureDatabase(database: Database.Database): DatabasePragmas {
  database.pragma('busy_timeout = 5000');
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');

  const pragmas = {
    journalMode: String(database.pragma('journal_mode', { simple: true })).toLowerCase(),
    foreignKeys: Number(database.pragma('foreign_keys', { simple: true })),
    synchronous: Number(database.pragma('synchronous', { simple: true })),
    busyTimeout: Number(database.pragma('busy_timeout', { simple: true })),
  };

  if (
    pragmas.journalMode !== 'wal' ||
    pragmas.foreignKeys !== 1 ||
    pragmas.synchronous !== 2 ||
    pragmas.busyTimeout !== 5000
  ) {
    throw new Error(`SQLite pragma verification failed: ${JSON.stringify(pragmas)}`);
  }
  return pragmas;
}

export function openDatabase(databasePath: string): Database.Database {
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(databasePath), 0o700);
  const database = new Database(databasePath);
  try {
    chmodSync(databasePath, 0o600);
    configureDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
